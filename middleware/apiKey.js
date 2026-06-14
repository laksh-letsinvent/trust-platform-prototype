// middleware/apiKey.js
// API key authentication. No-op when API_KEYS env var is not set (local dev / open deployments).

const KEYS = process.env.API_KEYS
    ? process.env.API_KEYS.split(',').map(k => k.trim()).filter(Boolean)
    : [];

function apiKey(req, res, next) {
    if (KEYS.length === 0) return next();
    const key = req.headers['x-api-key'];
    if (!key) return res.status(401).json({ error: 'Missing API key' });
    if (!KEYS.includes(key)) return res.status(403).json({ error: 'Invalid API key' });
    req.apiKeyId = key.slice(0, 8);
    next();
}

module.exports = apiKey;
