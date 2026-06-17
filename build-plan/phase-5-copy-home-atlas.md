# Home & Atlas: screen copy

Hand-off copy for the two **Learn** surfaces. Drop these strings into the Signal
components named against each block. Both screens are read-only.

These are the only two surfaces a stakeholder hits before they understand the product.
Home has to land the thesis and prove it's real in the time someone spends standing at
a desk. Atlas has to answer one question, "how does it actually decide?", for the
engineer or risk lead who'll poke holes in it. Everything else in the console assumes
you already know what the platform is for. These two don't.

A note on voice: mono (JetBrains Mono) for every number, id, score, signal name, and
rule token. Sans for prose. No emoji, no decorative icons, Signal's `.mk` glyphs only.
Numbers below are illustrative demo values matching the reference screens. Swap for live
data on render.

---

## HOME

Operator landing. It serves 3 readers at once. A leader reads the top strip and
leaves convinced. An operator goes straight to "Needs you." A newcomer follows the link
into Atlas. Keep the existing Signal layout. Add only the framing line and the "What's
inside" strip.

### Page header · `.phead`

- **Title (`.pt`):** `Good afternoon, Priya`
- **Description (`.pd`):** Policy **v37** is live and healthy. The platform has made **1.84M** decisions today. **2** need a human. Below is the system at a glance. Open **Atlas** for how it decides.
- **Primary action (`.btn.primary`):** `Open Simulator`

> The second and third sentences are the thesis in miniature for a leader: volume,
> health, and the human count in one breath. Keep `v37`, `1.84M`, and `2` in mono.

### Headline stats · `.stat-grid` (4 × `.box.stat`)

| Kicker | Bignum | Delta / sub |
|---|---|---|
| `Decisions today` | `1.84` `M` | `▲ 6% vs yesterday` (`.delta.up`) |
| `Allow rate` | `72` `%` | `▲ 1.2 pt` (`.delta.up`) |
| `Step-up rate` | `20` `%` | `▼ 1.2 pt` (`.delta.down`) |
| `Open cases` | `2` | `oldest 11m ago` (`.soft`) |

> Changed from the reference, which headlined Deny. Lead with **Allow rate** instead. The
> product's whole claim is that most customers clear without a challenge, so the top of
> the screen should say so. Deny still shows in the Live pulse mix below.

### Live pulse · `.box.pad`

- **Section title (`.h2`):** `Live pulse`
- **Status badge:** `.badge.r-allow` → `NORMAL`
- **Throughput kicker:** `Throughput · 60s`
- **Throughput readout (`.bignum`):** `2,140` `dec/min`
- **Decision mix kicker:** `Decision mix`
- **Mix rows (`.gauge`):**
  - `allow`: `72%` (`i.allow`)
  - `step-up`: `20%` (`i.review`)
  - `deny`: `8%` (`i.deny`)

> The mix gauge is the proof line. allow, step-up, and deny in their sacred colours.
> Nothing else tinted.

### Needs you · `.box` with `.panel-head` + `.tape`

- **Panel title:** `Needs you`  ·  count pill: `2`
- **Row 1:** cust `••8FZ1` · action `transfer · $8,900` · `4m left` (`.sn-review`)
- **Row 2:** cust `••3MZ9` · action `reset-pwd` · `11m left` (`.sn-deny`)
- **Footer button (`.btn.sm`):** `Open Review Queue →`

> Empty state (`.empty`) when the queue is clear:
> - Title: `Nothing waiting`
> - Subtitle: `Every escalated case is resolved. The platform is handling the rest.`

### Policy · `.box.pad`

- **Section title (`.h2`):** `Policy`  ·  chip: `v37 · live ▾`
- **Rows:**
  - `Active rules` → `142`
  - `Last change` → `2d ago · you`
  - `Draft` → `v38 · 3 edits` (`.sn-review`)
- **Footer button (`.btn.ghost.sm`):** `Simulate v38 vs live →`

### What's inside · NEW strip (`.box.pad`, full width, below the row)

A single horizontal strip of labelled chips that name the capability set and link into
Atlas. This is the element that shows the whole product on Home. One line of text, then
the chips. Restrained.

