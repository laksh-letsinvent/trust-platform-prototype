# Phase 3 — Live Traffic Simulation + Real-time Monitor

## Objective
Make the platform feel like a live system. A traffic daemon runs as a second PM2 process, continuously firing realistic decisions. A new Monitor tab streams them in real-time via Server-Sent Events. Attack scenarios can be triggered to watch the fraud rules fire. This is the primary demo experience.

## Prerequisites
Phase 1 and Phase 2 complete. Read CLAUDE.md fully.

## Current state
- `scripts/generate-traffic.js` generates a batch of records and appends to decisions.jsonl, then exits
- No continuous traffic generation
- No real-time feed — the Analytics tab only refreshes on demand
- No attack scenario simulation
- PM2 manages one process: `trust-platform`

## Tasks

### 1. Personas data file

Create `data/personas.json` — 20 synthetic users with richer attributes than data/users.json:

```json
{
  "personas": [
    {
      "id": "persona_lara",
      "customer_id": "Lara",
      "display_name": "Lara — Loyal retail",
      "archetype": "low_risk_regular",
      "fraud_score_base": 12,
      "fraud_score_jitter": 3,
      "geography": "UK",
      "device_ids": ["Device1", "Device2"],
      "action_weights": { "login": 25, "balance_inquiry": 30, "view_statements": 20, "bill_pay": 15, "p2p_send": 10 },
      "request_interval_ms": { "min": 8000, "max": 45000 },
      "active_hours": { "start": 7, "end": 22 },
      "attack_persona": false
    },
    ... (19 more personas covering medium-risk, high-risk, bot archetypes)
  ]
}
```

Include these archetypes (create at least 2 of each):
- `low_risk_regular`: fraud 8–20, known devices, UK/DE, varied daily actions
- `medium_risk_traveller`: fraud 30–50, multiple devices, multiple geographies, occasional large transfers
- `high_risk_flagged`: fraud 75–90, unknown devices, VPN IPs, account recovery attempts
- `bot_credential_stuffer`: fires login bursts, cycles device IDs, very fast intervals (200–500ms)
- `ato_attacker`: uses normal persona's customer_id but with new device + proxy IP flag

### 2. Traffic daemon

Create `scripts/traffic-daemon.js`:

This is a long-running process that:
1. Loads `data/personas.json`
2. For each persona, schedules recurring requests based on their `request_interval_ms` and `active_hours`
3. Fires `POST http://localhost:${PORT}/trust/decision` with persona's parameters
4. Adds jitter to all timing (±20%) to avoid artificial regularity
5. Logs to stdout (PM2 captures this to `traffic-daemon.log`)
6. Handles SIGTERM gracefully (stops all timers, exits cleanly)

Key implementation details:
- Use `node-fetch` or native `fetch` (Node 18+)
- If `API_KEYS` is set, include `X-API-Key: ${process.env.TRAFFIC_DAEMON_API_KEY}` — add `TRAFFIC_DAEMON_API_KEY` to .env.example
- Night-time behaviour: `active_hours` defines when each persona is active; outside those hours, interval multiplied by 10 (very quiet)
- Weekday/weekend multiplier: slightly fewer requests on weekends (multiply interval by 1.5 on Sat/Sun)
- Error handling: if the trust server is unreachable, retry after 10s — don't crash

Attack scenario scheduling (built into the daemon):
- Every 30 minutes: trigger a 60-second credential stuffing burst (bot personas fire rapidly)
- Every 2 hours: trigger a single ATO attempt (ato_attacker persona runs its scenario)
- Configurable via env vars: `ATTACK_INTERVAL_MS` (default 1800000), `ENABLE_ATTACKS=true/false`

### 3. Attack scenarios module

Create `scripts/attack-scenarios.js` — a module (not standalone script) that exports scenario functions:

```javascript
// Each returns an array of request payloads { customer_id, action, device_id, _scenario_tag }
function credentialStuffing(personas)   // 15 rapid login attempts across bot personas
function accountTakeover(personas)      // ATO attacker using a real customer's ID + new device
function muleNetwork(personas)          // 5 different customers all wiring to same new payee
```

The daemon imports this and fires the payloads at speed when a scenario is triggered.

Also export `SCENARIO_NAMES` array for the frontend trigger endpoint.

### 4. Server-Sent Events endpoint

In `server.js`, add `GET /events/stream`:

```javascript
app.get('/events/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Register this client
  const clientId = Date.now();
  sseClients.set(clientId, res);

  // Heartbeat every 15s to keep connection alive through proxies
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);

  req.on('close', () => {
    sseClients.delete(clientId);
    clearInterval(heartbeat);
  });
});
```

Add `sseClients` Map at module level (max 20 concurrent connections — drop oldest if exceeded).

In `analytics.js` `record()` function — after writing to DB/JSONL, emit to SSE:
- `analytics.js` cannot directly access `sseClients` (circular dep risk)
- Instead: `analytics` emits a Node.js EventEmitter event: `analyticsEmitter.emit('decision', row)`
- `server.js` listens and broadcasts: `analyticsEmitter.on('decision', row => { sseClients.forEach(res => res.write(`data: ${JSON.stringify(row)}\n\n`)) })`

