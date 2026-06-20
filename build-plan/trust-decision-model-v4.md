# Trust Decision Model v4 — Concept, Impact Analysis, and Build Prompt

Author: Laksh · Date: 2026-06-19
Status: Spec for Claude Code to implement
Scope: whole stack — data, engine, policies, schema, API, UI, demo/seed, deploy

---

## Part 1 — The concept

### Diagnosis

The engine carries six overlapping ways to express "how worried am I / how sure is it them": `fraudScore→riskLevel`, `deviceScore`, `effectiveConfidence→confidenceMeetsAction`, assurance level (`AL→alMeetsRequired`), `ambientTrustScore`, and raw enrichment flags. Two of these are dead or duplicated. `confidenceMeetsAction` drives zero decisions — the whole confidence formula, `required_confidence` per action, and `confidence_level` per authenticator exist only to compute a number no rule reads. `deviceScore` and `ambientTrustScore` are both 0–100 "trust" and both move on the same events, so one new-device login is counted three times. Authenticators encode strength twice (AAL and `confidence_level`). The result is a model that's hard to explain because it has two of everything.

### The target model: three inputs, two axes, one decision

Collapse six constructs to **three inputs** feeding a **two-axis decision**.

**Input 1 — Risk (one composite score, 0–100, higher = riskier).** Every probabilistic "how worried" signal becomes a normalised component and feeds one weighted score. Weights live in policy, not code.

| Component | Source | Direction fix | Default weight |
|---|---|---|---|
| `customerRisk` | `fraudScore` | already risk-oriented | 40 |
| `deviceRisk` | `100 − deviceScore` | invert (trust→risk) | 25 |
| `behaviouralRisk` | `100 − ambientTrustScore` | invert (trust→risk) | 15 |
| `networkRisk` | enrichment: vpn/proxy/breach/ip_abuse/new_device | derived sub-score | 15 |
| `velocityRisk` | velocity counts (non-burst) | derived sub-score | 5 |

`compositeRisk = Σ(component × weight) / 100`, clamped 0–100, then banded LOW/MEDIUM/HIGH. The five top-level weights must sum to 100 (same validation contract the old confidence weights had).

**`networkRisk` sub-score — additive points, capped at 100 (do NOT sum sub-weights to 100).** These signals co-occur, so they stack toward 100 rather than diluting each other. Defaults:

| Signal | Points | Rationale |
|---|---|---|
| `ip_abuse_score` | `score × 0.6` (max 60) | Strongest; already continuous |
| `email_breached` (breach_count > 2) | 25 | Credential exposure / ATO precursor |
| `proxy` | 20 | More often abuse than VPN |
| `is_new_device` | 20 | Real but false-positive-prone; kept modest |
| `vpn` | 15 | Many legitimate privacy users; weakest |

`networkRisk = min(100, Σ points)`. This is deliberately different math from the five top-level components — additive-capped for binary co-occurring flags, weighted-average for the components. (Tor and GreyNoise bot are gates, not contributors here.)

This replaces the additive magic numbers currently hardcoded in `decisionEngine.js` (`+40 tor`, `+15 vpn`, `−30 new device`…). Those mutations move into `networkRisk` with policy-defined weights, which finally makes "policy-driven, not code-driven" true for risk.

**Input 2 — Assurance (one ladder, AAL1–AAL4).** Keep the NIST-aligned assurance level. Drop `confidence_level` from authenticators entirely. An authenticator maps to an `assurance_level`; an action requires one; `alMeetsRequired` is the only sufficiency check. Step-up closes the gap (`AL_PLUS_1` / `REQUIRED_AL` tokens stay).

