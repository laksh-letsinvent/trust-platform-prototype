// adapters/greynoiseAdapter.js
// GreyNoise community API — bot/scanner IP detection (no API key needed for community endpoint).

const cache = require('../cache');

const TIMEOUT_MS = 300;

async function check(ip) {
    if (!ip) return null;

    const cacheKey = `gn:${ip}`;
    const cached = await cache.get(cacheKey);
    if (cached !== null) return cached;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(`https://api.greynoise.io/v3/community/${encodeURIComponent(ip)}`, {
            signal: controller.signal,
        });
        clearTimeout(timer);

        let result;
        if (res.status === 404) {
            result = { noise: false, riot: false, classification: 'unknown', name: null };
        } else if (res.ok) {
            const data = await res.json();
            result = {
                noise:          data.noise          || false,
                riot:           data.riot           || false,
                classification: data.classification || 'unknown',
                name:           data.name           || null,
            };
        } else {
            return null;
        }

        await cache.set(cacheKey, result, 21600); // 6 hr
        return result;
    } catch (_) {
        clearTimeout(timer);
        return null;
    }
}

module.exports = { check };
