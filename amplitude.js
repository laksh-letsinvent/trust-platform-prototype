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
 * Track a trust_decision event (primary decisions only — FRICTIONLESS, STEP_UP, MANUAL_REVIEW, DENY).
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

/**
 * Track a trust_decision_outcome event (step-up or manual review completions).
 * Fired once per lifecycle event — does NOT replace the original trust_decision.
 * @param {{
 *   customer_id: string,
 *   action: string,
 *   decision: string,           // 'STEP_UP' | 'MANUAL_REVIEW'
 *   outcome: string,            // 'APPROVED' | 'DENIED' | 'ESCALATED'
 *   original_reference_id: string|null,
 *   reviewer_id?: string|null,  // manual review only
 * }} entry
 */
function trackOutcome(entry) {
    if (!initialized) return;
    try {
        track({
            event_type: 'trust_decision_outcome',
            user_id: entry.customer_id || 'unknown',
            event_properties: {
                decision:              entry.decision              || null,
                outcome:               entry.outcome               || null,
                action:                entry.action                || null,
                original_reference_id: entry.original_reference_id || null,
                reviewer_id:           entry.reviewer_id           || null,
            }
        });
    } catch (err) {
        console.warn('Amplitude track error:', err.message);
    }
}

module.exports = { initAmplitude, trackDecision, trackOutcome };
