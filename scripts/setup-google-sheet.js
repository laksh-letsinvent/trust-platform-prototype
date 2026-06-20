#!/usr/bin/env node
/**
 * scripts/setup-google-sheet.js
 *
 * One-time bootstrap script — creates a Google Spreadsheet with all required
 * tabs and sample data for the Trust Platform demo.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=./credentials.json node scripts/setup-google-sheet.js
 *
 * After running, copy the printed SPREADSHEET_ID into your .env:
 *   GOOGLE_SHEETS_SPREADSHEET_ID=<id>
 *   GOOGLE_APPLICATION_CREDENTIALS=./credentials.json
 *
 * Then restart the server — all dropdowns will load from Sheets.
 *
 * Note: Your service account needs TWO scopes:
 *   - https://www.googleapis.com/auth/spreadsheets
 *   - https://www.googleapis.com/auth/drive.file
 *
 * If using Workload Identity or a key file, ensure the service account has
 * been granted "Editor" on the spreadsheet (or share it with the SA email).
 */

const { google } = require('googleapis');
const path = require('path');

// ─── Sample data ─────────────────────────────────────────────────────────────

const USERS = [
  // LOW risk personas
  { customer_id: 'cust_retail_001', fraud_score: 12, geography: 'UK' },  // Lara
  { customer_id: 'cust_retail_002', fraud_score: 22, geography: 'UK' },  // Jason
  { customer_id: 'cust_retail_003', fraud_score: 28, geography: 'DE' },  // Nikky
  // MEDIUM risk personas
  { customer_id: 'cust_retail_004', fraud_score: 35, geography: 'UK' },  // Maddy
  { customer_id: 'cust_retail_005', fraud_score: 55, geography: 'DE' },  // Maxim
  { customer_id: 'cust_retail_006', fraud_score: 68, geography: 'UK' },  // Lenny
  // HIGH risk personas
  { customer_id: 'cust_retail_007', fraud_score: 80, geography: 'UK' },  // Harvey
  { customer_id: 'cust_retail_008', fraud_score: 90, geography: 'DE' },  // Hitesh
];

const DEVICES = [
  { device_id: 'dev_iphone_001',   device_score: 92 },  // Highly trusted iPhone
  { device_id: 'dev_iphone_002',   device_score: 78 },  // Trusted iPhone
  { device_id: 'dev_android_001',  device_score: 55 },  // Moderate Android
  { device_id: 'dev_android_002',  device_score: 20 },  // Low-trust Android
  { device_id: 'dev_unknown_001',  device_score:  5 },  // Unknown / new device
  { device_id: 'dev_tablet_001',   device_score: 60 },  // Moderate tablet
];

const ACTIONS = [
  { id: 'view_balance',      name: 'View Balance',         tier: 'Tier1', required_al: 'AL1', risk_ceiling: 85 },
  { id: 'view_statement',    name: 'View Statement',        tier: 'Tier1', required_al: 'AL1', risk_ceiling: 85 },
  { id: 'bill_pay',          name: 'Bill Payment',          tier: 'Tier2', required_al: 'AL2', risk_ceiling: 70 },
  { id: 'p2p_send',          name: 'P2P Transfer',          tier: 'Tier2', required_al: 'AL2', risk_ceiling: 70 },
  { id: 'internal_transfer', name: 'Internal Transfer',     tier: 'Tier2', required_al: 'AL2', risk_ceiling: 70 },
  { id: 'international_wire',name: 'International Wire',    tier: 'Tier3', required_al: 'AL3', risk_ceiling: 55 },
  { id: 'investment_trade',  name: 'Investment Trade',      tier: 'Tier3', required_al: 'AL3', risk_ceiling: 55 },
  { id: 'account_recovery',  name: 'Account Recovery',      tier: 'Tier4', required_al: 'AL4', risk_ceiling: 40 },
  { id: 'add_payee',         name: 'Add New Payee',         tier: 'Tier4', required_al: 'AL4', risk_ceiling: 40 },
];

