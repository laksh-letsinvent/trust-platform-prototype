// sessionStore.js — Session state for step-up and manual review lifecycle
// Sessions are persisted to Redis (when available) and sessions.jsonl (file fallback).
// Redis provides cross-instance consistency; file provides warm-start after restart.

const fs    = require('fs');
const path  = require('path');
const cache = require('./cache');

const STEP_UP_TTL_MS  = 15 * 60 * 1000;      // 15 minutes
const REVIEW_TTL_MS   = 72 * 60 * 60 * 1000; // 72 hours

const SESSIONS_FILE   = path.join(__dirname, 'sessions.jsonl');
const SESSION_PREFIX  = 'session:';
const IDV_IDX_PREFIX  = 'idv_idx:';

// Local Map: reference_id → session (in-process cache; authoritative when Redis is down)
const sessions = new Map();
// Secondary index: idv_session_id → reference_id (local only; Redis has canonical index)
const idvIndex = new Map();

// ─── Redis helpers ─────────────────────────────────────────────────────────────

async function saveToRedis(session) {
    const r = cache.getClient();
    if (!r) return;
    try {
        const key    = SESSION_PREFIX + session.reference_id;
        const ttlSec = Math.max(1, Math.ceil((session.expires_at - Date.now()) / 1000));
        await r.setex(key, ttlSec, JSON.stringify(session));
        if (session.idv_session_id) {
            await r.setex(IDV_IDX_PREFIX + session.idv_session_id, ttlSec, session.reference_id);
        }
    } catch (err) {
        console.warn('[sessionStore] Redis write error:', err.message);
    }
}

