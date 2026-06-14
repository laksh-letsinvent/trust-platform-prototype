// adapters/enrichmentOrchestrator.js
// Runs all intelligence adapters in parallel and computes derived signals.
// Never throws — partial failure is accepted; missing signals default to safe values.

const ipEnrichment = require('./ipEnrichmentAdapter');
const abuseIpdb   = require('./abuseIpdbAdapter');
const hibp        = require('./hibpAdapter');
const greynoise   = require('./greynoiseAdapter');

/**
 * @param {{ ip, email, customerId, deviceId, existingDeviceIds }} opts
 * @returns enrichment signals (never rejects)
 */
async function enrich({ ip, email, customerId, deviceId, existingDeviceIds = [] } = {}) {
    const [ipRes, abuseRes, hibpRes, gnRes] = await Promise.allSettled([
        ipEnrichment.enrich(ip),
        abuseIpdb.getScore(ip),
        hibp.checkEmail(email),
        greynoise.check(ip),
    ]);

    const ipData    = ipRes.status    === 'fulfilled' ? ipRes.value    : null;
    const abuseData = abuseRes.status === 'fulfilled' ? abuseRes.value : null;
    const hibpData  = hibpRes.status  === 'fulfilled' ? hibpRes.value  : null;
    const gnData    = gnRes.status    === 'fulfilled' ? gnRes.value    : null;

    // Derived signals
    const is_proxy        = ipData?.proxy === true;
    const is_vpn          = ipData?.vpn   === true;
    const is_tor          = (ipData?.tor === true) || (abuseData?.isTor === true);
    const is_hosting      = ipData?.hosting === true;
    const email_breached  = hibpData?.breached === true;
    const breach_count    = hibpData?.breachCount ?? 0;
    const ip_abuse_score  = abuseData?.abuseScore ?? null;
    const is_greynoise_bot = gnData?.noise === true;

    // New device: deviceId not in customer's known device list
    const is_new_device = deviceId != null && !existingDeviceIds.includes(deviceId);

    // ATO signal count: three independent signals, 0–3
    const ato_signal_count = [email_breached, (is_proxy || is_vpn), is_new_device].filter(Boolean).length;

    // Geography from IP overrides static store value — only when a real country is returned
    const geography = (ipData?.country && ipData.country !== 'LOCAL') ? ipData.country : null;

    return {
        // IP signals
        geography,
        is_proxy,
        is_vpn,
        is_tor,
        is_hosting,
        ip_abuse_score,
        // Email signals
        email_breached,
        breach_count,
        // Bot signals
        is_greynoise_bot,
        // Device signals
        is_new_device,
        // Combined
        ato_signal_count,
        // Raw adapter results for trace
        _raw: { ip: ipData, abuse: abuseData, hibp: hibpData, greynoise: gnData },
    };
}

function isAnyAdapterConfigured() {
    return !!(process.env.ABUSEIPDB_API_KEY || process.env.HIBP_API_KEY);
    // ip-api.com and GreyNoise community always available (no key needed)
}

module.exports = { enrich, isAnyAdapterConfigured };
