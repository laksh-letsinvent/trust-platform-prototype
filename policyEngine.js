// policyEngine.js

const path = require('path');
const fs = require('fs');

let decisionsConfig = null;

function loadPolicies() {
    if (decisionsConfig) return decisionsConfig;
    const filePath = path.join(__dirname, 'policies', 'decisions.json');
    const raw = fs.readFileSync(filePath, 'utf8');
    decisionsConfig = JSON.parse(raw);
    return decisionsConfig;
}

function clearCache() {
    decisionsConfig = null;
}

// Maps a target AL to the step-up authenticator type that achieves it
const AL_ORDER = ['AL1', 'AL2', 'AL3', 'AL4'];
const AL_TO_STEPUP = { AL1: 'PASSCODE', AL2: 'PASSKEY', AL3: 'SELFIE', AL4: 'IDV' };

/**
 * Resolves dynamic step_up_type tokens:
 *   AL_PLUS_1   → one AL level above the action's requiredAL
 *   REQUIRED_AL → the authenticator type that achieves the action's requiredAL
 *   <literal>   → returned as-is (PASSCODE, PASSKEY, SELFIE, IDV)
 */
function resolveStepUpType(rawType, context) {
    if (!rawType) return null;
    if (rawType === 'AL_PLUS_1') {
        const idx = AL_ORDER.indexOf(context.requiredAL);
        const targetIdx = Math.min(idx < 0 ? 1 : idx + 1, AL_ORDER.length - 1);
        const targetAL = AL_ORDER[targetIdx];
        return AL_TO_STEPUP[targetAL] || 'PASSKEY';
    }
    if (rawType === 'REQUIRED_AL') {
        return AL_TO_STEPUP[context.requiredAL] || 'PASSKEY';
    }
    return rawType;
}

function matchesCondition(condition, context) {
    if (!condition) return true;

    if (condition.risk_ceiling_breached != null && context.risk_ceiling_breached !== condition.risk_ceiling_breached)
        return false;
    if (condition.riskLevel != null) {
        const allowed = Array.isArray(condition.riskLevel)
            ? condition.riskLevel.includes(context.riskLevel)
            : context.riskLevel === condition.riskLevel;
        if (!allowed) return false;
    }
    if (condition.geography != null) {
        const allowed = Array.isArray(condition.geography)
            ? condition.geography.includes(context.geography)
            : context.geography === condition.geography;
        if (!allowed) return false;
    }
    if (condition.actionTier != null) {
        const allowed = Array.isArray(condition.actionTier)
            ? condition.actionTier.includes(context.actionTier)
            : context.actionTier === condition.actionTier;
        if (!allowed) return false;
    }
    if (condition.requiredAL != null && context.requiredAL !== condition.requiredAL)
        return false;
    if (condition.alMeetsRequired != null && context.alMeetsRequired !== condition.alMeetsRequired)
        return false;
    if (condition.alMeetsNextLevel != null && (context.alMeetsNextLevel || false) !== condition.alMeetsNextLevel)
        return false;

    // Checks if current auth AL index is strictly less than the named level
    if (condition.currentAuthLevelLessThan != null) {
        const threshold = AL_ORDER.indexOf(condition.currentAuthLevelLessThan);
        const currentIdx = context.currentALIndex != null ? context.currentALIndex : -1;
        if (currentIdx >= threshold) return false;
    }

    // Velocity windows: velocity_1m_gt, velocity_5m_gt, velocity_15m_gt
    if (condition.velocity_1m_gt != null) {
        const v = context.velocity ? context.velocity.velocity_1m : 0;
        if (v <= condition.velocity_1m_gt) return false;
    }
    if (condition.velocity_5m_gt != null) {
        const v = context.velocity ? context.velocity.velocity_5m : 0;
        if (v <= condition.velocity_5m_gt) return false;
    }
    if (condition.velocity_15m_gt != null) {
        const v = context.velocity ? context.velocity.velocity_15m : 0;
        if (v <= condition.velocity_15m_gt) return false;
    }

    // Intelligence enrichment conditions (Phase 2)
    if (condition.vpn_detected != null && (context.is_vpn || false) !== condition.vpn_detected) return false;
    if (condition.proxy_detected != null && (context.is_proxy || false) !== condition.proxy_detected) return false;
    if (condition.hosting_detected != null && (context.is_hosting || false) !== condition.hosting_detected) return false;
    if (condition.tor_detected != null && (context.is_tor || false) !== condition.tor_detected) return false;
    if (condition.email_breached != null && (context.email_breached || false) !== condition.email_breached) return false;
    if (condition.is_new_device != null && (context.is_new_device || false) !== condition.is_new_device) return false;
    if (condition.is_greynoise_bot != null && (context.is_greynoise_bot || false) !== condition.is_greynoise_bot) return false;
    if (condition.ato_signal_count_gte != null && (context.ato_signal_count || 0) < condition.ato_signal_count_gte) return false;
    if (condition.ip_abuse_score_gte != null) {
        if (context.ip_abuse_score == null) return false; // skip rule when signal unavailable
        if (context.ip_abuse_score < condition.ip_abuse_score_gte) return false;
    }

    return true;
}

