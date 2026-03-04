// sessionStore.js — Session state for step-up and manual review lifecycle
// Sessions are persisted to sessions.jsonl so they survive server restarts.

const fs   = require('fs');
const path = require('path');

const STEP_UP_TTL_MS  = 15 * 60 * 1000;  // 15 minutes
const REVIEW_TTL_MS   = 72 * 60 * 60 * 1000; // 72 hours

const SESSIONS_FILE = path.join(__dirname, 'sessions.jsonl');

// Primary map: reference_id → session
const sessions = new Map();
// Secondary index: idv_session_id → reference_id
const idvIndex = new Map();

// ─── Persistence helpers ──────────────────────────────────────────────────────

/**
 * Rewrite sessions.jsonl from the current in-memory Map.
 * Called after every create/update so the file always reflects live state.
 */
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

/**
 * Load sessions from sessions.jsonl on startup.
 * Skips sessions that have been expired beyond their grace period.
 */
function loadSessions() {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    try {
        const lines = fs.readFileSync(SESSIONS_FILE, 'utf8').split('\n').filter(Boolean);
        const now = Date.now();
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

// Load persisted sessions immediately at module startup
loadSessions();

// ─── Session CRUD ─────────────────────────────────────────────────────────────

/**
 * Create a session for an actionable decision.
 *
 * @param {object} decision   - Full decision result from decisionEngine
 * @param {object} input      - Original request inputs: { customer_id, action, device_id }
 */
function createSession(decision, input) {
    const { reference_id, decision: decisionType, step_up_type, idv_vendor, idv_session_id } = decision;
    if (!reference_id) return; // ALLOW decisions have no reference_id, skip

    const isReview = decisionType === 'MANUAL_REVIEW';
    const ttl = isReview ? REVIEW_TTL_MS : STEP_UP_TTL_MS;

    const session = {
        reference_id,
        type: decisionType,          // STEP_UP | MANUAL_REVIEW | DENY
        status: 'PENDING',
        customer_id: input.customer_id,
        action: input.action,
        device_id: input.device_id,
        required_step_up_type: step_up_type || null,
        idv_session_id: idv_session_id || null,
        idv_vendor: idv_vendor || null,
        original_decision: decision,
        created_at: Date.now(),
        expires_at: Date.now() + ttl,
        completed_at: null,
        final_decision: null,
        reviewer_id: null,
        notes: null,
        fraud_score_override: null,
    };

    sessions.set(reference_id, session);
    if (idv_session_id) {
        idvIndex.set(idv_session_id, reference_id);
    }
    persistSessions();
    return session;
}

/**
 * Retrieve a session by reference_id.
 * Returns null if not found or expired.
 */
function getSession(referenceId) {
    const session = sessions.get(referenceId);
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
function getSessionByIdvSessionId(idvSessionId) {
    const ref = idvIndex.get(idvSessionId);
    if (!ref) return null;
    return getSession(ref);
}

/**
 * Update session fields. Merges provided updates into the session.
 */
function updateSession(referenceId, updates) {
    const session = sessions.get(referenceId);
    if (!session) return null;
    Object.assign(session, updates);
    persistSessions();
    return session;
}

/**
 * Return all PENDING MANUAL_REVIEW sessions (sorted oldest first).
 */
function getPendingReviews() {
    const now = Date.now();
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
    const now = Date.now();
    let pruned = 0;
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
};
