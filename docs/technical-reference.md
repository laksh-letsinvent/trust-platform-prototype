# Trust Platform — Technical Reference

## Overview

The Trust Platform is a Node.js (Express) service that evaluates every customer action against fraud signals, device trust, and authentication state to produce a real-time trust decision: **ALLOW**, **STEP_UP**, **DENY**, or **MANUAL_REVIEW**. All risk logic lives in JSON policy files — no hardcoded thresholds in application code.

---

## Architecture

### Decision Pipeline

Every `POST /trust/decision` call runs through this pipeline in sequence:

```
Request
  │
  ▼
decisionEngine.js        — Orchestrates all steps; builds the trace object
  ├── data/store.js      — Fetches user, device, action, authenticator records
  ├── cache.js           — Checks/sets Redis cache for fraud + device scores
  ├── velocityEngine.js  — Reads velocity counts; records this request
  ├── confidenceEngine.js— Computes riskLevel, effectiveConfidence, AL checks
  ├── policyEngine.js    — Evaluates ordered rules → decision + step_up_type
  ├── idvRouting.js      — (if step_up_type=IDV) Selects IDV vendor
  └── analytics.js       — Appends to ring buffer + decisions.jsonl
```

### Module Responsibilities

| Module | File | Responsibility |
|--------|------|----------------|
| Decision orchestrator | `decisionEngine.js` | Wires all modules; builds full trace; generates reference IDs |
| Confidence engine | `confidenceEngine.js` | Maps fraud score → risk level; computes effective confidence; checks AL hierarchy |
| Policy engine | `policyEngine.js` | Evaluates `decisions.json` rules in order; resolves dynamic step_up_type tokens |
| IDV routing | `idvRouting.js` | Selects IDV vendor from `idvRouting.json` using one of four strategies |
| Velocity engine | `velocityEngine.js` | Redis sorted-set based request rate tracking per customer |
| Cache | `cache.js` | Redis-backed fraud/device score cache; exposes shared client to velocity engine |
| Data store | `data/store.js` | Transparent abstraction over Google Sheets or local JSON files |
| Analytics | `analytics.js` | In-memory ring buffer (last 500) + `decisions.jsonl` persistence |
| HTTP server | `server.js` | Express routes; policy file read/write; Sheets sync |

---

## API Reference

### Trust Decision

```
POST /trust/decision
```

**Request body**

```json
{
  "customer_id": "cust_retail_001",
  "action": "bill_pay",
  "device_id": "dev_iphone_001",
  "current_auth_level": "AL2"
}
```

`current_auth_level` is optional. When provided, it must match an authenticator `id` in the data store (`AL1`–`AL4`).

**Response**

```json
{
  "decision": "ALLOW",
  "step_up_type": null,
  "reason": "Low fraud risk and authentication level sufficient for this action.",
  "reference_id": null,
  "idv_vendor": null,
  "idv_routing": null,
  "trace": { ... }
}
```

Decision values: `ALLOW` | `STEP_UP` | `DENY` | `MANUAL_REVIEW`

Step-up types: `PASSCODE` | `PASSKEY` | `SELFIE` | `IDV`

`reference_id` is generated for actionable decisions only:
- `STEP_UP` → `TXN-YYYYMMDD-XXXX`
- `MANUAL_REVIEW` → `CASE-YYYYMMDD-XXXX`
- `DENY` → `INC-YYYYMMDD-XXXX`

The `trace` object contains the full step-by-step audit trail: data lookups, signal values, confidence calculations, and every rule evaluated.

---

### Data Endpoints

```
GET /data/users
GET /data/devices
GET /data/actions
GET /data/authenticators
```

Returns the full contents of each data collection (from Sheets or JSON).

---

### Policy Endpoints

All policy reads return the current JSON. Writes are partial merges (deep merge for confidence/idvRouting; merge-by-id for decision rules).

#### Confidence policy

```
GET  /policies/confidence
PATCH /policies/confidence
```

Validation: `effectiveConfidence.deviceWeight + fraudWeight` must equal 100.

Optional query param: `?sync_sheets=true` — writes the updated policy to the Google Sheets `ControlPanel` tab.

#### Decision rules

```
GET  /policies/decisions
PATCH /policies/decisions
```

When the request body contains a `rules` array, each rule is merged by `id` (existing rules not in the patch are untouched). Top-level fields (e.g. `default`) are deep-merged separately.

#### IDV routing

```
GET  /policies/idvRouting
PATCH /policies/idvRouting
```

#### Velocity toggle (convenience)

```
POST /policies/velocity-toggle
Body: { "enabled": true | false }
```

