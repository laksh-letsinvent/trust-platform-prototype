// decisionEngine.js

const { computeRiskContext } = require('./riskEngine');
const { evaluate, evaluateWith } = require('./policyEngine');
const idvRouting = require('./idvRouting');
const cache = require('./cache');
const store = require('./data/store');
const velocityEngine = require('./velocityEngine');
const analytics = require('./analytics');
const amplitude = require('./amplitude');
const sessionStore = require('./sessionStore');
const enrichmentOrchestrator = require('./adapters/enrichmentOrchestrator');
const ambientTrustStore = require('./ambientTrustStore');
const abExperiment = require('./abExperiment');

/**
 * Generates a human-readable reference ID for actionable decisions.
 * Format: {PREFIX}-YYYYMMDD-XXXX  (e.g. TXN-20260228-K7P2)
 * Prefix: TXN = STEP_UP, CASE = MANUAL_REVIEW, INC = DENY
 */
function generateRef(prefix, customerId, action) {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
    let n = (customerId + action + Date.now()).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    let code = '';
    for (let i = 0; i < 4; i++) { code += chars[n % chars.length]; n = Math.floor(n / chars.length) || n + 7; }
    return `${prefix}-${date}-${code}`;
}

/**
 * Runs the full trust decision pipeline.
 * Request: customer_id, action, device_id, current_auth_level (optional).
 */