function conditionToSummary(condition) {
    if (!condition) return 'none';
    const parts = [];
    if (condition.risk_ceiling_breached != null) parts.push(`risk_ceiling_breached = ${condition.risk_ceiling_breached}`);
    if (condition.riskLevel != null) {
        const r = condition.riskLevel;
        parts.push(`riskLevel ∈ [${Array.isArray(r) ? r.join(', ') : r}]`);
    }
    if (condition.geography != null) {
        const g = condition.geography;
        parts.push(`geography ∈ [${Array.isArray(g) ? g.join(', ') : g}]`);
    }
    if (condition.actionTier != null) {
        const t = condition.actionTier;
        parts.push(`actionTier ∈ [${Array.isArray(t) ? t.join(', ') : t}]`);
    }
    if (condition.requiredAL != null) parts.push(`requiredAL = ${condition.requiredAL}`);
    if (condition.alMeetsRequired != null) parts.push(`alMeetsRequired = ${condition.alMeetsRequired}`);
    if (condition.alMeetsNextLevel != null) parts.push(`alMeetsNextLevel = ${condition.alMeetsNextLevel}`);
    if (condition.currentAuthLevelLessThan != null) parts.push(`currentAuthLevel < ${condition.currentAuthLevelLessThan}`);
    if (condition.velocity_1m_gt != null) parts.push(`velocity_1m > ${condition.velocity_1m_gt}`);
    if (condition.velocity_5m_gt != null) parts.push(`velocity_5m > ${condition.velocity_5m_gt}`);
    if (condition.velocity_15m_gt != null) parts.push(`velocity_15m > ${condition.velocity_15m_gt}`);
    if (condition.vpn_detected != null) parts.push(`vpn_detected = ${condition.vpn_detected}`);
    if (condition.proxy_detected != null) parts.push(`proxy_detected = ${condition.proxy_detected}`);
    if (condition.hosting_detected != null) parts.push(`hosting_detected = ${condition.hosting_detected}`);
    if (condition.tor_detected != null) parts.push(`tor_detected = ${condition.tor_detected}`);
    if (condition.email_breached != null) parts.push(`email_breached = ${condition.email_breached}`);
    if (condition.is_new_device != null) parts.push(`is_new_device = ${condition.is_new_device}`);
    if (condition.is_greynoise_bot != null) parts.push(`is_greynoise_bot = ${condition.is_greynoise_bot}`);
    if (condition.ato_signal_count_gte != null) parts.push(`ato_signal_count >= ${condition.ato_signal_count_gte}`);
    if (condition.ip_abuse_score_gte != null) parts.push(`ip_abuse_score >= ${condition.ip_abuse_score_gte}`);
    return parts.length ? parts.join(', ') : 'none';
}