- **Kicker:** `What's inside`
- **Lead line:** 8 capabilities decide every request, and we can change any of them without a deploy.
- **Chips (`.chip`, each links to the matching Atlas section):**
  `Signal enrichment` · `Confidence model` · `Ambient trust score` · `Step-up & IDV routing` · `Velocity protection` · `Policy Lab + AI copilot` · `Versioning & rollback` · `A/B experiments`
- **Trailing link (`.btn.ghost.sm`):** `See how it works in Atlas →`

---

## ATLAS

The system map. Signal ships only a brief for it, so this is the full content spec.
Read-only, built from `.box` cards, `.meter`s, `.badge`s, and mono. The platform has a
shape worth keeping in mind as you read: requests arrive on the left (real customers, or
the synthetic traffic engine), the engine in the middle enriches each one against the
intelligence layer on the right, decides, and records. Atlas walks that left to right
and top to bottom: the claim, how a decision gets made, what it reads, the patterns it
catches, how it's exercised, how policy changes, and what holds it all up.

### Page header · `.phead`

- **Title (`.pt`):** `Atlas`
- **Description (`.pd`):** How the Trust Platform turns signals into a decision. Every input we read, the order we read them in, and what each one can trigger. Read-only.

### 1. The claim · `.box.pad`

- **Kicker:** `What this platform is for`
- **Body:**

  Every customer action carries a question. Is this really them, and is it safe right now? The platform answers it in real time and returns one of 4 decisions: allow, step-up, deny, or send to a human.

  The goal is lopsided on purpose. Let the safe majority through untouched, and spend friction only where the risk earns it.

  2 design choices make that work. Risk logic lives in editable policy, so product and risk tune thresholds without an engineering release. And trust is contextual: the same customer doing the same thing can get a different answer depending on their device, their network, and how they've behaved lately.

> The lopsided claim is the point. Don't soften it into a balanced "of course there are
> tradeoffs" paragraph. The product has a position. Most people feel nothing.

### 2. How a decision is made · `.box` cards in a `.pipe`-style column

Mirror the 6 stages of the Simulator's Decision Trace so both screens teach the same
model. Each stage is a card: stage name (`.sname`), its one-line job (`.ssub`, mono),
and what it produces.

1. **Resolve** · `data/store.js` · Look up the customer, device, action, and current auth level. An unknown customer defaults to fraud score `50`, an unknown device to `0`. *Produces:* the raw inputs everything else reads.
2. **Enrich** · `adapters/*` · Add the network and identity context the request didn't carry: geolocation and proxy/Tor flags (ip-api), IP reputation (AbuseIPDB), breach exposure (HaveIBeenPwned), scanner and bot tags (GreyNoise), and a device fingerprint (FingerprintJS). *Produces:* enrichment signals and suspicion flags.
3. **Score** · `confidenceEngine.js` · Map fraud score to a risk level, blend device trust and fraud into one **effective confidence**, and check the customer's auth level against what the action needs. *Produces:* `riskLevel`, `effectiveConfidence`, AL checks.
4. **Trust** · `ambientTrustStore.js` · Fold in the customer's **Ambient Trust Score**, a running 0–100 read on whether their recent behaviour looks like them. *Produces:* `ambientTrustScore` in the decision context.
5. **Decide** · `policyEngine.js` · Walk the ordered rule list. The first rule whose conditions all match wins. A velocity burst or a low trust score can short-circuit here. *Produces:* the decision and the step-up type.
6. **Route & record** · `idvRouting.js` + `analytics.js` · If the answer is step-up to IDV, pick a vendor by the active strategy. Write the trace, the inputs, and a replay snapshot to the log. *Produces:* the customer-facing outcome and an auditable record.

- **Closing line under the pipe (`.outcome .why`):** Every decision ends in plain language. It's the same `why` the support agent and the auditor both read.

### 3. What we read · the signal catalog (the intelligence layer)

Group as cards. Each signal gets its name (mono), its source, what it does to the score,
and where it feeds. Use a `.meter` for range and direction where it helps. Spend the
most room on the enrichment sources and ambient trust. The obvious ones can be one line.

**Identity & fraud**
- `fraud_score`: 0–100, higher is riskier. The customer's standing risk from the profile store, or an external fraud API through the adapter. Bands: `LOW 0–25`, `MEDIUM 26–79`, `HIGH 80–100`. *Feeds:* Score.
- `geography`: country code, set from the customer record or the request IP. *Feeds:* Decide (rule conditions) and IDV vendor routing.

