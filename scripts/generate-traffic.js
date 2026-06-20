#!/usr/bin/env node
/**
 * scripts/generate-traffic.js
 *
 * Seeds decisions.jsonl with synthetic but realistic traffic so the policy
 * simulation engine has meaningful history to replay.
 *
 * Usage:
 *   node scripts/generate-traffic.js               # 500 records (default)
 *   node scripts/generate-traffic.js --count 2000  # custom count
 *   node scripts/generate-traffic.js --wipe        # clear log first, then generate
 *   node scripts/generate-traffic.js --dry-run     # print sample, don't write
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LOGFILE = path.join(__dirname, '..', 'decisions.jsonl');

// ─── Synthetic personas ───────────────────────────────────────────────────────
const PERSONAS = [
    // LOW risk (most traffic)
    { customer_id: 'Lara',   fraud_score: 15, geography: 'UK', weight: 15 },
    { customer_id: 'Lenny',  fraud_score: 22, geography: 'UK', weight: 12 },
    { customer_id: 'Maxim',  fraud_score: 10, geography: 'UK', weight: 12 },
    { customer_id: 'Maddy',  fraud_score: 10, geography: 'DE', weight: 10 },
    // MEDIUM risk
    { customer_id: 'Jason',  fraud_score: 28, geography: 'DE', weight: 8 },
    { customer_id: 'Nikky',  fraud_score: 40, geography: 'DE', weight: 8 },
    { customer_id: 'Sam',    fraud_score: 55, geography: 'UK', weight: 6 },
    { customer_id: 'Priya',  fraud_score: 68, geography: 'UK', weight: 4 },
    // HIGH risk (rare)
    { customer_id: 'Harvey', fraud_score: 80, geography: 'UK', weight: 3 },
    { customer_id: 'Hitesh', fraud_score: 90, geography: 'UK', weight: 2 },
];

const ACTIONS = [
    { id: 'login',             name: 'Login',                      tier: 'Tier1', required_al: 'AL1', risk_ceiling: 85, weight: 25 },
    { id: 'balance_inquiry',   name: 'Balance inquiry',            tier: 'Tier1', required_al: 'AL1', risk_ceiling: 85, weight: 20 },
    { id: 'view_statements',   name: 'View statements',            tier: 'Tier1', required_al: 'AL1', risk_ceiling: 85, weight: 15 },
    { id: 'bill_pay',          name: 'Bill pay',                   tier: 'Tier2', required_al: 'AL2', risk_ceiling: 70, weight: 12 },
    { id: 'p2p_send',          name: 'P2P / Pay to new person',   tier: 'Tier2', required_al: 'AL2', risk_ceiling: 70, weight: 10 },
    { id: 'internal_transfer', name: 'Internal transfer',          tier: 'Tier2', required_al: 'AL2', risk_ceiling: 70, weight: 8  },
    { id: 'wire_transfer',     name: 'Wire transfer (>10K)',       tier: 'Tier3', required_al: 'AL3', risk_ceiling: 55, weight: 5  },
    { id: 'large_transfer',    name: 'Transfer > £10K',           tier: 'Tier3', required_al: 'AL3', risk_ceiling: 55, weight: 3  },
    { id: 'change_password',   name: 'Change password / security', tier: 'Tier3', required_al: 'AL3', risk_ceiling: 55, weight: 4  },
    { id: 'account_recovery',  name: 'Account recovery',          tier: 'Tier4', required_al: 'AL4', risk_ceiling: 40, weight: 2  },
];

const DEVICES = [
    { device_id: 'Device1', device_score: 85, weight: 15 },
    { device_id: 'Device2', device_score: 90, weight: 15 },
    { device_id: 'Device3', device_score: 88, weight: 12 },
    { device_id: 'Device6', device_score: 82, weight: 12 },
    { device_id: 'Device4', device_score: 25, weight: 6  },
    { device_id: 'Device7', device_score: 20, weight: 5  },
    { device_id: 'Device5', device_score: 15, weight: 3  },
];

const AUTH_LEVELS = [
    { id: null,  weight: 10 },
    { id: 'AL1', weight: 30 },
    { id: 'AL2', weight: 35 },
    { id: 'AL3', weight: 20 },
    { id: 'AL4', weight: 5  },
];

// Ambient trust distribution per persona
const ATS_MAP = {
    Lara: 85, Lenny: 78, Maxim: 90, Maddy: 75,
    Jason: 55, Nikky: 48, Sam: 40, Priya: 35,
    Harvey: 25, Hitesh: 15,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function weighted(pool) {
    const total = pool.reduce((s, e) => s + e.weight, 0);
    let r = Math.random() * total;
    for (const e of pool) { r -= e.weight; if (r <= 0) return e; }
    return pool[pool.length - 1];
}

function jitter(ms) { return ms + Math.floor(Math.random() * ms * 0.2 - ms * 0.1); }

// ─── Risk engine imports ──────────────────────────────────────────────────────

const { computeRiskContext } = require('../riskEngine');
const policyEngine = require('../policyEngine');

const AL_ORDER = ['AL1', 'AL2', 'AL3', 'AL4'];

const AUTH_INFO = {
    AL1: { id: 'AL1', assurance_level: 'AL1' },
    AL2: { id: 'AL2', assurance_level: 'AL2' },
    AL3: { id: 'AL3', assurance_level: 'AL3' },
    AL4: { id: 'AL4', assurance_level: 'AL4' },
};

function prefixForDecision(d) {
    return { STEP_UP: 'TXN', MANUAL_REVIEW: 'CASE', DENY: 'INC' }[d] || null;
}

function generateRef(prefix, customerId, action) {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let n = (customerId + action + Date.now() + Math.random()).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    let code = '';
    for (let i = 0; i < 4; i++) { code += chars[n % chars.length]; n = Math.floor(n / chars.length) || n + 7; }
    return `${prefix}-${date}-${code}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const wipe   = args.includes('--wipe');
    const countArg = args[args.indexOf('--count') + 1];
    const targetCount = Math.min(Math.max(parseInt(countArg, 10) || 500, 1), 10000);

    console.log(`Generating ${targetCount} synthetic decisions${dryRun ? ' (dry run)' : ''}${wipe ? ' (wiping log first)' : ''}...`);

    const config = policyEngine.loadPolicies();

    const now = Date.now();
    const window = 7 * 24 * 60 * 60 * 1000;
    const interval = window / targetCount;

    const lines = [];

    for (let i = 0; i < targetCount; i++) {
        const persona    = weighted(PERSONAS);
        const action     = weighted(ACTIONS);
        const device     = weighted(DEVICES);
        const authEntry  = weighted(AUTH_LEVELS);
        const authLevel  = authEntry.id;
        const authenticatorInfo = authLevel ? AUTH_INFO[authLevel] : null;

        const fraudScore  = Math.min(100, Math.max(0, persona.fraud_score + Math.floor(Math.random() * 6 - 3)));
        const deviceScore = Math.min(100, Math.max(0, device.device_score + Math.floor(Math.random() * 10 - 5)));
        const ambientTrustScore = Math.min(100, Math.max(0, (ATS_MAP[persona.customer_id] ?? 50) + Math.floor(Math.random() * 10 - 5)));

        const context = computeRiskContext({
            fraudScore,
            deviceScore,
            ambientTrustScore,
            geography: persona.geography,
            actionInfo: action,
            authenticatorInfo,
            currentAuthLevel: authLevel,
            velocity: { velocity_1m: 0, velocity_5m: 0, velocity_15m: 0 },
            enrichment: null,
        });

        const policyResult = policyEngine.evaluateWith(config, context);
        const outputDecision = policyResult.decision === 'ALLOW' ? 'FRICTIONLESS' : policyResult.decision;

        const prefix = prefixForDecision(policyResult.decision);
        const reference_id = prefix ? generateRef(prefix, persona.customer_id, action.id) : null;
        const timestamp = now - window + jitter(interval * i + interval);

        const row = {
            timestamp,
            customer_id: persona.customer_id,
            action: action.id,
            actionTier: context.actionTier,
            riskLevel: context.riskLevel,
            decision: outputDecision,
            step_up_type: policyResult.step_up_type || null,
            ruleId: policyResult.ruleId || null,
            reference_id,
            outcome: null,
            original_reference_id: null,
            replay: {
                device_id: device.device_id,
                current_auth_level: authLevel,
                fraudScore,
                deviceScore,
                ambientTrustScore,
                geography: persona.geography,
                velocity: { velocity_1m: 0, velocity_5m: 0, velocity_15m: 0 },
                enrichment: null,
            }
        };

        lines.push(JSON.stringify(row));
    }

    if (dryRun) {
        console.log('\nSample (first 3):');
        lines.slice(0, 3).forEach(l => console.log(JSON.stringify(JSON.parse(l), null, 2)));
        console.log(`\nWould write ${lines.length} records to ${LOGFILE}`);
        return;
    }

    if (wipe && fs.existsSync(LOGFILE)) {
        fs.unlinkSync(LOGFILE);
        console.log('Wiped existing decisions.jsonl');
    }

    fs.appendFileSync(LOGFILE, lines.join('\n') + '\n', 'utf8');
    console.log(`✓ Wrote ${lines.length} records to ${LOGFILE}`);

    const counts = {};
    for (const l of lines) {
        const { decision } = JSON.parse(l);
        counts[decision] = (counts[decision] || 0) + 1;
    }
    console.log('\nDecision mix in generated traffic:');
    for (const [k, v] of Object.entries(counts)) {
        console.log(`  ${k}: ${v} (${Math.round(v / lines.length * 100)}%)`);
    }
}

main().catch(err => { console.error(err); process.exit(1); });
