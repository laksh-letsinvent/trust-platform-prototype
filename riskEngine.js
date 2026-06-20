// riskEngine.js
// Three inputs → two-axis decision: composite Risk, Assurance ladder, Action requirement.
// Weights live in policies/risk.json — nothing hardcoded here.

const path = require('path');
const fs = require('fs');

let riskConfig = null;

function loadRiskConfig() {
    if (riskConfig) return riskConfig;
    const filePath = path.join(__dirname, 'policies', 'risk.json');
    const raw = fs.readFileSync(filePath, 'utf8');
    riskConfig = JSON.parse(raw);
    return riskConfig;
}

function clearCache() {
    riskConfig = null;
}

const AL_ORDER = ['AL1', 'AL2', 'AL3', 'AL4'];

function alMeetsRequired(currentAL, requiredAL) {
    if (requiredAL == null) return true;
    if (currentAL == null) return false;
    const ci = AL_ORDER.indexOf(currentAL);
    const ri = AL_ORDER.indexOf(requiredAL);
    if (ci < 0 || ri < 0) return false;
    return ci >= ri;
}

function getRiskLevel(compositeRisk, config) {
    const bands = config.riskLevelBands || {};
    const order = config.riskLevelOrder || ['HIGH', 'MEDIUM', 'LOW'];
    const score = Number(compositeRisk);

    for (const level of order) {
        const band = bands[level];
        if (!band) continue;
        const minOk = band.compositeRiskMin == null || score >= band.compositeRiskMin;
        const maxOk = band.compositeRiskMax == null || score <= band.compositeRiskMax;
        if (minOk && maxOk) return level;
    }

    return config.defaultRiskLevel != null ? config.defaultRiskLevel : 'MEDIUM';
}

// networkRisk: additive sub-weights, capped at 100 (NOT a sum-to-100 set)
function computeNetworkRisk(enrichment, subWeights) {
    if (!enrichment) return 0;
    const sw = subWeights || {};
    const ipMultiplier    = sw.ip_abuse_multiplier ?? 0.6;
    const breachPoints    = sw.email_breached      ?? 25;
    const proxyPoints     = sw.proxy               ?? 20;
    const newDevicePoints = sw.new_device          ?? 20;
    const vpnPoints       = sw.vpn                 ?? 15;

    let score = 0;
    if (enrichment.ip_abuse_score != null)
        score += enrichment.ip_abuse_score * ipMultiplier;
    if (enrichment.email_breached && (enrichment.breach_count ?? 0) > 2)
        score += breachPoints;
    if (enrichment.is_proxy)
        score += proxyPoints;
    if (enrichment.is_new_device)
        score += newDevicePoints;
    if (enrichment.is_vpn)
        score += vpnPoints;

    return Math.min(100, Math.round(score));
}

// velocityRisk: non-burst signals (bursts are hard gates, not score contributors)
function computeVelocityRisk(velocity) {
    if (!velocity) return 0;
    const v1  = velocity.velocity_1m  || 0;
    const v5  = velocity.velocity_5m  || 0;
    const v15 = velocity.velocity_15m || 0;
    let score = 0;
    if (v1  > 2) score += Math.min(40, (v1  - 2) * 8);
    if (v5  > 4) score += Math.min(35, (v5  - 4) * 5);
    if (v15 > 8) score += Math.min(25, (v15 - 8) * 3);
    return Math.min(100, Math.round(score));
}

// compositeRisk: weighted average of five components, clamped 0–100
function computeCompositeRisk(components, weights) {
    const w = weights || {};
    const score =
        (components.customer    * (w.customer    ?? 40) +
         components.device      * (w.device      ?? 25) +
         components.behavioural * (w.behavioural ?? 15) +
         components.network     * (w.network     ?? 15) +
         components.velocity    * (w.velocity    ?? 5)) / 100;
    return Math.round(Math.min(100, Math.max(0, score)));
}

/**
 * Build the full risk context from raw signals.
 * Entry point for building the full risk context from raw signals.
 */