**Input 3 — Action requirement (what's at stake).** Each action declares a `tier`, a `required_al`, and a new `risk_ceiling` (max tolerated composite risk). `required_confidence` is deleted. Suggested ceilings: Tier1 85, Tier2 70, Tier3 55, Tier4 40 (higher tier → lower tolerance).

### Hard gates vs. risk signals — a clean split

Deterministic blocks are **gates**, evaluated before scoring; probabilistic signals feed the **risk score**. This kills the current double-count where Tor both adds +40 to fraud *and* triggers a deny rule.

- Gates (short-circuit, pre-policy): Tor exit node → DENY; GreyNoise bot → DENY; velocity 1m burst → DENY; velocity 5m elevated → MANUAL_REVIEW.
- Risk contributors (feed `networkRisk`): VPN, proxy, email breach, IP abuse score, new device.

### Decision logic (≈7 rules, not 18)

First-match-wins stays, but rules now read on two clean axes — `compositeRisk` band and the assurance gap — plus the gates:

1. Hard gates (above).
2. Risk ceiling breach on high tier → DENY (Tier4) / MANUAL_REVIEW (Tier2–3).
3. Assurance gap (`alMeetsRequired = false`) → STEP_UP, closing the gap (`AL_PLUS_1` when risk elevated, `REQUIRED_AL` when low).
4. Risk elevated but assurance met → STEP_UP extra factor, or MANUAL_REVIEW at high tier.
5. Low risk + assurance met → ALLOW (→ rendered FRICTIONLESS).
6. Default → STEP_UP `REQUIRED_AL`.

The two demo-friendly behaviours that currently need bespoke ATS rules now emerge from the model for free: a loyal customer has high ATS → low `behaviouralRisk` → low composite → frictionless. A customer with recent suspicion has low ATS → high composite → step-up. No standalone ATS rules needed.

### Decisions I'm making (and why)

- **Fold ATS into the composite, delete standalone ATS rules.** Removes the "two trust scores" confusion. ATS stays stored, displayed, and decayed as a *component input*, not a parallel decision path. Change my mind if you want ATS to override the model (e.g. VIP allow-list) — that's a deliberate gate, not a score.
- **Keep three risk bands.** The composite gives continuous resolution; three bands keep the UI legible. Tunable in policy. (Old MEDIUM spanned 26–79 — too wide; rebanding on composite fixes the worst of it.)
- **Delete the confidence subsystem outright, not deprecate.** Nothing reads it; a soft-deprecate just leaves the ghost limb. If an auditor needs a numeric confidence reported independently of AAL, that's a reporting view, not a decision input — out of scope here.

---

## Part 2 — Impact analysis (blast radius by layer)

Touch only the repo root. Ignore `.claude/worktrees/*` (throwaway git worktrees). Do not touch the other Caddy apps on the server.

### Engine / code

| File | Current role | Change |
|---|---|---|
| `confidenceEngine.js` | computes risk band + effectiveConfidence + AL checks | Rename concept to risk scoring. Add `computeCompositeRisk(components, weights)` and component normalisers. Delete `computeEffectiveConfidence`, `confidenceMeetsAction`, authenticator-confidence max logic. Keep `getRiskLevel` (now bands the composite), `alMeetsRequired`, `AL_ORDER`. Consider renaming file → `riskEngine.js` (update requires). |
| `decisionEngine.js` | orchestrates pipeline; **hardcoded enrichment magic numbers** | Remove the additive `fraudScore +=` / `deviceScore -=` blocks. Instead build the five risk components and call the composite scorer. Drop `effectiveConfidence`/`requiredConfidence` from trace and analytics. Keep ALLOW→FRICTIONLESS rename, reference IDs, sessions. |
| `policyEngine.js` | matches conditions, first-match-wins | Remove condition keys `confidenceMeetsAction`, `deviceScoreMin/Max`, `fraudScoreMin/Max`, `ambient_trust_gte/lte` — all folded into composite. **Rules read the band (`riskLevel`), not numeric composite — do NOT add `compositeRiskMax`/`compositeRiskMin`.** Add one computed boolean key `risk_ceiling_breached` (`compositeRisk > action.risk_ceiling`). Update `VALID_CONDITION_KEYS`, `conditionToSummary`, `explainCondition`, `matchesCondition`. |
| `simulationEngine.js` | replays `decisions.jsonl` snapshots | Rebuild context using composite scorer. Replay snapshots store `fraudScore`, `deviceScore`, `enrichment`, `velocity` — enough to recompute composite. ATS is not in old snapshots → default 50 on replay (already the case). Add `ambientTrustScore` to new snapshots. |
| `copilot.js` | NL→rule via Claude; describes signals to LLM | Update the system prompt's signal vocabulary: composite risk + components, AAL, risk_ceiling. Remove confidence language. |
| `analytics.js` | ring buffer + jsonl + replay snapshot | Drop `effectiveConfidence` from records; add `compositeRisk` + components. Add `ambientTrustScore` to `replay`. Old records without composite → skipped by simulator (existing `skipped_no_snapshot` path). |
| `amplitude.js` | event tracking | Replace `effectiveConfidence` property with `compositeRisk`. |
| `data/store.js`, `data/sheets.js` | dual data source | Stop reading `required_confidence` / `confidence_level` columns. Keep `fraud_score`, `device_score`, `assurance_level`. |
| `adapters/deviceAdapter.js`, `fraudAdapter.js` | thin score wrappers | No change (still supply raw scores). |
| `ambientTrustStore.js` | ATS store + decay | No change to storage; it now feeds `behaviouralRisk` instead of bespoke rules. |

### Policies / schema

| File | Change |
|---|---|
| `policies/confidence.json` | Rename → `risk.json` (or keep filename, change contents). Replace `effectiveConfidence{deviceWeight,fraudWeight,useAuthenticatorMax}` with `compositeRisk{weights:{customer,device,behavioural,network,velocity}}` summing to 100, plus `networkRisk` sub-weights. Remove `actionTierRequirements` (the required_confidence map). Keep `riskLevelBands` (now over composite), `actionTierRequiredAL`. |
| `policies/decisions.json` | Rewrite rule set from 18 → ~7 on the new axes. Remove ATS-only rules; remove confidence conditions. Bump version → 4.0. |
| `policies/schema/confidence.schema.json` | Replace `effectiveConfidence` block with `compositeRisk` weights; drop `actionTierRequirements`. |
| `policies/schema/decisions.schema.json` | Add new condition keys; remove `confidenceMeetsAction`, ATS keys (if dropped). |
| `policyValidator.js` | New weight-sum validation: composite weights sum to 100 (replaces device+fraud=100 check). |
| `data/actions.json` | Drop `required_confidence`; add `risk_ceiling` per action. |
| `data/authenticators.json` | Drop `confidence_level`; keep `assurance_level`. |

### API (`server.js`)

| Endpoint | Change |
|---|---|
| `GET/PATCH /policies/confidence` | Rename to `/policies/risk` (or keep path, new body). PATCH validates composite weights sum to 100. Update the Control Panel card it backs. |
| `/trust/decision` response + trace | Remove `effectiveConfidence`/`confidenceMeetsAction`; add `compositeRisk` + component breakdown. |
| `/analytics`, `/decisions` | Drop confidence fields from any projections. |
| ATS endpoints (`/trust/ats/*`) | Keep (ATS still exists as a component); no behavioural-rule wiring. |

### Frontend (`public/index.html`, 2,946 lines, ~46 confidence refs)

| Surface (approx line) | Change |
|---|---|
| Decision Simulator result + trace (≈570, 758, 944, 2110, 2233) | Replace "Effective confidence / requiredConfidence / confidenceMeetsAction" display with composite risk + a component bar (customer/device/behavioural/network/velocity). |
| Control Panel "Confidence formula weights" card (≈1374–1391, 2548–2623) | Becomes "Composite risk weights": five sliders summing to 100 + network sub-weights. Drop `useAuthenticatorMax` toggle. |
| Control Panel "Risk bands" card | Now bands the composite (relabel axis, same control). |
| Policy Lab | Update condition-key picker to new vocabulary. |
| Any authenticator/action tables showing `confidence_level`/`required_confidence` | Show `assurance_level` / `risk_ceiling`. |

### Demo / seed / deploy

| File | Change |
|---|---|
| `scripts/generate-traffic.js` | Stop seeding `required_confidence`/`confidence_level`; seed composite-relevant fields. Regenerate `decisions.jsonl` so Policy Lab + Analytics have v4 data. |
| `scripts/setup-google-sheet.js` | Update tab schema (drop two columns, add `risk_ceiling`). |
| `scripts/attack-scenarios.js`, `traffic-daemon.js` | Verify still produce expected decisions under v4. |
| `CLAUDE.md` | Rewrite the confidence/AL/enrichment sections to v4. |
| `docs/*.html` | Reference docs — update or mark superseded (non-runtime, low priority). |
| Deploy | After local verify, redeploy via the rsync+PM2 block in CLAUDE.md; smoke-test `https://trustdecision.letsinvent.co.uk`. |

### Backward-compatibility notes

- **Old `decisions.jsonl` replay snapshots** lack `ambientTrustScore` and composite — simulator must default ATS=50 and recompute composite from stored components; pre-snapshot records stay in `skipped_no_snapshot`.
- **API consumers** sending `current_auth_level` are unaffected; responses lose confidence fields and gain composite fields (additive + one removal — flag if any external caller reads `effectiveConfidence`).
- **Existing saved policy versions** (Postgres) referencing removed condition keys will fail validation on rollback — acceptable; note in migration.

---

## Part 3 — Build prompt for Claude Code

> Paste everything below into Claude Code, working in `/Users/lsinghal/trust-platform-prototype`.

---

**Context.** You are refactoring the trust decision engine to v4. The current model carries redundant, partly-dead scoring concepts. Read `build-plan/trust-decision-model-v4.md` (this file) Parts 1 and 2 in full before writing code — they define the target model and the per-file blast radius. Read `CLAUDE.md` for architecture and deploy steps.

**Goal.** Collapse six overlapping scoring constructs into three inputs (composite Risk, single Assurance ladder, Action requirement) and a two-axis decision. Delete the confidence subsystem. Move hardcoded enrichment adjustments into policy. Fold ambient trust into the composite. Reduce the rule set from 18 to ~7.

**Hard constraints.**
- Work only in the repo root. Do **not** modify anything under `.claude/worktrees/`.
- Do not touch other apps on the deploy server or their Caddy config.
- Keep the public API shape stable except the documented confidence-field removal and composite-field additions.
- Preserve: ALLOW→FRICTIONLESS rename, reference-ID generation, sessions, IDV routing, hard gates' deny/review behaviour.

**Execute in phases, verifying after each:**

1. **Policy + schema.** Rewrite `policies/confidence.json` (composite weights summing to 100, network sub-weights, risk bands over composite, drop `actionTierRequirements`). Rewrite `policies/decisions.json` to ~7 rules on `compositeRisk` band × assurance gap + gates; bump to v4.0. Update both schema files and `policyValidator.js` (weights-sum-to-100 check).
2. **Data.** `data/actions.json`: drop `required_confidence`, add `risk_ceiling`. `data/authenticators.json`: drop `confidence_level`. Update `data/store.js` and `data/sheets.js` readers.
3. **Engine.** In `confidenceEngine.js` (rename to `riskEngine.js`, update all requires): add composite scorer + component normalisers; delete `computeEffectiveConfidence` and `confidenceMeetsAction`. In `decisionEngine.js`: remove the hardcoded enrichment `+=/-=` blocks, build the five components, call the composite scorer, update trace. Update `policyEngine.js` condition keys (`VALID_CONDITION_KEYS`, `matchesCondition`, `conditionToSummary`, `explainCondition`).
4. **Supporting modules.** `simulationEngine.js`, `copilot.js`, `analytics.js` (incl. `replay` snapshot + add `ambientTrustScore`), `amplitude.js`.
5. **API.** `server.js`: rename/repoint the confidence policy endpoint, update validation, strip confidence fields from responses, add composite fields.
6. **Frontend.** `public/index.html`: replace confidence displays with composite risk + component breakdown; convert the "Confidence formula weights" card to "Composite risk weights"; update Policy Lab condition picker and any authenticator/action tables. (~46 confidence refs — grep to find them all.)
7. **Demo/seed.** Update `scripts/generate-traffic.js` and `scripts/setup-google-sheet.js`; regenerate `decisions.jsonl` (`node scripts/generate-traffic.js --count 2000`).
8. **Docs.** Rewrite the relevant `CLAUDE.md` sections to v4.

**Verification (definition of done):**
- Server boots clean (`node server.js`), `/status` healthy.
- `grep -rn "effectiveConfidence\|confidenceMeetsAction\|required_confidence\|confidence_level" --include=*.js --include=*.json --include=*.html .` (excluding `.claude/`, `node_modules`) returns **zero** in root.
- Composite weights validation rejects a non-100 sum via `PATCH`.
- Run the simulation engine (old config vs. new) and report the decision-mix delta; confirm the shift is explained by the model, not by a bug. Spot-check the personas: a low-fraud/known-device user on Tier1 is FRICTIONLESS; a high-fraud user (Hitesh, 90) on Tier4 is DENY; a Tor request on any tier is DENY.
- UI: Decision Simulator shows the composite breakdown; Control Panel risk-weights card saves and re-evaluates.
- Update `CLAUDE.md` so its description matches the running system.
- Do **not** auto-deploy. Stop and report the simulation delta + a one-paragraph summary so Laksh can review before the rsync/PM2 redeploy.

---

*End of spec.*
