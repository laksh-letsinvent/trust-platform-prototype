# Trust Platform — Product Overview

## What is the Trust Platform?

The Trust Platform is a real-time decision engine that determines how much friction a customer should experience when performing an action in the app. For every request — paying a bill, making a transfer, recovering an account — the platform evaluates the customer's fraud risk, device trust, and current authentication state, then issues one of four decisions.

The platform is built as a prototype to demonstrate and test trust policy logic. All decision rules are editable at runtime through a web console without redeploying code.

---

## The Four Decisions

| Decision | What it means | Customer experience |
|----------|---------------|-------------------|
| **ALLOW** | Trust is sufficient — let the customer through | No extra friction; action proceeds immediately |
| **STEP_UP** | Trust is borderline — require stronger authentication | Customer is prompted to complete an additional auth challenge |
| **DENY** | Risk is too high — block the action | Action is blocked; customer sees a protection message |
| **MANUAL_REVIEW** | Signals are ambiguous — route to a human | Action is queued for a fraud analyst to review |

---

## How Decisions Are Made

The platform combines three types of signals to arrive at a decision:

### 1. Fraud Risk (from the customer profile)

Every customer has a **fraud score** (0–100, higher = riskier). The platform maps this to a risk level:

| Risk Level | Fraud Score Range |
|------------|------------------|
| **LOW** | 0–25 |
| **MEDIUM** | 26–79 |
| **HIGH** | 80–100 |

Customers not in the system default to a score of 50 (MEDIUM risk).

### 2. Device Trust (from the device profile)

Every device has a **device score** (0–100, higher = more trusted). A device the customer has used regularly on a known network scores high; an unrecognised device scores low. Unregistered devices default to a score of 0.

### 3. Authentication State (from the request)

The request carries the customer's **current authentication level** (AL), which reflects how they authenticated for this session:

| Auth Level | Method | Strength |
|------------|--------|---------|
| **AL1** | Face ID / Device passcode | Baseline |
| **AL2** | Passkey (FIDO2) | Strong |
| **AL3** | Selfie check | Stronger |
| **AL4** | Identity document verification (IDV) | Strongest |

---

## Action Tiers

Not all actions carry the same risk. The platform groups actions into four tiers, each with a minimum required authentication level and confidence threshold:

| Tier | Example actions | Min auth required | Min confidence required |
|------|----------------|------------------|------------------------|
| **Tier 1** | Login, view balance, view statements | AL1 | ~30–45 |
| **Tier 2** | Bill pay, P2P transfer, internal transfer | AL2 | ~55–65 |
| **Tier 3** | Wire transfer >£10K, investment trade, change password | AL3 | ~70–75 |
| **Tier 4** | Account recovery, add new payee | AL4 | ~85–90 |

---

## Effective Confidence

The platform computes an **effective confidence score** (0–100) that reflects the overall trust level for a given request, blending device trust and fraud risk:

> `effective confidence = (device score × 40%) + ((100 − fraud score) × 60%)`

If the customer has authenticated at a high level (e.g. completed a selfie check), the authenticator's confidence can raise the effective confidence floor.

The decision engine then checks whether the effective confidence meets the action's required threshold, and whether the customer's current auth level meets the action's required AL.

---

## Step-Up Authentication

When the platform issues a **STEP_UP** decision, it specifies exactly which authentication method is required:

| Step-up type | What the customer sees |
|--------------|----------------------|
| **PASSCODE** | Prompted to enter their PIN |
| **PASSKEY** | Prompted to authenticate with their passkey |
| **SELFIE** | Prompted to complete a selfie liveness check |
| **IDV** | Routed through identity document verification |

The required step-up is determined by the action's tier and the customer's risk level — not hardcoded, but driven by policy rules that can be adjusted.

---

## Identity Verification (IDV) Routing

When a customer requires full IDV, the platform selects which IDV vendor to use. Four routing strategies are available:

| Strategy | How it works |
|----------|-------------|
| **Geo-based** | Route UK/Ireland customers to vendor 1, Germany/France to vendor 2 |
| **Percent split** | Send a configurable percentage (e.g. 70/30) to each vendor for A/B testing |
| **Round robin** | Alternate between vendors per request |
| **Time-based** | Route to different vendors based on time of day (e.g. for SLA management) |