**Device**
- `device_score`: 0–100, higher is more trusted. A known device on a known network scores high. A fresh device scores near `0`. *Feeds:* Score, as 40% of effective confidence.
- `device_fingerprint` (FingerprintJS OSS): a browser fingerprint that yields a stable `visitorId`. A known `visitorId` is a trusted device. A new `visitorId` on a known customer cuts device trust by `−30` and is a core account-takeover tell. Self-hosted, no vendor fee. The same seam takes an enterprise device-intelligence provider like ThreatMetrix. *Feeds:* Score.

**Network & identity enrichment** (added at the Enrich stage, none of it rides in the request)
- `ip_geo` (ip-api.com): country, city, ISP, and proxy, hosting, and Tor flags for the request IP. No API key, cached 30 min. A proxy or VPN adds `+15` to fraud; a Tor exit adds `+40`. *Feeds:* Score and Decide.
- `abuse_score` (AbuseIPDB): IP reputation 0–100, free tier 1,000 checks/day, cached 1h. Inverted into device trust: `deviceScore = 100 − abuse_score`. *Feeds:* Score and ambient trust.
- `breach_status` (HaveIBeenPwned): whether the customer's email sits in a known breach corpus. Cached 24h. A hit adds `+20` to fraud and `−15` to ambient trust. *Feeds:* Score, ambient trust, Decide.
- `bot_flag` (GreyNoise Community): whether the IP is a tagged internet scanner or bot. A hit sets fraud to `95` and denies outright. Most real customers never appear here. *Feeds:* Decide.
- `password_compromised` (Pwned Passwords, k-anonymity): whether the submitted password shows up in breach data, checked by sending only a hash prefix so the password never leaves the client. A hit forces `AL3` selfie or higher. *Feeds:* Decide.

**Behaviour & velocity**
- `velocity_1m / 5m / 15m`: request counts in rolling windows, tracked in Redis sorted sets. More than `5 in 1m` denies as an automated burst. More than `10 in 5m` routes to manual review. *Feeds:* Decide (short-circuit) and ambient trust (`velocity_burst −20`).

**Ambient trust** (the layer that gives the platform memory, see §6)
- `ambient_trust_score`: 0–100, a running read on the customer across sessions. It climbs with completed step-ups, drops with suspicious signals, and decays toward `50` over time. *Feeds:* Trust, then Decide.

