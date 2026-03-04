// decisionEngine.js

const { computeContext } = require('./confidenceEngine');
const { evaluate } = require('./policyEngine');
const idvRouting = require('./idvRouting');
const cache = require('./cache');
const store = require('./data/store');
const velocityEngine = require('./velocityEngine');
const analytics = require('./analytics');
const amplitude = require('./amplitude');
const sessionStore = require('./sessionStore');

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
async function getDecision({ customer_id, action, device_id, current_auth_level }, analyticsExtra = {}) {
    const trace = {
        input: { customer_id, action, device_id, current_auth_level: current_auth_level ?? null },
        data_lookup: {},
        signals: {},
        context: null,
        confidence_calculation: null,
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
        ? { id: actionInfo.id, name: actionInfo.name, tier: actionInfo.tier, required_confidence: actionInfo.required_confidence }
        : { id: action, note: 'Action not in store.' };
    if (current_auth_level != null) {
        trace.data_lookup.current_auth_level = authenticatorInfo
            ? { id: authenticatorInfo.id, confidence_level: authenticatorInfo.confidence_level }
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

    const geography = user && user.geography ? user.geography : null;

    // Velocity: get counts before recording this request
    const velocity = await velocityEngine.getVelocity(customer_id);
    await velocityEngine.recordRequest(customer_id);

    trace.signals = {
        fraudScore,
        deviceScore,
        geography,
        current_auth_level: current_auth_level ?? null,
        velocity,
        velocity_tracking: velocityEngine.isAvailable() ? 'active' : 'unavailable (Redis not connected)'
    };

    const context = computeContext({
        fraudScore,
        deviceScore,
        geography,
        actionInfo,
        authenticatorInfo,
        currentAuthLevel: current_auth_level ?? null,
        velocity
    });

    trace.context = {
        fraudScore: context.fraudScore,
        deviceScore: context.deviceScore,
        geography: context.geography,
        riskLevel: context.riskLevel,
        actionTier: context.actionTier,
        requiredConfidence: context.requiredConfidence,
        requiredAL: context.requiredAL,
        currentAL: context.currentAL,
        currentALIndex: context.currentALIndex,
        alMeetsRequired: context.alMeetsRequired,
        authenticatorConfidence: context.authenticatorConfidence,
        effectiveConfidence: context.effectiveConfidence,
        confidenceMeetsAction: context.confidenceMeetsAction,
        currentAuthLevel: context.currentAuthLevel,
        velocity: context.velocity
    };
    trace.confidence_calculation = context.confidenceTrace || null;

    const policyResult = evaluate(context);

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

    trace.decision = policyResult.decision;
    trace.step_up_type = policyResult.step_up_type;
    trace.reason = policyResult.reason;
    trace.reference_id = reference_id;

    let idvVendor = null;
    let idv_session_id = null;
    if (policyResult.step_up_type === 'IDV') {
        const resolved = idvRouting.resolveIdvVendor({ geography: context.geography, requestId: `${customer_id}:${action}:${device_id}` });
        idvVendor = resolved;
        trace.idv_routing = resolved;
        // Generate a stable IDV session ID tied to this reference
        idv_session_id = `ses_${reference_id}`;
        trace.idv_session_id = idv_session_id;
    }

    // Record for analytics
    analytics.record({
        customer_id,
        action,
        actionTier: context.actionTier,
        riskLevel: context.riskLevel,
        decision: policyResult.decision,
        step_up_type: policyResult.step_up_type || null,
        ruleId: policyResult.ruleId || null,
        reference_id,
        ...analyticsExtra
    });

    // Create session for actionable decisions (enables step-up completion + review feedback)
    const fullResult = {
        decision: policyResult.decision,
        step_up_type: policyResult.step_up_type,
        reason: policyResult.reason,
        reference_id,
        idv_vendor: idvVendor ? idvVendor.vendor : null,
        idv_session_id,
        trace
    };
    if (reference_id) {
        sessionStore.createSession(fullResult, { customer_id, action, device_id });
    }

    // Send to Amplitude
    amplitude.trackDecision({
        customer_id,
        action,
        actionTier: context.actionTier,
        riskLevel: context.riskLevel,
        decision: policyResult.decision,
        step_up_type: policyResult.step_up_type || null,
        ruleId: policyResult.ruleId || null,
        reference_id,
        geography: context.geography,
        fraudScore,
        deviceScore,
        effectiveConfidence: context.effectiveConfidence,
    });

    return {
        decision: trace.decision,
        step_up_type: trace.step_up_type,
        reason: trace.reason,
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