The active strategy is configurable without a code change.

---

## Velocity Protection

The platform tracks how many requests a customer makes in short time windows (1 minute, 5 minutes, 15 minutes). Unusual bursts trigger automatic protection:

- **More than 5 requests in 1 minute** → DENY (unusual burst — likely automated)
- **More than 10 requests in 5 minutes** → MANUAL_REVIEW (elevated rate — human review)

Velocity tracking requires Redis. When Redis is unavailable, velocity checks are skipped and all other decision logic continues normally.

---

## Reference IDs

Every actionable decision gets a human-readable reference ID for tracking and support:

| Decision | Format | Example |
|----------|--------|---------|
| STEP_UP | `TXN-YYYYMMDD-XXXX` | `TXN-20260228-K7P2` |
| MANUAL_REVIEW | `CASE-YYYYMMDD-XXXX` | `CASE-20260228-M3R7` |
| DENY | `INC-YYYYMMDD-XXXX` | `INC-20260228-Q9JH` |

ALLOW decisions do not get a reference ID (no action required).

---

## Tuning the Rules

The platform is **policy-driven**: decision logic lives in configuration files, not in application code. This means product and risk teams can adjust thresholds and rules without an engineering deploy.

### What can be changed at runtime

| Setting | What it affects | How |
|---------|----------------|-----|
| Risk level bands | The fraud score thresholds for LOW / MEDIUM / HIGH | Edit confidence policy |
| Effective confidence formula | The weighting between device trust and fraud risk | Edit confidence policy (weights must sum to 100%) |
| Action tier requirements | Minimum auth level and confidence per tier | Edit confidence policy |
| Decision rules | Which risk/tier/auth combinations trigger which outcome | Edit decisions policy |
| Individual rule on/off | Enable or disable any specific rule | Toggle `enabled` flag per rule |
| Velocity rules | Enable/disable burst and elevated-rate protection | Velocity toggle |
| IDV routing strategy | Which vendor to use and how to split traffic | Edit IDV routing policy |

### Decision rules are ordered

Rules are evaluated in priority order — the first rule whose conditions all match wins. This means more specific rules (e.g. "high risk + Tier 4 → DENY") should be placed before broader rules (e.g. "high auth level met → ALLOW").

---

## The Demo Console

A web console is available at `http://localhost:3000`. It provides:

- **Decision simulator** — Run a trust decision for any combination of customer, action, device, and auth level. See the full decision trace including which rule matched and why.
- **Decision log** — Browse the history of all decisions with filter by customer or outcome.
- **Analytics dashboard** — View breakdown of decisions by outcome, action, risk level, and rule.
- **Policy editor** — Adjust confidence weights, toggle individual decision rules, and configure IDV routing — all reflected immediately on the next decision.

---

## Data Sources

The platform supports two data sources, switchable via environment variable:

- **Local JSON files** — Default, no setup required. Edit `data/users.json`, `data/devices.json`, etc. directly.
- **Google Sheets** — Connect a spreadsheet for a shared, editable view of users, devices, actions, and authenticators. Recommended for demo scenarios with multiple stakeholders.

---

## Sample Customer Profiles

| Customer | Fraud Score | Risk | Geography |
|----------|------------|------|-----------|
| cust_retail_001 | 12 | LOW | UK |
| cust_retail_002 | 22 | LOW | UK |
| cust_retail_003 | 28 | MEDIUM | DE |
| cust_retail_004 | 35 | MEDIUM | UK |
| cust_retail_005 | 55 | MEDIUM | DE |
| cust_retail_006 | 68 | MEDIUM | UK |
| cust_retail_007 | 80 | HIGH | UK |
| cust_retail_008 | 90 | HIGH | DE |

## Sample Device Profiles

| Device | Score | Trust level |
|--------|-------|-------------|
| dev_iphone_001 | 92 | Highly trusted |
| dev_iphone_002 | 78 | Trusted |
| dev_android_001 | 55 | Moderate |
| dev_tablet_001 | 60 | Moderate |
| dev_android_002 | 20 | Low trust |
| dev_unknown_001 | 5 | Untrusted / new |
