// cache.js

/**
 * Redis-backed cache for fraud score and device score.
 * Falls back to no-op when Redis is unavailable.
 */

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const FRAUD_TTL_SEC = parseInt(process.env.CACHE_FRAUD_TTL_SEC || '300', 10);   // 5 min
const DEVICE_TTL_SEC = parseInt(process.env.CACHE_DEVICE_TTL_SEC || '600', 10); // 10 min

let client = null;
let cacheAvailable = false;

async function connect() {
    if (client) return cacheAvailable;
    try {
        const Redis = require('ioredis');
        client = new Redis(REDIS_URL, {
            maxRetriesPerRequest: 2,
            retryStrategy(times) {
                if (times > 2) return null;
                return Math.min(times * 200, 2000);
            },
            lazyConnect: true
        });
        await client.connect();
        client.on('error', (err) => console.warn('Redis error:', err.message));
        cacheAvailable = true;
        return true;
    } catch (err) {
        console.warn('Redis unavailable, running without cache:', err.message);
        client = null;
        cacheAvailable = false;
        return false;
    }
}

async function get(key) {
    if (!client || !cacheAvailable) return null;
    try {
        const raw = await client.get(key);
        if (raw == null) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function set(key, value, ttlSec) {
    if (!client || !cacheAvailable) return;
    try {
        const serialized = JSON.stringify(value);
        if (ttlSec > 0) {
            await client.setex(key, ttlSec, serialized);
        } else {
            await client.set(key, serialized);
        }
    } catch (err) {
        console.warn('Cache set failed:', err.message);
    }
}

function fraudKey(customerId, action, deviceId) {
    return `fraud:${customerId}:${action}:${deviceId}`;
}

function deviceKey(deviceId) {
    return `device:${deviceId}`;
}

async function getCachedFraudScore(customerId, action, deviceId) {
    const key = fraudKey(customerId, action, deviceId);
    const val = await get(key);
    return val != null ? val : null;
}

async function setCachedFraudScore(customerId, action, deviceId, score) {
    const key = fraudKey(customerId, action, deviceId);
    await set(key, score, FRAUD_TTL_SEC);
}

async function getCachedDeviceScore(deviceId) {
    const key = deviceKey(deviceId);
    const val = await get(key);
    return val != null ? val : null;
}

async function setCachedDeviceScore(deviceId, score) {
    const key = deviceKey(deviceId);
    await set(key, score, DEVICE_TTL_SEC);
}

async function close() {
    if (client) {
        await client.quit().catch(() => {});
        client = null;
    }
    cacheAvailable = false;
}

/**
 * Returns the underlying ioredis client (or null if unavailable).
 * Used by velocityEngine for sorted-set operations.
 */
function getClient() {
    return cacheAvailable ? client : null;
}

module.exports = {
    connect,
    close,
    get,
    set,
    getCachedFraudScore,
    setCachedFraudScore,
    getCachedDeviceScore,
    setCachedDeviceScore,
    getClient,
    get cacheAvailable() { return cacheAvailable; }
};
