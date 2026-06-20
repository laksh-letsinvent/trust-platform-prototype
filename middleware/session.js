'use strict';

const jwt = require('jsonwebtoken');

const SECRET = () => process.env.SESSION_SECRET || 'dev-secret-change-me';

const AL_ORDER = ['AL1', 'AL2', 'AL3', 'AL4'];

function alIndex(al) {
    const i = AL_ORDER.indexOf(al);
    return i === -1 ? -1 : i;
}

function verifySession(req) {
    const token = req.cookies?.sig_session;
    if (!token) return null;
    try {
        return jwt.verify(token, SECRET());
    } catch {
        return null;
    }
}

function requireSession(req, res, next) {
    const payload = verifySession(req);
    if (!payload) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    req.user = payload;
    next();
}

function requireAL(level) {
    return (req, res, next) => {
        const payload = verifySession(req);
        if (!payload) return res.status(401).json({ error: 'Authentication required' });
        req.user = payload;
        if (alIndex(payload.achieved_al) < alIndex(level)) {
            return res.status(403).json({
                error: `${level} required`,
                achieved: payload.achieved_al,
            });
        }
        next();
    };
}

function optionalSession(req, res, next) {
    req.user = verifySession(req) || null;
    next();
}

function issueSessionCookie(res, payload) {
    const token = jwt.sign(payload, SECRET(), { expiresIn: '24h' });
    res.cookie('sig_session', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: 24 * 60 * 60 * 1000,
    });
}

function clearSessionCookie(res) {
    res.clearCookie('sig_session', { path: '/' });
}

module.exports = { requireSession, requireAL, optionalSession, issueSessionCookie, clearSessionCookie };
