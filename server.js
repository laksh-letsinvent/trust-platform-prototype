// server.js

const express = require('express');
const fs = require('fs');
const path = require('path');

const { getDecision } = require('./decisionEngine');
const cache = require('./cache');
const store = require('./data/store');
const analytics = require('./analytics');
const confidenceEngine = require('./confidenceEngine');
const policyEngine = require('./policyEngine');
const idvRouting = require('./idvRouting');
const velocityEngine = require('./velocityEngine');

// Sheets is optional — only used for sync
let sheets = null;
try { sheets = require('./data/sheets'); } catch (_) {}

const app = express();
const PORT = process.env.PORT || 3000;

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

app.post('/trust/decision', async (req, res) => {
    const { customer_id, action, device_id, current_auth_level } = req.body;
    if (!customer_id || !action || !device_id) {
        return res.status(400).json({ error: 'Missing required fields: customer_id, action, device_id' });
    }
    try {
        const result = await getDecision({ customer_id, action, device_id, current_auth_level });
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

app.get('/decisions', (req, res) => {
    const logFile = path.join(__dirname, 'decisions.jsonl');
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const offset = parseInt(req.query.offset) || 0;
    const filterCustomer = req.query.customer_id || null;
    const filterDecision = req.query.decision || null;

    try {
        if (!fs.existsSync(logFile)) return res.json({ total: 0, decisions: [] });
        const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
        let rows = lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
        if (filterCustomer) rows = rows.filter(r => r.customer_id === filterCustomer);
        if (filterDecision) rows = rows.filter(r => r.decision === filterDecision);
        // Most recent first
        rows.reverse();
        const total = rows.length;
        const decisions = rows.slice(offset, offset + limit);
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

app.patch('/policies/confidence', async (req, res) => {
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

        writePolicyFile('confidence.json', merged);
        confidenceEngine.clearCache();

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

app.patch('/policies/decisions', async (req, res) => {
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

        writePolicyFile('decisions.json', merged);
        policyEngine.clearCache();

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

app.patch('/policies/idvRouting', async (req, res) => {
    try {
        const current = readPolicyFile('idvRouting.json');
        const merged = deepMerge(current, req.body);
        writePolicyFile('idvRouting.json', merged);
        idvRouting.clearCache();
        res.json({ ok: true, policy: merged });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Velocity toggle ─────────────────────────────────────────────────────────

app.post('/policies/velocity-toggle', (req, res) => {
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
        res.json({ ok: true, velocityEnabled: enabled });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── System status ───────────────────────────────────────────────────────────

app.get('/status', (req, res) => {
    res.json({
        redis: cache.cacheAvailable,
        velocityTracking: velocityEngine.isAvailable(),
        sheetsConfigured: sheets ? sheets.isConfigured() : false
    });
});

// ─── Start ───────────────────────────────────────────────────────────────────

async function start() {
    await cache.connect();
    app.listen(PORT, () => {
        console.log(`Trust Decision server running at http://localhost:${PORT}`);
        console.log(`Redis cache: ${cache.cacheAvailable ? 'enabled' : 'disabled (no Redis)'}`);
        console.log(`Velocity tracking: ${velocityEngine.isAvailable() ? 'active' : 'inactive (no Redis)'}`);
        if (sheets) console.log(`Google Sheets: ${sheets.isConfigured() ? 'configured' : 'not configured'}`);
    });
}

start().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
