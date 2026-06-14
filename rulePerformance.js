// rulePerformance.js
// Per-rule performance metrics: fire rates, step-up completion, friction, dead/dormant detection.
// Primary: Postgres. Fallback: decisions.jsonl scan.

const fs   = require('fs');
const path = require('path');
const db   = require('./db');

let cachedStats  = null;
let cacheTime    = 0;
const CACHE_TTL  = 30 * 60 * 1000; // 30 minutes

function getPolicyRuleIds() {
    try {
        const raw = fs.readFileSync(path.join(__dirname, 'policies', 'decisions.json'), 'utf8');
        return (JSON.parse(raw).rules || []).map(r => r.id);
    } catch (_) { return []; }
}

function statusFor(fired, issued, completed, lastFiredAt, windowMs) {
    if (fired === 0) return 'dead';
    if (lastFiredAt && (Date.now() - lastFiredAt) > windowMs) return 'dormant';
    if (issued > 1 && (issued - completed) / issued > 0.5) return 'high_friction';
    return 'healthy';
}

async function computeFromPostgres(since, windowMs, policyRuleIds) {
    const result = await db.query(`
        SELECT
            rule_id,
            COUNT(*)       FILTER (WHERE outcome IS NULL)                        AS fired,
            COUNT(*)       FILTER (WHERE decision = 'STEP_UP' AND outcome IS NULL)    AS step_ups_issued,
            COUNT(*)       FILTER (WHERE decision = 'STEP_UP' AND outcome = 'APPROVED') AS step_ups_completed,
            COUNT(*)       FILTER (WHERE decision = 'STEP_UP' AND outcome = 'DENIED')   AS step_ups_denied,
            COUNT(*)       FILTER (WHERE decision = 'MANUAL_REVIEW' AND outcome IS NULL) AS manual_reviews,
            MAX(timestamp) FILTER (WHERE outcome IS NULL)                        AS last_fired_at
        FROM decisions
        WHERE timestamp > $1
        GROUP BY rule_id
    `, [since]);

    if (!result) return null;

    const statsMap = new Map();
    for (const row of result.rows) {
        const fired      = parseInt(row.fired, 10);
        const issued     = parseInt(row.step_ups_issued, 10);
        const completed  = parseInt(row.step_ups_completed, 10);
        const denied     = parseInt(row.step_ups_denied, 10);
        const manual     = parseInt(row.manual_reviews, 10);
        const lastFiredAt = row.last_fired_at ? parseInt(row.last_fired_at, 10) : null;

        statsMap.set(row.rule_id, {
            rule_id: row.rule_id || '(default)',
            fired,
            step_ups_issued:    issued,
            step_ups_completed: completed,
            step_ups_denied:    denied,
            manual_reviews:     manual,
            precision:          issued > 0 ? +(completed / issued).toFixed(3) : null,
            friction_rate:      issued > 0 ? +((issued - completed) / issued).toFixed(3) : null,
            last_fired_at:      lastFiredAt,
            status:             statusFor(fired, issued, completed, lastFiredAt, windowMs),
        });
    }

    // Add dead rules — in policy but zero DB records in window
    for (const ruleId of policyRuleIds) {
        if (!statsMap.has(ruleId)) {
            statsMap.set(ruleId, {
                rule_id: ruleId, fired: 0, step_ups_issued: 0, step_ups_completed: 0,
                step_ups_denied: 0, manual_reviews: 0,
                precision: null, friction_rate: null, last_fired_at: null, status: 'dead',
            });
        }
    }

    return Array.from(statsMap.values()).sort((a, b) => b.fired - a.fired);
}

function computeFromJsonl(since, windowMs, policyRuleIds) {
    const LOGFILE = path.join(__dirname, 'decisions.jsonl');
    if (!fs.existsSync(LOGFILE)) return [];

    const statsMap = new Map();
    const lines = fs.readFileSync(LOGFILE, 'utf8').split('\n').filter(Boolean);

    for (const line of lines) {
        try {
            const r = JSON.parse(line);
            if (r.timestamp < since) continue;
            const ruleId = r.ruleId || '(default)';
            if (!statsMap.has(ruleId)) {
                statsMap.set(ruleId, {
                    rule_id: ruleId, fired: 0, step_ups_issued: 0, step_ups_completed: 0,
                    step_ups_denied: 0, manual_reviews: 0, last_fired_at: null,
                });
            }
            const s = statsMap.get(ruleId);
            if (!r.outcome) {
                s.fired++;
                s.last_fired_at = Math.max(s.last_fired_at || 0, r.timestamp);
                if (r.decision === 'STEP_UP')       s.step_ups_issued++;
                if (r.decision === 'MANUAL_REVIEW') s.manual_reviews++;
            } else if (r.decision === 'STEP_UP') {
                if (r.outcome === 'APPROVED') s.step_ups_completed++;
                if (r.outcome === 'DENIED')   s.step_ups_denied++;
            }
        } catch (_) {}
    }

    for (const ruleId of policyRuleIds) {
        if (!statsMap.has(ruleId)) {
            statsMap.set(ruleId, {
                rule_id: ruleId, fired: 0, step_ups_issued: 0, step_ups_completed: 0,
                step_ups_denied: 0, manual_reviews: 0, last_fired_at: null,
            });
        }
    }

    return Array.from(statsMap.values()).map(s => ({
        ...s,
        precision:     s.step_ups_issued > 0 ? +(s.step_ups_completed / s.step_ups_issued).toFixed(3) : null,
        friction_rate: s.step_ups_issued > 0 ? +((s.step_ups_issued - s.step_ups_completed) / s.step_ups_issued).toFixed(3) : null,
        status:        statusFor(s.fired, s.step_ups_issued, s.step_ups_completed, s.last_fired_at, windowMs),
    })).sort((a, b) => b.fired - a.fired);
}

/**
 * Returns per-rule stats. Result is cached for 30 minutes.
 */
async function getRuleStats(windowHours = 48) {
    const now = Date.now();
    if (cachedStats && (now - cacheTime) < CACHE_TTL) return cachedStats;

    const windowMs   = windowHours * 3600000;
    const since      = now - windowMs;
    const ruleIds    = getPolicyRuleIds();

    let stats = null;
    if (db.isConfigured()) {
        stats = await computeFromPostgres(since, windowMs, ruleIds).catch(() => null);
    }
    if (!stats) {
        stats = computeFromJsonl(since, windowMs, ruleIds);
    }

    cachedStats = stats;
    cacheTime   = now;
    return stats;
}

function invalidateCache() {
    cachedStats = null;
    cacheTime   = 0;
}

module.exports = { getRuleStats, invalidateCache };
