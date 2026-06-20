// policyVersioning.js
// Policy version history and rollback. Requires Postgres (DATABASE_URL).
// All operations are no-ops / empty results when Postgres is not configured.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');

function contentHash(obj) {
    return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 12);
}

async function nextVersionNumber(policyName) {
    const result = await db.query(
        `SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM policy_versions WHERE policy_name = $1`,
        [policyName]
    );
    return result ? parseInt(result.rows[0].next, 10) : 1;
}

/**
 * Save a new version of a policy. Called after every successful PATCH.
 * Returns { id, version_number } or null on failure / Postgres not configured.
 */
async function saveVersion(policyName, content, { author = 'system', simulationSummary = null } = {}) {
    if (!db.isConfigured()) return null;
    try {
        const versionNumber = await nextVersionNumber(policyName);
        const result = await db.query(
            `INSERT INTO policy_versions (policy_name, version_number, content, author, simulation_summary)
             VALUES ($1, $2, $3, $4, $5) RETURNING id, version_number`,
            [policyName, versionNumber, JSON.stringify(content), author,
             simulationSummary ? JSON.stringify(simulationSummary) : null]
        );
        if (!result || result.rows.length === 0) return null;
        return { id: parseInt(result.rows[0].id, 10), version_number: result.rows[0].version_number };
    } catch (err) {
        console.warn(`⚠ policyVersioning.saveVersion(${policyName}):`, err.message);
        return null;
    }
}

/**
 * List versions for a policy, newest first.
 */
async function getVersions(policyName, limit = 20) {
    if (!db.isConfigured()) return [];
    try {
        const result = await db.query(
            `SELECT id, version_number, author, created_at, simulation_summary, content
             FROM policy_versions WHERE policy_name = $1
             ORDER BY version_number DESC LIMIT $2`,
            [policyName, limit]
        );
        if (!result) return [];
        return result.rows.map(r => ({
            id: parseInt(r.id, 10),
            version_number: r.version_number,
            author: r.author,
            created_at: r.created_at,
            simulation_summary: r.simulation_summary,
            content_hash: contentHash(r.content),
            rules_count: r.content && r.content.rules ? r.content.rules.length : null,
        }));
    } catch (err) {
        console.warn(`⚠ policyVersioning.getVersions(${policyName}):`, err.message);
        return [];
    }
}

/**
 * Get full content of a specific version.
 */
async function getVersion(policyName, versionId) {
    if (!db.isConfigured()) return null;
    try {
        const result = await db.query(
            `SELECT * FROM policy_versions WHERE id = $1 AND policy_name = $2`,
            [versionId, policyName]
        );
        if (!result || result.rows.length === 0) return null;
        const r = result.rows[0];
        return {
            id: parseInt(r.id, 10),
            policy_name: r.policy_name,
            version_number: r.version_number,
            author: r.author,
            created_at: r.created_at,
            simulation_summary: r.simulation_summary,
            content_hash: contentHash(r.content),
            content: r.content,
        };
    } catch (err) {
        console.warn(`⚠ policyVersioning.getVersion(${policyName}, ${versionId}):`, err.message);
        return null;
    }
}

/**
 * Rollback: write a version's content back to the policy JSON file and clear engine cache.
 * Saves a new version record to log the rollback event.
 */
async function rollback(policyName, versionId, { author = 'rollback' } = {}) {
    if (!db.isConfigured()) {
        const err = new Error('Postgres not configured — versioning requires DATABASE_URL');
        err.statusCode = 503;
        throw err;
    }
    const version = await getVersion(policyName, versionId);
    if (!version) {
        const err = new Error(`Version ${versionId} not found for policy '${policyName}'`);
        err.statusCode = 404;
        throw err;
    }

    const filePath = path.join(__dirname, 'policies', `${policyName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(version.content, null, 2) + '\n', 'utf8');

    // Clear engine cache
    const cacheClears = {
        decisions:  () => require('./policyEngine').clearCache(),
        risk:       () => require('./riskEngine').clearCache(),
        idvRouting: () => require('./idvRouting').clearCache(),
    };
    if (cacheClears[policyName]) cacheClears[policyName]();

    // Record the rollback as a new version
    const newVersion = await saveVersion(policyName, version.content, {
        author,
        simulationSummary: { note: `Rolled back to v${version.version_number} (id:${versionId})` },
    });

    return {
        ok: true,
        rolled_back_to_version: version.version_number,
        new_version: newVersion ? newVersion.version_number : null,
    };
}

/**
 * Diff two policy contents by comparing their rules arrays.
 * Works on any object with a rules array (decisions policy).
 * For non-rules policies (confidence, idvRouting) returns a simple changed/unchanged flag.
 */
function diffVersions(contentA, contentB) {
    const rulesA = contentA.rules || null;
    const rulesB = contentB.rules || null;

    if (!rulesA || !rulesB) {
        const same = JSON.stringify(contentA) === JSON.stringify(contentB);
        return { added: [], removed: [], modified: [], unchanged_count: same ? 1 : 0, no_rules: true };
    }

    const mapA = new Map(rulesA.map(r => [r.id, r]));
    const mapB = new Map(rulesB.map(r => [r.id, r]));

    const added        = rulesB.filter(r => !mapA.has(r.id));
    const removed      = rulesA.filter(r => !mapB.has(r.id));
    const modified     = rulesB.filter(r => mapA.has(r.id) && JSON.stringify(mapA.get(r.id)) !== JSON.stringify(r));
    const unchangedCount = rulesB.filter(r => mapA.has(r.id) && JSON.stringify(mapA.get(r.id)) === JSON.stringify(r)).length;

    return { added, removed, modified, unchanged_count: unchangedCount };
}

module.exports = { saveVersion, getVersions, getVersion, rollback, diffVersions };
