// scripts/traffic-daemon.js
// Long-running traffic simulation daemon. Managed by PM2 as 'trust-traffic'.
// Fires realistic decision requests per persona schedule; runs attack scenarios periodically.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const personas = require('../data/personas.json').personas;
const attacks = require('./attack-scenarios');

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;
const API_KEY = process.env.TRAFFIC_DAEMON_API_KEY || null;
const ENABLE_ATTACKS = process.env.ENABLE_ATTACKS !== 'false';
const ATTACK_INTERVAL_MS = parseInt(process.env.ATTACK_INTERVAL_MS, 10) || 1800000;

const timers = new Set();
let shuttingDown = false;

function log(msg) {
    process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function jitter(ms) {
    return Math.round(ms * (0.8 + Math.random() * 0.4));
}

function isActiveHour(persona) {
    const h = new Date().getHours();
    return h >= persona.active_hours.start && h < persona.active_hours.end;
}

function isWeekend() {
    const d = new Date().getDay();
    return d === 0 || d === 6;
}

function weightedRandom(weights) {
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (const [key, weight] of Object.entries(weights)) {
        r -= weight;
        if (r <= 0) return key;
    }
    return Object.keys(weights)[0];
}

function getInterval(persona) {
    const { min, max } = persona.request_interval_ms;
    let base = min + Math.random() * (max - min);
    if (!isActiveHour(persona)) base *= 10;
    if (isWeekend()) base *= 1.5;
    return jitter(base);
}

async function fireRequest(payload) {
    const headers = { 'Content-Type': 'application/json' };
    if (API_KEY) headers['X-API-Key'] = API_KEY;
    try {
        const res = await fetch(`${BASE_URL}/trust/decision`, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5000),
        });
        const data = await res.json();
        const tag = payload._scenario_tag ? ` [${payload._scenario_tag}]` : '';
        log(`${tag} ${payload.customer_id}/${payload.action} → ${data.decision || 'ERR'}`);
        return data;
    } catch (err) {
        if (!shuttingDown) {
            log(`Request failed (${payload.customer_id}/${payload.action}): ${err.message}`);
        }
        return null;
    }
}

function schedulePersona(persona) {
    if (shuttingDown) return;

    const action = weightedRandom(persona.action_weights);
    const deviceId = persona.device_ids[Math.floor(Math.random() * persona.device_ids.length)];

    fireRequest({ customer_id: persona.customer_id, action, device_id: deviceId }).catch(() => {});

    const ms = getInterval(persona);
    const t = setTimeout(() => schedulePersona(persona), ms);
    timers.add(t);
}

async function fireScenario(scenarioFn) {
    const payloads = scenarioFn(personas);
    for (const payload of payloads) {
        if (shuttingDown) break;
        await fireRequest(payload);
        await new Promise(r => setTimeout(r, 150 + Math.random() * 350));
    }
}

function scheduleAttacks() {
    if (!ENABLE_ATTACKS) {
        log('Attack scenarios disabled (ENABLE_ATTACKS=false)');
        return;
    }

    const csTimer = setInterval(async () => {
        if (shuttingDown) return;
        log('Attack scenario: credentialStuffing');
        await fireScenario(attacks.credentialStuffing);
    }, ATTACK_INTERVAL_MS);
    timers.add(csTimer);

    const atoTimer = setInterval(async () => {
        if (shuttingDown) return;
        log('Attack scenario: accountTakeover');
        await fireScenario(attacks.accountTakeover);
    }, ATTACK_INTERVAL_MS * 4);
    timers.add(atoTimer);

    log(`Attack schedules: credentialStuffing every ${ATTACK_INTERVAL_MS / 60000}m, ATO every ${(ATTACK_INTERVAL_MS * 4) / 60000}m`);
}

async function waitForServer(maxAttempts = 12) {
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const res = await fetch(`${BASE_URL}/status`, { signal: AbortSignal.timeout(2000) });
            if (res.ok) return true;
        } catch (_) {}
        log(`Waiting for server at ${BASE_URL} (attempt ${i + 1}/${maxAttempts})…`);
        await new Promise(r => setTimeout(r, 10000));
    }
    return false;
}

function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    log('Shutting down — clearing all timers');
    for (const t of timers) clearTimeout(t);
    timers.clear();
    process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function main() {
    log(`Traffic daemon starting — ${personas.length} personas loaded`);
    log(`Target: ${BASE_URL}  |  API key: ${API_KEY ? 'set' : 'none'}`);

    const ok = await waitForServer();
    if (!ok) {
        log('ERROR: Trust server unreachable after all retries. Exiting.');
        process.exit(1);
    }

    log('Server reachable. Starting persona traffic…');

    // Stagger startup: 500ms between personas to avoid burst on launch
    for (let i = 0; i < personas.length; i++) {
        const persona = personas[i];
        const delay = i * 500 + Math.random() * 500;
        const t = setTimeout(() => schedulePersona(persona), delay);
        timers.add(t);
    }

    scheduleAttacks();
    log(`Daemon running. ${personas.length} personas active. Attacks: ${ENABLE_ATTACKS ? 'enabled' : 'disabled'}.`);
}

main().catch(err => {
    log(`FATAL: ${err.message}`);
    process.exit(1);
});