const AUTHENTICATORS = [
  { id: 'AL1', name: 'FaceID / Passcode',  assurance_level: 'AL1', description: 'Device biometric or PIN — baseline auth' },
  { id: 'AL2', name: 'Passkey',            assurance_level: 'AL2', description: 'FIDO2 passkey — strong bound credential' },
  { id: 'AL3', name: 'Selfie Check',       assurance_level: 'AL3', description: 'Liveness selfie matched to account photo' },
  { id: 'AL4', name: 'IDV',                assurance_level: 'AL4', description: 'Full identity document verification' },
];

// ─── Tab definitions ──────────────────────────────────────────────────────────

const TABS = [
  {
    name: 'Users',
    headers: ['customer_id', 'fraud_score', 'geography'],
    rows: USERS.map(u => [u.customer_id, u.fraud_score, u.geography]),
  },
  {
    name: 'Devices',
    headers: ['device_id', 'device_score'],
    rows: DEVICES.map(d => [d.device_id, d.device_score]),
  },
  {
    name: 'Actions',
    headers: ['id', 'name', 'tier', 'required_al', 'risk_ceiling'],
    rows: ACTIONS.map(a => [a.id, a.name, a.tier, a.required_al, a.risk_ceiling]),
  },
  {
    name: 'Authenticators',
    headers: ['id', 'name', 'assurance_level', 'description'],
    rows: AUTHENTICATORS.map(a => [a.id, a.name, a.assurance_level, a.description]),
  },
  {
    name: 'ControlPanel',
    headers: ['key', 'value', 'updated_at'],
    rows: [], // Populated by server when Control Panel policies are synced
  },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Auth — supports GOOGLE_APPLICATION_CREDENTIALS (key file) or ADC
  const auth = new google.auth.GoogleAuth({
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file',
    ],
  });

  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  const drive = google.drive({ version: 'v3', auth: authClient });

  console.log('\n🚀 Trust Platform — Google Sheets Setup\n');

  // 1. Create spreadsheet with all sheets pre-defined
  console.log('Creating spreadsheet...');
  const createRes = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: 'Trust Platform — Demo Data' },
      sheets: TABS.map((tab, idx) => ({
        properties: {
          sheetId: idx,
          title: tab.name,
          gridProperties: { rowCount: 200, columnCount: 10 },
        },
      })),
    },
  });

  const spreadsheetId = createRes.data.spreadsheetId;
  const spreadsheetUrl = createRes.data.spreadsheetUrl;
  console.log(`✅ Spreadsheet created: ${spreadsheetUrl}\n`);

  // 2. Write headers + data into each tab
  const data = TABS.map(tab => ({
    range: `${tab.name}!A1`,
    values: [tab.headers, ...tab.rows],
  }));

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data },
  });
  console.log('✅ Sample data written to all tabs');

  // 3. Bold the header rows
  const boldRequests = TABS.map((_, idx) => ({
    repeatCell: {
      range: { sheetId: idx, startRowIndex: 0, endRowIndex: 1 },
      cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: 'userEnteredFormat.textFormat.bold',
    },
  }));
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: boldRequests },
  });
  console.log('✅ Header rows formatted\n');

  // 4. Print env var instructions
  console.log('─'.repeat(60));
  console.log('📋 Add these lines to your .env file:\n');
  console.log(`GOOGLE_APPLICATION_CREDENTIALS=./credentials.json`);
  console.log(`GOOGLE_SHEETS_SPREADSHEET_ID=${spreadsheetId}`);
  console.log('\nThen restart the server:');
  console.log('  node server.js\n');
  console.log('─'.repeat(60));
  console.log('\n📊 Tabs created:');
  TABS.forEach(tab => {
    const rowCount = tab.rows.length;
    console.log(`  • ${tab.name.padEnd(16)} — ${rowCount > 0 ? `${rowCount} rows` : 'empty (populated by server)'}`);
  });
  console.log('\n✅ Setup complete!\n');
}

main().catch(err => {
  console.error('\n❌ Setup failed:', err.message);
  if (err.message.includes('Could not load the default credentials')) {
    console.error('\nMake sure GOOGLE_APPLICATION_CREDENTIALS points to your service account key file.');
    console.error('Example: GOOGLE_APPLICATION_CREDENTIALS=./credentials.json node scripts/setup-google-sheet.js\n');
  }
  process.exit(1);
});
