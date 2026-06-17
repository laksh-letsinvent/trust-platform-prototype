// ambientTrustStore.js — Redis-backed Ambient Trust Score (ATS) per customer.
// Score 0–100; new customers default to 50. Ephemeral — no Postgres table.

const cache = require('./cache');

const KEY = cid => `ats:${cid}`;
const HIST_KEY = cid => `ats_hist:${cid}`;
const DEFAULT = 50;
const MAX = 95;
const MIN = 5;
const DECAY = 2; // points per day toward baseline 50

const SUCCESS_DELTA = { AL1: 2, AL2: 3, AL3: 5, AL4: 8 };
const SUSPICION_DELTA = { new_device: -10, vpn_detected: -5, breach_detected: -15, velocity_burst: -20 };

function c() { return cache.getClient(); }

async function getScore(customerId) {
    const cl = c();
    if (!cl) return DEFAULT;
    try {
        const v = await cl.hGet(KEY(customerId), 'score');
        const n = parseFloat(v);
        return isNaN(n) ? DEFAULT : Math.round(n);
    } catch { return DEFAULT; }
}

async function getHistory(customerId) {
    const cl = c();
    if (!cl) return [];
    try {
        const items = await cl.lRange(HIST_KEY(customerId), 0, 9);
        return items.map(i => { try { return JSON.parse(i); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
}

async function _pushHist(customerId, entry) {
    const cl = c();
    if (!cl) return;
    try {
        await cl.lPush(HIST_KEY(customerId), JSON.stringify(entry));
        await cl.lTrim(HIST_KEY(customerId), 0, 9);
    } catch {}
}

async function recordSuccess(customerId, authLevel) {
    const cl = c();
    if (!cl) return;
    try {
        const delta = SUCCESS_DELTA[authLevel] ?? 2;
        const current = await getScore(customerId);
        const next = Math.min(MAX, current + delta);
        await cl.hSet(KEY(customerId), 'score', String(next));
        await _pushHist(customerId, { type: 'success', authLevel, delta: `+${delta}`, ts: Date.now() });
    } catch {}
}

async function recordSuspicion(customerId, signalType) {
    const cl = c();
    if (!cl) return;
    try {
        const delta = SUSPICION_DELTA[signalType] ?? -5;
        const current = await getScore(customerId);
        const next = Math.max(MIN, current + delta);
        await cl.hSet(KEY(customerId), 'score', String(next));
        await _pushHist(customerId, { type: 'suspicion', signalType, delta: String(delta), ts: Date.now() });
    } catch {}
}

// Drift all scores toward baseline 50 at DECAY pts. Called every 6 hours via setInterval.
async function applyDecay() {
    const cl = c();
    if (!cl) return;
    try {
        let cursor = '0';
        do {
            const [next, keys] = await cl.scan(cursor, 'MATCH', 'ats:*', 'COUNT', 100);
            cursor = next;
            for (const key of keys) {
                const v = await cl.hGet(key, 'score');
                const score = parseFloat(v);
                if (isNaN(score)) continue;
                const diff = score - DEFAULT;
                if (Math.abs(diff) <= DECAY) {
                    await cl.hSet(key, 'score', String(DEFAULT));
                } else {
                    await cl.hSet(key, 'score', String(diff > 0 ? score - DECAY : score + DECAY));
                }
            }
        } while (cursor !== '0');
    } catch {}
}

module.exports = { getScore, getHistory, recordSuccess, recordSuspicion, applyDecay };
