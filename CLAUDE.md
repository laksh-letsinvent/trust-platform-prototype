# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the server

```bash
node server.js
```

The server starts on port 3000 (or `PORT` env var). Redis and Google Sheets are optional — the server degrades gracefully without them.

## Production deployment

**Live URL:** https://trustdecision.letsinvent.co.uk
**Server:** Hetzner VPS `77.42.46.176` (Ubuntu 22.04)
**App path on server:** `/opt/trust-platform/`
**Port on server:** 4000 (Caddy proxies 443 → 4000)
**Process manager:** PM2 (`trust-platform`), auto-restarts on crash and VM reboot
**Reverse proxy:** Caddy — config at `/etc/caddy/Caddyfile` on the server. SSL is managed automatically by Caddy via Let's Encrypt.

Other apps on the same server: `letsinvent.co.uk` (banking demo) and `agent-idam.letsinvent.co.uk` (agent IDAM). Do not modify their Caddyfile blocks.

### Redeploy after local changes

```bash
rsync -avz \
  --exclude='.env' --exclude='credentials.json' --exclude='*.jsonl' \
  --exclude='.DS_Store' --exclude='.claude/' --exclude='.git/' \
  --exclude='node_modules/' --exclude='daily-digest-*.md' \
  --exclude='trust-daily-digest-*.md' --exclude='design-system.html' \
  --exclude='design-tokens.json' --exclude='touch' \
  -e "ssh -i ~/.ssh/id_rsa" \
  /Users/lsinghal/trust-platform-prototype/ \
  root@77.42.46.176:/opt/trust-platform/ && \
ssh -i ~/.ssh/id_rsa root@77.42.46.176 \
  "cd /opt/trust-platform && npm install --production && pm2 restart trust-platform"
```

### SSH access

```bash
ssh -i ~/.ssh/id_rsa root@77.42.46.176
```

## Google Sheets setup (optional)

```bash
GOOGLE_APPLICATION_CREDENTIALS=./credentials.json node scripts/setup-google-sheet.js
```

This creates a spreadsheet with all required tabs and sample data, then prints the `SPREADSHEET_ID` to add to your `.env`.

## Environment variables

See `.env.example`. Key vars:
- `GOOGLE_SHEETS_SPREADSHEET_ID` + `GOOGLE_APPLICATION_CREDENTIALS` — enable Sheets as data source
- `REDIS_URL` — enables caching and velocity tracking (defaults to `redis://localhost:6379`)
- `SHEETS_CACHE_MS` — Sheets cache TTL (default 60000ms)
- `CACHE_FRAUD_TTL_SEC` / `CACHE_DEVICE_TTL_SEC` — Redis cache TTL defaults (also runtime-adjustable via `PATCH /cache/config`)

## Architecture

This is a **trust decision engine** for banking/fintech. Every customer action request goes through a pipeline:

```
POST /trust/decision
  → decisionEngine.js          (orchestrates the pipeline)
  → enrichmentOrchestrator.js  (parallel enrichment: IP/VPN/proxy/tor, AbuseIPDB, HIBP, GreyNoise)
  → confidenceEngine.js        (computes risk level + effective confidence from signals)
  → policyEngine.js            (evaluates ordered decision rules → ALLOW / STEP_UP / DENY / MANUAL_REVIEW)
  → idvRouting.js              (if step_up_type=IDV, selects vendor via routing strategy)
  → analytics.js               (records decision to in-memory ring buffer + decisions.jsonl)
```

### Phase 1 additions

- **`db.js`** — Postgres pool (optional). Exports `init()`, `query()`, `isConfigured()`, `getStatus()`. No-op (returns null) when `DATABASE_URL` not set.
- **`middleware/apiKey.js`** — API key auth. Reads `X-API-Key` header, checks against `API_KEYS` env var (comma-separated). No-op when `API_KEYS` not set. Sets `req.apiKeyId` (first 8 chars, never full key). Applied to all mutation endpoints.
- **`policyValidator.js`** — AJV v8 structural validation for policy files. `validate(policyName, content)` → `{ valid, errors }`. Schemas live in `policies/schema/`. Warns on startup, hard-fails on PATCH.
- **`scripts/migrate-jsonl-to-pg.js`** — One-shot migration of `decisions.jsonl` → Postgres. Safe to re-run.

