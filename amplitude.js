// amplitude.js
/**
 * Thin wrapper around @amplitude/analytics-node.
 * Initialised by server.js on startup. Tracks trust decisions as 'trust_decision' events.
 * Gracefully no-ops when AMPLITUDE_API_KEY is not set.
 */

const { init, track } = require('@amplitude/analytics-node');

let initialized = false;

function initAmplitude() {
    const apiKey = process.env.AMPLITUDE_API_KEY;
    if (!apiKey) {
        console.log('Amplitude: AMPLITUDE_API_KEY not set, skipping instrumentation.');
        return;
    }
    init(apiKey, {
        flushIntervalMillis: 5000,
        logLevel: 0 // suppress SDK noise
    });
    initialized = true;
    console.log('Amplitude: initialized.');
}

/**
 * Track a trust_decision event.
 * @param {{
 *   customer_id: string,
 *   action: string,
 *   actionTier: string,
 *   riskLevel: string,
 *   decision: string,
 *   step_up_type: string|null,
 *   ruleId: string|null,
 *   reference_id: string|null,
 *   geography: string|null,
 *   fraudScore: number,
 *   deviceScore: number,
 *   effectiveConfidence: number
 * }} entry
 */
function trackDecision(entry) {
    if (!initialized) return;
    try {
        track({
            event_type: 'trust_decision',
            user_id: entry.customer_id || 'unknown',
            event_properties: {
                decision:             entry.decision             || null,
                step_up_type:         entry.step_up_type         || null,
                risk_level:           entry.riskLevel            || null,
                action_tier:          entry.actionTier           || null,
                action:               entry.action               || null,
                rule_id:              entry.ruleId               || null,
                geography:            entry.geography            || null,
                fraud_score:          entry.fraudScore           ?? null,
                device_score:         entry.deviceScore          ?? null,
                effective_confidence: entry.effectiveConfidence  ?? null,
                reference_id:         entry.reference_id         || null,
            }
        });
    } catch (err) {
        console.warn('Amplitude track error:', err.message);
    }
}

module.exports = { initAmplitude, trackDecision };
