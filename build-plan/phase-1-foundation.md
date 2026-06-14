# Phase 1 — Foundation Hardening

## Objective
Make the codebase production-safe before adding any new features. This phase has no visible product changes — it's all structural. Everything built in phases 2–5 depends on this being solid.

## Current state (what exists)
Read CLAUDE.md fully before starting. Key facts:
- `analytics.js` writes decisions to `decisions.jsonl` (append-only flat file) + in-memory ring buffer
- `simulationEngine.js` streams `decisions.jsonl` line by line for replay
- `server.js` has no authentication on any endpoint — all routes are open
- Policy files (`policies/*.json`) are loaded with `JSON.parse` but never schema-validated
- Redis is "optional" — if unreachable, velocity rules silently return 0 (no warning, no visual indicator)
- The `replay` field was recently added to analytics records — old records without it are skipped by simulation

## Tasks

### 1. Postgres migration

Install `pg` (node-postgres). Do NOT use an ORM.

Create `db.js` in the project root:
- Export a `pool` (pg Pool) using `DATABASE_URL` env var
- Export `query(text, params)` helper
- Export `isConfigured()` — returns true if DATABASE_URL is set
- If DATABASE_URL is not set, all db calls must be no-ops that return null — Postgres is optional, JSONL remains the fallback

Create the decisions table on first connection (use `CREATE TABLE IF NOT EXISTS`):
```sql
CREATE TABLE IF NOT EXISTS decisions (
  id BIGSERIAL PRIMARY KEY,
  timestamp BIGINT NOT NULL,
  customer_id TEXT,
  action TEXT,
  action_tier TEXT,
  risk_level TEXT,
  decision TEXT,
  step_up_type TEXT,
  rule_id TEXT,
  reference_id TEXT,
  outcome TEXT,
  original_reference_id TEXT,
  replay JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_decisions_customer ON decisions(customer_id);
CREATE INDEX IF NOT EXISTS idx_decisions_timestamp ON decisions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_decision ON decisions(decision);
CREATE INDEX IF NOT EXISTS idx_decisions_outcome ON decisions(outcome);
```

Create a second table for policy versions (used in Phase 4):
```sql
CREATE TABLE IF NOT EXISTS policy_versions (
  id BIGSERIAL PRIMARY KEY,
  policy_name TEXT NOT NULL,
  version_number INT NOT NULL,
  content JSONB NOT NULL,
  author TEXT DEFAULT 'system',
  simulation_summary JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_policy_versions_name ON policy_versions(policy_name, version_number DESC);
```

Update `analytics.js`:
- `record()` now writes to BOTH Postgres (if configured) AND the JSONL file (keep JSONL as backup/fallback)
- When Postgres is configured, `getDecisions()` used by `GET /decisions` queries Postgres instead of streaming JSONL
- `getStats()` (used by `GET /analytics`) continues to use the in-memory ring buffer — no change needed

Update `simulationEngine.js`:
- `loadReplayableHistory(limit)` — if Postgres is configured, query it: `SELECT * FROM decisions WHERE outcome IS NULL AND replay IS NOT NULL ORDER BY timestamp DESC LIMIT $1`
- If Postgres not configured, fall back to the existing JSONL streaming approach

Create `scripts/migrate-jsonl-to-pg.js`:
- Reads `decisions.jsonl` line by line
- Inserts each valid record into Postgres (skip duplicates via `ON CONFLICT DO NOTHING` — add a unique constraint on `reference_id` where not null)
- Prints progress every 100 records
- Usage: `node scripts/migrate-jsonl-to-pg.js`

Update `server.js` `GET /decisions` handler:
- If Postgres configured: query with filters (customer_id, decision, limit, offset) using parameterised queries
- If not: keep existing JSONL file streaming logic

### 2. API key authentication middleware

Create `middleware/apiKey.js`:
- Reads `API_KEYS` env var (comma-separated list of valid keys, e.g. `sk-trust-abc123,sk-trust-def456`)
- If `API_KEYS` is not set, middleware is a no-op (pass-through) — don't break existing local dev workflow
- Checks `X-API-Key` header
- Returns `401 { error: "Missing API key" }` if header absent when keys are configured
- Returns `403 { error: "Invalid API key" }` if key doesn't match
- Attaches `req.apiKeyId` (first 8 chars of key for logging, never full key)

