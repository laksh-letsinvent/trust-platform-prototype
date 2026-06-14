# Phase 2 — Intelligence Layer

## Objective
Replace static fraud/device scores from JSON files with real enrichment from free external APIs. Every decision gets enriched with IP reputation, geolocation, breach status, and bot detection. The enrichment is non-blocking — if any service is slow or down, the decision falls back to static scores with zero latency impact.

## Prerequisites
Phase 1 must be complete. Redis must be running (needed for enrichment caching). Read CLAUDE.md fully.

## Current state
- `fraudAdapter.js` and `deviceAdapter.js` are thin wrappers over `data/store.js` — they look up static scores from JSON files
- `data/users.json` has hard-coded `fraud_score` per customer
- `data/devices.json` has hard-coded `device_score` per device
- `decisionEngine.js` calls these adapters to get scores before running the pipeline
- No IP address, email, or browser fingerprint signals anywhere in the pipeline

## Architecture decision
All external enrichment calls:
1. Are async, fire with `Promise.allSettled` — partial failure is fine
2. Have a hard 300ms timeout — if the API doesn't respond in time, return null
3. Are cached in Redis (different TTLs per signal type)
4. Adjust scores additively — they don't replace the static baseline, they modify it
5. If Redis is unavailable: enrichment still runs but results aren't cached (acceptable for demo scale)

## Tasks

### 1. ip-api.com adapter — geolocation + proxy/VPN/Tor detection

Create `adapters/ipEnrichmentAdapter.js`:
- `enrich(ip)` → `{ country, countryCode, city, isp, proxy, vpn, tor, hosting, query }` or `null` on failure
- API: `http://ip-api.com/json/${ip}?fields=status,country,countryCode,city,isp,proxy,hosting,query` (no API key needed)
- Note: ip-api.com requires HTTP not HTTPS on the free endpoint
- Redis cache key: `ipenrich:${ip}`, TTL: 1800 seconds (30 min)
- Timeout: 300ms using `AbortController`
- Return null on any error, timeout, or non-success status
- Do NOT call this for localhost/private IPs (127.x, 10.x, 192.168.x, ::1) — return `{ country: 'LOCAL', proxy: false, vpn: false, tor: false }` for those

### 2. AbuseIPDB adapter — IP abuse reputation

Create `adapters/abuseIpdbAdapter.js`:
- `getScore(ip)` → `{ abuseScore, totalReports, countryCode, isTor }` or `null`
- API: `https://api.abuseipdb.com/api/v2/check?ipAddress=${ip}&maxAgeInDays=90`
- Header: `Key: ${process.env.ABUSEIPDB_API_KEY}`, `Accept: application/json`
- Redis cache key: `abuseipdb:${ip}`, TTL: 3600 seconds (1 hr)
- Timeout: 300ms
- Returns null if `ABUSEIPDB_API_KEY` not set (graceful degradation)
- Returns null on any error

### 3. HaveIBeenPwned adapter — email breach detection

