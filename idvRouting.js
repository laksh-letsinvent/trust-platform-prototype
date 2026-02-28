// idvRouting.js
/**
 * Resolves IDV vendor from policy (idvRouting.json).
 * Strategies: round_robin, percent_split, time_based, geo_based.
 */

const path = require('path');
const fs = require('fs');

let routingConfig = null;
let roundRobinIndex = 0;

function loadRoutingConfig() {
    if (routingConfig) return routingConfig;
    const filePath = path.join(__dirname, 'policies', 'idvRouting.json');
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        routingConfig = JSON.parse(raw);
        return routingConfig;
    } catch (err) {
        return { default_vendor: 'vendor_1', strategies: {}, active_strategy: null };
    }
}

/**
 * Resolve IDV vendor for a request.
 * @param {{ geography?: string, requestId?: string }} context - geography for geo_based; requestId for deterministic percent_split
 */
function resolveIdvVendor(context = {}) {
    const config = loadRoutingConfig();
    const strategyName = config.active_strategy || 'percent_split';
    const strategy = config.strategies && config.strategies[strategyName];
    const defaultVendor = config.default_vendor || 'vendor_1';

    if (!strategy) return { vendor: defaultVendor, strategy: null, note: 'No strategy; using default.' };

    const { type } = strategy;

    if (type === 'round_robin' && Array.isArray(strategy.vendors) && strategy.vendors.length > 0) {
        const idx = roundRobinIndex % strategy.vendors.length;
        roundRobinIndex += 1;
        const vendor = strategy.vendors[idx];
        return { vendor, strategy: strategyName, note: `Round robin index ${idx}.` };
    }

    if (type === 'percent_split' && Array.isArray(strategy.splits) && strategy.splits.length > 0) {
        const r = (context.requestId || Math.random().toString(36)).split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 100;
        let cum = 0;
        for (const s of strategy.splits) {
            cum += s.percent || 0;
            if (r < cum) return { vendor: s.vendor, strategy: strategyName, note: `Percent split (r=${r}).` };
        }
        return { vendor: strategy.splits[0].vendor, strategy: strategyName, note: 'Percent split (fallback).' };
    }

    if (type === 'time_based' && Array.isArray(strategy.rules) && strategy.rules.length > 0) {
        const hour = new Date().getUTCHours();
        for (const rule of strategy.rules) {
            const start = rule.hour_start != null ? rule.hour_start : 0;
            const end = rule.hour_end != null ? rule.hour_end : 24;
            if (hour >= start && hour < end) return { vendor: rule.vendor, strategy: strategyName, note: `Time UTC hour ${hour}.` };
        }
        return { vendor: strategy.rules[0].vendor, strategy: strategyName, note: 'Time-based fallback.' };
    }

    if (type === 'geo_based' && Array.isArray(strategy.rules) && strategy.rules.length > 0) {
        const geo = (context.geography || '').toUpperCase();
        for (const rule of strategy.rules) {
            const geos = Array.isArray(rule.geography) ? rule.geography : [rule.geography];
            if (geos.some(g => (g || '').toUpperCase() === geo)) return { vendor: rule.vendor, strategy: strategyName, note: `Geo ${geo}.` };
        }
        return { vendor: defaultVendor, strategy: strategyName, note: `Geo ${geo || 'unknown'}; default.` };
    }

    return { vendor: defaultVendor, strategy: strategyName, note: 'Strategy not applicable.' };
}

function clearCache() {
    routingConfig = null;
}

module.exports = {
    loadRoutingConfig,
    resolveIdvVendor,
    clearCache
};