**Authentication state**
- `current_auth_level`: how the customer authenticated this session: `AL1` Face ID or passcode, `AL2` passkey, `AL3` selfie, `AL4` IDV. *Feeds:* Score (does it meet the action's required AL?) and Decide.

> Design note worth showing as a `.box`: enrichment runs async and cached. Every external
> call fires without blocking the decision, and results land in Redis (30 min to 24h
> depending on how fast the signal changes). If a source is slow or down, the engine uses
> the last cached value or the static score and decides anyway. The intelligence layer
> adds context to a decision; it never holds one up. The caching is also what keeps the
> free tiers viable: stable persona IPs mean most lookups are cache hits.

### 4. The pattern that catches account takeover · `.box.pad`, featured

Give this its own card. It's the sharpest story in the product.

- **Kicker:** `Why a "normal" account can still get stopped`
- **Body:**

  Account takeover is hard to catch because the attacker looks like the customer on paper. They're using the real person's credentials, so the fraud score reads normal. The platform watches 3 independent signals that move the moment someone else is at the controls: the email turns up in a breach (HaveIBeenPwned), the device fingerprint is new for this customer (FingerprintJS), and the connection is a proxy or VPN (ip-api). Any 2 of the 3 force `AL4` IDV, whatever the fraud score says. This is the logic major banks run in production.

- **Show as:** 3 `.minichip`s (`breach` · `new device` · `proxy`) with a `→ IDV` outcome `.badge`. Keep the chips neutral; only the IDV badge carries decision colour.

### 5. What we decide · `.badge` row + short table

4 outcomes. Show each as its decision `.badge` with the one-line meaning and what the
customer feels.

| Decision | Badge | Customer experience | Gets a reference id |
|---|---|---|---|
| Allow | `.r-allow` ALLOW | Nothing. The action goes through. | no |
| Step-up | `.r-review` STEP-UP | One extra challenge: passcode, passkey, selfie, or IDV. | `TXN-…` |
| Deny | `.r-deny` DENY | Action blocked, protection message shown. | `INC-…` |
| Manual review | `.r-deny` (muted) MANUAL | Queued for a human. The operator picks it up in Review. | `CASE-…` |

> The step-up type flexes with policy. `AL_PLUS_1` asks for one level above what the
> action requires. `REQUIRED_AL` asks for exactly enough.

### 6. Action tiers & assurance · two compact tables

**Action tiers.** Not every action carries the same risk.

| Tier | Examples | Min auth | Min confidence |
|---|---|---|---|
| `Tier1` | login, view balance | `AL1` | ~30–45 |
| `Tier2` | bill pay, P2P transfer | `AL2` | ~55–65 |
| `Tier3` | wire >£10K, change password | `AL3` | ~70–75 |
| `Tier4` | account recovery, add payee | `AL4` | ~85–90 |

**Assurance ladder.** Each rung is stronger and carries a confidence floor.

`AL1` Face ID / passcode · 45  →  `AL2` passkey · 65  →  `AL3` selfie · 80  →  `AL4` IDV · 95

- **Confidence formula** (show as a `.rulecard`): `effectiveConfidence = (deviceScore/100 × 40) + ((100 − fraudScore)/100 × 60)`, then clamped up to the authenticator's confidence floor once the customer has stepped up.

### 7. The trust layer · Ambient Trust Score · `.box.pad`, featured

Give this room. It's the part most people haven't seen before.

- **Kicker:** `Why the same request can get a different answer`
- **Body:**

  The Ambient Trust Score gives the platform a memory of each customer. It's one number, 0 to 100, that carries across sessions and moves with behaviour. A completed passkey adds `+3`, a selfie `+5`, full IDV `+8`. A new device costs `−10`, a detected breach `−15`, a velocity burst `−20`. Leave an account alone and the score drifts back toward a neutral `50`, so trust has to keep being renewed.

  The effect shows up in real decisions. A loyal customer who's cleared step-ups for months sits at a high score and stops getting asked. A wire that would normally demand a selfie just goes through. The same wire from an account showing a low score after a breach and a new login device gets pushed all the way to IDV. Policy reads the number directly through `ambient_trust_gte` and `ambient_trust_lte`, so you set the threshold in Policy Lab and tune it whenever you want.

- **Meter to show:** `.meter`, red `<30`, amber `30–70`, green `>70`, labelled "trust ramp." The score is a risk reading, so the decision-colour ramp belongs here.

> Keep this honest for the risk leads who'll read it: a memory of trust is also a target.
> Account takeover that rides a high score is the failure mode. That's why suspicious
> signals cut the score hard and fast (`−15`, `−20`) while trust accrues slowly (`+3` to
> `+8`).

### 8. How we exercise it · synthetic traffic & attacks · `.box` cards

You don't wait for real fraud to see the platform work. A traffic engine drives
continuous, realistic decisions, and they stream into Monitor in real time. This is the
left side of the system.

- **Traffic daemon**: a Node process under PM2 fires decision requests around the clock, time-weighted to look like real load, with an attack scheduler mixed in. Built on `generate-traffic.js`.
- **Persona bank**: 20–30 synthetic customers, each with a stable fraud score, device set, geography, and behaviour pattern, plus an attack probability. Stored in `personas.json`.
- **Live feed**: decisions stream into Monitor over Server-Sent Events. No polling, no websocket overhead.

**The 6 persona archetypes** (show as `.box` cards or a `.tape`; tint only the expected-outcome `.badge`):

| Persona | Profile | Headline signals | Expected |
|---|---|---|---|
| `Lara` | loyal retail, UK, daily | fraud `12`, known iPhone, home ISP, not breached | `ALLOW` |
| `Maxim` | cautious saver, infrequent | fraud `8`, known Android, Manchester home | `ALLOW` |
| `Jason` | business, DE/UK travel | fraud `38`, 3 known devices, 1 old breach, large wires | `STEP-UP` often |
| `Harvey` | high risk | fraud `82`, unknown device, VPN, 3 recent breaches, recovery | `DENY` / `MANUAL` |
| `Bot-001` | credential stuffer | fraud `95`, new device each request, AbuseIPDB `90+`, login burst | velocity `DENY` |
| `ATO-Nikky` | account takeover | fraud `40` (normal), new fingerprint, Nigeria proxy, email breached | `IDV` forced |

**3 attack scenarios the daemon can inject** (show as `.box` cards):

- **Credential stuffing burst**: Bot-001 fires 20 logins in 60 seconds across rotating IPs. `velocity_1m > 5` trips and AbuseIPDB returns `90+`. You watch the DENY cascade land in the live feed.
- **Account takeover chain**: Nikky's stolen credentials from a new device, a VPN, and a breached email. The fraud score looks normal, the ATO stack (§4) fires, and the action is forced to IDV.
- **Mule network**: 5 customers send to the same new payee inside 10 minutes. The pattern surfaces across the decision log and routes the later ones to manual review.

> This section is what turns a demo from "trust me" into "watch." Pair it with the
> Monitor's `.sys` state going `warn` then `crit` as an attack scenario runs.

### 9. How policy changes · governance · `.box` cards

The platform is meant to be tuned by product and risk, safely, without a deploy. These
are the controls that make that defensible.

- **Policy as configuration**: every band, weight, and rule lives in `policies/*.json`. Changing behaviour means editing JSON. Rules are ordered, first match wins, so specific rules sit above broad ones.
- **Policy Lab + AI copilot**: write the intent in plain language ("block Tor users on money movement") and the copilot drafts the rule, validates its structure, and simulates it. Nothing publishes on its own.
- **Simulate before publish**: replay a draft against recent real traffic and read the before/after decision mix, a transition matrix, and which rules fired or never fired. You see the blast radius before a customer does.
- **Versioning & rollback**: every published policy is a version. The history shows what changed, who changed it, and when. Rollback is one click.
- **A/B experiments**: run a draft against a deterministic slice of live traffic, control against treatment, and compare decision mixes before a full rollout. The same customer always lands in the same variant.
- **Rule performance**: per-rule health: how often each rule fires, which ones drive friction, which sit dormant. The link from a noisy rule drops you into Policy Lab filtered to it.

### 10. What holds it up · architecture envelope · `.box.pad`, for engineers

- **Kicker:** `Operating envelope`
- **Body:**

  The decision path is a Node and Express service with a strict pipeline and no risk logic in code. It degrades on purpose. Redis powers caching and velocity, and when it's gone, velocity rules skip and the rest carries on. Postgres backs the decision log and analytics, and without it the platform writes append-only JSONL. Google Sheets is an optional shared data source over the same store, with local JSON as the default. Mutation endpoints sit behind API-key auth. Every decision writes a replay snapshot, so you can rerun any past decision from the log exactly as it happened.

  External vendors plug in at fixed seams. Fraud and device scores come through the adapter layer; the enrichment sources in §3 are async adapters behind that same layer. IDV runs through vendor routing with 4 strategies, geo, percent split, round robin, and time-based, switchable without a release.

  Decision metrics ship to Grafana Cloud in Prometheus format: decision rates, p99 latency, and a rule-firing heatmap, the ops view that lives outside the console. The whole intelligence layer runs on free-tier APIs, so the added monthly cost is a few pounds, almost all of it the copilot.

- **Health pills to mirror (`.health`):** `Redis`, `Postgres`, `Sheets`, `Adapters 2/4`, each on or off.

### 11. Read on · link row (`.btn.ghost.sm`)

- `See it live → Monitor`
- `Try a request → Simulator`
- `Tune a rule → Policy Lab`

---

## Notes for the builder
- Atlas has no Signal reference screen. Build it from `.box`, `.meter`, `.badge`, `.rulecard`, and `.gauge` only. No new components, no new colours.
- The `.rulecard` blocks (the confidence formula, and any sample rule you show) use mono with `.k` for keywords and `.fired` for a matched rule.
- Atlas stays read-only. No inputs, no toggles. Behaviour changes only in Operate.
- Every decision-coloured element on both screens has to be an actual decision: the mix gauge, the badges, the trust ramp, the persona expected-outcome badges. Nothing else goes green, amber, or red.
- Live status check before shipping: the Control surface shows which enrichment adapters are actually configured (`Adapters 2/4`). Atlas names the full set as capability; if a source is dark, don't imply it's live. The numbers in §3 (`+20`, `+15`, `+40`, `−30`) are the configured mappings, not invented.