Apply the middleware in `server.js` to:
- `POST /trust/decision`
- `PATCH /policies/*`
- `POST /policies/*` (all policy mutation endpoints)
- NOT applied to: `GET /status`, `GET /analytics`, `GET /decisions`, `GET /policies/*` (read-only), static files

Log `req.apiKeyId` in the decision record (add `caller_key_id` field to the analytics record).

### 3. Policy JSON Schema validation

Install `ajv` and `ajv-formats`.

Create schema files:
- `policies/schema/decisions.schema.json` — validates the decisions.json structure (rules array, each rule has id/enabled/decision/condition shape, valid decision values, valid step_up_type values, condition keys from the known list in policyEngine.js)
- `policies/schema/confidence.schema.json` — validates risk bands, weights sum to 100, AL order
- `policies/schema/idvRouting.schema.json` — validates routing strategies

Create `policyValidator.js`:
- `validate(policyName, content)` — returns `{ valid: boolean, errors: string[] }`
- Uses AJV to validate against the appropriate schema

In `server.js` startup (after `app.listen`):
- Validate all 3 policy files
- If any fail: `console.warn('⚠ Policy validation warning:', errors)` — warn but don't crash (live server may have working policies that predate the schema)
- Log `✓ All policies valid` if all pass

In PATCH handlers for each policy:
- Validate the merged result before writing to disk
- Return `400 { error: 'Policy validation failed', validation_errors: [...] }` if invalid
- This is already partially done for confidence.json (weight check) — extend it properly

### 4. Redis health enforcement

In `velocityEngine.js` (or wherever Redis connection is managed):
- On connection failure: log `⚠ Redis unavailable — velocity rules disabled` clearly
- Expose `getStatus()` method: returns `{ connected: boolean, lastError: string|null }`

In `server.js` `GET /status`:
- Add `redis_status: { connected, last_error }` to the response
- Add `postgres_status: { connected, last_error }` to the response

In `public/index.html` status bar (header badges):
- Postgres badge alongside existing Redis and Sheets badges
- If Redis disconnected: show "Velocity rules OFF" warning text in the Control Panel velocity section (currently it just says nothing)

### 5. Environment and configuration cleanup

Update `.env.example` with all new variables:
```
# Database (optional — JSONL fallback if not set)
DATABASE_URL=postgresql://user:password@localhost:5432/trust_platform

# API Authentication (optional — open if not set)
API_KEYS=sk-trust-abc123,sk-trust-def456

# Intelligence adapters (all optional, added in Phase 2)
ABUSEIPDB_API_KEY=
HIBP_API_KEY=
```

Update `CLAUDE.md`:
- Add `db.js` to the architecture section
- Add `middleware/apiKey.js`
- Document the dual-write strategy (Postgres + JSONL)
- Update the API surface table with the new `caller_key_id` field in decision records

## Technical decisions — do not deviate
- `pg` library only, no Sequelize, Prisma, or other ORM
- Postgres is optional — JSONL fallback must remain working
- API keys are plaintext in env (no hashing needed for a demo platform)
- AJV v8 (latest) — import as `import Ajv from 'ajv'` or `const Ajv = require('ajv')`
- Schema validation warns on startup, hard-fails on PATCH

## Success criteria
1. `node server.js` starts cleanly with and without `DATABASE_URL` set
2. `PATCH /policies/decisions` with a deliberately broken rule returns `400` with a meaningful error message
3. `POST /trust/decision` without `X-API-Key` returns `401` when `API_KEYS` is set
4. `GET /status` shows postgres_status and redis_status
5. `node scripts/migrate-jsonl-to-pg.js` imports existing decisions.jsonl records into Postgres
6. `GET /decisions` returns the same records whether reading from Postgres or JSONL

## Deployment to Hetzner after this phase
```bash
# Set DATABASE_URL on the server first (use local Postgres installed on same VPS)
# SSH in and: sudo apt install postgresql postgresql-contrib
# sudo -u postgres createdb trust_platform
# sudo -u postgres psql -c "CREATE USER trust WITH PASSWORD 'yourpassword';"
# sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE trust_platform TO trust;"

# Add to /opt/trust-platform/.env:
# DATABASE_URL=postgresql://trust:yourpassword@localhost:5432/trust_platform

# Then redeploy (standard rsync from CLAUDE.md)
# After deploy, run migration:
# ssh in and: node /opt/trust-platform/scripts/migrate-jsonl-to-pg.js
```
