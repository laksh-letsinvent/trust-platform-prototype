// adapters/hibpAdapter.js
// HaveIBeenPwned email breach lookup (https://haveibeenpwned.com/API/v3).
// Requires HIBP_API_KEY (~$3.50/month at haveibeenpwned.com/API).
// Returns null gracefully if not configured.

const cache = require('../cache');

const TIMEOUT_MS = 300;

async function checkEmail(email) {
    if (!process.env.HIBP_API_KEY) return null;
    if (!email) return null;

    const normalised = email.toLowerCase();
    const cacheKey = `hibp:${normalised}`;
    const cached = await cache.get(cacheKey);
    if (cached !== null) return cached;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(
            `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(normalised)}?truncateResponse=true`,
            {
                headers: {
                    'hibp-api-key': process.env.HIBP_API_KEY,
                    'User-Agent': 'trust-platform-demo',
                },
                signal: controller.signal,
            }
        );
        clearTimeout(timer);

        let result;
        if (res.status === 404) {
            result = { breached: false, breachCount: 0 };
        } else if (res.ok) {
            const data = await res.json();
            result = { breached: true, breachCount: Array.isArray(data) ? data.length : 1 };
        } else {
            return null;
        }

        await cache.set(cacheKey, result, 86400); // 24 hr — breach status is slow-changing
        return result;
    } catch (_) {
        clearTimeout(timer);
        return null;
    }
}

module.exports = { checkEmail };
