// server.js
require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');

const { getDecision } = require('./decisionEngine');
const cache = require('./cache');
const db = require('./db');
const store = require('./data/store');
const analytics = require('./analytics');
const confidenceEngine = require('./confidenceEngine');
const policyEngine = require('./policyEngine');
const idvRouting = require('./idvRouting');
const velocityEngine = require('./velocityEngine');
const sessionStore = require('./sessionStore');
const apiKey = require('./middleware/apiKey');
const policyValidator = require('./policyValidator');

const { initAmplitude, trackOutcome } = require('./amplitude');
const simulationEngine = require('./simulationEngine');
const copilot = require('./copilot');

// Sheets is optional — only used for sync
let sheets = null;
try { sheets = require('./data/sheets'); } catch (_) {}

const enrichmentOrchestrator = require('./adapters/enrichmentOrchestrator');
const attackScenarios = require('./scripts/attack-scenarios');
const policyVersioning = require('./policyVersioning');
const rulePerformance = require('./rulePerformance');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── SSE clients ─────────────────────────────────────────────────────────────
const sseClients = new Map();
const MAX_SSE_CLIENTS = 20;

const ATTACK_TRIGGERS_ENABLED =
    process.env.ENABLE_ATTACK_TRIGGERS === 'true' || process.env.NODE_ENV !== 'production';

app.set('trust proxy', 1); // trust Caddy/nginx forwarded IP
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Utility ───────────────────────────────────────────────────────────────

function deepMerge(target, source) {
    const result = Object.assign({}, target);
    for (const [k, v] of Object.entries(source)) {
        if (v !== null && typeof v === 'object' && !Array.isArray(v) && typeof result[k] === 'object' && result[k] !== null) {
            result[k] = deepMerge(result[k], v);
        } else {
            result[k] = v;
        }
    }
    return result;
}

