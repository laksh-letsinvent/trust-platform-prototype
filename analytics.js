// analytics.js
/**
 * In-memory ring buffer tracking the last 500 trust decisions.
 * Each decision is also appended to decisions.jsonl for persistence across restarts.
 * Postgres upgrade path: swap fs.appendFileSync call for a pg.query(INSERT ...).
 */

const fs = require('fs');
const path = require('path');

const BUFFER_SIZE = 500;
const LOGFILE = path.join(__dirname, 'decisions.jsonl');
const ringBuffer = [];

/**
 * Record a completed decision.
 * @param {{ customer_id, action, actionTier, riskLevel, decision, step_up_type, ruleId, reference_id, triggered_by?, original_reference_id? }} entry
 * triggered_by: null for direct decisions; "step_up_complete" | "idv_webhook" | "manual_review_approved" | "manual_review_denied" for post-challenge outcomes
 */
function record(entry) {
    if (ringBuffer.length >= BUFFER_SIZE) ringBuffer.shift();
    const row = {
        timestamp: Date.now(),
        customer_id: entry.customer_id || null,
        action: entry.action || null,
        actionTier: entry.actionTier || null,
        riskLevel: entry.riskLevel || null,
        decision: entry.decision || null,
        step_up_type: entry.step_up_type || null,
        ruleId: entry.ruleId || null,
        reference_id: entry.reference_id || null,
        triggered_by: entry.triggered_by || null,
        original_reference_id: entry.original_reference_id || null
    };
    ringBuffer.push(row);
    // Persist to JSONL file — survives server restarts
    // To upgrade to Postgres: swap this line for pg.query('INSERT INTO decisions ...', [...])
    try { fs.appendFileSync(LOGFILE, JSON.stringify(row) + '\n'); } catch (_) {}
}

/**
 * Aggregate stats over the ring buffer.
 * @param {string|null} filterCustomerId - if set, only include entries for this customer
 */
function getStats(filterCustomerId = null) {
    const entries = filterCustomerId
        ? ringBuffer.filter(e => e.customer_id === filterCustomerId)
        : ringBuffer.slice();

    const total = entries.length;
    const decisionCounts = { ALLOW: 0, STEP_UP: 0, DENY: 0, MANUAL_REVIEW: 0 };
    const allowBreakdown = { direct: 0, after_step_up: 0, after_idv: 0, after_manual_review: 0 };
    const stepUpCounts = {};
    const perAction = {};
    const perRiskLevel = {};
    const ruleCounts = {};

    const DECISIONS = ['ALLOW', 'STEP_UP', 'DENY', 'MANUAL_REVIEW'];

    for (const e of entries) {
        const d = e.decision;
        if (d && decisionCounts.hasOwnProperty(d)) decisionCounts[d]++;

        // ALLOW breakdown: direct vs. post-challenge
        if (d === 'ALLOW') {
            if      (e.triggered_by === 'step_up_complete')       allowBreakdown.after_step_up++;
            else if (e.triggered_by === 'idv_webhook')             allowBreakdown.after_idv++;
            else if (e.triggered_by === 'manual_review_approved') allowBreakdown.after_manual_review++;
            else                                                   allowBreakdown.direct++;
        }

        if (e.step_up_type) {
            stepUpCounts[e.step_up_type] = (stepUpCounts[e.step_up_type] || 0) + 1;
        }

        if (e.action) {
            if (!perAction[e.action]) {
                perAction[e.action] = { tier: e.actionTier, ALLOW: 0, STEP_UP: 0, DENY: 0, MANUAL_REVIEW: 0 };
            }
            if (d && perAction[e.action].hasOwnProperty(d)) perAction[e.action][d]++;
        }

        if (e.riskLevel) {
            if (!perRiskLevel[e.riskLevel]) {
                perRiskLevel[e.riskLevel] = { ALLOW: 0, STEP_UP: 0, DENY: 0, MANUAL_REVIEW: 0 };
            }
            if (d && perRiskLevel[e.riskLevel].hasOwnProperty(d)) perRiskLevel[e.riskLevel][d]++;
        }

        if (e.ruleId) {
            ruleCounts[e.ruleId] = (ruleCounts[e.ruleId] || 0) + 1;
        }
    }

    const decisionPct = {};
    for (const [k, v] of Object.entries(decisionCounts)) {
        decisionPct[k] = total > 0 ? Math.round((v / total) * 100) : 0;
    }

    // Sort rule counts descending
    const sortedRuleCounts = Object.entries(ruleCounts)
        .sort(([, a], [, b]) => b - a)
        .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});

    return {
        total,
        filterCustomerId: filterCustomerId || null,
        decisionCounts,
        decisionPct,
        allowBreakdown,
        stepUpCounts,
        perAction,
        perRiskLevel,
        ruleCounts: sortedRuleCounts,
        lastUpdated: Date.now()
    };
}

/**
 * Clear all recorded decisions (for testing).
 */
function clear() {
    ringBuffer.length = 0;
}

module.exports = { record, getStats, clear };