function computeRiskContext(signals) {
    const {
        fraudScore, deviceScore, ambientTrustScore,
        geography, actionInfo, authenticatorInfo,
        currentAuthLevel, velocity, enrichment
    } = signals;

    const config = loadRiskConfig();

    // Component normalisers — all 0–100, higher = riskier
    const customerRisk    = Math.min(100, Math.max(0, Number(fraudScore) || 0));
    const deviceRisk      = Math.min(100, Math.max(0, 100 - (Number(deviceScore) || 0)));
    const atScore         = ambientTrustScore != null ? Number(ambientTrustScore) : 50;
    const behaviouralRisk = Math.min(100, Math.max(0, 100 - atScore));

    const nwSubWeights = config.networkRisk?.subWeights;
    const networkRisk  = computeNetworkRisk(enrichment, nwSubWeights);
    const velocityRisk = computeVelocityRisk(velocity);

    const components = {
        customer:    customerRisk,
        device:      deviceRisk,
        behavioural: behaviouralRisk,
        network:     networkRisk,
        velocity:    velocityRisk
    };

    const weights       = config.compositeRisk?.weights;
    const compositeRisk = computeCompositeRisk(components, weights);
    const riskLevel     = getRiskLevel(compositeRisk, config);

    // Assurance: from action data or policy tier defaults
    const tierAL  = config.actionTierRequiredAL || {};
    const actionTier = actionInfo ? actionInfo.tier : null;
    const requiredAL = actionInfo && actionInfo.required_al != null
        ? actionInfo.required_al
        : (actionTier && tierAL[actionTier]) || null;
    const currentAL = authenticatorInfo && authenticatorInfo.assurance_level != null
        ? authenticatorInfo.assurance_level
        : null;
    const alMeets       = alMeetsRequired(currentAL, requiredAL);
    const currentALIndex = currentAL != null ? AL_ORDER.indexOf(currentAL) : -1;
    // True when current AL already satisfies the next level above required (AL_PLUS_1)
    const requiredALIndex = requiredAL != null ? AL_ORDER.indexOf(requiredAL) : -1;
    const nextLevelIndex  = requiredALIndex >= 0 ? Math.min(requiredALIndex + 1, AL_ORDER.length - 1) : -1;
    const alMeetsNextLevel = nextLevelIndex >= 0 && currentALIndex >= nextLevelIndex;

    // Risk ceiling: compositeRisk > action.risk_ceiling
    const riskCeiling         = actionInfo?.risk_ceiling ?? null;
    const risk_ceiling_breached = riskCeiling != null ? compositeRisk > riskCeiling : false;

    const velocitySignals = velocity || { velocity_1m: 0, velocity_5m: 0, velocity_15m: 0 };

    const riskTrace = {
        components,
        weights: weights || { customer: 40, device: 25, behavioural: 15, network: 15, velocity: 5 },
        compositeRisk,
        riskLevel,
        networkRiskDetail: {
            subWeights:   nwSubWeights,
            ip_abuse_score: enrichment?.ip_abuse_score ?? null,
            email_breached: enrichment?.email_breached  ?? false,
            breach_count:   enrichment?.breach_count    ?? 0,
            is_proxy:       enrichment?.is_proxy        ?? false,
            is_new_device:  enrichment?.is_new_device   ?? false,
            is_vpn:         enrichment?.is_vpn          ?? false
        },
        assurance: {
            source: actionInfo && actionInfo.required_al != null
                ? 'data (action.required_al)' : 'policy (actionTierRequiredAL)',
            requiredAL,
            currentAL,
            currentALIndex,
            alMeetsRequired: alMeets,
            alMeetsNextLevel
        },
        riskCeiling: { ceiling: riskCeiling, compositeRisk, breached: risk_ceiling_breached }
    };

    return {
        fraudScore:   Number(fraudScore) || 0,
        deviceScore:  deviceScore == null ? 0 : Number(deviceScore),
        ambientTrustScore: atScore,
        geography:    geography || null,
        riskLevel,
        compositeRisk,
        components,
        actionTier,
        requiredAL,
        currentAL,
        currentALIndex,
        alMeetsRequired: alMeets,
        alMeetsNextLevel,
        currentAuthLevel: currentAuthLevel ?? null,
        risk_ceiling_breached,
        velocity: velocitySignals,
        // Enrichment flags for gate-condition matching
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
        riskTrace
    };
}

module.exports = {
    loadRiskConfig,
    getRiskLevel,
    computeNetworkRisk,
    computeVelocityRisk,
    computeCompositeRisk,
    computeRiskContext,
    alMeetsRequired,
    clearCache,
    AL_ORDER
};
