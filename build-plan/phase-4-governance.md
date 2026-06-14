# Phase 4 — Policy Governance + Rule Feedback Loop

## Objective
Make the platform auditable and self-improving. Every policy change is versioned with a rollback path. Rule performance is tracked automatically (which rules fire, which are dead weight, which cause friction that customers abandon). A bank's model risk team could audit this system. Customer-facing reason messages are visible in the simulator.

## Prerequisites
Phases 1–3 complete. Postgres must be configured (DATABASE_URL set) — policy versions require it. Read CLAUDE.md fully.

## Current state
- Policy changes via PATCH overwrite the JSON file with no history
- No rollback capability
- `analytics.js` records outcome (APPROVED/DENIED) but this data isn't aggregated per rule
- The `display_message` field was added to decisions.json rules in Phase 2 but nothing reads it yet
- No draft/publish workflow — every PATCH goes live immediately

## Tasks

### 1. Policy versioning module

Create `policyVersioning.js`:

```javascript
// Save a new version of a policy (called automatically on every successful PATCH)
async function saveVersion(policyName, content, { author, simulationSummary } = {})

// Get version history for a policy
async function getVersions(policyName, limit = 20)
// Returns: [{ id, version_number, author, created_at, simulation_summary, content_hash }]

// Get a specific version's full content
async function getVersion(policyName, versionId)

// Rollback: writes content to policy JSON file + clears engine cache
async function rollback(policyName, versionId)
// Returns: { ok, version, previous_version }

// Compute a human-readable diff between two versions (rules added/removed/changed)
function diffVersions(versionA, versionB)
// Returns: { added: [], removed: [], modified: [], unchanged_count: N }
```

Uses the `policy_versions` table created in Phase 1.

Version numbering: auto-increment per policy_name (query MAX(version_number) + 1).

`diffVersions()` compares rules arrays by `id`:
- `added`: rules in B not in A
- `removed`: rules in A not in B
- `modified`: rules in both but with any field changed (compare JSON.stringify)
- `unchanged_count`: count of rules identical in both

### 2. Wire versioning into server.js policy endpoints

In every successful PATCH handler (`/policies/decisions`, `/policies/confidence`, `/policies/idvRouting`):
- After writing the file and clearing cache, call `policyVersioning.saveVersion()`
- Pass `author: req.apiKeyId || 'anonymous'` (from Phase 1 API key middleware)
- If a simulation was run as part of a Policy Lab publish, pass `simulationSummary` from that result
- Do NOT fail the PATCH if versioning fails — catch and log, return the PATCH result either way

New endpoints in `server.js`:

```
GET  /policies/:name/history          — list versions (limit=20)
GET  /policies/:name/history/:id      — get full version content
POST /policies/:name/rollback/:id     — rollback to version (requires API key)
GET  /policies/:name/diff/:idA/:idB  — diff two versions
```

Where `:name` is `decisions`, `confidence`, or `idvRouting`.

### 3. Rule performance tracking

Create `rulePerformance.js`:

Computes per-rule metrics by querying Postgres:

```javascript
// Get performance stats for all rules over a time window
async function getRuleStats(windowHours = 48)
// Returns array of:
// {
//   rule_id,
//   fired: N,           // primary decisions where outcome IS NULL
//   step_ups_issued: N, // decisions where decision='STEP_UP'
//   step_ups_completed: N, // outcome='APPROVED' records linked via original_reference_id
//   step_ups_denied: N,   // outcome='DENIED'
//   manual_reviews: N,
//   precision: 0.0–1.0,  // step_ups_completed / step_ups_issued (null if 0 issued)
//   friction_rate: 0.0–1.0, // (step_ups_issued - step_ups_completed) / step_ups_issued
//   last_fired_at: timestamp or null
// }
```

SQL pattern for completion rate:
```sql
SELECT
  d.rule_id,
  COUNT(*) FILTER (WHERE d.outcome IS NULL) as fired,
  COUNT(*) FILTER (WHERE d.decision = 'STEP_UP' AND d.outcome IS NULL) as step_ups_issued,
  COUNT(*) FILTER (WHERE d.decision = 'STEP_UP' AND d.outcome = 'APPROVED') as step_ups_completed,
  MAX(d.timestamp) FILTER (WHERE d.outcome IS NULL) as last_fired_at
FROM decisions d
WHERE d.timestamp > $1
GROUP BY d.rule_id
```

Dead rule detection: any rule in `policies/decisions.json` that has `last_fired_at IS NULL` or `last_fired_at < now() - 48hr` is flagged as a dead/dormant rule.

High-friction rule detection: `friction_rate > 0.5` (more than half of issued step-ups are abandoned).

Run stats computation:
- Computed on-demand via `GET /analytics/rules`
- Also computed by a lightweight `setInterval` every 30 minutes in `server.js` — results cached in memory, served from cache on subsequent requests

Add to `server.js`:
```
GET /analytics/rules   — returns rule performance stats (last 48h default, ?window=24 to override)
```

### 4. Analytics tab — Rule Performance section

In `public/index.html`, add a "Rule Performance" section at the bottom of the Analytics tab:

Table with columns: Rule ID | Fired (48h) | Step-ups Issued | Completion Rate | Friction Rate | Status

Status badge logic:
- `🟢 Healthy`: completion rate > 70%
- `🟡 High friction`: friction rate > 50%
- `⚪ Dormant`: not fired in 48h
- `🔴 Dead`: never fired (exists in policy but 0 records)

