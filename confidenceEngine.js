// confidenceEngine.js
/**
 * Risk and confidence are computed only from policy (confidence.json).
 * Data stores provide raw scores only; bands and formulas are defined in policy.
 */

const path = require('path');
const fs = require('fs');

let confidenceConfig = null;

function loadConfidenceConfig() {
    if (confidenceConfig) return confidenceConfig;
    const filePath = path.join(__dirname, 'policies', 'confidence.json');
    const raw = fs.readFileSync(filePath, 'utf8');
    confidenceConfig = JSON.parse(raw);
    return confidenceConfig;
}

function clearCache() {
    confidenceConfig = null;
}

const AL_ORDER = ['AL1', 'AL2', 'AL3', 'AL4'];

/**
 * Compare Auth Assurance Levels: true if current meets or exceeds required.
 */
function alMeetsRequired(currentAL, requiredAL) {
    if (requiredAL == null) return true;
    if (currentAL == null) return false;
    const ci = AL_ORDER.indexOf(currentAL);
    const ri = AL_ORDER.indexOf(requiredAL);
    if (ci < 0 || ri < 0) return false;
    return ci >= ri;
}

/**
 * Derive risk level from fraud score using only policy bands.
 */
function getRiskLevel(fraudScore, config) {
    const bands = config.riskLevelBands || {};
    const order = config.riskLevelOrder || ['HIGH', 'MEDIUM', 'LOW'];
    const score = Number(fraudScore);

    for (const level of order) {
        const band = bands[level];
        if (!band) continue;
        const minOk = band.fraudScoreMin == null || score >= band.fraudScoreMin;
        const maxOk = band.fraudScoreMax == null || score <= band.fraudScoreMax;
        if (minOk && maxOk) return level;
    }

    return config.defaultRiskLevel != null ? config.defaultRiskLevel : 'MEDIUM';
}

/**
 * Compute effective confidence using the formula in policy.
 * Both deviceWeight and fraudWeight are percentages that sum to 100.
 * Formula: (deviceScore/100 * deviceWeight) + ((100-fraudScore)/100 * fraudWeight)
 */
function computeEffectiveConfidence(fraudScore, deviceScore, authenticatorConfidence, config) {
    const formula = config.effectiveConfidence || {};
    const deviceWeight = formula.deviceWeight != null ? formula.deviceWeight : 40;
    const fraudWeight = formula.fraudWeight != null ? formula.fraudWeight : 60;
    const clampedDevice = Math.min(100, Math.max(0, Number(deviceScore)));
    const clampedFraud = Math.min(100, Math.max(0, Number(fraudScore)));
    let value = (clampedDevice / 100) * deviceWeight + ((100 - clampedFraud) / 100) * fraudWeight;
    if (formula.useAuthenticatorMax !== false && authenticatorConfidence != null) {
        value = Math.max(value, authenticatorConfidence);
    }
    return Math.round(Math.min(100, Math.max(0, value)));
}

/**
 * Build context and a step-by-step trace of how risk and confidence were derived.
 * Accepts optional velocity signals for velocity-based policy rules.
 */
