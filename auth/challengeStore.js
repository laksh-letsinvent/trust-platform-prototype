'use strict';

const TTL_MS = 5 * 60 * 1000;
const _store = new Map();

function set(email, challenge) {
    _store.set(email, { challenge, expiresAt: Date.now() + TTL_MS });
    _gc();
}

function get(email) {
    const entry = _store.get(email);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { _store.delete(email); return null; }
    return entry.challenge;
}

function del(email) {
    _store.delete(email);
}

function _gc() {
    const now = Date.now();
    for (const [k, v] of _store) {
        if (now > v.expiresAt) _store.delete(k);
    }
}

module.exports = { set, get, del };
