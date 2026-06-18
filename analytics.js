// analytics.js
/**
 * In-memory ring buffer tracking the last 500 trust decisions.
 * Each decision is also appended to decisions.jsonl (fallback) and Postgres (when configured).
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const db = require('./db');

const analyticsEmitter = new EventEmitter();

const BUFFER_SIZE = 500;
const LOGFILE = path.join(__dirname, 'decisions.jsonl');
const ringBuffer = [];

const PG_INSERT = `
INSERT INTO decisions (
  timestamp, customer_id, action, action_tier, risk_level,
  decision, step_up_type, rule_id, reference_id, outcome,
  original_reference_id, caller_key_id, replay
)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
ON CONFLICT DO NOTHING
`;

/**
 * Record a completed decision.
 * @param {{ customer_id, action, actionTier, riskLevel, decision, step_up_type, ruleId, reference_id, triggered_by?, original_reference_id?, caller_key_id? }} entry
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
        outcome: entry.outcome || null,
        original_reference_id: entry.original_reference_id || null,
        caller_key_id: entry.caller_key_id || null,
        replay: entry.replay || null,
    };
    ringBuffer.push(row);
    analyticsEmitter.emit('decision', row);

    // Primary write: JSONL survives restarts and is the simulation replay source
    try { fs.appendFileSync(LOGFILE, JSON.stringify(row) + '\n'); } catch (_) {}

    // Dual-write to Postgres (fire-and-forget — JSONL is the authoritative fallback)
    if (db.isConfigured()) {
        db.query(PG_INSERT, [
            row.timestamp, row.customer_id, row.action, row.actionTier, row.riskLevel,
            row.decision, row.step_up_type, row.ruleId, row.reference_id, row.outcome,
            row.original_reference_id, row.caller_key_id,
            row.replay !== null ? JSON.stringify(row.replay) : null,
        ]).catch(() => {});
    }
}

/**
 * Paginated decision log. Uses Postgres when configured, JSONL otherwise.
 */
const ALLOWED_ENRICHMENT_SIGNALS = new Set([
    'is_tor', 'is_vpn', 'is_proxy', 'is_hosting', 'is_new_device',
    'email_breached', 'is_greynoise_bot',
]);

