// db.js
// Postgres connection pool. Optional — all callers must check isConfigured() or handle null returns.

const { Pool } = require('pg');

let pool = null;
let lastError = null;
let connected = false;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS decisions (
  id               BIGSERIAL PRIMARY KEY,
  timestamp        BIGINT NOT NULL,
  customer_id      TEXT,
  action           TEXT,
  action_tier      TEXT,
  risk_level       TEXT,
  decision         TEXT,
  step_up_type     TEXT,
  rule_id          TEXT,
  reference_id     TEXT,
  outcome          TEXT,
  original_reference_id TEXT,
  caller_key_id    TEXT,
  replay           JSONB,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_decisions_customer  ON decisions(customer_id);
CREATE INDEX IF NOT EXISTS idx_decisions_timestamp ON decisions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_decision  ON decisions(decision);
CREATE INDEX IF NOT EXISTS idx_decisions_outcome   ON decisions(outcome);
CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_ref_id ON decisions(reference_id)
  WHERE reference_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS policy_versions (
  id               BIGSERIAL PRIMARY KEY,
  policy_name      TEXT NOT NULL,
  version_number   INT  NOT NULL,
  content          JSONB NOT NULL,
  author           TEXT DEFAULT 'system',
  simulation_summary JSONB,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_policy_versions_name ON policy_versions(policy_name, version_number DESC);
`;

function isConfigured() {
    return !!process.env.DATABASE_URL;
}

async function init() {
    if (!isConfigured()) return;
    try {
        pool = new Pool({ connectionString: process.env.DATABASE_URL });
        await pool.query(SCHEMA_SQL);
        connected = true;
        console.log('Postgres: connected and schema ensured');
    } catch (err) {
        lastError = err.message;
        console.warn('⚠ Postgres unavailable:', err.message);
        pool = null;
        connected = false;
    }
}

async function query(text, params) {
    if (!pool) return null;
    try {
        return await pool.query(text, params);
    } catch (err) {
        lastError = err.message;
        console.warn('Postgres query error:', err.message);
        return null;
    }
}

function getStatus() {
    return { connected, last_error: lastError };
}

module.exports = { init, query, isConfigured, getStatus };
