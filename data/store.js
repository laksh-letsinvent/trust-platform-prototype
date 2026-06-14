// data/store.js
/**
 * Data store: Google Sheets (if configured) or local JSON files.
 * Users: fraud_score, geography. Devices: device_id, device_score (number).
 */

const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname);
const sheets = require('./sheets');

function loadJSON(filename) {
    const filePath = path.join(DATA_DIR, filename);
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

function useSheets() {
    return sheets.isConfigured();
}

// ---- JSON-backed (fallback) ----

function getUsersFromJSON() {
    const data = loadJSON('users.json');
    return (data && data.users) ? data.users : [];
}

function getDevicesFromJSON() {
    const data = loadJSON('devices.json');
    return (data && data.devices) ? data.devices : [];
}

function getAuthenticatorsFromJSON() {
    const data = loadJSON('authenticators.json');
    return (data && data.authenticators) ? data.authenticators : [];
}

function getActionsFromJSON() {
    const data = loadJSON('actions.json');
    return (data && data.actions) ? data.actions : [];
}

// ---- Unified async API ----

async function getUsers() {
    if (useSheets()) return sheets.getUsers();
    return Promise.resolve(getUsersFromJSON());
}

async function getDevices() {
    if (useSheets()) return sheets.getDevices();
    return Promise.resolve(getDevicesFromJSON());
}

async function getAuthenticators() {
    if (useSheets()) return sheets.getAuthenticators();
    return Promise.resolve(getAuthenticatorsFromJSON());
}

async function getActions() {
    if (useSheets()) return sheets.getActions();
    return Promise.resolve(getActionsFromJSON());
}

async function getUserById(customerId) {
    if (useSheets()) return sheets.getUserById(customerId);
    const users = getUsersFromJSON();
    return Promise.resolve(users.find(u => u.customer_id === customerId) || null);
}

async function getDeviceById(deviceId) {
    if (useSheets()) return sheets.getDeviceById(deviceId);
    const devices = getDevicesFromJSON();
    return Promise.resolve(devices.find(d => d.device_id === deviceId) || null);
}

async function getAuthenticatorById(id) {
    if (useSheets()) return sheets.getAuthenticatorById(id);
    const auths = getAuthenticatorsFromJSON();
    return Promise.resolve(auths.find(a => a.id === id) || null);
}

async function getActionById(actionId) {
    if (useSheets()) return sheets.getActionById(actionId);
    const actions = getActionsFromJSON();
    return Promise.resolve(actions.find(a => a.id === actionId) || null);
}

/**
 * Update a user's fraud_score in users.json (persistent).
 * Sheets path is not implemented — falls back to JSON update only.
 */
async function updateUserFraudScore(customerId, newScore) {
    const filePath = path.join(DATA_DIR, 'users.json');
    const data = loadJSON('users.json');
    if (!data || !data.users) return false;
    const idx = data.users.findIndex(u => u.customer_id === customerId);
    if (idx === -1) return false;
    data.users[idx].fraud_score = newScore;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return true;
}

/**
 * Add a device to a user's known_device_ids list (max 20, drops oldest on overflow).
 * Called after a successful step-up so the device becomes trusted on future decisions.
 */
async function addKnownDevice(customerId, deviceId) {
    if (!customerId || !deviceId) return false;
    const filePath = path.join(DATA_DIR, 'users.json');
    const data = loadJSON('users.json');
    if (!data || !data.users) return false;
    const idx = data.users.findIndex(u => u.customer_id === customerId);
    if (idx === -1) return false;
    const user = data.users[idx];
    const known = Array.isArray(user.known_device_ids) ? user.known_device_ids : [];
    if (known.includes(deviceId)) return false; // already known
    known.push(deviceId);
    if (known.length > 20) known.shift(); // drop oldest
    data.users[idx].known_device_ids = known;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return true;
}

module.exports = {
    getUsers,
    getDevices,
    getAuthenticators,
    getActions,
    getUserById,
    getDeviceById,
    getAuthenticatorById,
    getActionById,
    updateUserFraudScore,
    addKnownDevice,
    useSheets,
    loadJSON
};
