// adapters/abuseIpdbAdapter.js
// IP abuse reputation via AbuseIPDB (https://abuseipdb.com). Free tier: 1000 checks/day.
// Requires ABUSEIPDB_API_KEY env var. Returns null gracefully if not configured.

const cache = require('../cache');

const TIMEOUT_MS = 300;

async function getScore(ip) {
    if (!process.env.ABUSEIPDB_API_KEY) return null;
    if (!ip) return null;

    const cacheKey = `abuseipdb:${ip}`;
    const cached = await cache.get(cacheKey);
    if (cached !== null) return cached;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(
            `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90`,
            {
                headers: {
                    'Key': process.env.ABUSEIPDB_API_KEY,
                    'Accept': 'application/json',
                },
                signal: controller.signal,
            }
        );
        clearTimeout(timer);
        if (!res.ok) return null;
        const body = await res.json();
        const d = body.data;
        if (!d) return null;

        const result = {
            abuseScore:   d.abuseConfidenceScore ?? 0,
            totalReports: d.totalReports          ?? 0,
            countryCode:  d.countryCode           || null,
            isTor:        d.isTor                 || false,
        };
        await cache.set(cacheKey, result, 3600); // 1 hr
        return result;
    } catch (_) {
        clearTimeout(timer);
        return null;
    }
}

module.exports = { getScore };