function explainCondition(condition, context) {
    if (!condition) return [{ check: 'no condition', result: true }];
    const steps = [];

    const check = (label, result, value) => {
        steps.push({ check: label, value, result });
        return result;
    };

    if (condition.risk_ceiling_breached != null && !check(`risk_ceiling_breached === ${condition.risk_ceiling_breached}`, context.risk_ceiling_breached === condition.risk_ceiling_breached, context.risk_ceiling_breached)) return steps;
    if (condition.riskLevel != null) {
        const allowed = Array.isArray(condition.riskLevel) ? condition.riskLevel : [condition.riskLevel];
        if (!check(`riskLevel in [${allowed.join(', ')}]`, allowed.includes(context.riskLevel), context.riskLevel)) return steps;
    }
    if (condition.geography != null) {
        const allowed = Array.isArray(condition.geography) ? condition.geography : [condition.geography];
        if (!check(`geography in [${allowed.join(', ')}]`, allowed.includes(context.geography), context.geography)) return steps;
    }
    if (condition.actionTier != null) {
        const allowed = Array.isArray(condition.actionTier) ? condition.actionTier : [condition.actionTier];
        if (!check(`actionTier in [${allowed.join(', ')}]`, allowed.includes(context.actionTier), context.actionTier)) return steps;
    }
    if (condition.requiredAL != null && !check(`requiredAL === ${condition.requiredAL}`, context.requiredAL === condition.requiredAL, context.requiredAL)) return steps;
    if (condition.alMeetsRequired != null && !check(`alMeetsRequired === ${condition.alMeetsRequired}`, context.alMeetsRequired === condition.alMeetsRequired, context.alMeetsRequired)) return steps;
    if (condition.alMeetsNextLevel != null && !check(`alMeetsNextLevel === ${condition.alMeetsNextLevel}`, (context.alMeetsNextLevel || false) === condition.alMeetsNextLevel, context.alMeetsNextLevel || false)) return steps;

    if (condition.currentAuthLevelLessThan != null) {
        const threshold = AL_ORDER.indexOf(condition.currentAuthLevelLessThan);
        const currentIdx = context.currentALIndex != null ? context.currentALIndex : -1;
        if (!check(`currentAuthLevel < ${condition.currentAuthLevelLessThan} (index ${currentIdx} < ${threshold})`, currentIdx < threshold, context.currentAL || 'none')) return steps;
    }

    if (condition.velocity_1m_gt != null) {
        const v = context.velocity ? context.velocity.velocity_1m : 0;
        if (!check(`velocity_1m > ${condition.velocity_1m_gt}`, v > condition.velocity_1m_gt, v)) return steps;
    }
    if (condition.velocity_5m_gt != null) {
        const v = context.velocity ? context.velocity.velocity_5m : 0;
        if (!check(`velocity_5m > ${condition.velocity_5m_gt}`, v > condition.velocity_5m_gt, v)) return steps;
    }
    if (condition.velocity_15m_gt != null) {
        const v = context.velocity ? context.velocity.velocity_15m : 0;
        if (!check(`velocity_15m > ${condition.velocity_15m_gt}`, v > condition.velocity_15m_gt, v)) return steps;
    }

    // Intelligence enrichment conditions
    if (condition.vpn_detected != null)
        if (!check(`vpn_detected === ${condition.vpn_detected}`, (context.is_vpn || false) === condition.vpn_detected, context.is_vpn)) return steps;
    if (condition.proxy_detected != null)
        if (!check(`proxy_detected === ${condition.proxy_detected}`, (context.is_proxy || false) === condition.proxy_detected, context.is_proxy)) return steps;
    if (condition.hosting_detected != null)
        if (!check(`hosting_detected === ${condition.hosting_detected}`, (context.is_hosting || false) === condition.hosting_detected, context.is_hosting)) return steps;
    if (condition.tor_detected != null)
        if (!check(`tor_detected === ${condition.tor_detected}`, (context.is_tor || false) === condition.tor_detected, context.is_tor)) return steps;
    if (condition.email_breached != null)
        if (!check(`email_breached === ${condition.email_breached}`, (context.email_breached || false) === condition.email_breached, context.email_breached)) return steps;
    if (condition.is_new_device != null)
        if (!check(`is_new_device === ${condition.is_new_device}`, (context.is_new_device || false) === condition.is_new_device, context.is_new_device)) return steps;
    if (condition.is_greynoise_bot != null)
        if (!check(`is_greynoise_bot === ${condition.is_greynoise_bot}`, (context.is_greynoise_bot || false) === condition.is_greynoise_bot, context.is_greynoise_bot)) return steps;
    if (condition.ato_signal_count_gte != null)
        if (!check(`ato_signal_count >= ${condition.ato_signal_count_gte}`, (context.ato_signal_count || 0) >= condition.ato_signal_count_gte, context.ato_signal_count || 0)) return steps;
    if (condition.ip_abuse_score_gte != null) {
        if (context.ip_abuse_score == null) { check(`ip_abuse_score >= ${condition.ip_abuse_score_gte}`, false, 'unavailable'); return steps; }
        if (!check(`ip_abuse_score >= ${condition.ip_abuse_score_gte}`, context.ip_abuse_score >= condition.ip_abuse_score_gte, context.ip_abuse_score)) return steps;
    }

    return steps;
}

function evaluate(context) {
    return evaluateWith(loadPolicies(), context);
}

/**
 * Evaluate a context against an arbitrary decisions config (does not touch the
 * cached live policy). Used by the simulation engine to compare proposed
 * policies against the current one on identical contexts.
 */
