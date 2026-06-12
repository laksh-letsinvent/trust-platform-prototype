# Trust Platform

A policy-driven trust decision engine for banking and fintech. Every customer action flows through a risk pipeline that combines fraud scores, device signals, and velocity checks to produce a real-time decision: **ALLOW**, **STEP_UP**, **DENY**, or **MANUAL_REVIEW**.

**Live:** https://trustdecision.letsinvent.co.uk

---

## Quick start

```bash
npm install
node server.js
```

Server starts on `http://localhost:3000`. Redis and Google Sheets are optional — the app runs fully on local JSON files without them.

## Environment variables

Copy `.env.example` to `.env` and set what you need:

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | HTTP port (default 3000) |
| `AMPLITUDE_API_KEY` | No | Product analytics |
| `REDIS_URL` | No | Enables caching + velocity tracking |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | No | Use Sheets instead of local JSON |
| `GOOGLE_APPLICATION_CREDENTIALS` | No | Path to service account key |

## How it works

Every `POST /trust/decision` request goes through this pipeline:

```
request
  → confidenceEngine   compute risk level + effective confidence from fraud/device scores
  → policyEngine       evaluate ordered rules → ALLOW / STEP_UP / DENY / MANUAL_REVIEW
  → idvRouting         if step_up_type=IDV, select vendor via routing strategy
  → analytics          log decision to ring buffer + decisions.jsonl
```

All risk thresholds, confidence formulas, and decision rules live in `policies/*.json` — no code changes needed to adjust behaviour.

### Auth Assurance Levels

`AL1` (passcode/FaceID) → `AL2` (passkey) → `AL3` (selfie) → `AL4` (IDV)

Step-up challenges escalate through this hierarchy based on the action tier and current risk.

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/trust/decision` | Main endpoint. Body: `{ customer_id, action, device_id, current_auth_level? }` |
| `GET` | `/analytics` | Aggregated decision stats. Optional `?customer_id=` filter |
| `GET` | `/decisions` | Paginated decision log. Params: `limit`, `offset`, `customer_id`, `decision` |
| `DELETE` | `/analytics` | Clear in-memory ring buffer |
| `GET/PATCH` | `/policies/confidence` | Confidence policy |
| `GET/PATCH` | `/policies/decisions` | Decision rules |
| `GET/PATCH` | `/policies/idvRouting` | IDV vendor routing |
| `POST` | `/policies/velocity-toggle` | Toggle velocity rules. Body: `{ "enabled": true\|false }` |
| `GET` | `/data/users\|devices\|actions\|authenticators` | Raw data inspection |
| `GET` | `/status` | Redis / Sheets availability |

## Project structure

```
policies/          risk rules and confidence config (edit these to change behaviour)
data/              local JSON data store (users, devices, actions, authenticators)
adapters/          thin wrappers over data/store.js — extension points for external APIs
public/index.html  single-page frontend
server.js          Express app + route handlers
decisionEngine.js  pipeline orchestrator
confidenceEngine.js risk level + confidence calculation
policyEngine.js    rule evaluation
velocityEngine.js  Redis sorted-set velocity tracking
idvRouting.js      IDV vendor selection
analytics.js       decision logging
```

## Google Sheets setup (optional)

```bash
GOOGLE_APPLICATION_CREDENTIALS=./credentials.json node scripts/setup-google-sheet.js
```

Creates a spreadsheet with all required tabs and sample data, then prints the `SPREADSHEET_ID` to add to `.env`.
