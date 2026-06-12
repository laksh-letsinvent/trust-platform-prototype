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
- `CACHE_FRAUD_TTL_SEC` / `CACHE_DEVICE_TTL_SEC` — Redis cache TTLs

## Architecture

This is a **trust decision engine** for banking/fintech. Every customer action request goes through a pipeline:

```
POST /trust/decision
  → decisionEngine.js   (orchestrates the pipeline)
  → confidenceEngine.js (computes risk level + effective confidence from signals)
  → policyEngine.js     (evaluates ordered decision rules → ALLOW / STEP_UP / DENY / MANUAL_REVIEW)
  → idvRouting.js       (if step_up_type=IDV, selects vendor via routing strategy)
  → analytics.js        (records decision to in-memory ring buffer + decisions.jsonl)
```

### Key design principles

**Policy-driven, not code-driven.** All risk bands, confidence formulas, and decision rules live in `policies/*.json`, not in code. Changing behavior means editing JSON, not JavaScript.

**Data stores hold raw scores only.** `data/store.js` provides users (fraud_score, geography), devices (device_score), actions (tier, required_confidence, required_al), and authenticators (confidence_level, assurance_level). Risk classification happens in policy.

**Dual data sources.** `data/store.js` transparently switches between Google Sheets (when `GOOGLE_SHEETS_SPREADSHEET_ID` is set) and local JSON files in `data/`.

### Policy files (`policies/`)

- **`confidence.json`** — Defines: risk level bands (fraud score → LOW/MEDIUM/HIGH), action tier requirements (required confidence per tier), Auth Assurance Level (AL1–AL4) requirements per tier, and the effective confidence formula: `(deviceScore/100 × deviceWeight) + ((100-fraudScore)/100 × fraudWeight)`. `deviceWeight + fraudWeight` must sum to 100.

- **`decisions.json`** — Ordered array of rules; first match wins. Each rule has a `condition` (can match on fraudScoreMin/Max, deviceScoreMin/Max, riskLevel, geography, actionTier, alMeetsRequired, confidenceMeetsAction, currentAuthLevelLessThan, velocity_1m_gt, velocity_5m_gt, velocity_15m_gt) and produces a `decision` + optional `step_up_type`. Dynamic step_up_type tokens: `AL_PLUS_1` (one AL above required) and `REQUIRED_AL` (exact required AL). Velocity rules (`deny_velocity_burst`, `manual_review_velocity_elevated`) require Redis.

- **`idvRouting.json`** — IDV vendor routing strategies: `round_robin`, `percent_split`, `time_based`, `geo_based`. Active strategy set by `active_strategy`.

### Auth Assurance Levels (AL hierarchy)

`AL1` (passcode/FaceID) < `AL2` (passkey) < `AL3` (selfie) < `AL4` (IDV). Mapped to step-up types: `AL1→PASSCODE`, `AL2→PASSKEY`, `AL3→SELFIE`, `AL4→IDV`.

### Caching (`cache.js`)

Redis-backed, no-op when Redis is unavailable. Caches fraud scores (key: `fraud:{customerId}:{action}:{deviceId}`) and device scores (key: `device:{deviceId}`). The same Redis client is shared with `velocityEngine.js` for sorted-set velocity tracking.

### Policy cache invalidation

Each policy module (`confidenceEngine`, `policyEngine`, `idvRouting`) caches its parsed JSON in memory. `PATCH /policies/*` endpoints call `clearCache()` on the relevant module after writing the updated file.

### Decision log

Every decision is written to `decisions.jsonl` (append-only JSONL) and an in-memory ring buffer (last 500). `GET /decisions` reads from the file; `GET /analytics` aggregates the ring buffer. The comment in `analytics.js` notes the Postgres upgrade path.

### Adapters (`adapters/`)

`fraudAdapter.js` and `deviceAdapter.js` are thin wrappers over `data/store.js` — currently used for direct lookups but designed as extension points for external fraud/device scoring APIs.

## API surface

| Method | Path | Description |
|--------|------|-------------|
| POST | `/trust/decision` | Main decision endpoint. Body: `{ customer_id, action, device_id, current_auth_level? }` |
| GET | `/data/users\|devices\|actions\|authenticators` | Raw data inspection |
| GET/PATCH | `/policies/confidence` | Confidence policy (PATCH supports partial merge; validates weights sum to 100) |
| GET/PATCH | `/policies/decisions` | Decision rules (PATCH merges rules by `id`) |
| GET/PATCH | `/policies/idvRouting` | IDV routing policy |
| POST | `/policies/velocity-toggle` | Toggle velocity rules on/off. Body: `{ "enabled": true\|false }` |
| GET | `/analytics` | Aggregated decision stats (optional `?customer_id=` filter) |
| DELETE | `/analytics` | Clear in-memory ring buffer |
| GET | `/decisions` | Paginated decision log from JSONL. Params: `limit`, `offset`, `customer_id`, `decision` |
| GET | `/status` | Redis/velocity/Sheets availability |

The frontend (`public/index.html`) is a single-page app served statically.