Export `analyticsEmitter` from `analytics.js`.

### 5. Attack trigger endpoint

Add `POST /dev/attack/:scenario` in `server.js`:
- Only active if `NODE_ENV !== 'production'` or `ENABLE_ATTACK_TRIGGERS=true`
- Triggers a named attack scenario immediately (for demo purposes)
- Returns `{ ok: true, scenario, payloads_queued: N }`
- Does not fire requests directly — pushes to a queue that the next daemon tick processes

### 6. PM2 ecosystem config

Create `ecosystem.config.js` in project root:

```javascript
module.exports = {
  apps: [
    {
      name: 'trust-platform',
      script: 'server.js',
      env_production: {
        NODE_ENV: 'production',
        PORT: 4000
      }
    },
    {
      name: 'trust-traffic',
      script: 'scripts/traffic-daemon.js',
      env_production: {
        NODE_ENV: 'production',
        PORT: 4000,
        ENABLE_ATTACKS: 'true',
        TRAFFIC_DAEMON_API_KEY: 'sk-trust-daemon-internal'
      },
      // Don't auto-start — operator explicitly starts it for demo
      autorestart: true,
      watch: false
    }
  ]
};
```

### 7. Live Monitor tab (new frontend tab)

Add "📺 Monitor" tab to `public/index.html` — insert it as the second tab (between Decision Simulator and Control Panel).

The Monitor tab layout:

**Top row — stats strip (4 cards):**
- Decisions/min (rolling 60s count)
- Active rule triggers (count in last 5 min)
- Current risk distribution (% of last 50: LOW/MEDIUM/HIGH)  
- Attack status: "Normal" (green) or "🚨 Attack detected" (red, when velocity rules fired in last 2 min)

**Middle — decision feed (left, 60% width):**
- Rolling list of last 50 decisions, newest at top
- Each row: `[timestamp] [customer_id] [action] [decision badge] [riskLevel] [ruleId]`
- Decision badges: colour-coded (FRICTIONLESS=green, STEP_UP=amber, DENY=red, MANUAL_REVIEW=purple)
- Smooth scroll animation as new rows arrive
- Auto-pauses if user scrolls up (so they can read), resumes on scroll back to top

**Right panel (40% width):**
- Geography breakdown: flag emoji + country name + count for last 50 decisions
- Top 5 firing rules: mini bar chart
- "Trigger Attack" buttons (only shown if server confirms `ENABLE_ATTACK_TRIGGERS` is true via a new `GET /status` field)

**SSE connection logic:**
```javascript
function connectMonitorStream() {
  const es = new EventSource('/events/stream');
  es.onmessage = (e) => {
    const decision = JSON.parse(e.data);
    addDecisionToFeed(decision);
    updateStats(decision);
  };
  es.onerror = () => {
    // Show "Reconnecting..." badge, retry after 3s
    setTimeout(connectMonitorStream, 3000);
  };
}
```

Only connect SSE when Monitor tab is active (disconnect when switching away to save server resources).

## Technical decisions — do not deviate
- SSE not WebSockets — simpler, works through Caddy reverse proxy without extra config
- Max 20 SSE clients — no memory leak from unlimited connections
- Traffic daemon uses native fetch, no extra HTTP libraries
- Daemon and server communicate via HTTP only (daemon is a separate process) — no shared memory
- `ecosystem.config.js` for PM2 — trust-traffic is NOT auto-started, operator must `pm2 start ecosystem.config.js --only trust-traffic`
- Attack scenarios are purely additive requests to the existing pipeline — no special handling needed in server.js

## Success criteria
1. `node scripts/traffic-daemon.js` runs without crashing and fires decisions visible in `GET /decisions`
2. Open Monitor tab — decisions appear within seconds of the daemon firing them
3. `POST /dev/attack/credentialStuffing` triggers visible velocity rule denial cascade in the feed
4. Attack status card turns red when velocity rules fire
5. Closing the Monitor tab disconnects the SSE client (check `sseClients` size drops)
6. `pm2 start ecosystem.config.js` starts both processes; `pm2 stop trust-traffic` stops just the daemon

## Deployment to Hetzner
```bash
# Standard rsync (CLAUDE.md command)
# Then on server:
ssh -i ~/.ssh/id_rsa root@77.42.46.176
cd /opt/trust-platform

# Add to .env:
# TRAFFIC_DAEMON_API_KEY=sk-trust-daemon-internal
# ENABLE_ATTACKS=true
# ENABLE_ATTACK_TRIGGERS=true

# Switch from pm2 restart to ecosystem:
pm2 delete trust-platform  # remove old single-process config
pm2 start ecosystem.config.js --env production
pm2 save  # persist across reboots

# To start traffic (when you want demo mode):
pm2 start trust-traffic
# To stop traffic:
pm2 stop trust-traffic
```
