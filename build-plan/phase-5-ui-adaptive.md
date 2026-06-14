# Phase 5 — UI Overhaul + Adaptive AuthN

## Objective
Transform the frontend from a multi-tab prototype into a professional-grade operations product. Introduce sidebar navigation, proper data visualisations, a polished design system, and the Ambient Trust Score — the core of the "context and risk adaptive authN" concept. This is the Level 4 state.

## Prerequisites
Phases 1–4 complete. All backend features must be working. Read CLAUDE.md fully.

## Current state
- `public/index.html` is a single file ~1900+ lines, growing unwieldy
- Navigation is a top tab bar (5–6 tabs, becoming cluttered)
- Analytics tab has basic counters — no charts
- No sidebar, no grouping of related functions
- Ambient Trust Score concept doesn't exist yet

## Architecture decision: keep it one file
`public/index.html` remains a single file served statically. Do NOT split into JS modules, a build system, or React — this adds operational complexity with no demo benefit. Instead, organise the single file into clearly commented sections.

## Design system (apply consistently throughout)

**Layout**: Left sidebar (220px fixed) + main content area. Sidebar collapses to icon-only on viewport < 900px.

**Colour palette** (extend existing CSS variables — keep what's there, add):
```css
--sidebar-bg: #0f1117;
--sidebar-border: #1e2436;
--sidebar-item-hover: rgba(255,255,255,.05);
--sidebar-item-active: rgba(255,107,107,.1);
--sidebar-active-indicator: #ff6b6b;
--chart-1: #4d9fff;
--chart-2: #00d4aa;
--chart-3: #ffb347;
--chart-4: #b794f4;
--chart-5: #ff6b6b;
--risk-low: #00d4aa;
--risk-medium: #ffb347;
--risk-high: #ff6b6b;
--decision-frictionless: #00d4aa;
--decision-stepup: #ffb347;
--decision-deny: #ff6b6b;
--decision-manual: #b794f4;
```

**Typography**: Keep existing font stack. Add:
- Page titles: 18px, weight 700
- Section headings: 13px, weight 600, uppercase, letter-spacing .06em, color var(--muted)
- Body: 13px
- Monospace: 11px for reference IDs, rule IDs, JSON

**Cards**: Consistent padding 20px, border-radius 10px, 1px border var(--border).

**Empty states**: Every list/table must have a designed empty state (icon + title + subtitle). No raw "no data" text.

**Loading states**: Skeleton loaders (animated shimmer) on all async loads — not spinners.

## Tasks

### 1. Sidebar navigation

Replace the top `<nav class="tab-nav">` with a left sidebar. The sidebar has three navigation groups:

**Operations**
- 📺 Monitor (live feed)
- 🔬 Simulator (decision tester)
- 📋 Decisions Log (paginated history)

**Policy**
- 🧪 Policy Lab (simulate + AI copilot)
- 📜 Policy History (versions + rollback)

**Intelligence**
- 📊 Analytics (charts + stats)
- 📐 Rule Performance (per-rule health)

**System**
- ⚙️ Settings (adapters, keys, daemon)
- 🔴 Status (live health badges)

Sidebar items show: icon + label (expanded) or icon only (collapsed).
Active item: left border in var(--coral) + subtle background.
Collapse toggle: chevron button at bottom of sidebar.

Keep sidebar state (expanded/collapsed) in localStorage.

Header changes: remove tab badges from header (move review queue badge to sidebar Monitor item). Keep theme toggle and status badges (Redis, Postgres, Sheets) in top-right of header.

### 2. Split Review Queue into Decisions Log

Rename "Review Queue" → two separate sections:
- **Decisions Log** (Operations group): full paginated decision history with filters (customer, action, decision type, date range). Replaces the current `GET /decisions` table.
- **Review Queue** moves inside the Monitor section as a panel — it's an operational view, not a top-level nav item.

### 3. Analytics tab — full redesign

Replace the current counters-only layout with:

**Row 1 — Summary cards** (4 across):
- Total decisions (last 7 days)
- Frictionless rate % (with trend arrow vs previous 7 days)
- Step-up completion rate %
- Active rules count / dormant rules count

**Row 2 — Decision trend chart** (full width):
- Chart.js line chart, last 7 days, one line per decision type
- Load Chart.js from `https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js`
- Data from `GET /analytics` — aggregate by day client-side from the decisions array
- If < 2 days of data: show "Not enough history yet" message with a button to generate traffic

**Row 3 — Two columns:**
- Left: Risk distribution donut chart (LOW/MEDIUM/HIGH, Chart.js doughnut)
- Right: Top 10 actions by friction rate (horizontal bar chart — actions sorted by % step-up)

**Row 4 — Geographic breakdown:**
- CSS grid of flag + country + count cards (no external map lib needed)
- Sorted by count descending

**Row 5 — Rule Performance** (previously a separate task, integrate here):
- Table from Phase 4 `GET /analytics/rules` data
- Health badges per rule
- Link to Policy Lab filtered to that rule

### 4. Decision Simulator — full upgrade

Current simulator is functional but dense. Redesign the layout:

**Left panel** (inputs):
- Customer, Action, Device dropdowns — same as now
- Auth Level selector — same
- New: "IP Override" text field (for testing enrichment — enter any IP to simulate that location)
- New: "Scenario" dropdown — None, VPN User, Breached Email, New Device, Tor Exit Node (pre-fills signals)
- Submit button with loading state

**Right panel** (output — tabbed within the panel):
Tab 1: **Decision** — the outcome card (existing FRICTIONLESS/STEP_UP/DENY/MANUAL badge), reference ID, customer sees message (display_message from Phase 4), reason
Tab 2: **Signals** — enrichment panel (IP, geo, abuse score, breach status, device trust, ATS)
Tab 3: **Trace** — the existing rule evaluation trace, but redesigned as a visual pipeline (each rule as a row with ✓ matched / ✗ skipped, with condition values)
Tab 4: **Raw** — raw JSON response (collapsible)

### 5. Ambient Trust Score

This is the core adaptive authN concept. Implement it as a demonstration that shows the idea working.

Create `ambientTrustStore.js`:

```javascript
// Get a customer's current ambient trust score (0–100)
async function getScore(customerId)
// Default for new customers: 50

// Record a successful step-up completion — trust increases
async function recordSuccess(customerId, authLevel)
// AL1 completion: +2, AL2: +3, AL3: +5, AL4: +8
// Max: 95

// Record a suspicious signal — trust decreases
async function recordSuspicion(customerId, signalType)
// new_device: -10, vpn_detected: -5, breach_detected: -15, velocity_burst: -20
// Min: 5

// Decay: trust drifts toward baseline (50) at 2 points/day
// Run this as a setInterval in server.js (every 6 hours)
async function applyDecay()
```

Storage: Redis hash `ats:${customerId}`, field `score`. If Redis unavailable: `ambientTrustStore` is a no-op (returns 50 for all).

Wire into `decisionEngine.js`:
- After enrichment, fetch `ambientTrustStore.getScore(customer_id)` (non-blocking, fallback 50)
- Add `ambientTrustScore` to context
- After a successful step-up completion (in `POST /trust/step-up/complete`): call `ambientTrustStore.recordSuccess()`
- When enrichment signals fire suspicious flags: call `ambientTrustStore.recordSuspicion()`

New condition key in `policyEngine.js`:
- `ambient_trust_gte: number` — true if context.ambientTrustScore >= N
- `ambient_trust_lte: number` — true if context.ambientTrustScore <= N

Add to `VALID_CONDITION_KEYS`.

Example rules to add to decisions.json to demonstrate the concept:
```json
{
  "id": "frictionless_high_ambient_trust",
  "enabled": true,
  "description": "Frictionless allow: very high ambient trust (90+) on Tier1/Tier2 — loyal customer skip step-up",
  "condition": { "ambient_trust_gte": 90, "actionTier": ["Tier1", "Tier2"] },
  "decision": "ALLOW",
  "reason": "High ambient trust from consistent behaviour; no additional authentication required.",
  "display_message": "All good — your account history confirms it's you."
},
{
  "id": "step_up_low_ambient_trust",
  "enabled": true,
  "description": "Step-up: low ambient trust (under 30) regardless of action tier",
  "condition": { "ambient_trust_lte": 30 },
  "decision": "STEP_UP",
  "step_up_type": "AL_PLUS_1",
  "reason": "Low ambient trust from recent suspicious signals; additional verification required.",
  "display_message": "For your security, we need a quick check — your recent account activity flagged a concern."
}
```

In the Decision Simulator Signals tab:
- Show Ambient Trust Score as a visual meter (0–100 coloured bar: red < 30, amber 30–70, green > 70)
- Show history: "+3 (passkey completion 2h ago)", "-10 (new device detected yesterday)"
- Show trajectory: "↑ Building" / "→ Stable" / "↓ Declining"

### 6. Settings tab

New section in sidebar under System > Settings:

**Intelligence Adapters** section:
- Each adapter (ip-api, AbuseIPDB, HIBP, GreyNoise): configured (green ✓) / not configured (grey —)
- Cache stats: hit rate, last call timestamp (from a new `GET /status/adapters` endpoint)

**Traffic Daemon** section:
- Status: running / stopped (from PM2 or a simple health check to the daemon)
- Start/Stop button (calls `POST /dev/daemon/start` and `/stop` — only if `NODE_ENV !== 'production'`)
- Current attack schedule: next attack scenario ETA

**API Keys** section:
- Show configured key IDs (masked: `sk-trust-abc...`) — not full keys
- Copy button for each key ID

**System** section:
- Redis status (connected / disconnected / no URL configured)
- Postgres status (connected / disconnected / no URL configured)
- Sheets status (configured / not configured)
- Node.js version, uptime

Add `GET /status/adapters` endpoint to server.js:
```json
{
  "ip_enrichment": { "configured": true, "cache_hits": 142, "last_call_ms_ago": 3200 },
  "abuseipdb": { "configured": false },
  "hibp": { "configured": true, "cache_hits": 58, "last_call_ms_ago": 180000 },
  "greynoise": { "configured": true, "cache_hits": 89, "last_call_ms_ago": 45000 }
}
```

Track `cache_hits` and `last_call` as in-memory counters in each adapter module.

### 7. Responsive layout

The sidebar should collapse to icons only at viewport width < 900px (CSS media query).
All card grids should stack to single column at < 600px.
Decision feed rows should truncate long values with ellipsis at narrow widths.
This ensures the demo works on a laptop screen and is presentable on a tablet.

### 8. Polish pass (do this last)

- Every async load has a skeleton shimmer state (CSS animation, no external lib)
- Every empty list/table has a designed empty state with an icon
- All action buttons have loading states (disabled + spinner text while pending)
- Toast messages are consistent (success=green, error=red, info=blue)
- The "🧪" and "📺" emoji in nav items — remove if they look unprofessional in context, use SVG icons instead (inline SVG, simple icons for each nav item)
- Ensure light/dark theme toggle (already exists) works correctly with all new components

### 9. Daemon control endpoints

Phase 3 built the traffic daemon and the Settings tab (task 6 above) shows Start/Stop buttons — but the backend endpoints those buttons call don't exist yet. Add them now.

In `server.js`, only when `ENABLE_ATTACK_TRIGGERS=true` or `NODE_ENV !== 'production'`:

```
POST /dev/daemon/start   — starts the trust-traffic PM2 process
POST /dev/daemon/stop    — stops the trust-traffic PM2 process
GET  /dev/daemon/status  — returns { running: boolean, uptime_sec: number|null }
```

Implementation: use the `pm2` npm package in programmatic mode:
```javascript
const pm2 = require('pm2');

app.post('/dev/daemon/start', (req, res) => {
  pm2.connect(err => {
    if (err) return res.status(500).json({ error: err.message });
    pm2.start({ name: 'trust-traffic', script: 'scripts/traffic-daemon.js' }, (err) => {
      pm2.disconnect();
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true, action: 'started' });
    });
  });
});
// Similar pattern for stop and status
```

If PM2 is not installed or connect fails (e.g. local dev without PM2): return `{ ok: false, reason: 'PM2 not available — start daemon manually: node scripts/traffic-daemon.js' }` with a 200 (not 500) — graceful degradation.

Add `GET /dev/daemon/status` result to `GET /status` response so the Settings tab can poll a single endpoint.

### 10. A/B policy experiment framework

Enables two policy configs to run side-by-side on real traffic, split deterministically by customer. Essential for validating ATS threshold changes before full rollout.

Create `abExperiment.js`:

```javascript
// Assign a customer to a variant (deterministic — same customer always gets same variant)
function assignVariant(customerId, experimentId, splitPct = 50) {
  const hash = require('crypto').createHash('md5').update(`${experimentId}:${customerId}`).digest('hex');
  const bucket = parseInt(hash.slice(0, 8), 16) % 100;
  return bucket < splitPct ? 'treatment' : 'control';
}

// Get the active experiment (if any)
function getActiveExperiment()

// Set/clear the active experiment
function setExperiment({ id, name, treatmentConfig, splitPct })
function clearExperiment()
```

Store the active experiment in memory (not Redis — experiments are operator-session scoped, not persistent). `treatmentConfig` is a full decisions policy config object.

Wire into `decisionEngine.js`:
```javascript
const experiment = abExperiment.getActiveExperiment();
if (experiment) {
  const variant = abExperiment.assignVariant(customer_id, experiment.id, experiment.splitPct);
  const config = variant === 'treatment' ? experiment.treatmentConfig : null; // null = live config
  // Pass config to policyEngine.evaluateWith() — or evaluate() for control
  const policyResult = config
    ? policyEngine.evaluateWith(config, context)
    : policyEngine.evaluate(context);
  // Tag the analytics record with variant
  analyticsExtra.experiment_id = experiment.id;
  analyticsExtra.variant = variant;
}
```

Add `experiment_id` and `variant` columns to the `decisions` Postgres table (ALTER TABLE, nullable). JSONL records include them as optional fields.

New endpoints in `server.js`:
```
POST /experiments/start    — body: { id, name, treatmentConfig, splitPct }
DELETE /experiments/active — clear active experiment
GET  /experiments/active   — return current experiment config
GET  /experiments/results  — query Postgres for decision mix by variant (for active experiment id)
```

In the Policy Lab tab, add an "A/B Test" button alongside "Simulate Impact":
- Clicking it starts an experiment using the current Policy Lab editor config as `treatmentConfig`
- A banner appears: "🧪 A/B experiment active — X% treatment / Y% control"
- Results panel shows: side-by-side decision mix (control vs treatment) updated live from `GET /experiments/results`
- "Stop Experiment" button clears and shows final result summary

Why `splitPct=50` default: equal split maximises statistical power. Let the operator adjust if they want a cautious 10% canary rollout.

Success criteria for A/B framework:
- Start an experiment via Policy Lab, fire 100 decisions via the daemon — `GET /experiments/results` shows two distinct decision mixes
- The same customer_id always gets the same variant (deterministic hash confirmed across restarts)
- Clearing the experiment reverts all traffic to live policy immediately

## Technical decisions — do not deviate
- `public/index.html` stays as one file — no build system, no React, no module bundler
- Chart.js only (from cdnjs) — no D3, no Recharts, no other charting lib
- No CSS framework (Tailwind, Bootstrap) — keep the existing custom CSS design system and extend it
- Ambient Trust Score in Redis only — no Postgres table (it's ephemeral, can rebuild)
- Sidebar state persisted in localStorage under key `sidebar_collapsed`
- SVG icons inline in HTML — 20x20px, stroke-based, consistent stroke-width 1.5
- A/B experiment state is in-memory only — clears on server restart (intentional — experiments are operator-session scoped)
- Daemon control endpoints require PM2 to be installed (`npm install pm2 -g`) — gracefully degrade if not available
- `assignVariant()` uses MD5 hash for speed — not cryptographic, just deterministic bucketing

## Success criteria
1. The sidebar renders with all nav groups and items, active item highlighted
2. Navigating to Analytics shows at least one Chart.js chart with data
3. Decision Simulator shows the 4-tab output panel (Decision / Signals / Trace / Raw)
4. Ambient Trust Score is visible in the Signals tab for every simulator decision
5. Running traffic for 10 minutes and then viewing the Monitor shows decisions streaming live
6. Loyal persona (Lara) after 20+ completions has ATS > 80 and gets FRICTIONLESS on Tier1/Tier2
7. Settings tab shows all adapter statuses correctly
8. Layout works at 1280px and 768px viewport width
9. `POST /dev/daemon/start` starts the traffic daemon; `GET /dev/daemon/status` returns `{ running: true }`
10. Start an A/B experiment with a variant policy, fire 50 decisions — `GET /experiments/results` shows split by variant with different decision mixes
11. Same customer_id always lands in the same variant (fire 10 requests, confirm variant is stable)

## Deployment
Standard rsync. No new env vars. After deploy:
- `pm2 restart trust-platform`
- Run decay interval: starts automatically as `setInterval` in server.js

## Final state — what Level 4 looks like
- Open the sidebar: a proper operations product, not a prototype
- Monitor tab: decisions streaming live, attack scenarios triggerable, real-time rule firing heatmap
- Run a credential stuffing attack: watch velocity DENY cascade in real-time
- Open the Simulator: enter Lara (ATS=92), wire transfer — FRICTIONLESS (adaptive authN working)
- Switch to Harvey (new device + VPN + breached email): ATO signals → IDV forced
- Policy Lab: type "block Tor users on any action" → Claude generates rule → simulate → 0.3% of traffic affected → publish
- Version history: see the last 10 policy changes with one-click rollback
- Rule Performance: see which rules are causing high friction and need tuning
