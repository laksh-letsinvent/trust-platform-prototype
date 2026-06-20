// data/sheets.js
/**
 * Google Sheets data source. Set GOOGLE_SHEETS_SPREADSHEET_ID and
 * GOOGLE_APPLICATION_CREDENTIALS (path to service account JSON) to use.
 */

const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const SHEET_NAMES = ['Users', 'Devices', 'Actions', 'Authenticators'];

let sheetsClient = null;
let cache = null;
const CACHE_MS = parseInt(process.env.SHEETS_CACHE_MS || '60000', 10); // 1 min default

function isConfigured() {
    return Boolean(SPREADSHEET_ID);
}

function headersToKeys(row) {
    return row.map(h => String(h || '').trim().toLowerCase().replace(/\s+/g, '_'));
}

function rowToObject(keys, values) {
    const obj = {};
    keys.forEach((k, i) => {
        let v = values[i];
        if (v === '' || v === undefined) v = null;
        else if (typeof v === 'string' && /^\d+$/.test(v)) v = parseInt(v, 10);
        else if (typeof v === 'string' && /^\d+\.\d+$/.test(v)) v = parseFloat(v);
        obj[k] = v;
    });
    return obj;
}

function parseSheet(values, schema) {
    if (!values || values.length < 2) return [];
    const keys = headersToKeys(values[0]);
    const out = [];
    for (let i = 1; i < values.length; i++) {
        const row = values[i];
        if (!row || row.every(c => c === '' || c === undefined)) continue;
        const obj = rowToObject(keys, row);
        if (schema) {
            const normalized = {};
            schema.forEach(({ key, col }) => { normalized[key] = obj[col] != null ? obj[col] : obj[key]; });
            out.push(normalized);
        } else {
            out.push(obj);
        }
    }
    return out;
}

const SCHEMAS = {
    Users: [
        { key: 'customer_id', col: 'customer_id' },
        { key: 'fraud_score', col: 'fraud_score' },
        { key: 'geography', col: 'geography' }
    ],
    Devices: [
        { key: 'device_id', col: 'device_id' },
        { key: 'device_score', col: 'device_score' }
    ],
    Actions: [
        { key: 'id', col: 'id' },
        { key: 'name', col: 'name' },
        { key: 'tier', col: 'tier' },
        { key: 'required_al', col: 'required_al' },
        { key: 'risk_ceiling', col: 'risk_ceiling' }
    ],
    Authenticators: [
        { key: 'id', col: 'id' },
        { key: 'name', col: 'name' },
        { key: 'assurance_level', col: 'assurance_level' },
        { key: 'description', col: 'description' }
    ]
};

async function getClient() {
    if (sheetsClient) return sheetsClient;
    const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_SHEETS_CREDENTIALS_PATH;
    if (!credsPath) throw new Error('Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SHEETS_CREDENTIALS_PATH to a service account JSON path.');
    const auth = new google.auth.GoogleAuth({
        keyFile: credsPath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
    const authClient = await auth.getClient();
    sheetsClient = google.sheets({ version: 'v4', auth: authClient });
    return sheetsClient;
}

let writeClient = null;

async function getWriteClient() {
    if (writeClient) return writeClient;
    const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_SHEETS_CREDENTIALS_PATH;
    if (!credsPath) throw new Error('Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SHEETS_CREDENTIALS_PATH to a service account JSON path.');
    const auth = new google.auth.GoogleAuth({
        keyFile: credsPath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const authClient = await auth.getClient();
    writeClient = google.sheets({ version: 'v4', auth: authClient });
    return writeClient;
}

/**
 * Flatten a nested JSON object to [key, value, updated_at] rows.
 * E.g. { compositeRisk: { weights: { customer: 40 } } } → [["compositeRisk.weights.customer", "40", "..."]]
 */
function flattenToRows(obj, prefix = '') {
    const rows = [];
    const now = new Date().toISOString();
    for (const [k, v] of Object.entries(obj)) {
        if (k.startsWith('_')) continue; // skip comment keys
        const fullKey = prefix ? `${prefix}.${k}` : k;
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            rows.push(...flattenToRows(v, fullKey));
        } else {
            rows.push([fullKey, String(v), now]);
        }
    }
    return rows;
}

/**
 * Write policy settings to a 'ControlPanel' sheet tab.
 * Requires Editor access on the spreadsheet.
 * @param {object} policy - The policy object to persist
 * @param {string} [sheetName='ControlPanel'] - Target sheet tab name
 */
async function writeConfidencePolicy(policy, sheetName = 'ControlPanel') {
    if (!SPREADSHEET_ID) throw new Error('GOOGLE_SHEETS_SPREADSHEET_ID not set.');
    const client = await getWriteClient();
    const rows = flattenToRows(policy);
    const values = [['key', 'value', 'updated_at'], ...rows];
    await client.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${sheetName}'!A1`,
        valueInputOption: 'RAW',
        requestBody: { values }
    });
}

async function fetchAll() {
    const client = await getClient();
    const ranges = SHEET_NAMES.map(name => `'${name}'!A:Z`);
    const res = await client.spreadsheets.values.batchGet({
        spreadsheetId: SPREADSHEET_ID,
        ranges
    });
    const out = {};
    (res.data.valueRanges || []).forEach((vr, i) => {
        const name = SHEET_NAMES[i];
        out[name] = parseSheet(vr.values, SCHEMAS[name]);
    });
    return out;
}

async function getData() {
    const now = Date.now();
    if (cache && cache.ts && (now - cache.ts) < CACHE_MS) return cache.data;
    const data = await fetchAll();
    cache = { data, ts: now };
    return data;
}

async function getUsers() {
    const data = await getData();
    return data.Users || [];
}

async function getDevices() {
    const data = await getData();
    return data.Devices || [];
}

async function getActions() {
    const data = await getData();
    return data.Actions || [];
}

async function getAuthenticators() {
    const data = await getData();
    return data.Authenticators || [];
}

async function getUserById(customerId) {
    const users = await getUsers();
    return users.find(u => String(u.customer_id || '').trim() === String(customerId).trim()) || null;
}

async function getDeviceById(deviceId) {
    const devices = await getDevices();
    return devices.find(d => String(d.device_id || '').trim() === String(deviceId).trim()) || null;
}

async function getActionById(actionId) {
    const actions = await getActions();
    return actions.find(a => String(a.id || '').trim() === String(actionId).trim()) || null;
}

async function getAuthenticatorById(id) {
    const auths = await getAuthenticators();
    return auths.find(a => String(a.id || '').trim() === String(id).trim()) || null;
}

function clearCache() {
    cache = null;
}

module.exports = {
    isConfigured,
    getUsers,
    getDevices,
    getActions,
    getAuthenticators,
    getUserById,
    getDeviceById,
    getActionById,
    getAuthenticatorById,
    writeConfidencePolicy,
    clearCache
};