Toggles both `deny_velocity_burst` and `manual_review_velocity_elevated` rules simultaneously.

---

### Decision Log

```
GET /decisions
```

Reads directly from `decisions.jsonl`. Results are returned most-recent-first.

Query params: `limit` (max 1000, default 100), `offset`, `customer_id`, `decision`

---

### Analytics

```
GET    /analytics?customer_id=<optional>
DELETE /analytics
```

`GET` returns aggregated counts from the in-memory ring buffer. `DELETE` clears the buffer (the JSONL file is not truncated).

---

### System Status

```
GET /status
```

```json
{
  "redis": true,
  "velocityTracking": true,
  "sheetsConfigured": false
}
```

---

## Policy Files

### `policies/confidence.json`

Controls all risk and confidence computation. **No risk logic exists in application code.**

```jsonc
{
  "riskLevelBands": {
    "HIGH":   { "fraudScoreMin": 80 },
    "MEDIUM": { "fraudScoreMin": 26, "fraudScoreMax": 79 },
    "LOW":    { "fraudScoreMax": 25 }
  },
  "riskLevelOrder": ["HIGH", "MEDIUM", "LOW"],  // evaluation order; first match wins
  "defaultRiskLevel": "MEDIUM",

  "actionTierRequirements": {          // fallback required_confidence per tier
    "Tier1": 30, "Tier2": 55, "Tier3": 70, "Tier4": 90
  },
  "actionTierRequiredAL": {            // fallback required_al per tier
    "Tier1": "AL1", "Tier2": "AL2", "Tier3": "AL3", "Tier4": "AL4"
  },

  "effectiveConfidence": {
    "deviceWeight": 40,                // deviceWeight + fraudWeight must = 100
    "fraudWeight": 60,
    "useAuthenticatorMax": true        // clamp up to authenticator confidence_level
    // Formula: (deviceScore/100 × deviceWeight) + ((100-fraudScore)/100 × fraudWeight)
    // If useAuthenticatorMax=true: result = max(formula, authenticatorConfidence)
  }
}
```

Per-action `required_confidence` and `required_al` in the data store override tier defaults.

### `policies/decisions.json`

Ordered rule list. **First matching enabled rule wins.** If no rule matches, `default` is used.

```jsonc
{
  "rules": [
    {
      "id": "deny_velocity_burst",
      "enabled": true,
      "description": "...",
      "condition": { "velocity_1m_gt": 5 },
      "decision": "DENY",
      "reason": "..."
    }
  ],
  "default": {
    "decision": "STEP_UP",
    "step_up_type": "REQUIRED_AL",
    "reason": "..."
  }
}
```

**Available condition fields**

| Field | Type | Description |
|-------|------|-------------|
| `fraudScoreMin` / `fraudScoreMax` | number | Inclusive bounds on raw fraud score (0–100) |
| `deviceScoreMin` / `deviceScoreMax` | number | Inclusive bounds on device trust score (0–100) |
| `riskLevel` | string \| string[] | `LOW`, `MEDIUM`, or `HIGH` (derived from fraud score via confidence.json) |
| `geography` | string \| string[] | Country code from user record (e.g. `"UK"`, `["UK","IE"]`) |
| `actionTier` | string \| string[] | `Tier1`–`Tier4` |
| `requiredAL` | string | Exact required assurance level (`AL1`–`AL4`) |
| `alMeetsRequired` | boolean | Whether current_auth_level satisfies the action's required AL |
| `confidenceMeetsAction` | boolean | Whether effectiveConfidence ≥ requiredConfidence |
| `currentAuthLevelLessThan` | string | True if current AL index < named AL index |
| `velocity_1m_gt` | number | Requests in last 1 min > threshold (requires Redis) |
| `velocity_5m_gt` | number | Requests in last 5 min > threshold (requires Redis) |
| `velocity_15m_gt` | number | Requests in last 15 min > threshold (requires Redis) |

**Dynamic `step_up_type` tokens**

| Token | Resolves to |
|-------|-------------|
| `AL_PLUS_1` | Authenticator one AL level above the action's required AL |
| `REQUIRED_AL` | Authenticator that exactly satisfies the action's required AL |
| Literal (`PASSCODE`, `PASSKEY`, `SELFIE`, `IDV`) | Returned as-is |

AL → authenticator mapping: `AL1→PASSCODE`, `AL2→PASSKEY`, `AL3→SELFIE`, `AL4→IDV`

### `policies/idvRouting.json`

Selects an IDV vendor when `step_up_type=IDV`. `active_strategy` names which strategy to use.

