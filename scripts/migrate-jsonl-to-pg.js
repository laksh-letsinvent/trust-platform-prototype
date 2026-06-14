#!/usr/bin/env node
// Migrate decisions.jsonl → Postgres decisions table.
// Safe to re-run: records with a reference_id are skipped on conflict.
// Usage: node scripts/migrate-jsonl-to-pg.js

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Set it in .env or environment.');
    process.exit(1);
}

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const LOGFILE = path.join(__dirname, '..', 'decisions.jsonl');

const INSERT_SQL = `
INSERT INTO decisions (
  timestamp, customer_id, action, action_tier, risk_level,
  decision, step_up_type, rule_id, reference_id, outcome,
  original_reference_id, caller_key_id, replay
)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
ON CONFLICT DO NOTHING
`;

async function migrate() {
    if (!fs.existsSync(LOGFILE)) {
        console.log('decisions.jsonl not found — nothing to migrate.');
        await pool.end();
        return;
    }

    const rl = readline.createInterface({
        input: fs.createReadStream(LOGFILE, 'utf8'),
        crlfDelay: Infinity
    });

    let imported = 0;
    let skipped = 0;
    let errors = 0;
    let total = 0;

    for await (const line of rl) {
        if (!line.trim()) continue;
        total++;

        let row;
        try { row = JSON.parse(line); } catch (_) { skipped++; continue; }

        try {
            await pool.query(INSERT_SQL, [
                row.timestamp,
                row.customer_id || null,
                row.action || null,
                row.actionTier || null,
                row.riskLevel || null,
                row.decision || null,
                row.step_up_type || null,
                row.ruleId || null,
                row.reference_id || null,
                row.outcome || null,
                row.original_reference_id || null,
                row.caller_key_id || null,
                row.replay ? JSON.stringify(row.replay) : null,
            ]);
            imported++;
        } catch (err) {
            errors++;
            if (errors <= 3) console.warn('  Insert error:', err.message, '| row:', line.slice(0, 80));
        }

        if (total % 100 === 0) {
            process.stdout.write(`  ${total} lines processed (${imported} imported, ${skipped} skipped, ${errors} errors)\r`);
        }
    }

    console.log(`\nDone. ${total} lines read → ${imported} imported, ${skipped} skipped, ${errors} errors.`);
    await pool.end();
}

migrate().catch(err => {
    console.error('Migration failed:', err.message);
    process.exit(1);
});
