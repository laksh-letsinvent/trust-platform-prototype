# Phase 5 — UI Overhaul (on Signal) + Adaptive AuthN

## Objective
Rebuild the frontend as a professional operations console **on the Signal design system**, and ship the Ambient Trust Score — the core of context- and risk-adaptive AuthN. This is the Level 4 state.

> **Changed since the original Phase 5 plan.** The original prompt embedded its own ad-hoc design system (coral accent, a 5-colour chart palette, a 220px left sidebar, 13px body, emoji nav icons). That is now **superseded by Signal**, which lives at `Signal Design System/` and is the single source of truth for all visual decisions. Where this document and Signal disagree, **Signal wins.** The pre-Signal version of this file is kept at `build-plan/phase-5-ui-adaptive.pre-signal.bak.md` for reference only — do not follow it.

## Prerequisites
- Phases 1–4 complete; all backend features working.
- Read `CLAUDE.md` fully.
- **Read `Signal Design System/README.md` fully, then open `Signal Design System/design-system.html` and the four built screens (`screens/home.html`, `monitor.html`, `simulator.html`, `review-queue.html`).** Treat these as reference-complete. Build by composing the classes already defined in `signal.css`. Do not invent colours, radii, shadows, or component classes.

## Source of truth: Signal
- **Stylesheet:** `Signal Design System/signal.css` — tokens + every component class. Copy it into `public/` (e.g. `public/signal.css`) and link it; also link the two Google Fonts (Hanken Grotesk + JetBrains Mono) per the README quick-start. Set `data-theme="dark"` on both `<html>` and `<body>`; theme persists to `localStorage` key `signal-theme` (the screens already wire `.themebtn`).
- **The hard rules (non-negotiable, from Signal's guardrails):**
  - **Decision colours are sacred.** `--allow` green / `--review` amber / `--deny` red are used *only* for ALLOW / STEP-UP / DENY. Never for decoration, charts-chrome, nav, or any non-decision UI.
  - **Accent is indigo** (`--accent`, hue 280) — brand + primary action only. Never use the accent to signal risk.
  - **Never hard-code a hex value** in a component. Everything is a token (`--bg/--bg-2/--bg-3`, `--line/--line-soft`, `--ink/--ink-soft/--ink-faint`, `--accent/--accent-ink`, `--allow/--review/--deny`).
  - **Mono for data, sans for prose.** Timestamps, customer ids, scores, signal names, rule ids, JSON → `--mono` (JetBrains Mono). Everything else → Hanken Grotesk.
  - **One shadow (`--shadow`), three radii** (`--radius` 20 / `--radius-sm` 13 / `--radius-ctl` 10). Spacing on the `--s1…--s8` 4pt scale. Don't invent elevations, corners, or spacing.
  - **No emoji, no decorative icons, no gradients.** Signal marks nav items with restrained unicode glyphs in `.mk` (e.g. `⌂ ▤ ◉`). Match that; do not introduce emoji or an SVG icon set.
  - **Both themes always.** Every new surface must work in light and dark.
  - **Every decision explains itself.** Any surface showing a decision must reach the Decision Trace and an `.outcome .why` in plain language.

## Architecture decision: keep it one file
`public/index.html` stays a single statically-served file — no build system, no React, no bundler. Organise it into clearly commented sections. (`signal.css` is the one additional static asset.)

## Navigation — Signal topbar + grouped tabs (NOT a left sidebar)
Use Signal's shell exactly: `.app` → `.topbar` (`.brand` · `.health` pills · `.sys` status · `.themebtn` · `.avatar`) → `.tabs` → `.work` > `.canvas`. The original left-sidebar spec is **dropped**. Nav is grouped into `.grp` blocks with a `.glabel`, active tab = `.tab.active`, pending count = `.count`.

Signal defines **eight** surfaces in three groups. Phase-5's extra screens fold into these — do not create separate top-level nav items for them:

**Learn**
- **Home** — operator overview *(built)*.
- **Atlas** — read-only map of the decision system: every signal, what it means, where it feeds in. `.box` cards + `.meter`s.

**Watch** (read-only observation)
- **Monitor** — live decision stream *(built)*. The **Review Queue badge** moves to the Monitor tab's `.count`. The old "Review Queue inside Monitor as a panel" idea is replaced by Signal's dedicated **Review** surface (below).
- **Analytics** — historical trends. Absorbs the old **Rule Performance** task as a section within Analytics.
- **Review** — escalated-case workbench, `.master-detail` *(built)*. This is the standalone Review surface (not a Monitor panel).

**Operate** (the only surfaces that change behaviour)
- **Simulator** — request builder → Decision Trace *(built)*.
- **Policy Lab** — author / diff / publish policy. Absorbs the old **Policy History** (version diff + rollback) and the A/B experiment controls.
- **Control** — operational kill-switches + system health. Absorbs the old **Settings** *and* **Status** tasks: `.health` pills at full size, adapter status, `.switch` toggles, the `.sys` state machine (normal → warn → crit), API key ids, Redis/Postgres/Sheets status, Node version/uptime, and the traffic-daemon controls.

Where the old plan had a "Decisions Log" (paginated `GET /decisions`): render it as a panel inside **Monitor** (history view beneath the live tape) using the `.tape` table component with filters. Do not add a separate nav item.

## Component vocabulary (use these, don't reinvent)
Compose from Signal's classes — full reference in `design-system.html` and the README. Key ones:
- **Surfaces:** `.box`, `.box.pad`, `.inset`.
- **Buttons:** `.btn` + `.primary` / default / `.ghost` / `.danger` (deny-red, destructive only); sizes `.sm`/`.lg`; `.icon`.
- **Decision status object:** `.badge` + `.r-allow|r-review|r-deny` with a `<span class="dot">`; labels uppercase ALLOW / STEP-UP / DENY.
- **Chips/tags:** `.chip` (with `.r-*` tints, `.car` caret), `.minichip`/`.tag` (mono metadata), `.count` (pending pill).
- **Forms:** `.field`/`.fl`, `.input`, `.seg`/`.on`, `.switch`/`.switch.on`, `.search`.
- **Data:** `.tape` table (`.tape-head`+`.tape-row`, cells `.tm/.cust/.act/.sig/.scorecell`), `.spark` sparkline, `.gauge` (`.bar > i.allow|review|deny`), `.stat-grid` > `.box.stat` (`.kicker`+`.bignum`+`.delta.up|down`), `.meter` (`> i.allow|review|deny`).
- **Decision Trace (centerpiece):** `.trace` > `.trace-head` > `.pipe` of `.stage` rows > `.outcome`. Stage detail: `.sigrow` + `.rulecard` (`.k` keyword, `.fired` matched rule). Outcome carries `.allow|.deny` tint + `.why`.
- **Split layouts:** `.sim` (352px|1fr), `.mon` (1fr|232px), `.master-detail` (1fr|392px), `.builder` form grid.
- **Overlays/states:** `.scrim`>`.dialog`, `.panel-head/.panel-body/.panel-title`, `.empty`, `.skeleton`.

Every async load uses `.skeleton` (not spinners). Every empty list/table uses `.empty`. These are Signal primitives — don't write new ones.

## Tasks

### 1. Shell + navigation
Replace the current top tab bar with Signal's `.topbar` + `.tabs` shell and the eight surfaces above. Keep theme toggle (`.themebtn`) and move the Redis/Postgres/Sheets/adapter indicators into the `.health` pills. System state shows in `.sys` (`.warn`/`.crit` variants for elevated/attack states). No left sidebar, no localStorage `sidebar_collapsed` key.

### 2. Decisions history (inside Monitor)
Render the paginated `GET /decisions` history as a panel beneath the live tape on **Monitor**, using `.tape` with filters (customer, action, decision type, date range). Not a separate nav item.

### 3. Analytics — redesign on Signal
Headline row uses `.stat-grid` > `.box.stat` cards:
- Total decisions (last 7 days)
- Frictionless rate % (`.delta.up|down` vs previous 7 days)
- Step-up completion rate %
- Active vs dormant rules count

**Charts: Chart.js, themed strictly to Signal.** Load Chart.js from `https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js`. It is the only charting lib. Force every colour through Signal tokens read from CSS custom properties at runtime (`getComputedStyle(document.documentElement).getPropertyValue('--accent')` etc.) so charts re-theme with light/dark:
- Decision-type series → `--allow` / `--review` / `--deny` / `--accent` (manual review). No default Chart.js palette.
- Risk distribution donut (LOW/MEDIUM/HIGH) → `--allow` / `--review` / `--deny`.
- Axis/grid/legend chrome → `--ink-faint` / `--line`. Tick + tooltip fonts → JetBrains Mono (`--mono`).
- Keep Signal's gauge/spark language for inline/at-a-glance bars; use Chart.js only where multi-series line / donut / horizontal bar genuinely need it.
- < 2 days of data → Signal `.empty` state with a "generate traffic" button.

Charts to render: decision-trend line (last 7 days, one line per decision type, aggregated client-side from `GET /analytics`), risk-distribution donut, top-10 actions by friction rate (horizontal bar), geographic breakdown (CSS grid of `.box` country/count cards, no map lib).

**Rule Performance** lives here as a section: table from `GET /analytics/rules` with health badges per rule and a link into Policy Lab filtered to that rule.

### 4. Simulator — upgrade (already built in Signal; extend it)
Signal's `simulator.html` (the `.sim` layout: `.builder` → 6-stage Decision Trace) is the reference. Extend the builder inputs and surface the new signals in the trace — keep the Signal structure, don't rebuild it.

Builder (`.builder` form, `.full` spans both columns): Customer, Action, Device, Auth Level (as now), plus a new **IP Override** `.input` and a **Scenario** `.seg`/dropdown (None, VPN User, Breached Email, New Device, Tor Exit Node) that pre-fills signals. Submit `.btn.primary` with a `.skeleton`/disabled loading state.

Output is the Decision Trace, not a 4-tab panel. Map the originally-planned tabs onto trace stages/detail:
- **Decision** → `.trace-head` `.badge` + the `.outcome .why` (use Phase 4 `display_message` as the customer-facing line).
- **Signals** → enrichment stage(s): `.sigrow` rows (IP, geo, abuse score, breach status, device trust, **Ambient Trust Score**) each with a `.meter` and mono `.sv` value.
- **Trace** → the `.pipe` of `.stage` rows, each showing matched/skipped with condition values; matched rule highlighted via `.rulecard .fired`.
- **Raw** → a collapsible `.inset` with the raw JSON response.

### 5. Ambient Trust Score (core adaptive-AuthN concept)
Backend unchanged from the original plan. Create `ambientTrustStore.js`:
```javascript
async function getScore(customerId)        // 0–100; new customers default 50
async function recordSuccess(customerId, authLevel)   // AL1 +2, AL2 +3, AL3 +5, AL4 +8; max 95
async function recordSuspicion(customerId, signalType) // new_device −10, vpn_detected −5, breach_detected −15, velocity_burst −20; min 5
async function applyDecay()                // drifts toward baseline 50 at 2 pts/day
```
Storage: Redis hash `ats:${customerId}`, field `score`. Redis unavailable → no-op returning 50. Run `applyDecay()` via `setInterval` in `server.js` (every 6 hours).

Wire into `decisionEngine.js`: after enrichment, fetch `getScore(customer_id)` (non-blocking, fallback 50), add `ambientTrustScore` to context. Call `recordSuccess()` on `POST /trust/step-up/complete`; call `recordSuspicion()` when enrichment fires suspicious flags.

New `policyEngine.js` condition keys (add to `VALID_CONDITION_KEYS`): `ambient_trust_gte`, `ambient_trust_lte`.

Demonstration rules to add to `decisions.json`:
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

**ATS in the Simulator Signals stage — colour note (Signal reconciliation):** the ATS is a *risk-semantic* value, so the `--allow/--review/--deny` ramp is permitted here (it expresses trust, not decoration). Render it with Signal's `.meter` + `i.allow|review|deny`, threshold red < 30 / amber 30–70 / green > 70. Show score history in mono `.minichip`s ("+3 passkey 2h ago", "−10 new device yesterday") and a trajectory label (↑ Building / → Stable / ↓ Declining). Do **not** use the indigo accent for the ATS bar.

### 6. Control surface (absorbs Settings + Status)
Single **Control** surface in the Operate group. Use `.box`/`.inset` sections, `.health` pills at full size, `.switch` toggles, and the `.sys` state machine.

- **Intelligence Adapters:** ip-api / AbuseIPDB / HIBP / GreyNoise each configured (✓) / not (—), with cache hit rate + last-call age. Add `GET /status/adapters`:
  ```json
  {
    "ip_enrichment": { "configured": true, "cache_hits": 142, "last_call_ms_ago": 3200 },
    "abuseipdb": { "configured": false },
    "hibp": { "configured": true, "cache_hits": 58, "last_call_ms_ago": 180000 },
    "greynoise": { "configured": true, "cache_hits": 89, "last_call_ms_ago": 45000 }
  }
  ```
  Track `cache_hits`/`last_call` as in-memory counters per adapter module.
- **Traffic Daemon:** running/stopped, Start/Stop `.btn`s (call `POST /dev/daemon/start|stop`, dev only), next attack-scenario ETA.
- **API Keys:** configured key ids masked (`sk-trust-abc…`), copy button. Never show full keys.
- **System:** Redis / Postgres / Sheets status, Node version, uptime.

### 7. Responsive
Signal's layouts already handle narrow widths via its split-layout components — verify, don't re-spec. Confirm the console is usable at 1280px and 768px; let Signal's grids stack. Tape rows truncate long values with ellipsis at narrow widths.

### 8. Polish pass (last)
- All async loads use Signal `.skeleton`; all empty states use `.empty`.
- All action buttons get a disabled/loading state.
- Toasts consistent (reuse Signal's surface tokens; success/error/info distinguished by `--allow`/`--deny`/`--accent` accents on the border, not full fills).
- Verify light/dark across every new surface — read tokens at runtime, never hard-code.

### 9. Daemon control endpoints
Add to `server.js`, only when `ENABLE_ATTACK_TRIGGERS=true` or `NODE_ENV !== 'production'`:
```
POST /dev/daemon/start   — start the trust-traffic PM2 process
POST /dev/daemon/stop    — stop it
GET  /dev/daemon/status  — { running: boolean, uptime_sec: number|null }
```
Use the `pm2` npm package programmatically (connect → start `{ name: 'trust-traffic', script: 'scripts/traffic-daemon.js' }` → disconnect). If PM2 isn't installed / connect fails, return `{ ok: false, reason: 'PM2 not available — start daemon manually: node scripts/traffic-daemon.js' }` with **200** (graceful degradation). Fold `/dev/daemon/status` into `GET /status` so Control polls one endpoint.

### 10. A/B policy experiment framework
Surfaced in **Policy Lab** (Operate group), not a separate screen. Backend unchanged from the original plan. Create `abExperiment.js`:
```javascript
function assignVariant(customerId, experimentId, splitPct = 50) {
  const hash = require('crypto').createHash('md5').update(`${experimentId}:${customerId}`).digest('hex');
  const bucket = parseInt(hash.slice(0, 8), 16) % 100;
  return bucket < splitPct ? 'treatment' : 'control';
}
function getActiveExperiment()
function setExperiment({ id, name, treatmentConfig, splitPct })
function clearExperiment()
```
Active experiment in memory only (operator-session scoped; clears on restart). `treatmentConfig` is a full decisions policy config.

Wire into `decisionEngine.js`: if an experiment is active, assign a variant, evaluate `policyEngine.evaluateWith(treatmentConfig, context)` for treatment or `evaluate(context)` for control, and tag the analytics record with `experiment_id` + `variant`. Add nullable `experiment_id`/`variant` columns to the Postgres `decisions` table (ALTER TABLE); JSONL records carry them as optional fields.

Endpoints in `server.js`:
```
POST   /experiments/start    — { id, name, treatmentConfig, splitPct }
DELETE /experiments/active    — clear
GET    /experiments/active    — current config
GET    /experiments/results   — decision mix by variant for the active experiment
```

In **Policy Lab**, add an "A/B Test" `.btn` beside "Simulate Impact": starts an experiment from the current editor config as `treatmentConfig`; show a `.sys`/banner "A/B experiment active — X% treatment / Y% control" (text, no emoji); results panel shows side-by-side decision mix (control vs treatment) live from `GET /experiments/results`; "Stop Experiment" clears and shows the final summary. Default `splitPct=50` (max statistical power); operator may set a cautious canary split.

## Technical decisions — do not deviate
- `public/index.html` stays one file — no build system, React, or bundler.
- Signal is the design system: link `signal.css` + the two fonts; compose its classes; obey its guardrails. No coral accent, no ad-hoc palette, no left sidebar, no emoji icons.
- Chart.js only (from cdnjs), themed entirely through Signal tokens read at runtime.
- No CSS framework (Tailwind/Bootstrap). Signal's tokens are the design layer.
- Ambient Trust Score in Redis only — ephemeral, no Postgres table.
- Theme persisted under Signal's `localStorage` key `signal-theme`.
- A/B experiment state in-memory only (clears on restart — intentional).
- Daemon control requires PM2 (`npm install pm2 -g`); degrade gracefully if absent.
- `assignVariant()` uses MD5 for fast deterministic bucketing (not cryptographic).

## Success criteria
1. Console renders on Signal's `.topbar` + `.tabs` shell with all three groups; active tab highlighted; light/dark both work.
2. Every surface uses Signal tokens/classes only — no hard-coded hex, no non-decision use of green/amber/red, no emoji.
3. Analytics shows at least one Chart.js chart with data, coloured from Signal tokens, re-theming correctly on dark/light toggle.
4. Simulator's Decision Trace shows enrichment signals including the Ambient Trust Score `.meter` for every decision, ending in an `.outcome .why`.
5. Run traffic 10 min → Monitor shows decisions streaming live; the decisions-history panel paginates.
6. Loyal persona (Lara) after 20+ completions has ATS > 80 and gets FRICTIONLESS on Tier1/Tier2.
7. Control shows all adapter statuses, key ids (masked), and system health correctly.
8. Layout works at 1280px and 768px.
9. `POST /dev/daemon/start` starts the daemon; `GET /dev/daemon/status` returns `{ running: true }`.
10. Start an A/B experiment with a variant policy, fire 50 decisions → `GET /experiments/results` shows split-by-variant with different decision mixes.
11. Same customer_id always lands in the same variant across restarts.

## Deployment
Standard rsync. No new env vars. After deploy: `pm2 restart trust-platform`. Decay interval starts automatically as a `setInterval` in `server.js`. Ensure `public/signal.css` and the font links are deployed with `index.html`.

## Final state — what Level 4 looks like
- Open the console: Signal-clean operations product, not a prototype — topbar, grouped tabs, restrained indigo accent, decision colours only where decisions live.
- Monitor: decisions streaming live; trigger a credential-stuffing attack and watch the velocity DENY cascade; `.sys` flips to `.crit`.
- Simulator: enter Lara (ATS≈92), wire transfer → FRICTIONLESS (adaptive AuthN working); switch to Harvey (new device + VPN + breached email) → ATO signals → IDV forced; the Decision Trace explains each in plain language.
- Policy Lab: "block Tor users on any action" → Claude generates the rule → simulate against recent traffic → ~0.3% affected → publish; version history with one-click rollback; A/B a threshold change before full rollout.
- Analytics: decision-mix and friction trends; Rule Performance flags high-friction rules to tune.
