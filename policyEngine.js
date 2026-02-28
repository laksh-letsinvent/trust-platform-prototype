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

    if (condition.fraudScoreMin != null && context.fraudScore < condition.fraudScoreMin)
        return false;
    if (condition.fraudScoreMax != null && context.fraudScore > condition.fraudScoreMax)
        return false;
    if (condition.deviceScoreMin != null && context.deviceScore < condition.deviceScoreMin)
        return false;
    if (condition.deviceScoreMax != null && context.deviceScore > condition.deviceScoreMax)
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
    if (condition.confidenceMeetsAction != null && context.confidenceMeetsAction !== condition.confidenceMeetsAction)
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

    return true;
}

function conditionToSummary(condition) {
    if (!condition) return 'none';
    const parts = [];
    if (condition.fraudScoreMin != null) parts.push(`fraudScore ≥ ${condition.fraudScoreMin}`);
    if (condition.fraudScoreMax != null) parts.push(`fraudScore ≤ ${condition.fraudScoreMax}`);
    if (condition.deviceScoreMin != null) parts.push(`deviceScore ≥ ${condition.deviceScoreMin}`);
    if (condition.deviceScoreMax != null) parts.push(`deviceScore ≤ ${condition.deviceScoreMax}`);
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
    if (condition.confidenceMeetsAction != null) parts.push(`confidenceMeetsAction = ${condition.confidenceMeetsAction}`);
    if (condition.currentAuthLevelLessThan != null) parts.push(`currentAuthLevel < ${condition.currentAuthLevelLessThan}`);
    if (condition.velocity_1m_gt != null) parts.push(`velocity_1m > ${condition.velocity_1m_gt}`);
    if (condition.velocity_5m_gt != null) parts.push(`velocity_5m > ${condition.velocity_5m_gt}`);
    if (condition.velocity_15m_gt != null) parts.push(`velocity_15m > ${condition.velocity_15m_gt}`);
    return parts.length ? parts.join(', ') : 'none';
}

function explainCondition(condition, context) {
    if (!condition) return [{ check: 'no condition', result: true }];
    const steps = [];

    const check = (label, result, value) => {
        steps.push({ check: label, value, result });
        return result;
    };

    if (condition.fraudScoreMin != null && !check(`fraudScore >= ${condition.fraudScoreMin}`, context.fraudScore >= condition.fraudScoreMin, context.fraudScore)) return steps;
    if (condition.fraudScoreMax != null && !check(`fraudScore <= ${condition.fraudScoreMax}`, context.fraudScore <= condition.fraudScoreMax, context.fraudScore)) return steps;
    if (condition.deviceScoreMin != null && !check(`deviceScore >= ${condition.deviceScoreMin}`, context.deviceScore >= condition.deviceScoreMin, context.deviceScore)) return steps;
    if (condition.deviceScoreMax != null && !check(`deviceScore <= ${condition.deviceScoreMax}`, context.deviceScore <= condition.deviceScoreMax, context.deviceScore)) return steps;
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
    if (condition.confidenceMeetsAction != null && !check(`confidenceMeetsAction === ${condition.confidenceMeetsAction}`, context.confidenceMeetsAction === condition.confidenceMeetsAction, context.confidenceMeetsAction)) return steps;

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

    return steps;
}

function evaluate(context) {
    const config = loadPolicies();
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
        ruleId: null,
        trace
    };
}

module.exports = {
    loadPolicies,
    evaluate,
    matchesCondition,
    conditionToSummary,
    explainCondition,
    clearCache
};
