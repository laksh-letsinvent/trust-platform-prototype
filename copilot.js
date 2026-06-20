// copilot.js
/**
 * AI Policy Copilot — natural language → rule JSON → simulated impact.
 *
 * Requires ANTHROPIC_API_KEY in .env. If not set the module exports a stub that
 * returns a 501 with a clear message — the rest of the app is unaffected.
 *
 * Flow:
 *   1. User describes a policy intent in plain English
 *   2. Claude generates a valid rule object (condition, decision, step_up_type, etc.)
 *   3. Rule is validated against policyEngine schema
 *   4. If valid, the current decisions config is cloned with the new rule prepended
 *      and immediately simulated against decision history
 *   5. Returns: { rule, validation, simulation } — nothing is written to disk
 *
 * The caller decides what to do: display impact, let the user edit, then
 * publish via the existing PATCH /policies/decisions endpoint.
 */

'use strict';

const { validateDecisionsConfig, validateRule, loadPolicies, VALID_CONDITION_KEYS, VALID_DECISIONS, VALID_STEP_UP_TYPES } = require('./policyEngine');
const { simulate } = require('./simulationEngine');

const AVAILABLE = !!process.env.ANTHROPIC_API_KEY;

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a trust & fraud policy assistant for a banking risk engine.
Your job is to translate a natural language policy intent into a single rule object that the engine can execute.

CONTEXT — the decision pipeline (v4 composite risk model):
- Each request carries: customer_id, action (with tier Tier1–Tier4, risk_ceiling per tier), device_id, current_auth_level (AL1–AL4)
- Scoring: compositeRisk (0–100, weighted average of 5 components) → riskLevel (LOW/MEDIUM/HIGH)
  Components: customerRisk (fraudScore), deviceRisk (100−deviceScore), behaviouralRisk (100−ambientTrustScore),
  networkRisk (additive: ip_abuse, vpn, proxy, new_device, breach), velocityRisk (non-burst counts)
- Hard gates (evaluated before scoring): tor_detected → DENY, is_greynoise_bot → DENY,
  velocity_1m_gt: 5 → DENY, velocity_5m_gt: 10 → MANUAL_REVIEW
- risk_ceiling_breached: true when compositeRisk > action's risk_ceiling (Tier1=85, Tier2=70, Tier3=55, Tier4=40)
- Assurance ladder: alMeetsRequired (bool), AL1 (FaceID) < AL2 (passkey) < AL3 (selfie) < AL4 (IDV)
- Decisions: ALLOW, STEP_UP, DENY, MANUAL_REVIEW. STEP_UP requires a step_up_type.

VALID condition keys (only these are recognised):
${VALID_CONDITION_KEYS.map(k => `  ${k}`).join('\n')}

VALID decisions: ${VALID_DECISIONS.join(', ')}
VALID step_up_type values: ${VALID_STEP_UP_TYPES.join(', ')}
  Dynamic tokens: AL_PLUS_1 (one AL above action's required), REQUIRED_AL (exact required AL)

OUTPUT FORMAT — respond with ONLY a single JSON object, no markdown, no explanation:
{
  "id": "<snake_case_rule_id>",
  "enabled": true,
  "description": "<one sentence>",
  "condition": { ...only valid condition keys... },
  "decision": "<ALLOW|STEP_UP|DENY|MANUAL_REVIEW>",
  "step_up_type": "<type or null>",
  "reason": "<customer-facing explanation, max 120 chars>",
  "copilot_explanation": "<2–3 sentences explaining the rule and any trade-offs>"
}

Rules:
- step_up_type must be null for ALLOW, DENY, MANUAL_REVIEW
- step_up_type is required for STEP_UP
- Prefer specific conditions over broad ones
- If the intent is ambiguous, pick the safer/more conservative interpretation
- Never invent condition keys not in the list above`;

// ─── Claude API call ─────────────────────────────────────────────────────────

async function callClaude(userMessage) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk').catch(() => {
        throw new Error('@anthropic-ai/sdk is not installed. Run: npm install @anthropic-ai/sdk');
    });

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const msg = await client.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }]
    });

    const text = msg.content.find(b => b.type === 'text')?.text?.trim();
    if (!text) throw new Error('Empty response from Claude');

    // Strip markdown code fences if Claude wraps anyway
    const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

    let rule;
    try {
        rule = JSON.parse(cleaned);
    } catch (e) {
        throw new Error(`Claude returned non-JSON: ${text.slice(0, 200)}`);
    }

    return rule;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Generate a policy rule from natural language, validate it, and simulate its impact.
 * @param {string} intent - plain English policy intent
 * @param {object} [opts]
 * @param {string} [opts.insertPosition] - 'top' (before all rules) or 'bottom' (before default). Default: 'top'
 * @param {number} [opts.simulationLimit] - max records to replay
 * @returns {object} { rule, validation, simulation, insert_position }
 */
async function suggest(intent, opts = {}) {
    if (!AVAILABLE) {
        const err = new Error('AI copilot requires ANTHROPIC_API_KEY to be set in your environment');
        err.statusCode = 501;
        throw err;
    }

    if (!intent || typeof intent !== 'string' || !intent.trim()) {
        const err = new Error('intent must be a non-empty string');
        err.statusCode = 400;
        throw err;
    }

    // 1. Ask Claude to generate a rule
    const rule = await callClaude(intent.trim());

    // 2. Validate the rule
    const ruleErrors = validateRule(rule);
    const ruleValid = ruleErrors.length === 0;

    // 3. Build a proposed config with the new rule inserted
    const currentConfig = loadPolicies();
    const insertPosition = opts.insertPosition === 'bottom' ? 'bottom' : 'top';

    let proposedRules;
    if (insertPosition === 'top') {
        proposedRules = [rule, ...currentConfig.rules];
    } else {
        proposedRules = [...currentConfig.rules, rule];
    }

    const proposedConfig = { ...currentConfig, rules: proposedRules };

    // 4. Simulate if rule is valid (skip if invalid — would cause a 400 from simulator too)
    let simulationResult = null;
    let simulationError = null;

    if (ruleValid) {
        try {
            simulationResult = await simulate(proposedConfig, {
                limit: opts.simulationLimit || 1000
            });
        } catch (e) {
            simulationError = e.message;
        }
    }

    return {
        rule,
        validation: {
            valid: ruleValid,
            errors: ruleErrors
        },
        simulation: simulationResult,
        simulation_error: simulationError,
        insert_position: insertPosition,
        note: !ruleValid
            ? 'Rule failed validation — fix errors before publishing via PATCH /policies/decisions'
            : 'Review impact, then publish via PATCH /policies/decisions with the rule object'
    };
}

module.exports = { suggest, isAvailable: () => AVAILABLE };