Create `adapters/hibpAdapter.js`:
- `checkEmail(email)` → `{ breached: boolean, breachCount: number }` or `null`
- API: `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=true`
- Headers: `hibp-api-key: ${process.env.HIBP_API_KEY}`, `User-Agent: trust-platform-demo`
- A 404 response means "not breached" — return `{ breached: false, breachCount: 0 }`
- A 200 response returns an array — return `{ breached: true, breachCount: array.length }`
- Redis cache key: `hibp:${email.toLowerCase()}`, TTL: 86400 seconds (24 hr — breach status doesn't change hourly)
- Returns null if `HIBP_API_KEY` not set
- Note: HIBP API key costs ~$3.50/month at haveibeenpwned.com/API. Document this in comments.

### 4. GreyNoise community adapter — bot/scanner IP detection

Create `adapters/greynoiseAdapter.js`:
- `check(ip)` → `{ noise: boolean, riot: boolean, classification: string, name: string }` or `null`
- API: `https://api.greynoise.io/v3/community/${ip}` (no API key needed for community)
- A 404 means IP not in GreyNoise — return `{ noise: false, riot: false, classification: 'unknown' }`
- Redis cache key: `gn:${ip}`, TTL: 21600 seconds (6 hr)
- Timeout: 300ms

### 5. Enrichment orchestrator

Create `adapters/enrichmentOrchestrator.js`:

```javascript
// Input: { ip, email, customerId, deviceId, existingDeviceIds }
// Output: enrichment signals object (never throws)
async function enrich({ ip, email, customerId, deviceId, existingDeviceIds = [] })
```

Runs all adapters in parallel with `Promise.allSettled`. Computes derived signals:
- `geography`: from ip-api country (overrides static if available)
- `is_proxy`: ip-api proxy || vpn
- `is_tor`: ip-api tor || abuseipdb isTor
- `is_vpn`: ip-api vpn
- `is_hosting`: ip-api hosting (data centre IP — unusual for real users)
- `ip_abuse_score`: abuseipdb abuseScore (0–100), null if unavailable
- `email_breached`: hibp breached boolean
- `breach_count`: hibp breachCount
- `is_greynoise_bot`: greynoise noise === true
- `is_new_device`: true if deviceId is NOT in existingDeviceIds (new fingerprint for known customer)
- `ato_signal_count`: count of (email_breached, is_proxy || is_vpn, is_new_device) that are true — 0/1/2/3

Exports: `enrich`, and `isAnyAdapterConfigured()` (returns true if at least one optional API key is set).

### 6. Wire enrichment into decisionEngine.js

In `decisionEngine.js`, after fetching user/device/action from store but before computing confidence:

```javascript
// Enrich request with external intelligence (async, non-blocking fallback)
const enrichment = await enrichmentOrchestrator.enrich({
  ip: req.ip || analyticsExtra.ip || null,  // need to pass IP from server.js
  email: user?.email || null,               // users may not have email in data/users.json yet
  customerId: customer_id,
  deviceId: device_id,
  existingDeviceIds: user?.known_device_ids || []
}).catch(() => ({}));  // never let enrichment crash the decision
```

Apply enrichment adjustments to scores (additive, clamped 0–100):
- `is_tor`: fraudScore = Math.min(100, fraudScore + 40)
- `is_greynoise_bot`: fraudScore = Math.min(100, fraudScore + 40)
- `is_proxy || is_vpn`: fraudScore = Math.min(100, fraudScore + 15)
- `email_breached && breach_count > 2`: fraudScore = Math.min(100, fraudScore + 20)
- `ip_abuse_score > 80`: deviceScore = Math.max(0, deviceScore - 40)
- `ip_abuse_score > 50`: deviceScore = Math.max(0, deviceScore - 20)
- `is_new_device && customerId known`: deviceScore = Math.max(0, deviceScore - 30)

Add enrichment signals to `trace.signals` and `trace.enrichment` in the decision output.
Add `enrichment` to the `replay` snapshot so simulations can account for it.

Pass `ip` from `server.js` into `getDecision()`: update the function signature to accept `{ customer_id, action, device_id, current_auth_level, ip }`.
In the `POST /trust/decision` handler: pass `req.ip` (Express populates this).

### 7. New condition keys in policyEngine.js

Add these to `matchesCondition()` and `conditionToSummary()` and `explainCondition()`:
- `vpn_detected: boolean` — matches context.is_vpn
- `tor_detected: boolean` — matches context.is_tor
- `email_breached: boolean` — matches context.email_breached
- `ato_signal_count_gte: number` — matches context.ato_signal_count >= N
- `ip_abuse_score_gte: number` — matches context.ip_abuse_score >= N (skip if null)
- `is_new_device: boolean` — matches context.is_new_device

Add all 6 to `VALID_CONDITION_KEYS` array (used by copilot and validation).

Pass enrichment fields through `computeContext()` in `confidenceEngine.js` — add them to the returned context object.

### 8. Built-in ATO rules in decisions.json

Add these rules to `policies/decisions.json` BEFORE the existing velocity rules (high priority):

```json
{
  "id": "deny_tor_exit_node",
  "enabled": true,
  "description": "Deny: request from Tor exit node",
  "condition": { "tor_detected": true },
  "decision": "DENY",
  "reason": "Access from anonymising network detected; action blocked for security.",
  "display_message": "We couldn't verify your connection. Please try again from your usual network."
},
{
  "id": "deny_greynoise_bot",
  "enabled": true,
  "description": "Deny: IP flagged as automated scanner by GreyNoise",
  "condition": { "vpn_detected": false },
  "decision": "DENY",
  "reason": "Automated traffic detected.",
  "display_message": "Something looks unusual about this request. Please try again."
},
{
  "id": "idv_ato_high_confidence",
  "enabled": true,
  "description": "Step-up IDV: 2+ ATO signals detected (new device + breach + proxy/VPN)",
  "condition": { "ato_signal_count_gte": 2 },
  "decision": "STEP_UP",
  "step_up_type": "IDV",
  "reason": "Multiple account takeover signals detected; full identity verification required.",
  "display_message": "For your security, we need to verify your identity before continuing."
},
{
  "id": "step_up_vpn_high_tier",
  "enabled": true,
  "description": "Step-up selfie: VPN detected on high-value action",
  "condition": { "vpn_detected": true, "actionTier": ["Tier3", "Tier4"] },
  "decision": "STEP_UP",
  "step_up_type": "SELFIE",
  "reason": "VPN detected on high-value action; selfie verification required.",
  "display_message": "We noticed you're using a VPN. A quick selfie check keeps your account safe."
}
```

Add `display_message` field to all existing rules in decisions.json (write appropriate plain-English messages for each). This field is ignored by the engine today but used in Phase 4.

### 9. FingerprintJS OSS in frontend

In `public/index.html`, in the `<head>`:
```html
<script>
  // FingerprintJS OSS — device fingerprinting
  const fpPromise = import('https://openfpcdn.io/fingerprintjs/v4').then(FingerprintJS => FingerprintJS.load());
  let visitorId = localStorage.getItem('fp_visitor_id');
  fpPromise.then(fp => fp.get()).then(result => {
    visitorId = result.visitorId;
    localStorage.setItem('fp_visitor_id', visitorId);
  });
</script>
```

In the Decision Simulator, where the `device_id` field is populated:
- Default value: `visitorId` from FingerprintJS (when available), fallback to existing dropdown
- Show a small badge: "🖥 Real fingerprint" when FingerprintJS has loaded

In the decision request body (the fetch call in the simulator):
- Include `device_id: visitorId || selectedDeviceId`

Add a `known_device_ids` field to `data/users.json` for each user — an array of known device fingerprints. Start empty (`[]`) — the system will learn them over time. For the simulator, show "new device" signal if the fingerprint isn't in this list.

### 10. Enrichment panel in Decision Simulator output

After a decision is returned, show an "Intelligence Signals" section in the trace output:
- IP: country flag + city (or "LOCAL")
- VPN/Proxy: green ✓ or red ✗
- Tor: green ✓ or red ✗
- Email breached: green ✓ or red ✗ (only if email is known)
- ATO signal count: 0/1/2/3 with colour coding
- Device: "Known" (green) / "New" (red)
- IP abuse score: 0–100 with colour coding (green < 20, amber 20–50, red > 50)

If no enrichment was returned (no API keys configured), show: "Intelligence signals unavailable — configure API keys in .env to enable."

## Data model additions

Add optional `email` field to `data/users.json` for each user (can be null). Example:
```json
{ "customer_id": "Lara", "fraud_score": 15, "geography": "UK", "email": "lara@example.com", "known_device_ids": [] }
```

## Technical decisions — do not deviate
- All external HTTP calls use native `fetch` (Node 18+) with `AbortController` for timeout — no axios
- Enrichment is always a best-effort overlay — never blocks or throws on the main decision path
- Redis TTLs: ip-api 30min, AbuseIPDB 1hr, HIBP 24hr, GreyNoise 6hr
- Score adjustments are additive and clamped — they never set fraudScore to a fixed value
- FingerprintJS OSS only (not Pro) — self-sufficient, no account needed
- `is_new_device` comparison is against `user.known_device_ids` — NOT auto-updated (that's Phase 5 territory)

## Success criteria
1. `POST /trust/decision` with an IP from a known bad list (e.g., a Tor exit node) returns DENY with reason "tor_detected"
2. `GET /status` shows which intelligence adapters are configured (even if keys aren't set)
3. Decision trace includes `enrichment` object showing which signals fired
4. FingerprintJS runs in the browser and populates `device_id` in the simulator
5. `node scripts/generate-traffic.js --count 100` still works (enrichment is skipped for script-generated traffic since it has no real IP)
6. If ALL API keys are absent, decisions still work exactly as before (graceful degradation)

## Environment variables to add to .env
```
ABUSEIPDB_API_KEY=your_key_here    # free at abuseipdb.com
HIBP_API_KEY=your_key_here         # ~$3.50/month at haveibeenpwned.com/API
# GREYNOISE requires no key for community API
# ip-api.com requires no key
```

## Deployment
Standard rsync from CLAUDE.md. Add new env vars to `/opt/trust-platform/.env` on the server before restarting.