function readPolicyFile(name) {
    const filePath = path.join(__dirname, 'policies', name);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writePolicyFile(name, data) {
    const filePath = path.join(__dirname, 'policies', name);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function maybeSyncToSheets(policy, req) {
    const shouldSync = req.query.sync_sheets === 'true';
    if (!shouldSync || !sheets || !sheets.isConfigured()) return null;
    try {
        await sheets.writeConfidencePolicy(policy);
        return { synced: true };
    } catch (err) {
        console.warn('Sheets sync failed:', err.message);
        return { synced: false, sheetsWriteError: err.message };
    }
}

// ─── Data endpoints ─────────────────────────────────────────────────────────

app.get('/data/users', async (req, res) => {
    try { res.json({ users: await store.getUsers() }); }
    catch (err) { res.status(500).json({ error: 'Failed to load users.' }); }
});

app.get('/data/devices', async (req, res) => {
    try { res.json({ devices: await store.getDevices() }); }
    catch (err) { res.status(500).json({ error: 'Failed to load devices.' }); }
});

app.get('/data/actions', async (req, res) => {
    try { res.json({ actions: await store.getActions() }); }
    catch (err) { res.status(500).json({ error: 'Failed to load actions.' }); }
});

app.get('/data/authenticators', async (req, res) => {
    try { res.json({ authenticators: await store.getAuthenticators() }); }
    catch (err) { res.status(500).json({ error: 'Failed to load authenticators.' }); }
});

// ─── Trust decision ──────────────────────────────────────────────────────────

app.post('/trust/decision', apiKey, async (req, res) => {
    const { customer_id, action, device_id, current_auth_level } = req.body;
    if (!customer_id || !action || !device_id) {
        return res.status(400).json({ error: 'Missing required fields: customer_id, action, device_id' });
    }
    try {
        const result = await getDecision(
            { customer_id, action, device_id, current_auth_level, ip: req.ip || null },
            { callerKeyId: req.apiKeyId || null }
        );
        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Trust decision failed.' });
    }
});

// ─── Analytics ───────────────────────────────────────────────────────────────

app.get('/analytics', (req, res) => {
    const customerId = req.query.customer_id || null;
    res.json(analytics.getStats(customerId));
});

app.delete('/analytics', (req, res) => {
    analytics.clear();
    res.json({ ok: true, message: 'Analytics cleared.' });
});

// ─── Decision log (JSONL file) ────────────────────────────────────────────────

app.get('/decisions', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const offset = parseInt(req.query.offset) || 0;
    try {
        const { total, decisions } = await analytics.getDecisions({
            limit,
            offset,
            customerFilter: req.query.customer_id || null,
            decisionFilter: req.query.decision || null,
        });
        res.json({ total, limit, offset, decisions });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Policy: confidence ──────────────────────────────────────────────────────

app.get('/policies/confidence', (req, res) => {
    try { res.json(readPolicyFile('confidence.json')); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/policies/confidence', apiKey, async (req, res) => {
    try {
        const current = readPolicyFile('confidence.json');
        const merged = deepMerge(current, req.body);

        // Validate weights sum to 100
        const formula = merged.effectiveConfidence || {};
        if (formula.deviceWeight != null && formula.fraudWeight != null) {
            if (Math.abs(formula.deviceWeight + formula.fraudWeight - 100) > 0.01) {
                return res.status(400).json({ error: 'deviceWeight + fraudWeight must equal 100' });
            }
        }

        const { valid, errors } = policyValidator.validate('confidence', merged);
        if (!valid) return res.status(400).json({ error: 'Policy validation failed', validation_errors: errors });

        writePolicyFile('confidence.json', merged);
        confidenceEngine.clearCache();
        policyVersioning.saveVersion('confidence', merged, { author: req.apiKeyId || 'anonymous' }).catch(() => {});

        const sheetsResult = await maybeSyncToSheets(merged, req);
        res.json({ ok: true, policy: merged, ...(sheetsResult || {}) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Policy: decisions (rules) ───────────────────────────────────────────────

app.get('/policies/decisions', (req, res) => {
    try { res.json(readPolicyFile('decisions.json')); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/policies/decisions', apiKey, async (req, res) => {
    try {
        const current = readPolicyFile('decisions.json');

        // If body contains a rules array, merge by rule id (update enabled + any other field)
        if (Array.isArray(req.body.rules)) {
            const patchRulesById = {};
            for (const r of req.body.rules) {
                if (r.id) patchRulesById[r.id] = r;
            }
            current.rules = current.rules.map(rule => {
                const patch = patchRulesById[rule.id];
                return patch ? Object.assign({}, rule, patch) : rule;
            });
        }

        // Merge other top-level fields (version, description, default, etc.)
        const { rules: _patchRules, ...restPatch } = req.body;
        const merged = deepMerge(current, restPatch);
        if (Array.isArray(current.rules)) merged.rules = current.rules;

        const schemaCheck = policyValidator.validate('decisions', merged);
        if (!schemaCheck.valid) return res.status(400).json({ error: 'Policy validation failed', validation_errors: schemaCheck.errors });

        const semanticCheck = policyEngine.validateDecisionsConfig(merged);
        if (!semanticCheck.valid) return res.status(400).json({ error: 'Policy validation failed', validation_errors: semanticCheck.errors });

        writePolicyFile('decisions.json', merged);
        policyEngine.clearCache();
        rulePerformance.invalidateCache();
        policyVersioning.saveVersion('decisions', merged, { author: req.apiKeyId || 'anonymous' }).catch(() => {});

        res.json({ ok: true, policy: merged });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Policy: IDV routing ─────────────────────────────────────────────────────

app.get('/policies/idvRouting', (req, res) => {
    try { res.json(readPolicyFile('idvRouting.json')); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/policies/idvRouting', apiKey, async (req, res) => {
    try {
        const current = readPolicyFile('idvRouting.json');
        const merged = deepMerge(current, req.body);

        const { valid, errors } = policyValidator.validate('idvRouting', merged);
        if (!valid) return res.status(400).json({ error: 'Policy validation failed', validation_errors: errors });

        writePolicyFile('idvRouting.json', merged);
        idvRouting.clearCache();
        policyVersioning.saveVersion('idvRouting', merged, { author: req.apiKeyId || 'anonymous' }).catch(() => {});

        res.json({ ok: true, policy: merged });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Policy simulation ───────────────────────────────────────────────────────

/**
 * POST /policies/simulate
 * Body: { rules, default, ... }  — full proposed decisions config
 * Optional query: ?limit=500
 *
 * Replays recent decision history against the proposed config side-by-side with
 * the current live config and returns decision-mix before/after, transition
 * counts, per-rule firing rates, and up to 20 changed-decision samples.
 * Nothing is written to disk — this is purely read+compute.
 */
app.post('/policies/simulate', apiKey, async (req, res) => {
    try {
        const proposed = req.body;
        if (!proposed || typeof proposed !== 'object') {
            return res.status(400).json({ error: 'Body must be a decisions config object ({ rules, default })' });
        }
        const result = await simulationEngine.simulate(proposed, {
            limit: req.query.limit
        });
        res.json(result);
    } catch (err) {
        if (err.statusCode === 400) {
            return res.status(400).json({ error: err.message, validation_errors: err.validationErrors });
        }
        console.error('Simulation error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── AI Policy Copilot ───────────────────────────────────────────────────────

/**
 * POST /policies/copilot
 * Body: { intent: "deny medium risk customers on wire transfers" }
 * Optional: { insert_position: "top"|"bottom", simulation_limit: 500 }
 *
 * Returns: { rule, validation, simulation, note }
 * Nothing is written — publish separately via PATCH /policies/decisions.
 * Requires ANTHROPIC_API_KEY env var; returns 501 without it.
 */
app.post('/policies/copilot', apiKey, async (req, res) => {
    const { intent, insert_position, simulation_limit } = req.body || {};
    if (!intent) {
        return res.status(400).json({ error: 'Body must contain { intent: "..." }' });
    }
    try {
        const result = await copilot.suggest(intent, {
            insertPosition: insert_position,
            simulationLimit: simulation_limit
        });
        res.json(result);
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
        console.error('Copilot error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /policies/copilot/status
 * Returns whether the AI copilot is available (ANTHROPIC_API_KEY set).
 */
app.get('/policies/copilot/status', (req, res) => {
    res.json({ available: copilot.isAvailable() });
});

// ─── Velocity toggle ─────────────────────────────────────────────────────────

app.post('/policies/velocity-toggle', apiKey, (req, res) => {
    try {
        const { enabled } = req.body;
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ error: 'Body must contain { "enabled": true|false }' });
        }
        const current = readPolicyFile('decisions.json');
        const VELOCITY_RULE_IDS = ['deny_velocity_burst', 'manual_review_velocity_elevated'];
        current.rules = current.rules.map(rule =>
            VELOCITY_RULE_IDS.includes(rule.id) ? { ...rule, enabled } : rule
        );
        writePolicyFile('decisions.json', current);
        policyEngine.clearCache();
        rulePerformance.invalidateCache();
        policyVersioning.saveVersion('decisions', current, { author: req.apiKeyId || 'anonymous' }).catch(() => {});
        res.json({ ok: true, velocityEnabled: enabled });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Step-up completion ──────────────────────────────────────────────────────

app.post('/trust/step-up/complete', async (req, res) => {
    const { reference_id, completed_auth_level } = req.body;
    if (!reference_id || !completed_auth_level) {
        return res.status(400).json({ error: 'Missing required fields: reference_id, completed_auth_level' });
    }

    const session = await sessionStore.getSession(reference_id);
    if (!session) {
        return res.status(404).json({ error: 'Session not found. May have expired or never existed.' });
    }
    if (session.status === 'EXPIRED') {
        return res.status(410).json({ error: 'Session expired. Please request a new decision.' });
    }
    if (session.status === 'COMPLETED') {
        return res.status(409).json({ error: 'Step-up already completed.', final_decision: session.final_decision });
    }
    if (session.type !== 'STEP_UP') {
        return res.status(400).json({ error: `Session type is ${session.type}, not STEP_UP.` });
    }

    try {
        const result = await getDecision({
            customer_id: session.customer_id,
            action: session.action,
            device_id: session.device_id,
            current_auth_level: completed_auth_level
        }, { skipAnalytics: true });

        // The re-evaluation may return FRICTIONLESS (auth now sufficient) or DENY/STEP_UP.
        // The *transaction* was a STEP_UP — record outcome as subcategory, not a new primary.
        const stepOutcome = result.decision === 'FRICTIONLESS' ? 'APPROVED' : 'DENIED';

        analytics.record({
            customer_id: session.customer_id,
            action: session.action,
            decision: 'STEP_UP',
            outcome: stepOutcome,
            original_reference_id: reference_id,
        });

        if (stepOutcome === 'APPROVED') {
            store.addKnownDevice(session.customer_id, session.device_id).catch(() => {});
        }

        await sessionStore.updateSession(reference_id, {
            status: 'COMPLETED',
            completed_at: Date.now(),
            final_decision: 'STEP_UP',
            final_outcome: stepOutcome,
        });

        trackOutcome({
            customer_id: session.customer_id,
            action: session.action,
            decision: 'STEP_UP',
            outcome: stepOutcome,
            original_reference_id: reference_id,
        });

        return res.json({
            decision: 'STEP_UP',
            outcome: stepOutcome,
            reason: result.reason,
            original_reference_id: reference_id,
            trace: result.trace,
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Re-evaluation failed.' });
    }
});

// ─── Step-up status poll ─────────────────────────────────────────────────────

app.get('/trust/step-up/:reference_id/status', async (req, res) => {
    const session = await sessionStore.getSession(req.params.reference_id);
    if (!session) {
        return res.status(404).json({ error: 'Session not found.' });
    }
    return res.json({
        reference_id: session.reference_id,
        type: session.type,
        status: session.status,
        required_step_up_type: session.required_step_up_type,
        idv_vendor: session.idv_vendor,
        idv_session_id: session.idv_session_id,
        final_decision: session.final_decision,
        final_outcome: session.final_outcome,
        created_at: session.created_at,
        expires_at: session.expires_at,
        completed_at: session.completed_at,
    });
});

// ─── IDV vendor webhook ───────────────────────────────────────────────────────

app.post('/idv/webhook', async (req, res) => {
    const { session_id, vendor, result, fraud_score_update } = req.body;
    if (!session_id || !result) {
        return res.status(400).json({ error: 'Missing required fields: session_id, result' });
    }

    const session = await sessionStore.getSessionByIdvSessionId(session_id);
    if (!session) {
        return res.status(404).json({ error: 'IDV session not found.' });
    }
    if (session.status !== 'PENDING') {
        return res.status(409).json({ error: `Session already in status: ${session.status}` });
    }

    try {
        // Update fraud score if vendor provides one
        if (typeof fraud_score_update === 'number') {
            const clamped = Math.max(0, Math.min(100, fraud_score_update));
            // Update persistent store
            await store.updateUserFraudScore(session.customer_id, clamped);
            // Bust the Redis cache so next decision picks up the new score
            await cache.bustFraudScore(session.customer_id);
        }

        // Determine new auth level based on IDV result
        const idvOutcomeMap = { PASS: 'IDV', FAIL: null, REVIEW: null };
        const newAuthLevel = idvOutcomeMap[result] || null;

        if (result === 'PASS' && newAuthLevel) {
            const decision = await getDecision({
                customer_id: session.customer_id,
                action: session.action,
                device_id: session.device_id,
                current_auth_level: newAuthLevel
            }, { skipAnalytics: true });

            // Record lifecycle outcome as subcategory of the original STEP_UP
            analytics.record({
                customer_id: session.customer_id,
                action: session.action,
                decision: 'STEP_UP',
                outcome: decision.decision === 'FRICTIONLESS' ? 'APPROVED' : 'DENIED',
                original_reference_id: session.reference_id,
            });

            // The transaction was a STEP_UP — store outcome as subcategory, not FRICTIONLESS
            const idvOutcome = decision.decision === 'FRICTIONLESS' ? 'APPROVED' : 'DENIED';
            await sessionStore.updateSession(session.reference_id, {
                status: 'COMPLETED',
                completed_at: Date.now(),
                final_decision: 'STEP_UP',
                final_outcome: idvOutcome,
            });
            trackOutcome({
                customer_id: session.customer_id,
                action: session.action,
                decision: 'STEP_UP',
                outcome: idvOutcome,
                original_reference_id: session.reference_id,
            });
            if (idvOutcome === 'APPROVED') {
                store.addKnownDevice(session.customer_id, session.device_id).catch(() => {});
            }
            return res.json({ ok: true, reference_id: session.reference_id, result, decision: 'STEP_UP', outcome: idvOutcome });
        } else {
            // FAIL or REVIEW — mark as failed/pending review
            await sessionStore.updateSession(session.reference_id, {
                status: result === 'FAIL' ? 'FAILED' : 'PENDING',
                completed_at: result === 'FAIL' ? Date.now() : null,
                final_decision: result === 'FAIL' ? 'DENY' : null,
            });
            return res.json({ ok: true, reference_id: session.reference_id, result, decision: result === 'FAIL' ? 'DENY' : 'PENDING_REVIEW' });
        }
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'IDV callback processing failed.' });
    }
});

// ─── Manual review queue ──────────────────────────────────────────────────────

app.get('/trust/review/queue', (req, res) => {
    const pending = sessionStore.getPendingReviews();
    const all = sessionStore.getAllReviews();
    return res.json({
        pending_count: pending.length,
        pending: pending.map(s => ({
            reference_id: s.reference_id,
            customer_id: s.customer_id,
            action: s.action,
            device_id: s.device_id,
            signals: s.original_decision && s.original_decision.trace ? s.original_decision.trace.context : null,
            rule_id: s.original_decision && s.original_decision.trace && s.original_decision.trace.policy ? s.original_decision.trace.policy.ruleId : null,
            reason: s.original_decision ? s.original_decision.reason : null,
            created_at: s.created_at,
            expires_at: s.expires_at,
        })),
        all_reviews: all.map(s => ({
            reference_id: s.reference_id,
            status: s.status,
            customer_id: s.customer_id,
            action: s.action,
            final_decision: s.final_decision,
            reviewer_id: s.reviewer_id,
            notes: s.notes,
            created_at: s.created_at,
            completed_at: s.completed_at,
        })),
    });
});

// ─── Manual review feedback ───────────────────────────────────────────────────

app.post('/trust/review/:reference_id/feedback', async (req, res) => {
    const { reviewer_id, outcome, notes, fraud_score_override } = req.body;
    const { reference_id } = req.params;

    if (!reviewer_id || !outcome) {
        return res.status(400).json({ error: 'Missing required fields: reviewer_id, outcome' });
    }
    if (!['APPROVE', 'DENY', 'ESCALATE'].includes(outcome)) {
        return res.status(400).json({ error: 'outcome must be APPROVE, DENY, or ESCALATE' });
    }

    const session = await sessionStore.getSession(reference_id);
    if (!session) {
        return res.status(404).json({ error: 'Review case not found.' });
    }
    if (session.type !== 'MANUAL_REVIEW') {
        return res.status(400).json({ error: `Session type is ${session.type}, not MANUAL_REVIEW.` });
    }
    if (session.status !== 'PENDING') {
        return res.status(409).json({ error: `Case already actioned (status: ${session.status}).`, final_decision: session.final_decision });
    }

    try {
        // Apply fraud score override if provided
        if (typeof fraud_score_override === 'number') {
            const clamped = Math.max(0, Math.min(100, fraud_score_override));
            await store.updateUserFraudScore(session.customer_id, clamped);
            await cache.bustFraudScore(session.customer_id);
        }

        const final_decision = outcome === 'APPROVE' ? 'FRICTIONLESS' : outcome === 'DENY' ? 'DENY' : null;
        const newStatus = outcome === 'ESCALATE' ? 'PENDING' : 'COMPLETED';

        await sessionStore.updateSession(reference_id, {
            status: newStatus,
            completed_at: newStatus === 'COMPLETED' ? Date.now() : null,
            final_decision,
            reviewer_id,
            notes: notes || null,
            fraud_score_override: fraud_score_override ?? null,
        });

        // Record the review outcome as a lifecycle subcategory of MANUAL_REVIEW
        if (outcome === 'APPROVE' || outcome === 'DENY' || outcome === 'ESCALATE') {
            const origTrace = session.original_decision && session.original_decision.trace;
            const reviewOutcome = outcome === 'APPROVE' ? 'APPROVED' : outcome === 'DENY' ? 'DENIED' : 'ESCALATED';
            analytics.record({
                customer_id: session.customer_id,
                action: session.action,
                actionTier: origTrace && origTrace.context ? origTrace.context.actionTier : null,
                riskLevel: origTrace && origTrace.context ? origTrace.context.riskLevel : null,
                decision: 'MANUAL_REVIEW',
                outcome: reviewOutcome,
                ruleId: origTrace && origTrace.policy ? origTrace.policy.ruleId : null,
                original_reference_id: reference_id,
            });
            trackOutcome({
                customer_id: session.customer_id,
                action: session.action,
                decision: 'MANUAL_REVIEW',
                outcome: reviewOutcome,
                original_reference_id: reference_id,
                reviewer_id: reviewer_id || null,
            });
        }

        // Append to reviews.jsonl
        const reviewEntry = JSON.stringify({
            timestamp: Date.now(),
            reference_id,
            customer_id: session.customer_id,
            action: session.action,
            reviewer_id,
            outcome,
            notes: notes || null,
            fraud_score_override: fraud_score_override ?? null,
            final_decision,
        });
        fs.appendFileSync(path.join(__dirname, 'reviews.jsonl'), reviewEntry + '\n', 'utf8');

        return res.json({
            ok: true,
            reference_id,
            outcome,
            final_decision,
            reviewed_at: Date.now(),
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Review feedback failed.' });
    }
});

// ─── Server-Sent Events ──────────────────────────────────────────────────────

analytics.analyticsEmitter.on('decision', (row) => {
    const payload = `data: ${JSON.stringify(row)}\n\n`;
    for (const [, res] of sseClients) {
        try { res.write(payload); } catch (_) {}
    }
});

app.get('/events/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    // Enforce max client limit — drop the oldest connection if exceeded
    if (sseClients.size >= MAX_SSE_CLIENTS) {
        const [oldestId] = sseClients.keys();
        try { sseClients.get(oldestId).end(); } catch (_) {}
        sseClients.delete(oldestId);
    }

    const clientId = Date.now() + Math.random();
    sseClients.set(clientId, res);

    const heartbeat = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch (_) {}
    }, 15000);

    req.on('close', () => {
        sseClients.delete(clientId);
        clearInterval(heartbeat);
    });
});

// ─── Attack trigger (dev/demo only) ─────────────────────────────────────────

app.post('/dev/attack/:scenario', apiKey, async (req, res) => {
    if (!ATTACK_TRIGGERS_ENABLED) {
        return res.status(403).json({ error: 'Attack triggers disabled. Set ENABLE_ATTACK_TRIGGERS=true.' });
    }
    const { scenario } = req.params;
    if (!attackScenarios.SCENARIO_NAMES.includes(scenario)) {
        return res.status(400).json({ error: `Unknown scenario. Valid: ${attackScenarios.SCENARIO_NAMES.join(', ')}` });
    }

    const personas = (() => { try { return require('./data/personas.json').personas; } catch (_) { return []; } })();
    const payloads = attackScenarios[scenario](personas);

    // Fire asynchronously so the endpoint returns immediately
    setImmediate(async () => {
        for (const payload of payloads) {
            try {
                await getDecision(
                    { customer_id: payload.customer_id, action: payload.action, device_id: payload.device_id, ip: null },
                    { callerKeyId: 'attack-trigger' }
                );
            } catch (_) {}
            // Small gap between payloads to produce visible velocity signal
            await new Promise(r => setTimeout(r, 200));
        }
    });

    res.json({ ok: true, scenario, payloads_queued: payloads.length });
});

// ─── Policy versioning ───────────────────────────────────────────────────────

const VALID_POLICY_NAMES = ['decisions', 'confidence', 'idvRouting'];

app.get('/policies/:name/history', async (req, res) => {
    if (!VALID_POLICY_NAMES.includes(req.params.name)) return res.status(400).json({ error: 'Unknown policy' });
    const versions = await policyVersioning.getVersions(req.params.name, parseInt(req.query.limit) || 20);
    res.json({ policy_name: req.params.name, versions });
});

app.get('/policies/:name/history/:id', async (req, res) => {
    if (!VALID_POLICY_NAMES.includes(req.params.name)) return res.status(400).json({ error: 'Unknown policy' });
    const version = await policyVersioning.getVersion(req.params.name, req.params.id);
    if (!version) return res.status(404).json({ error: 'Version not found' });
    res.json(version);
});

app.post('/policies/:name/rollback/:id', apiKey, async (req, res) => {
    if (!VALID_POLICY_NAMES.includes(req.params.name)) return res.status(400).json({ error: 'Unknown policy' });
    try {
        const result = await policyVersioning.rollback(req.params.name, req.params.id, { author: req.apiKeyId || 'anonymous' });
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

app.get('/policies/:name/diff/:idA/:idB', async (req, res) => {
    if (!VALID_POLICY_NAMES.includes(req.params.name)) return res.status(400).json({ error: 'Unknown policy' });
    const [a, b] = await Promise.all([
        policyVersioning.getVersion(req.params.name, req.params.idA),
        policyVersioning.getVersion(req.params.name, req.params.idB),
    ]);
    if (!a || !b) return res.status(404).json({ error: 'One or both versions not found' });
    res.json({ policy_name: req.params.name, version_a: a.version_number, version_b: b.version_number,
               diff: policyVersioning.diffVersions(a.content, b.content) });
});

// ─── Policy draft / publish ───────────────────────────────────────────────────

const DRAFT_FILE = path.join(__dirname, 'policies', 'draft_decisions.json');

app.post('/policies/decisions/draft', apiKey, async (req, res) => {
    try {
        const proposed = req.body;
        const schemaCheck = policyValidator.validate('decisions', proposed);
        if (!schemaCheck.valid) return res.status(400).json({ error: 'Validation failed', validation_errors: schemaCheck.errors });
        const semanticCheck = policyEngine.validateDecisionsConfig(proposed);
        if (!semanticCheck.valid) return res.status(400).json({ error: 'Validation failed', validation_errors: semanticCheck.errors });
        fs.writeFileSync(DRAFT_FILE, JSON.stringify(proposed, null, 2) + '\n', 'utf8');
        res.json({ ok: true, message: 'Draft saved. Review via GET /policies/decisions/draft, then POST /policies/decisions/publish.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/policies/decisions/draft', (req, res) => {
    if (!fs.existsSync(DRAFT_FILE)) return res.json({ draft: null });
    try {
        const draft = JSON.parse(fs.readFileSync(DRAFT_FILE, 'utf8'));
        const live  = readPolicyFile('decisions.json');
        const diff  = policyVersioning.diffVersions(live, draft);
        res.json({ draft, diff });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/policies/decisions/publish', apiKey, async (req, res) => {
    if (!fs.existsSync(DRAFT_FILE)) return res.status(404).json({ error: 'No draft to publish' });
    try {
        const draft = JSON.parse(fs.readFileSync(DRAFT_FILE, 'utf8'));
        writePolicyFile('decisions.json', draft);
        policyEngine.clearCache();
        rulePerformance.invalidateCache();
        const simulationEngine = require('./simulationEngine');
        let simulationSummary = null;
        try {
            const sim = await simulationEngine.simulate(draft, { limit: 200 });
            simulationSummary = { total_replayed: sim.total_replayed, changed: sim.changed_count,
                                  decision_mix_after: sim.decision_mix && sim.decision_mix.after };
        } catch (_) {}
        await policyVersioning.saveVersion('decisions', draft, {
            author: req.apiKeyId || 'anonymous', simulationSummary
        });
        fs.unlinkSync(DRAFT_FILE);
        res.json({ ok: true, message: 'Draft published as live policy.', simulation_summary: simulationSummary });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/policies/decisions/draft', apiKey, (req, res) => {
    if (!fs.existsSync(DRAFT_FILE)) return res.json({ ok: true, message: 'No draft to delete' });
    try { fs.unlinkSync(DRAFT_FILE); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Rule performance ─────────────────────────────────────────────────────────

app.get('/analytics/rules', async (req, res) => {
    try {
        const windowHours = Math.min(parseInt(req.query.window) || 48, 168);
        const stats = await rulePerformance.getRuleStats(windowHours);
        res.json({ window_hours: windowHours, computed_at: Date.now(), rules: stats });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Decision explain (customer-facing) ──────────────────────────────────────

app.get('/trust/decision/explain/:reference_id', async (req, res) => {
    const { reference_id } = req.params;
    // Try session store first (works for recent decisions)
    const session = await sessionStore.getSession(reference_id);
    if (session && session.original_decision) {
        const d = session.original_decision;
        return res.json({
            reference_id,
            decision: d.decision,
            step_up_type: d.step_up_type || null,
            display_message: d.display_message || null,
            reason: d.reason || null,
            rule_id: d.trace && d.trace.policy ? d.trace.policy.ruleId : null,
            timestamp: session.created_at,
        });
    }
    // Fallback: Postgres lookup
    if (db.isConfigured()) {
        const result = await db.query(
            'SELECT rule_id, decision, step_up_type, timestamp FROM decisions WHERE reference_id = $1 LIMIT 1',
            [reference_id]
        ).catch(() => null);
        if (result && result.rows.length > 0) {
            const row = result.rows[0];
            // Best-effort: look up display_message from current policy
            let display_message = null;
            try {
                const policy = readPolicyFile('decisions.json');
                const rule = (policy.rules || []).find(r => r.id === row.rule_id);
                if (rule) display_message = rule.display_message || null;
            } catch (_) {}
            return res.json({
                reference_id,
                decision: row.decision,
                step_up_type: row.step_up_type || null,
                display_message,
                rule_id: row.rule_id,
                timestamp: parseInt(row.timestamp, 10),
                note: 'display_message sourced from current policy (session expired)',
            });
        }
    }
    return res.status(404).json({ error: 'Decision not found. Session may have expired.' });
});

// ─── System status ───────────────────────────────────────────────────────────

app.get('/status', (req, res) => {
    res.json({
        redis: cache.cacheAvailable,
        velocityTracking: velocityEngine.isAvailable(),
        sheetsConfigured: sheets ? sheets.isConfigured() : false,
        redis_status: velocityEngine.getStatus(),
        postgres_status: db.getStatus(),
        adapters: {
            ip_geolocation: true,        // ip-api.com — always available, no key needed
            greynoise:      true,        // GreyNoise community — no key needed
            abuse_ipdb:     !!process.env.ABUSEIPDB_API_KEY,
            hibp:           !!process.env.HIBP_API_KEY,
        },
        attackTriggersEnabled: ATTACK_TRIGGERS_ENABLED,
        sseClients: sseClients.size,
    });
});

// ─── Start ───────────────────────────────────────────────────────────────────

async function start() {
    await cache.connect();
    await db.init();
    await sessionStore.syncFromRedis();
    initAmplitude();

    // Validate all policy files on startup — warn but don't crash
    const POLICY_MAP = { decisions: 'decisions.json', confidence: 'confidence.json', idvRouting: 'idvRouting.json' };
    let allValid = true;
    for (const [name, file] of Object.entries(POLICY_MAP)) {
        try {
            const content = readPolicyFile(file);
            const { valid, errors } = policyValidator.validate(name, content);
            if (!valid) {
                console.warn(`⚠ Policy validation warning (${name}):`, errors);
                allValid = false;
            }
        } catch (err) {
            console.warn(`⚠ Could not validate policy ${name}:`, err.message);
        }
    }
    if (allValid) console.log('✓ All policies valid');

    // Background rule performance refresh every 30 minutes
    setInterval(() => rulePerformance.getRuleStats().catch(() => {}), 30 * 60 * 1000);

    app.listen(PORT, () => {
        console.log(`Trust Decision server running at http://localhost:${PORT}`);
        console.log(`Redis cache: ${cache.cacheAvailable ? 'enabled' : 'disabled (no Redis)'}`);
        console.log(`Velocity tracking: ${velocityEngine.isAvailable() ? 'active' : 'inactive (no Redis)'}`);
        console.log(`Postgres: ${db.isConfigured() ? (db.getStatus().connected ? 'connected' : 'configured but unavailable') : 'not configured (JSONL fallback)'}`);
        if (sheets) console.log(`Google Sheets: ${sheets.isConfigured() ? 'configured' : 'not configured'}`);
    });
}

start().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
