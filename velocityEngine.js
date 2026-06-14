// velocityEngine.js
/**
 * Tracks request velocity per customer using Redis sorted sets.
 * Gracefully degrades to zero-velocity when Redis is unavailable.
 *
 * Key: velocity:{customerId}
 * Score: Date.now() (milliseconds) — enables ZCOUNT time-window queries
 */

const cache = require('./cache');

const ZERO_VELOCITY = { velocity_1m: 0, velocity_5m: 0, velocity_15m: 0 };

function getClient() {
    return cache.getClient();
}

/**
 * Record a request for this customer. Trims entries older than 15 minutes.
 */
async function recordRequest(customerId) {
    const client = getClient();
    if (!client) return;
    try {
        const key = `velocity:${customerId}`;
        const now = Date.now();
        const member = `${now}-${Math.random().toString(36).slice(2, 8)}`;
        const fifteenMinAgo = now - 15 * 60 * 1000;

        await client.zadd(key, now, member);
        await client.zremrangebyscore(key, 0, fifteenMinAgo);
        await client.expire(key, 1800); // 30 min safety TTL
    } catch (err) {
        // Non-fatal: velocity tracking best-effort
        console.warn('velocityEngine.recordRequest error:', err.message);
    }
}

/**
 * Get velocity counts for 1m, 5m, and 15m windows.
 * Returns zero-velocity object if Redis is unavailable.
 */
async function getVelocity(customerId) {
    const client = getClient();
    if (!client) return { ...ZERO_VELOCITY };
    try {
        const key = `velocity:${customerId}`;
        const now = Date.now();
        const [v1m, v5m, v15m] = await Promise.all([
            client.zcount(key, now - 60_000, now),
            client.zcount(key, now - 300_000, now),
            client.zcount(key, now - 900_000, now)
        ]);
        return {
            velocity_1m: Number(v1m),
            velocity_5m: Number(v5m),
            velocity_15m: Number(v15m)
        };
    } catch (err) {
        console.warn('velocityEngine.getVelocity error:', err.message);
        return { ...ZERO_VELOCITY };
    }
}

/**
 * Whether velocity tracking is active (Redis connected).
 */
function isAvailable() {
    return !!getClient();
}

function getStatus() {
    return cache.getStatus();
}

module.exports = {
    recordRequest,
    getVelocity,
    isAvailable,
    getStatus
};
