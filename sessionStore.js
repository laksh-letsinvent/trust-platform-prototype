// sessionStore.js — In-memory session state for step-up and manual review lifecycle
// Sessions are ephemeral (lost on restart) — prototype only.

const STEP_UP_TTL_MS  = 15 * 60 * 1000;  // 15 minutes
const REVIEW_TTL_MS   = 72 * 60 * 60 * 1000; // 72 hours

// Primary map: reference_id → session
const sessions = new Map();
// Secondary index: idv_session_id → reference_id
const idvIndex = new Map();

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

// Prune expired sessions every minute to prevent unbounded memory growth
setInterval(() => {
    const now = Date.now();
    for (const [ref, session] of sessions.entries()) {
        if (now > session.expires_at + STEP_UP_TTL_MS) {
            // Remove stale sessions (expired + grace period)
            if (session.idv_session_id) idvIndex.delete(session.idv_session_id);
            sessions.delete(ref);
        }
    }
}, 60_000);

module.exports = {
    createSession,
    getSession,
    getSessionByIdvSessionId,
    updateSession,
    getPendingReviews,
    getAllReviews,
};