Add a small visual indicator on the rule rows in the Control Panel decision rules list — a dot showing each rule's health status (populated from the same /analytics/rules data).

### 5. Customer-facing transparency

The `display_message` field was added to decisions.json rules in Phase 2. Now surface it:

New endpoint in `server.js`:
```
GET /trust/decision/explain/:reference_id
```
Returns:
```json
{
  "reference_id": "TXN-20260613-AB12",
  "decision": "STEP_UP",
  "step_up_type": "SELFIE",
  "display_message": "We noticed you're using a VPN. A quick selfie check keeps your account safe.",
  "reason": "VPN detected on high-value action; selfie verification required.",
  "rule_id": "step_up_vpn_high_tier",
  "timestamp": 1718270000000
}
```

Reads from Postgres using `reference_id`. Returns 404 if not found.

In `public/index.html` Decision Simulator output:
- Show `display_message` prominently as "Customer sees:" in a distinct styled box (simulating what the customer's app would show)
- Show `reason` as "Internal reason:" below it in smaller muted text
- This makes it clear these are two separate strings: one customer-facing, one for ops

### 6. Policy draft / publish workflow

This is intentionally lightweight — not a full approval workflow, just a "review before going live" gate.

In `server.js`, add:
```
POST /policies/decisions/draft      — saves proposed config to draft_decisions.json (not active)
GET  /policies/decisions/draft      — returns current draft (if any)
POST /policies/decisions/publish    — moves draft to decisions.json, saves version, fires simulation
DELETE /policies/decisions/draft    — discard draft
```

Draft is stored as `policies/draft_decisions.json` (gitignored if you want, or tracked).
Publishing triggers an automatic simulation and saves the simulation summary in the version record.

In `public/index.html` Policy Lab tab:
- Add "Save as Draft" button alongside "Simulate" and "Publish"
- Draft indicator: if draft exists, show a banner "⚠ Draft pending — review before publishing"
- Draft preview: show the diff against current live policy

### 7. Policy Lab tab — History panel

Add a "History" section in the Policy Lab tab (below the simulation results):

- "Version History" collapsible panel
- Shows last 10 versions: timestamp, author, rules changed (from diff), decision mix change summary
- Each version has a "View diff" button (shows added/removed/modified rules inline)
- Each version has a "Rollback to this version" button with a confirmation dialog
- After rollback: shows success toast + reruns simulation automatically to confirm the rollback worked

### 8. Auto-update known device IDs on step-up completion

Phase 2 added `known_device_ids: []` to each user in `data/users.json` and uses it for `is_new_device` detection. But nothing ever writes back to it — every device stays "new" forever. Close the loop here.

In `server.js`, in the existing step-up completion handler (wherever `POST /trust/step-up/complete` or equivalent records `outcome: APPROVED`):

After recording the outcome to analytics, call:
```javascript
// Promote the device to "known" for this customer
await store.addKnownDevice(customer_id, device_id);
```

Add `addKnownDevice(customerId, deviceId)` to `data/store.js`:
- Reads the current user from `data/users.json` (or Sheets if configured)
- If `known_device_ids` doesn't include `deviceId`, appends it and writes back to the JSON file
- Max 20 known devices per user — if exceeded, drop the oldest entry (shift)
- No-op if the user isn't found or `device_id` is null
- If Google Sheets is the data source: update the `known_device_ids` column (store as JSON string in the cell)

Why this matters: without it, `ambientTrustStore.recordSuccess()` (Phase 5) fires on completion but `is_new_device` stays true indefinitely, sending conflicting signals to the policy engine. With it, a device becomes "known" after the customer's first verified completion — exactly the right trust accumulation semantics.

Add `known_device_ids` to the session snapshot in `sessionStore.js` so the completion handler has access to the device that was used in the original decision.

## Technical decisions — do not deviate
- `policyVersioning.js` requires Postgres — if DATABASE_URL not set, `saveVersion()` is a no-op, `getVersions()` returns `[]`, rollback returns an error
- Diffs are computed in-process from the stored JSON — no external diff library
- Rule performance stats use a 48-hour window by default (configurable via query param)
- The draft workflow uses a file (`policies/draft_decisions.json`), not DB — simple, survives restarts
- `setInterval` for stats refresh runs every 30 minutes — not a cron job, restarts with the server
- `addKnownDevice()` writes to the local JSON file synchronously — Sheets write is fire-and-forget

## Success criteria
1. Make a PATCH to `/policies/decisions`, then `GET /policies/decisions/history` returns 1 version
2. Make another PATCH, rollback to version 1 — live policy reverts correctly
3. `GET /analytics/rules` returns per-rule stats after running some traffic
4. Dormant rules (those in policy but not fired in 48h) are flagged in the response
5. Decision Simulator shows `display_message` as "Customer sees:" for a STEP_UP decision
6. `GET /trust/decision/explain/TXN-xxx` returns the display message for a stored decision
7. Policy Lab shows version history and rollback works from the UI
8. After a step-up APPROVED outcome, the device_id appears in `known_device_ids` for that user in data/users.json
9. Firing a second decision for the same customer+device now shows `is_new_device: false` in the enrichment trace

## Deployment
Standard rsync. No new env vars in this phase — uses Postgres from Phase 1 and API keys from Phase 1.

After deploy, run: the first PATCH to any policy will create the first version entry automatically.