**Dual-write strategy:** `analytics.record()` writes to JSONL (synchronous primary) and fires a Postgres insert (async, fire-and-forget). `GET /decisions` queries Postgres when configured, falls back to JSONL streaming. `GET /analytics` always uses the in-memory ring buffer.

### Key design principles

**Policy-driven, not code-driven.** All risk bands, confidence formulas, and decision rules live in `policies/*.json`, not in code. Changing behavior means editing JSON, not JavaScript.

**Data stores hold raw scores only.** `data/store.js` provides users (fraud_score, geography), devices (device_score), actions (tier, required_confidence, required_al), and authenticators (confidence_level, assurance_level). Risk classification happens in policy.

**Dual data sources.** `data/store.js` transparently switches between Google Sheets (when `GOOGLE_SHEETS_SPREADSHEET_ID` is set) and local JSON files in `data/`.

### Policy files (`policies/`)

- **`confidence.json`** — Defines: risk level bands (fraud score → LOW/MEDIUM/HIGH), action tier requirements (required confidence per tier), Auth Assurance Level (AL1–AL4) requirements per tier, and the effective confidence formula: `(deviceScore/100 × deviceWeight) + ((100-fraudScore)/100 × fraudWeight)`. `deviceWeight + fraudWeight` must sum to 100. Optional `useAuthenticatorMax: true` overrides with `max(calculated, authenticatorConfidence)`.

- **`decisions.json`** — Ordered array of rules; first match wins. Each rule has a `condition` (can match on fraudScoreMin/Max, deviceScoreMin/Max, riskLevel, geography, actionTier, alMeetsRequired, confidenceMeetsAction, currentAuthLevelLessThan, velocity_1m_gt, velocity_5m_gt, velocity_15m_gt, vpn_detected, proxy_detected, tor_detected, is_new_device, email_breached, is_greynoise_bot, ato_signal_count_gte, ip_abuse_score_gte, ambient_trust_gte, ambient_trust_lte, breach_count) and produces a `decision` + optional `step_up_type`. Dynamic step_up_type tokens: `AL_PLUS_1` (one AL above required) and `REQUIRED_AL` (exact required AL). Velocity rules (`deny_velocity_burst`, `manual_review_velocity_elevated`) require Redis.

- **`idvRouting.json`** — IDV vendor routing strategies: `round_robin`, `percent_split`, `time_based`, `geo_based`. Active strategy set by `active_strategy`.

### Auth Assurance Levels (AL hierarchy)

`AL1` (passcode/FaceID) < `AL2` (passkey) < `AL3` (selfie) < `AL4` (IDV). Mapped to step-up types: `AL1→PASSCODE`, `AL2→PASSKEY`, `AL3→SELFIE`, `AL4→IDV`.

### Caching (`cache.js`)

Redis-backed, no-op when Redis is unavailable. Caches fraud scores (key: `fraud:{customerId}:{action}:{deviceId}`) and device scores (key: `device:{deviceId}`). TTLs default to env vars but are **runtime-adjustable** via `PATCH /cache/config` — changes take effect immediately for new cache writes. The same Redis client is shared with `velocityEngine.js` for sorted-set velocity tracking.

### Enrichment adjustments (applied in `decisionEngine.js`)

Enrichment runs in parallel before scoring. Signals adjust the raw scores additively:

| Signal | Adjustment |
|--------|-----------|
| `is_tor = true` | fraudScore +40 |
| `is_greynoise_bot = true` | fraudScore +40 |
| `is_proxy or is_vpn = true` | fraudScore +15 |
| `email_breached and breach_count > 2` | fraudScore +20 |
| `ip_abuse_score > 80` | deviceScore −40 |
| `ip_abuse_score > 50` | deviceScore −20 |
| `is_new_device = true` (known user) | deviceScore −30 |

Adapters can be runtime-disabled per-adapter via `PATCH /adapters/config` without restarting.

### Ambient Trust Score (`ambientTrustStore.js`)