| Strategy type | Behaviour |
|---------------|-----------|
| `round_robin` | Cycles through `vendors` array on each request |
| `percent_split` | Deterministic hash of `requestId` mod 100, matched against cumulative `splits[].percent` |
| `time_based` | Routes by UTC hour using `hour_start` / `hour_end` rules |
| `geo_based` | Matches request geography against `geography` arrays per rule; falls back to `default_vendor` |

---

## Data Schemas

### Users (`data/users.json` or Sheets "Users" tab)

```json
{ "customer_id": "cust_retail_001", "fraud_score": 12, "geography": "UK" }
```

`fraud_score`: 0–100 (higher = higher fraud risk). Default 50 when customer not found.

### Devices (`data/devices.json` or Sheets "Devices" tab)

```json
{ "device_id": "dev_iphone_001", "device_score": 92 }
```

`device_score`: 0–100 (higher = more trusted). Default 0 when device not found.

### Actions (`data/actions.json` or Sheets "Actions" tab)

```json
{ "id": "bill_pay", "name": "Bill pay", "tier": "Tier2", "required_al": "AL2", "required_confidence": 55 }
```

`required_al` and `required_confidence` override the tier defaults in `confidence.json`.

### Authenticators (`data/authenticators.json` or Sheets "Authenticators" tab)

```json
{ "id": "AL2", "name": "Passkey", "assurance_level": "AL2", "confidence_level": 65, "description": "..." }
```

The `id` field is what the request's `current_auth_level` is matched against.

---

## Auth Assurance Level (AL) Hierarchy

| Level | Authenticator | Confidence Level |
|-------|--------------|-----------------|
| AL1 | FaceID / Passcode | 45 |
| AL2 | Passkey (FIDO2) | 65 |
| AL3 | Selfie Check | 80 |
| AL4 | IDV (document + liveness) | 95 |

`alMeetsRequired` is true when `indexOf(currentAL) >= indexOf(requiredAL)`.

---

## Redis Usage

Redis is optional. When unavailable, the server starts normally with caching and velocity tracking disabled.

| Key pattern | Type | TTL | Used by |
|-------------|------|-----|---------|
| `fraud:{customerId}:{action}:{deviceId}` | String (JSON) | 300s (configurable) | `cache.js` |
| `device:{deviceId}` | String (JSON) | 600s (configurable) | `cache.js` |
| `velocity:{customerId}` | Sorted set (score=timestamp ms) | 1800s safety TTL | `velocityEngine.js` |

Velocity sorted sets are trimmed on every write — entries older than 15 minutes are removed via `ZREMRANGEBYSCORE`. Counts are retrieved with `ZCOUNT` over 1m/5m/15m windows.

---

## Data Source: Google Sheets

When `GOOGLE_SHEETS_SPREADSHEET_ID` is set, `data/store.js` uses Sheets for all reads. JSON files in `data/` are the fallback.

**One-time setup:**

```bash
GOOGLE_APPLICATION_CREDENTIALS=./credentials.json node scripts/setup-google-sheet.js
```

Creates the spreadsheet with Users, Devices, Actions, Authenticators, and ControlPanel tabs. Prints the `SPREADSHEET_ID` to copy into `.env`.

Service account needs: `spreadsheets` and `drive.file` OAuth scopes.

Sheet data is cached in-process for `SHEETS_CACHE_MS` (default 60 000 ms).

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listen port |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `CACHE_FRAUD_TTL_SEC` | `300` | Fraud score cache TTL |
| `CACHE_DEVICE_TTL_SEC` | `600` | Device score cache TTL |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | — | Enables Sheets data source |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | Path to service account key JSON |
| `GOOGLE_SHEETS_CREDENTIALS_PATH` | — | Alternative to `GOOGLE_APPLICATION_CREDENTIALS` |
| `SHEETS_CACHE_MS` | `60000` | In-process Sheets cache duration |

---

## Extending the System

### Adding a decision rule

Edit `policies/decisions.json`. Add a new object to `rules` at the desired priority position (earlier = higher priority). Use any combination of condition fields. The server picks up changes on the next policy write via `clearCache()` — no restart needed when using the API.

### Adding an action tier

Add the tier name to `confidence.json` under `actionTierRequirements` and `actionTierRequiredAL`, then add actions with that tier to the data store.

### Swapping analytics to Postgres

In `analytics.js`, replace the `fs.appendFileSync` call with a `pg.query('INSERT INTO decisions ...')`. The comment in the file marks the exact line.

### Adding an external fraud/device score API

The `adapters/fraudAdapter.js` and `adapters/deviceAdapter.js` files are thin wrappers designed as the integration point. Swap the `store` lookup for an HTTP call to your external API. `decisionEngine.js` fetches scores through `cache.js`, so the cache layer applies automatically.
