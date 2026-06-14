// adapters/ipEnrichmentAdapter.js
// Geolocation + proxy/VPN detection via ip-api.com (free, no key needed).
// Note: free endpoint requires HTTP, not HTTPS. Rate limit: 45 req/min.

const cache = require('../cache');

// Matches localhost and RFC-1918 private ranges
const PRIVATE_IP = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1$|^$)/;

const TIMEOUT_MS = 300;

async function enrich(ip) {
    if (!ip || PRIVATE_IP.test(ip)) {
        return { country: 'LOCAL', countryCode: 'LOCAL', city: null, isp: null, proxy: false, vpn: false, tor: false, hosting: false, query: ip || 'local' };
    }

    const cacheKey = `ipenrich:${ip}`;
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(
            `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,city,isp,proxy,hosting,query`,
            { signal: controller.signal }
        );
        clearTimeout(timer);
        const data = await res.json();
        if (data.status !== 'success') return null;

        const result = {
            country:     data.country     || null,
            countryCode: data.countryCode || null,
            city:        data.city        || null,
            isp:         data.isp         || null,
            proxy:       data.proxy       || false,
            vpn:         data.proxy       || false, // ip-api free merges VPN into proxy field
            tor:         false,                     // not available on free tier
            hosting:     data.hosting     || false,
            query:       data.query       || ip,
        };
        await cache.set(cacheKey, result, 1800); // 30 min
        return result;
    } catch (_) {
        clearTimeout(timer);
        return null;
    }
}

module.exports = { enrich };
