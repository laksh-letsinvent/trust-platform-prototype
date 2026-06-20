'use strict';

const fs   = require('fs');
const path = require('path');
const store = require('../data/store');

const CRED_PATH = path.join(__dirname, '../data/credentials.json');

function _load() {
    try {
        return JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
    } catch {
        return { users: {} };
    }
}

function _save(data) {
    fs.writeFileSync(CRED_PATH, JSON.stringify(data, null, 2));
}

async function getByEmail(email) {
    const data = _load();
    let cred = data.users[email] || null;

    // Resolve customer_id from users.json
    const appUser = await store.getUserByEmail(email);
    if (cred) {
        if (appUser) {
            cred.customer_id = appUser.customer_id;
            cred.fraud_score = appUser.fraud_score;
        }
        return cred;
    }

    if (appUser) {
        // Known app user but no credential record yet — create one
        const record = {
            customer_id: appUser.customer_id,
            email,
            passkeys: [],
            passcode_hash: null,
            magic_token_hash: null,
            magic_token_expires: null,
        };
        data.users[email] = record;
        _save(data);
        return { ...record, fraud_score: appUser.fraud_score };
    }

    return null;
}

async function upsertUser(email, patch) {
    const data = _load();
    const existing = data.users[email] || {
        customer_id: null,
        email,
        passkeys: [],
        passcode_hash: null,
        magic_token_hash: null,
        magic_token_expires: null,
    };
    data.users[email] = { ...existing, ...patch };
    _save(data);

    // Ensure entry exists in users.json too
    const appUser = await store.getUserByEmail(email);
    if (!appUser && data.users[email].customer_id) {
        await store.createUser({
            customer_id: data.users[email].customer_id,
            email,
            fraud_score: 10,
            geography: 'UNKNOWN',
            known_device_ids: [],
        });
    }
}

function addPasskey(email, credential) {
    const data = _load();
    if (!data.users[email]) {
        data.users[email] = {
            customer_id: null, email,
            passkeys: [], passcode_hash: null,
            magic_token_hash: null, magic_token_expires: null,
        };
    }
    data.users[email].passkeys.push(credential);
    _save(data);
}

function getPasskeyById(credentialId) {
    const data = _load();
    for (const user of Object.values(data.users)) {
        const pk = (user.passkeys || []).find(p => p.id === credentialId);
        if (pk) return { passkey: pk, email: user.email };
    }
    return null;
}

function updateCounter(email, credentialId, counter) {
    const data = _load();
    const user = data.users[email];
    if (!user) return;
    const pk = (user.passkeys || []).find(p => p.id === credentialId);
    if (pk) pk.counter = counter;
    _save(data);
}

function setPasscodeHash(email, hash) {
    const data = _load();
    if (data.users[email]) {
        data.users[email].passcode_hash = hash;
        _save(data);
    }
}

function setMagicToken(email, tokenHash, expiresAt) {
    const data = _load();
    if (!data.users[email]) {
        data.users[email] = {
            customer_id: null, email,
            passkeys: [], passcode_hash: null,
            magic_token_hash: tokenHash,
            magic_token_expires: expiresAt,
        };
    } else {
        data.users[email].magic_token_hash = tokenHash;
        data.users[email].magic_token_expires = expiresAt;
    }
    _save(data);
}

function clearMagicToken(email) {
    const data = _load();
    if (data.users[email]) {
        data.users[email].magic_token_hash = null;
        data.users[email].magic_token_expires = null;
        _save(data);
    }
}

module.exports = {
    getByEmail, upsertUser, addPasskey,
    getPasskeyById, updateCounter,
    setPasscodeHash, setMagicToken, clearMagicToken,
};