async function getDecisions({ limit = 100, offset = 0, customerFilter = null, decisionFilter = null, ruleFilter = null, riskFilter = null, enrichmentSignal = null } = {}) {
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

    if (db.isConfigured()) {
        const conditions = [];
        const countParams = [];
        if (customerFilter) {
            countParams.push(customerFilter);
            conditions.push(`customer_id = $${countParams.length}`);
        }
        if (decisionFilter) {
            countParams.push(decisionFilter);
            conditions.push(`decision = $${countParams.length}`);
        }
        if (ruleFilter) {
            countParams.push(ruleFilter);
            conditions.push(`rule_id = $${countParams.length}`);
        }
        if (riskFilter) {
            countParams.push(riskFilter);
            conditions.push(`risk_level = $${countParams.length}`);
        }
        if (enrichmentSignal && ALLOWED_ENRICHMENT_SIGNALS.has(enrichmentSignal)) {
            // replay is stored as JSON text; cast to jsonb for field access
            conditions.push(`(replay::jsonb)->'enrichment'->>'${enrichmentSignal}' = 'true'`);
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const queryParams = [...countParams, safeLimit, safeOffset];
        const limitIdx = countParams.length + 1;
        const offsetIdx = countParams.length + 2;

        const [countResult, rowResult] = await Promise.all([
            db.query(`SELECT COUNT(*)::int AS total FROM decisions ${where}`, countParams),
            db.query(
                `SELECT * FROM decisions ${where} ORDER BY timestamp DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
                queryParams
            ),
        ]);

        const total = countResult ? parseInt(countResult.rows[0].total, 10) : 0;
        const decisions = rowResult
            ? rowResult.rows.map(r => ({
                timestamp: parseInt(r.timestamp, 10),
                customer_id: r.customer_id,
                action: r.action,
                actionTier: r.action_tier,
                riskLevel: r.risk_level,
                decision: r.decision,
                step_up_type: r.step_up_type,
                ruleId: r.rule_id,
                reference_id: r.reference_id,
                outcome: r.outcome,
                original_reference_id: r.original_reference_id,
                caller_key_id: r.caller_key_id,
                replay: r.replay,
            }))
            : [];
        return { total, decisions };
    }

    // JSONL fallback
    if (!fs.existsSync(LOGFILE)) return { total: 0, decisions: [] };
    const lines = fs.readFileSync(LOGFILE, 'utf8').split('\n').filter(Boolean);
    let rows = lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    if (customerFilter) rows = rows.filter(r => r.customer_id === customerFilter);
    if (decisionFilter) rows = rows.filter(r => r.decision === decisionFilter);
    if (ruleFilter) rows = rows.filter(r => r.ruleId === ruleFilter || r.rule_id === ruleFilter);
    if (riskFilter) rows = rows.filter(r => r.riskLevel === riskFilter || r.risk_level === riskFilter);
    if (enrichmentSignal && ALLOWED_ENRICHMENT_SIGNALS.has(enrichmentSignal))
        rows = rows.filter(r => r.replay?.enrichment?.[enrichmentSignal] === true);
    rows.reverse();
    return { total: rows.length, decisions: rows.slice(safeOffset, safeOffset + safeLimit) };
}

/**
 * Aggregate stats over the ring buffer.
 */
function getStats(filterCustomerId = null) {
    const entries = filterCustomerId
        ? ringBuffer.filter(e => e.customer_id === filterCustomerId)
        : ringBuffer.slice();

    const decisionCounts  = { FRICTIONLESS: 0, STEP_UP: 0, DENY: 0, MANUAL_REVIEW: 0 };
    const stepUpOutcomes  = { APPROVED: 0, DENIED: 0, EXPIRED: 0 };
    const reviewOutcomes  = { APPROVED: 0, DENIED: 0, ESCALATED: 0, EXPIRED: 0 };
    const stepUpCounts = {};
    const perAction = {};
    const perRiskLevel = {};
    const ruleCounts = {};

    for (const e of entries) {
        const d = e.decision;

        if (e.outcome == null) {
            if (d && decisionCounts.hasOwnProperty(d)) decisionCounts[d]++;

            if (e.action) {
                if (!perAction[e.action]) {
                    perAction[e.action] = { tier: e.actionTier, FRICTIONLESS: 0, STEP_UP: 0, DENY: 0, MANUAL_REVIEW: 0 };
                }
                if (d && perAction[e.action].hasOwnProperty(d)) perAction[e.action][d]++;
            }

            if (e.riskLevel) {
                if (!perRiskLevel[e.riskLevel]) {
                    perRiskLevel[e.riskLevel] = { FRICTIONLESS: 0, STEP_UP: 0, DENY: 0, MANUAL_REVIEW: 0 };
                }
                if (d && perRiskLevel[e.riskLevel].hasOwnProperty(d)) perRiskLevel[e.riskLevel][d]++;
            }

            if (e.ruleId) {
                ruleCounts[e.ruleId] = (ruleCounts[e.ruleId] || 0) + 1;
            }
        } else {
            if (d === 'STEP_UP'       && stepUpOutcomes.hasOwnProperty(e.outcome))  stepUpOutcomes[e.outcome]++;
            if (d === 'MANUAL_REVIEW' && reviewOutcomes.hasOwnProperty(e.outcome))  reviewOutcomes[e.outcome]++;
        }

        if (e.step_up_type) {
            stepUpCounts[e.step_up_type] = (stepUpCounts[e.step_up_type] || 0) + 1;
        }
    }

    const total = entries.filter(e => e.outcome == null).length;
    const decisionPct = {};
    for (const [k, v] of Object.entries(decisionCounts)) {
        decisionPct[k] = total > 0 ? Math.round((v / total) * 100) : 0;
    }

    const sortedRuleCounts = Object.entries(ruleCounts)
        .sort(([, a], [, b]) => b - a)
        .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});

    return {
        total,
        filterCustomerId: filterCustomerId || null,
        decisionCounts,
        decisionPct,
        stepUpOutcomes,
        reviewOutcomes,
        stepUpCounts,
        perAction,
        perRiskLevel,
        ruleCounts: sortedRuleCounts,
        lastUpdated: Date.now()
    };
}

function clear() {
    ringBuffer.length = 0;
}

module.exports = { record, getStats, getDecisions, clear, analyticsEmitter };