async function loadFromRedis(referenceId) {
    const r = cache.getClient();
    if (!r) return null;
    try {
        const raw = await r.get(SESSION_PREFIX + referenceId);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (err) {
        console.warn('[sessionStore] Redis read error:', err.message);
        return null;
    }
}

async function refByIdvId(idvSessionId) {
    const r = cache.getClient();
    if (!r) return null;
    try {
        return await r.get(IDV_IDX_PREFIX + idvSessionId);
    } catch (err) {
        console.warn('[sessionStore] Redis IDV index read error:', err.message);
        return null;
    }
}

// ─── Persistence helpers ───────────────────────────────────────────────────────

function persistSessions() {
    const lines = [];
    for (const session of sessions.values()) {
        lines.push(JSON.stringify(session));
    }
    try {
        fs.writeFileSync(SESSIONS_FILE, lines.join('\n') + (lines.length ? '\n' : ''));
    } catch (err) {
        console.error('[sessionStore] Failed to persist sessions:', err.message);
    }
}

function loadSessions() {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    try {
        const lines = fs.readFileSync(SESSIONS_FILE, 'utf8').split('\n').filter(Boolean);
        const now   = Date.now();
        for (const line of lines) {
            try {
                const session = JSON.parse(line);
                // Skip sessions stale beyond grace period (TTL + 15 min buffer)
                if (now > session.expires_at + STEP_UP_TTL_MS) continue;
                sessions.set(session.reference_id, session);
                if (session.idv_session_id) {
                    idvIndex.set(session.idv_session_id, session.reference_id);
                }
            } catch (_) { /* skip malformed lines */ }
        }
        console.log(`[sessionStore] Loaded ${sessions.size} session(s) from disk`);
    } catch (err) {
        console.error('[sessionStore] Failed to load sessions:', err.message);
    }
}

// Load persisted sessions from file immediately at module startup (warm start)
loadSessions();

// ─── Startup Redis sync ────────────────────────────────────────────────────────

/**
 * Seed local Map from Redis session keys.
 * Called once by server.js after cache.connect() succeeds.
 * Enables cross-instance session visibility on startup.
 */
async function syncFromRedis() {
    const r = cache.getClient();
    if (!r) return;
    try {
        let cursor  = '0';
        let loaded  = 0;
        const now   = Date.now();
        do {
            const [nextCursor, keys] = await r.scan(cursor, 'MATCH', SESSION_PREFIX + '*', 'COUNT', 100);
            cursor = nextCursor;
            for (const key of keys) {
                try {
                    const raw = await r.get(key);
                    if (!raw) continue;
                    const session = JSON.parse(raw);
                    if (now > session.expires_at + STEP_UP_TTL_MS) continue;
                    sessions.set(session.reference_id, session);
                    if (session.idv_session_id) {
                        idvIndex.set(session.idv_session_id, session.reference_id);
                    }
                    loaded++;
                } catch (_) { /* skip malformed */ }
            }
        } while (cursor !== '0');
        if (loaded > 0) {
            console.log(`[sessionStore] Synced ${loaded} session(s) from Redis`);
        }
    } catch (err) {
        console.warn('[sessionStore] Redis sync error:', err.message);
    }
}

// ─── Session CRUD ──────────────────────────────────────────────────────────────

/**
 * Create a session for an actionable decision.
 *
 * @param {object} decision   - Full decision result from decisionEngine
 * @param {object} input      - Original request inputs: { customer_id, action, device_id }
 */
async function createSession(decision, input) {
    const { reference_id, decision: decisionType, step_up_type, idv_vendor, idv_session_id } = decision;
    if (!reference_id) return; // ALLOW decisions have no reference_id, skip

    const isReview = decisionType === 'MANUAL_REVIEW';
    const ttl      = isReview ? REVIEW_TTL_MS : STEP_UP_TTL_MS;

    const session = {
        reference_id,
        type:                  decisionType,           // STEP_UP | MANUAL_REVIEW | DENY
        status:                'PENDING',
        customer_id:           input.customer_id,
        action:                input.action,
        device_id:             input.device_id,
        required_step_up_type: step_up_type || null,
        idv_session_id:        idv_session_id || null,
        idv_vendor:            idv_vendor || null,
        original_decision:     decision,
        created_at:            Date.now(),
        expires_at:            Date.now() + ttl,
        completed_at:          null,
        final_decision:        null,
        final_outcome:         null,
        reviewer_id:           null,
        notes:                 null,
        fraud_score_override:  null,
    };

    sessions.set(reference_id, session);
    if (idv_session_id) {
        idvIndex.set(idv_session_id, reference_id);
    }

    await saveToRedis(session);
    persistSessions();
    return session;
}

/**
 * Retrieve a session by reference_id.
 * Checks local Map first; falls back to Redis for cross-instance lookups.
 * Returns null if not found or expired.
 */
async function getSession(referenceId) {
    let session = sessions.get(referenceId);

    if (!session) {
        // Cross-instance lookup: try Redis
        session = await loadFromRedis(referenceId);
        if (session) {
            sessions.set(referenceId, session);
            if (session.idv_session_id) {
                idvIndex.set(session.idv_session_id, referenceId);
            }
        }
    }

    if (!session) return null;

    if (Date.now() > session.expires_at) {
        if (session.status === 'PENDING') {
            session.status = 'EXPIRED';
        }
    }
    return session;
}

/**
 * Retrieve a session by the IDV vendor session ID.
 */
async function getSessionByIdvSessionId(idvSessionId) {
    // Try Redis canonical index first (cross-instance safe)
    const refFromRedis = await refByIdvId(idvSessionId);
    if (refFromRedis) {
        return getSession(refFromRedis);
    }

    // Fallback: local index
    const ref = idvIndex.get(idvSessionId);
    if (ref) return getSession(ref);

    return null;
}

/**
 * Update session fields. Merges provided updates into the session.
 */
async function updateSession(referenceId, updates) {
    let session = sessions.get(referenceId);

    if (!session) {
        // May be on another instance — load from Redis first
        session = await loadFromRedis(referenceId);
        if (session) sessions.set(referenceId, session);
    }

    if (!session) return null;

    Object.assign(session, updates);
    await saveToRedis(session);
    persistSessions();
    return session;
}

/**
 * Return all PENDING MANUAL_REVIEW sessions (sorted oldest first).
 */
function getPendingReviews() {
    const now     = Date.now();
    const pending = [];
    for (const session of sessions.values()) {
        if (session.type === 'MANUAL_REVIEW' && session.status === 'PENDING' && now <= session.expires_at) {
            pending.push(session);
        }
    }
    pending.sort((a, b) => a.created_at - b.created_at);
    return pending;
}

/**
 * Return all MANUAL_REVIEW sessions (all statuses), sorted newest first.
 */
function getAllReviews() {
    const reviews = [];
    for (const session of sessions.values()) {
        if (session.type === 'MANUAL_REVIEW') {
            reviews.push(session);
        }
    }
    reviews.sort((a, b) => b.created_at - a.created_at);
    return reviews;
}

// Prune expired sessions every minute to prevent unbounded memory + file growth
setInterval(() => {
    const now    = Date.now();
    let pruned   = 0;
    for (const [ref, session] of sessions.entries()) {
        if (now > session.expires_at + STEP_UP_TTL_MS) {
            if (session.idv_session_id) idvIndex.delete(session.idv_session_id);
            sessions.delete(ref);
            pruned++;
        }
    }
    if (pruned > 0) persistSessions();
}, 60_000);

module.exports = {
    createSession,
    getSession,
    getSessionByIdvSessionId,
    updateSession,
    getPendingReviews,
    getAllReviews,
    syncFromRedis,
};