Redis-backed per-customer score 0–100 (default 50, clamped 5–95). Updated on step-up completions and enrichment signals. **Decay rate is runtime-configurable** via `PATCH /trust/ats/config` (stored in `ats:cfg` Redis hash); defaults to 2 pts per 6 h cycle. The 6 h interval itself requires a restart to change. New customers always start at 50.

### Policy cache invalidation

Each policy module (`confidenceEngine`, `policyEngine`, `idvRouting`) caches its parsed JSON in memory. `PATCH /policies/*` endpoints call `clearCache()` on the relevant module after writing the updated file.

### Policy versioning (`policyVersioning.js`)

When `DATABASE_URL` is set, each `PATCH /policies/:name` saves a version row. `getVersions()` returns versions newest-first with `id`, `version_number`, `author`, `created_at`, `simulation_summary`, `content_hash`. `diffVersions(a, b)` returns `{ added, removed, modified, unchanged_count }` for rules-based policies.

### Decision log

Every decision is written to `decisions.jsonl` (append-only JSONL) and an in-memory ring buffer (last 500). When `DATABASE_URL` is set, decisions are also inserted into Postgres asynchronously (fire-and-forget). `GET /decisions` queries Postgres when configured, otherwise streams JSONL. `GET /analytics` always aggregates the in-memory ring buffer. Decision records include a `caller_key_id` field (first 8 chars of the API key used, or null).

### Adapters (`adapters/`)

- `fraudAdapter.js` / `deviceAdapter.js` — thin wrappers over `data/store.js`.
- `enrichmentOrchestrator.js` — runs IP geolocation, AbuseIPDB, HIBP, and GreyNoise in parallel. Exposes `enableAdapter(name)` / `disableAdapter(name)` / `getAdapterStates()` for per-adapter runtime toggling. Disabled adapters resolve immediately to `null` (contribute no signals). IP geolocation and GreyNoise require no API key; AbuseIPDB needs `ABUSEIPDB_API_KEY`; HIBP needs `HIBP_API_KEY`.

## API surface

| Method | Path | Description |
|--------|------|-------------|
| POST | `/trust/decision` | Main decision endpoint. Body: `{ customer_id, action, device_id, current_auth_level? }` |
| GET | `/data/users\|devices\|actions\|authenticators` | Raw data inspection |
| GET/PATCH | `/policies/confidence` | Confidence policy (PATCH supports partial merge; validates weights sum to 100) |
| GET/PATCH | `/policies/decisions` | Decision rules (PATCH merges rules by `id`) |
| GET/PATCH | `/policies/idvRouting` | IDV routing policy |
| GET | `/policies/:name/history` | Policy version history (requires Postgres). Query: `?limit=` |
| GET | `/policies/:name/diff/:idA/:idB` | Diff two policy versions. Returns `{ added, removed, modified, unchanged_count }` |
| POST | `/policies/:name/rollback/:id` | Restore a policy version. Replaces live policy immediately. |
| POST | `/policies/velocity-toggle` | Toggle velocity rules on/off. Body: `{ "enabled": true\|false }` |
| POST | `/policies/simulate` | Replay decision history against a proposed decisions config (read-only). Body: `{ rules, default }`. Query: `?limit=` |
| POST | `/policies/copilot` | NL → rule + simulation. Body: `{ intent, insert_position?, simulation_limit? }`. Requires `ANTHROPIC_API_KEY`. Returns `{ rule, validation, simulation, note }` |
| GET | `/policies/copilot/status` | Whether AI copilot is available (ANTHROPIC_API_KEY set) |
| GET | `/analytics` | Aggregated decision stats (optional `?customer_id=` filter). Includes `stepUpOutcomes`, `reviewOutcomes` |
| DELETE | `/analytics` | Clear in-memory ring buffer |
| GET | `/decisions` | Paginated decision log. Params: `limit`, `offset`, `customer_id`, `decision`, `rule_id`, `risk_level`, `enrichment_signal` (one of: `is_tor`, `is_vpn`, `is_proxy`, `is_hosting`, `is_new_device`, `email_breached`, `is_greynoise_bot`) |
| GET | `/trust/review/queue` | Pending manual review cases. Each case includes `enrichment` field from original decision trace |
| POST | `/trust/review/:reference_id/feedback` | Submit review outcome. Body: `{ reviewer_id, outcome, notes?, fraud_score_override? }` |
| GET | `/trust/ats/:customerId` | Ambient trust score + history (last 10 events) |
| PATCH | `/trust/ats/:customerId` | Override ATS score. Body: `{ score: 0–100 }`. Requires API key |
| GET | `/trust/ats/config` | ATS decay rate config. Returns `{ decayRate, intervalHours }` |
| PATCH | `/trust/ats/config` | Set ATS decay rate. Body: `{ decayRate: 0–20 }`. Requires API key |
| GET | `/cache/config` | Redis cache TTLs. Returns `{ fraudTtlSec, deviceTtlSec }` |
| PATCH | `/cache/config` | Update cache TTLs at runtime. Body: `{ fraudTtlSec?, deviceTtlSec? }`. Requires API key |
| GET | `/status/adapters` | Per-adapter status: `configured` (API key present) + `enabled` (not runtime-disabled) |
| PATCH | `/adapters/config` | Enable/disable an enrichment adapter. Body: `{ adapter: string, enabled: boolean }`. Requires API key |
| GET | `/status` | Redis/velocity/Sheets/Postgres availability |