function computeContext(signals) {
    const { fraudScore, deviceScore, geography, actionInfo, authenticatorInfo, currentAuthLevel, velocity, enrichment } = signals;
    const config = loadConfidenceConfig();

    const score = Number(fraudScore);

    // --- Risk level: policy bands only ---
    const riskLevel = getRiskLevel(score, config);
    const confidenceTrace = {
        riskLevel: {
            source: 'policy (riskLevelBands)',
            input: { fraudScore: score },
            bands: config.riskLevelBands,
            order: config.riskLevelOrder,
            result: riskLevel
        }
    };

    // --- Required confidence: from action data or policy tier defaults ---
    const tierReqs = config.actionTierRequirements || {};
    const actionTier = actionInfo ? actionInfo.tier : null;
    const requiredConfidence = actionInfo && actionInfo.required_confidence != null
        ? actionInfo.required_confidence
        : (actionTier && tierReqs[actionTier] != null) ? tierReqs[actionTier] : null;

    confidenceTrace.requiredConfidence = {
        source: actionInfo && actionInfo.required_confidence != null ? 'data (action.required_confidence)' : 'policy (actionTierRequirements)',
        actionTier: actionTier,
        value: requiredConfidence
    };

    // --- Authenticator confidence: from data (current_auth_level) ---
    const authenticatorConfidence = authenticatorInfo ? authenticatorInfo.confidence_level : null;
    confidenceTrace.authenticatorConfidence = {
        source: 'data (authenticators), from request current_auth_level',
        value: authenticatorConfidence,
        currentAuthLevel: currentAuthLevel ?? null,
        note: authenticatorConfidence == null ? 'not set or unknown' : `authenticator ${authenticatorInfo.id || '—'}`
    };

    // --- Effective confidence: formula from policy ---
    const formula = config.effectiveConfidence || {};
    const effectiveConfidence = computeEffectiveConfidence(score, deviceScore, authenticatorConfidence, config);
    confidenceTrace.effectiveConfidence = {
        source: 'policy (effectiveConfidence formula)',
        inputs: {
            fraudScore: score,
            deviceScore: deviceScore,
            authenticatorConfidence: authenticatorConfidence
        },
        formula: {
            deviceWeight: formula.deviceWeight != null ? formula.deviceWeight : 40,
            fraudWeight: formula.fraudWeight != null ? formula.fraudWeight : 60,
            useAuthenticatorMax: formula.useAuthenticatorMax !== false,
            expression: `(deviceScore/100 × ${formula.deviceWeight ?? 40}) + ((100-fraudScore)/100 × ${formula.fraudWeight ?? 60})`
        },
        result: effectiveConfidence
    };

    const confidenceMeetsAction = requiredConfidence != null
        ? effectiveConfidence >= requiredConfidence
        : null;
    confidenceTrace.confidenceMeetsAction = {
        check: requiredConfidence != null ? `effectiveConfidence (${effectiveConfidence}) >= requiredConfidence (${requiredConfidence})` : 'not applicable',
        result: confidenceMeetsAction
    };

    // --- Required AL: from action (required_al) or policy (actionTierRequiredAL) ---
    const tierAL = config.actionTierRequiredAL || {};
    const requiredAL = actionInfo && actionInfo.required_al != null
        ? actionInfo.required_al
        : (actionTier && tierAL[actionTier]) || null;
    const currentAL = authenticatorInfo && authenticatorInfo.assurance_level != null
        ? authenticatorInfo.assurance_level
        : null;
    const alMeets = alMeetsRequired(currentAL, requiredAL);

    // Index of current AL in the AL hierarchy (-1 if no auth)
    const currentALIndex = currentAL != null ? AL_ORDER.indexOf(currentAL) : -1;

    confidenceTrace.requiredAL = {
        source: actionInfo && actionInfo.required_al != null ? 'data (action.required_al)' : 'policy (actionTierRequiredAL)',
        value: requiredAL,
        currentAL,
        currentALIndex,
        alMeetsRequired: alMeets
    };

    // --- Velocity signals (if provided) ---
    const velocitySignals = velocity || { velocity_1m: 0, velocity_5m: 0, velocity_15m: 0 };
    if (velocity) {
        confidenceTrace.velocity = {
            source: 'redis (velocityEngine)',
            velocity_1m: velocitySignals.velocity_1m,
            velocity_5m: velocitySignals.velocity_5m,
            velocity_15m: velocitySignals.velocity_15m
        };
    }

    return {
        fraudScore: score,
        deviceScore: deviceScore == null ? 0 : Number(deviceScore),
        geography: geography || null,
        riskLevel,
        actionTier,
        requiredConfidence,
        requiredAL,
        currentAL,
        currentALIndex,
        alMeetsRequired: alMeets,
        authenticatorConfidence: authenticatorConfidence ?? null,
        effectiveConfidence,
        confidenceMeetsAction,
        currentAuthLevel: currentAuthLevel ?? null,
        velocity: velocitySignals,
        // Intelligence enrichment (Phase 2) — defaults to safe falsy values when absent
        is_proxy:         enrichment?.is_proxy         || false,
        is_vpn:           enrichment?.is_vpn           || false,
        is_tor:           enrichment?.is_tor           || false,
        is_hosting:       enrichment?.is_hosting       || false,
        email_breached:   enrichment?.email_breached   || false,
        breach_count:     enrichment?.breach_count     ?? 0,
        ip_abuse_score:   enrichment?.ip_abuse_score   ?? null,
        is_greynoise_bot: enrichment?.is_greynoise_bot || false,
        is_new_device:    enrichment?.is_new_device    || false,
        ato_signal_count: enrichment?.ato_signal_count ?? 0,
        signals,
        confidenceTrace
    };
}

module.exports = {
    loadConfidenceConfig,
    getRiskLevel,
    computeEffectiveConfidence,
    computeContext,
    alMeetsRequired,
    clearCache,
    AL_ORDER
};
