# Policies

**Data stores hold raw scores only.** All bands (e.g. risk level) and formulas (e.g. effective confidence) are defined in policy files below.

## confidence.json

Single source for risk and confidence logic:

- **riskLevelBands** – Maps fraud score ranges to risk levels (LOW, MEDIUM, HIGH). Each band can use `fraudScoreMin`, `fraudScoreMax`, or both. **riskLevelOrder** defines evaluation order (first matching band wins). **defaultRiskLevel** used if no band matches.
- **actionTierRequirements** – Default required_confidence per action tier (overridden by action data when present).
- **effectiveConfidence** – Formula for effective confidence: deviceScoreWeight (device_score 0–100), fraudInverseWeight, and useAuthenticatorMax. Authenticator confidence comes from request **current_auth_level** (looked up in data); only the formula lives here.

There is no hardcoded risk or confidence logic in code—only policy drives it.

## decisions.json

Decision rules (allow / step-up / deny):

- **rules** – Evaluated in order; first matching rule wins. Each rule has `id`, `description`, `condition` (fraudScoreMin/Max, deviceScoreMin/deviceScoreMax, riskLevel, geography, actionTier, etc.), `decision`, optional `step_up_type`, `reason`.
- **default** – Applied when no rule matches.

Conditions can use `riskLevel` (derived from fraud score via confidence.json bands) and `confidenceMeetsAction` (derived from effectiveConfidence vs requiredConfidence).