The frontend (`public/index.html`) is a single-page app served statically. Five tabs: Decision Simulator, Control Panel, Analytics, Review Queue, Policy Lab.

### Control Panel cards

| Card | What it controls |
|------|-----------------|
| Action tier thresholds | Required confidence % per tier (Tier1–Tier4) |
| Risk bands | Fraud score thresholds for LOW/MEDIUM/HIGH (with live visual validator) |
| Confidence formula weights | deviceWeight / fraudWeight + `useAuthenticatorMax` toggle |
| Velocity enforcement | Enable/disable Redis velocity rules |
| Velocity thresholds | 1 m burst deny threshold + 5 m elevated review threshold |
| IDV routing | Active strategy + percent-split vendor weights |
| ATS override | Look up + manually override a customer's ambient trust score |
| ATS decay rate | Pts drifted toward baseline 50 per 6 h cycle (0–20, runtime) |
| Cache TTLs | Fraud + device score Redis cache expiry (runtime, no restart needed) |
| Traffic daemon | Start/stop synthetic traffic generator |
| Adapters | Per-adapter enable/disable toggles + API key status |
| A/B experiment | Create/stop rule experiments |

### Policy Lab (`simulationEngine.js`, `copilot.js`)

`simulationEngine.js` — streams `decisions.jsonl`, rebuilds context from the `replay` snapshot attached to each primary decision record, evaluates both the current and proposed config on identical contexts, and returns before/after decision mix, a transition matrix, per-rule firing counts, never-fired rules, and up to 20 changed-decision samples.

`copilot.js` — calls Claude API (`claude-opus-4-8`), receives a rule JSON, validates it via `policyEngine.validateDecisionsConfig`, then auto-simulates. Returns without writing anything; the caller publishes via `PATCH /policies/decisions`. Requires `ANTHROPIC_API_KEY`; exports `isAvailable()` for the status endpoint.

**Seed simulation history:**
```bash
node scripts/generate-traffic.js              # 500 records
node scripts/generate-traffic.js --count 2000
node scripts/generate-traffic.js --dry-run
```

### Decision log replay snapshots

`analytics.js` `record()` stores a `replay` field on each primary decision record (outcome === null). Shape:
```json
{
  "device_id", "current_auth_level", "fraudScore", "deviceScore",
  "geography", "velocity",
  "enrichment": { "is_tor", "is_vpn", "is_proxy", "is_hosting", "ip_abuse_score",
                  "email_breached", "breach_count", "is_greynoise_bot",
                  "is_new_device", "ato_signal_count" }
}
```
Records without `replay` (written before this change) are skipped by the simulator — counted in `skipped_no_snapshot`. The `enrichment` sub-object is used by `GET /decisions?enrichment_signal=is_tor` filtering.

### Known ioredis API note

This project uses **ioredis** (not node-redis). ioredis uses **lowercase** command names: `hset`, `hget`, `lpush`, `ltrim`, `lrange`, `scan`, `setex`, etc. Node-redis uses camelCase (`hSet`, `hGet`). Any new Redis code must use lowercase or ioredis will throw `TypeError: cl.XYZ is not a function`.