async function getDecision({ customer_id, action, device_id, current_auth_level, ip, email: emailOverride }, analyticsExtra = {}) {
    const trace = {
        input: { customer_id, action, device_id, current_auth_level: current_auth_level ?? null },
        data_lookup: {},
        signals: {},
        context: null,
        risk_calculation: null,
        policy: null,
        decision: null,
        step_up_type: null,
        reason: null
    };

    const [user, device, actionInfo, authenticatorInfo] = await Promise.all([
        store.getUserById(customer_id),
        store.getDeviceById(device_id),
        store.getActionById(action),
        current_auth_level ? store.getAuthenticatorById(current_auth_level) : Promise.resolve(null)
    ]);

    trace.data_lookup.user = user
        ? { customer_id: user.customer_id, fraud_score: user.fraud_score, geography: user.geography }
        : { customer_id, note: 'User not in store; using default fraud score.' };
    trace.data_lookup.device = device
        ? { device_id: device.device_id, device_score: device.device_score }
        : { device_id, note: 'Device not in store; using default device score.' };
    trace.data_lookup.action = actionInfo
        ? { id: actionInfo.id, name: actionInfo.name, tier: actionInfo.tier, risk_ceiling: actionInfo.risk_ceiling }
        : { id: action, note: 'Action not in store.' };
    if (current_auth_level != null) {
        trace.data_lookup.current_auth_level = authenticatorInfo
            ? { id: authenticatorInfo.id, assurance_level: authenticatorInfo.assurance_level }
            : { requested: current_auth_level, note: 'Authenticator not in store.' };
    }

    let fraudScore = await cache.getCachedFraudScore(customer_id, action, device_id);
    if (fraudScore == null) {
        fraudScore = user != null && typeof user.fraud_score === 'number' ? user.fraud_score : 50;
        await cache.setCachedFraudScore(customer_id, action, device_id, fraudScore);
    }

    let deviceScore = await cache.getCachedDeviceScore(device_id);
    if (deviceScore == null) {
        deviceScore = device != null && typeof device.device_score === 'number' ? device.device_score : 0;
        await cache.setCachedDeviceScore(device_id, deviceScore);
    }

    // Enrich with external intelligence — always best-effort, never blocks the decision
    const enrichment = await enrichmentOrchestrator.enrich({
        ip: ip || null,
        email: user?.email || emailOverride || null,
        customerId: customer_id,
        deviceId: device_id,
        existingDeviceIds: user?.known_device_ids || [],
    }).catch(() => ({}));

    // Use IP-derived geography when available, fall back to user record
    const geography = enrichment.geography || (user && user.geography ? user.geography : null);

    // Velocity: get counts before recording this request
    const velocity = await velocityEngine.getVelocity(customer_id);
    await velocityEngine.recordRequest(customer_id);

    // Ambient Trust Score — non-blocking, falls back to 50 on Redis unavailability
    const ambientTrustScore = await ambientTrustStore.getScore(customer_id).catch(() => 50);

    // Record suspicion signals into ATS
    if (enrichment.is_new_device && user != null)
        ambientTrustStore.recordSuspicion(customer_id, 'new_device').catch(() => {});
    if (enrichment.is_vpn || enrichment.is_proxy)
        ambientTrustStore.recordSuspicion(customer_id, 'vpn_detected').catch(() => {});
    if (enrichment.email_breached && enrichment.breach_count > 2)
        ambientTrustStore.recordSuspicion(customer_id, 'breach_detected').catch(() => {});
    if (velocity && velocity.velocity_1m > 5)
        ambientTrustStore.recordSuspicion(customer_id, 'velocity_burst').catch(() => {});

    trace.signals = {
        fraudScore,
        deviceScore,
        geography,
        ambientTrustScore,
        current_auth_level: current_auth_level ?? null,
        velocity,
        velocity_tracking: velocityEngine.isAvailable() ? 'active' : 'unavailable (Redis not connected)',
        enrichment: Object.keys(enrichment).length ? enrichment : null,
    };
    trace.enrichment = Object.keys(enrichment).length ? enrichment : null;

    const context = computeRiskContext({
        fraudScore,
        deviceScore,
        ambientTrustScore,
        geography,
        actionInfo,
        authenticatorInfo,
        currentAuthLevel: current_auth_level ?? null,
        velocity,
        enrichment,
    });

    trace.context = {
        fraudScore:          context.fraudScore,
        deviceScore:         context.deviceScore,
        ambientTrustScore:   context.ambientTrustScore,
        geography:           context.geography,
        compositeRisk:       context.compositeRisk,
        components:          context.components,
        riskLevel:           context.riskLevel,
        actionTier:          context.actionTier,
        requiredAL:          context.requiredAL,
        currentAL:           context.currentAL,
        currentALIndex:      context.currentALIndex,
        alMeetsRequired:     context.alMeetsRequired,
        risk_ceiling_breached: context.risk_ceiling_breached,
        currentAuthLevel:    context.currentAuthLevel,
        velocity:            context.velocity,
    };
    trace.risk_calculation = context.riskTrace || null;

    // A/B experiment: assign variant and evaluate with treatment/control config
    const experiment = abExperiment.getActiveExperiment();
    let experimentId = null;
    let variant = null;
    let policyResult;
    if (experiment) {
        experimentId = experiment.id;
        variant = abExperiment.assignVariant(customer_id, experiment.id, experiment.splitPct);
        policyResult = variant === 'treatment'
            ? evaluateWith(experiment.treatmentConfig, context)
            : evaluate(context);
    } else {
        policyResult = evaluate(context);
    }

    // Generate reference ID for actionable decisions
    const prefixMap = { STEP_UP: 'TXN', MANUAL_REVIEW: 'CASE', DENY: 'INC' };
    const refPrefix = prefixMap[policyResult.decision];
    const reference_id = refPrefix ? generateRef(refPrefix, customer_id, action) : null;

    trace.policy = {
        decision: policyResult.decision,
        step_up_type: policyResult.step_up_type,
        reason: policyResult.reason,
        ruleId: policyResult.ruleId,
        rules_evaluated: policyResult.trace.rules_evaluated,
        matched_rule_id: policyResult.trace.matched_rule_id,
        default_used: policyResult.trace.default_used
    };

    trace.step_up_type = policyResult.step_up_type;
    trace.reason = policyResult.reason;
    trace.reference_id = reference_id;

    let idvVendor = null;
    let idv_session_id = null;
    if (policyResult.step_up_type === 'IDV') {
        const resolved = idvRouting.resolveIdvVendor({ geography: context.geography, requestId: `${customer_id}:${action}:${device_id}` });
        idvVendor = resolved;
        trace.idv_routing = resolved;
        idv_session_id = `ses_${reference_id}`;
        trace.idv_session_id = idv_session_id;
    }

    // Translate policy ALLOW → FRICTIONLESS (policy layer stays unaware of this rename)
    const outputDecision = policyResult.decision === 'ALLOW' ? 'FRICTIONLESS' : policyResult.decision;
    trace.decision = outputDecision;

    // Record for analytics
    if (!analyticsExtra.skipAnalytics) {
        analytics.record({
            customer_id,
            action,
            actionTier: context.actionTier,
            riskLevel: context.riskLevel,
            decision: outputDecision,
            step_up_type: policyResult.step_up_type || null,
            ruleId: policyResult.ruleId || null,
            reference_id,
            outcome: null,
            original_reference_id: analyticsExtra.original_reference_id || null,
            caller_key_id: analyticsExtra.callerKeyId || null,
            experiment_id: experimentId || null,
            variant: variant || null,
            // Snapshot of raw signals at decision time, for policy simulation replay
            replay: {
                device_id,
                current_auth_level: current_auth_level ?? null,
                fraudScore,
                deviceScore,
                ambientTrustScore,
                geography: context.geography,
                velocity: context.velocity,
                enrichment: Object.keys(enrichment).length ? enrichment : null,
            },
        });
    }

    // Create session for actionable decisions (enables step-up completion + review feedback)
    const fullResult = {
        decision: outputDecision,
        step_up_type: policyResult.step_up_type,
        reason: policyResult.reason,
        reference_id,
        idv_vendor: idvVendor ? idvVendor.vendor : null,
        idv_session_id,
        trace
    };
    if (reference_id) {
        await sessionStore.createSession(fullResult, { customer_id, action, device_id });
    }

    // Send to Amplitude
    amplitude.trackDecision({
        customer_id,
        action,
        actionTier: context.actionTier,
        riskLevel: context.riskLevel,
        decision: outputDecision,
        step_up_type: policyResult.step_up_type || null,
        ruleId: policyResult.ruleId || null,
        reference_id,
        geography: context.geography,
        fraudScore,
        deviceScore,
        compositeRisk: context.compositeRisk,
        velocity: context.velocity || null,
    });

    return {
        decision: trace.decision,
        step_up_type: trace.step_up_type,
        reason: trace.reason,
        display_message: policyResult.display_message || null,
        reference_id: trace.reference_id,
        idv_vendor: idvVendor ? idvVendor.vendor : undefined,
        idv_session_id: idv_session_id || undefined,
        idv_routing: idvVendor ? { vendor: idvVendor.vendor, strategy: idvVendor.strategy, note: idvVendor.note } : undefined,
        trace
    };
}

module.exports = {
    getDecision
};