function evaluateWith(config, context) {
    const { rules, default: defaultResult } = config;

    const trace = {
        rules_evaluated: [],
        matched_rule_id: null,
        default_used: false
    };

    for (const rule of rules) {
        // Skip disabled rules
        if (rule.enabled === false) {
            trace.rules_evaluated.push({
                ruleId: rule.id,
                description: rule.description,
                conditionSummary: conditionToSummary(rule.condition),
                matched: false,
                skipped: true,
                conditionSteps: []
            });
            continue;
        }

        const matched = matchesCondition(rule.condition, context);
        const conditionSteps = explainCondition(rule.condition, context);

        trace.rules_evaluated.push({
            ruleId: rule.id,
            description: rule.description,
            conditionSummary: conditionToSummary(rule.condition),
            matched,
            conditionSteps
        });

        if (matched) {
            trace.matched_rule_id = rule.id;
            const resolvedStepUpType = resolveStepUpType(rule.step_up_type, context);
            return {
                decision: rule.decision,
                step_up_type: resolvedStepUpType,
                reason: rule.reason ?? '',
                display_message: rule.display_message ?? null,
                ruleId: rule.id,
                trace
            };
        }
    }

    // Default rule
    trace.default_used = true;
    const defaultStepUpType = defaultResult.step_up_type
        ? resolveStepUpType(defaultResult.step_up_type, context)
        : null;
    return {
        decision: defaultResult.decision,
        step_up_type: defaultStepUpType,
        reason: defaultResult.reason ?? '',
        display_message: defaultResult.display_message ?? null,
        ruleId: null,
        trace
    };
}

// ─── Config validation ───────────────────────────────────────────────────────

const VALID_DECISIONS = ['ALLOW', 'STEP_UP', 'DENY', 'MANUAL_REVIEW'];
const VALID_STEP_UP_TYPES = ['PASSCODE', 'PASSKEY', 'SELFIE', 'IDV', 'AL_PLUS_1', 'REQUIRED_AL'];
const VALID_CONDITION_KEYS = [
    'riskLevel', 'geography', 'actionTier', 'requiredAL', 'alMeetsRequired', 'alMeetsNextLevel',
    'risk_ceiling_breached', 'currentAuthLevelLessThan',
    'velocity_1m_gt', 'velocity_5m_gt', 'velocity_15m_gt',
    // Intelligence enrichment gate conditions
    'vpn_detected', 'proxy_detected', 'hosting_detected',
    'tor_detected', 'email_breached', 'ato_signal_count_gte',
    'ip_abuse_score_gte', 'is_new_device', 'is_greynoise_bot',
];

/**
 * Validates a decisions config (or a single rule via validateRule).
 * Returns { valid: boolean, errors: string[] }.
 */
function validateRule(rule, idx = null) {
    const errors = [];
    const label = rule && rule.id ? `rule '${rule.id}'` : `rule at index ${idx}`;
    if (!rule || typeof rule !== 'object') return [`${label}: not an object`];
    if (!rule.id || typeof rule.id !== 'string') errors.push(`${label}: missing string 'id'`);
    if (!VALID_DECISIONS.includes(rule.decision)) errors.push(`${label}: decision must be one of ${VALID_DECISIONS.join(', ')}`);
    if (rule.step_up_type != null && !VALID_STEP_UP_TYPES.includes(rule.step_up_type)) {
        errors.push(`${label}: step_up_type must be one of ${VALID_STEP_UP_TYPES.join(', ')}`);
    }
    if (rule.decision === 'STEP_UP' && rule.step_up_type == null) {
        errors.push(`${label}: STEP_UP decision requires a step_up_type`);
    }
    if (rule.condition != null) {
        if (typeof rule.condition !== 'object' || Array.isArray(rule.condition)) {
            errors.push(`${label}: condition must be an object`);
        } else {
            for (const key of Object.keys(rule.condition)) {
                if (!VALID_CONDITION_KEYS.includes(key)) {
                    errors.push(`${label}: unknown condition key '${key}' (valid: ${VALID_CONDITION_KEYS.join(', ')})`);
                }
            }
        }
    }
    return errors;
}

function validateDecisionsConfig(config) {
    const errors = [];
    if (!config || typeof config !== 'object') {
        return { valid: false, errors: ['config must be an object'] };
    }
    if (!Array.isArray(config.rules)) {
        errors.push("config must contain a 'rules' array");
    } else {
        const seen = new Set();
        config.rules.forEach((rule, idx) => {
            errors.push(...validateRule(rule, idx));
            if (rule && rule.id) {
                if (seen.has(rule.id)) errors.push(`duplicate rule id '${rule.id}'`);
                seen.add(rule.id);
            }
        });
    }
    if (!config.default || !VALID_DECISIONS.includes(config.default.decision)) {
        errors.push(`config must contain a 'default' with decision in ${VALID_DECISIONS.join(', ')}`);
    }
    return { valid: errors.length === 0, errors };
}

module.exports = {
    loadPolicies,
    evaluate,
    evaluateWith,
    matchesCondition,
    conditionToSummary,
    explainCondition,
    validateRule,
    validateDecisionsConfig,
    clearCache,
    VALID_CONDITION_KEYS,
    VALID_DECISIONS,
    VALID_STEP_UP_TYPES
};
