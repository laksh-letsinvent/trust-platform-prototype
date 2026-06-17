// abExperiment.js — In-memory A/B experiment framework.
// State is operator-session scoped; intentionally clears on server restart.

const crypto = require('crypto');

let active = null;

// Deterministic bucketing: same customerId always lands in the same variant.
function assignVariant(customerId, experimentId, splitPct = 50) {
    const hash = crypto.createHash('md5').update(`${experimentId}:${customerId}`).digest('hex');
    const bucket = parseInt(hash.slice(0, 8), 16) % 100;
    return bucket < splitPct ? 'treatment' : 'control';
}

function getActiveExperiment() {
    return active;
}

function setExperiment({ id, name, treatmentConfig, splitPct = 50 }) {
    active = { id, name, treatmentConfig, splitPct, startedAt: Date.now() };
}

function clearExperiment() {
    active = null;
}

module.exports = { assignVariant, getActiveExperiment, setExperiment, clearExperiment };
