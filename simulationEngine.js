// simulationEngine.js
/**
 * Policy simulation: replays historical decisions against a proposed
 * decisions.json and reports the impact before anything goes live.
 *
 * Replay source: decisions.jsonl records that carry a `replay` signal snapshot
 * (fraudScore, deviceScore, geography, current_auth_level, velocity captured
 * at decision time). Records without a snapshot are skipped — re-looking up
 * scores from the store would silently drift from what the customer actually
 * looked like when the decision was made.
 *
 * Comparison is policy-vs-policy on identical contexts: each record's context
 * is rebuilt once, then evaluated against both the current and the proposed
 * config. The logged decision is not used as the baseline, so confidence-policy
 * drift or data changes since logging don't pollute the delta.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { computeContext } = require('./confidenceEngine');
const policyEngine = require('./policyEngine');
const store = require('./data/store');
const db = require('./db');

const LOGFILE = path.join(__dirname, 'decisions.jsonl');
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;
const SAMPLE_CAP = 20;

/** Policy ALLOW is presented as FRICTIONLESS everywhere outside the policy layer. */
function displayDecision(d) {
    return d === 'ALLOW' ? 'FRICTIONLESS' : d;
}

/**
 * Returns the last `limit` replayable records (primary decisions with a replay snapshot).
 * Queries Postgres when configured; streams decisions.jsonl otherwise.
 */
async function loadReplayableHistory(limit) {
    if (db.isConfigured()) {
        const result = await db.query(
            `SELECT timestamp, customer_id, action, replay
             FROM decisions
             WHERE outcome IS NULL AND replay IS NOT NULL
             ORDER BY timestamp DESC
             LIMIT $1`,
            [limit]
        );
        if (result && result.rows) {
            // Return in ascending order so simulation processes oldest first
            const records = result.rows.reverse().map(r => ({
                timestamp: parseInt(r.timestamp, 10),
                customer_id: r.customer_id,
                action: r.action,
                replay: r.replay, // pg parses JSONB automatically
            }));
            return { records, scanned: records.length, skipped: 0 };
        }
        return { records: [], scanned: 0, skipped: 0 };
    }

    // JSONL fallback
    if (!fs.existsSync(LOGFILE)) return { records: [], scanned: 0, skipped: 0 };

    const records = [];
    let scanned = 0;
    let skipped = 0;

    const rl = readline.createInterface({
        input: fs.createReadStream(LOGFILE, 'utf8'),
        crlfDelay: Infinity
    });

    for await (const line of rl) {
        if (!line.trim()) continue;
        scanned++;
        let row;
        try { row = JSON.parse(line); } catch (_) { skipped++; continue; }
        if (row.outcome != null || !row.replay) { skipped++; continue; }
        records.push(row);
        if (records.length > limit) records.shift();
    }

    return { records, scanned, skipped };
}

/**
 * Runs the simulation.
 * @param {object} proposedConfig - full decisions config ({ rules, default, ... })
 * @param {object} [opts]
 * @param {number} [opts.limit] - max records to replay (default 1000, cap 5000)
 * @param {object} [opts.baselineConfig] - override baseline (defaults to live decisions.json)
 * @returns simulation report
 */
async function simulate(proposedConfig, opts = {}) {
    const validation = policyEngine.validateDecisionsConfig(proposedConfig);
    if (!validation.valid) {
        const err = new Error('Proposed policy failed validation');
        err.validationErrors = validation.errors;
        err.statusCode = 400;
        throw err;
    }

    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const baselineConfig = opts.baselineConfig || policyEngine.loadPolicies();

    const [{ records, scanned, skipped }, actions, authenticators] = await Promise.all([
        loadReplayableHistory(limit),
        store.getActions(),
        store.getAuthenticators()
    ]);

    const actionsById = new Map((actions || []).map(a => [a.id, a]));
    const authsById = new Map((authenticators || []).map(a => [a.id, a]));

    const mixBefore = {};
    const mixAfter = {};
    const ruleCountsBefore = {};
    const ruleCountsAfter = {};
    const transitions = {};          // "STEP_UP → FRICTIONLESS": count
    const changedSamples = [];
    let changedCount = 0;

    for (const row of records) {
        const r = row.replay;
        const actionInfo = actionsById.get(row.action) || null;
        const authenticatorInfo = r.current_auth_level ? (authsById.get(r.current_auth_level) || null) : null;

        const context = computeContext({
            fraudScore: r.fraudScore,
            deviceScore: r.deviceScore,
            geography: r.geography,
            actionInfo,
            authenticatorInfo,
            currentAuthLevel: r.current_auth_level,
            velocity: r.velocity,
            enrichment: r.enrichment || null,
        });

        const before = policyEngine.evaluateWith(baselineConfig, context);
        const after = policyEngine.evaluateWith(proposedConfig, context);

        const beforeDecision = displayDecision(before.decision);
        const afterDecision = displayDecision(after.decision);

        mixBefore[beforeDecision] = (mixBefore[beforeDecision] || 0) + 1;
        mixAfter[afterDecision] = (mixAfter[afterDecision] || 0) + 1;
        const beforeRule = before.ruleId || '(default)';
        const afterRule = after.ruleId || '(default)';
        ruleCountsBefore[beforeRule] = (ruleCountsBefore[beforeRule] || 0) + 1;
        ruleCountsAfter[afterRule] = (ruleCountsAfter[afterRule] || 0) + 1;

        const changed = beforeDecision !== afterDecision
            || (before.step_up_type || null) !== (after.step_up_type || null);

        if (changed) {
            changedCount++;
            const key = `${beforeDecision} → ${afterDecision}`;
            transitions[key] = (transitions[key] || 0) + 1;
            if (changedSamples.length < SAMPLE_CAP) {
                changedSamples.push({
                    timestamp: row.timestamp,
                    customer_id: row.customer_id,
                    action: row.action,
                    actionTier: context.actionTier,
                    riskLevel: context.riskLevel,
                    fraudScore: context.fraudScore,
                    deviceScore: context.deviceScore,
                    before: { decision: beforeDecision, step_up_type: before.step_up_type || null, ruleId: before.ruleId },
                    after: { decision: afterDecision, step_up_type: after.step_up_type || null, ruleId: after.ruleId }
                });
            }
        }
    }

    const total = records.length;
    const pct = counts => {
        const out = {};
        for (const [k, v] of Object.entries(counts)) {
            out[k] = total > 0 ? Math.round((v / total) * 1000) / 10 : 0;
        }
        return out;
    };

    // Rules in the proposed config that never fired during replay
    const proposedRuleIds = (proposedConfig.rules || []).filter(r => r.enabled !== false).map(r => r.id);
    const neverFired = proposedRuleIds.filter(id => !ruleCountsAfter[id]);

    return {
        replayed: total,
        scanned,
        skipped_no_snapshot: skipped,
        changed: changedCount,
        changed_pct: total > 0 ? Math.round((changedCount / total) * 1000) / 10 : 0,
        decision_mix: {
            before: { counts: mixBefore, pct: pct(mixBefore) },
            after: { counts: mixAfter, pct: pct(mixAfter) }
        },
        transitions,
        rule_counts: { before: ruleCountsBefore, after: ruleCountsAfter },
        rules_never_fired: neverFired,
        changed_samples: changedSamples,
        note: total === 0
            ? 'No replayable history found. Decision records need a replay snapshot — generate traffic (scripts/generate-traffic.js) or make live decisions first.'
            : undefined
    };
}

module.exports = { simulate, loadReplayableHistory };
