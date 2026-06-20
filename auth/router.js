'use strict';

const express   = require('express');
const crypto    = require('crypto');
const { v4: uuidv4 } = require('uuid');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const credStore    = require('./credentialStore');
const chalStore    = require('./challengeStore');
const store        = require('../data/store');
const { getDecision } = require('../decisionEngine');
const { issueSessionCookie, clearSessionCookie, requireSession, requireAL } = require('../middleware/session');

const router = express.Router();

const SESSION_SECRET = () => process.env.SESSION_SECRET || 'dev-secret-change-me';
const RP_ID     = () => process.env.WEBAUTHN_RP_ID     || 'localhost';
const RP_NAME   = () => process.env.WEBAUTHN_RP_NAME   || 'Signal Trust Platform';
const ORIGIN    = () => process.env.WEBAUTHN_ORIGIN    || 'http://localhost:3000';
const SITE_URL  = () => process.env.SITE_URL           || 'http://localhost:3000';

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureDeviceCookie(req, res) {
    let deviceId = req.cookies?.sig_device;
    if (!deviceId) {
        deviceId = uuidv4();
        res.cookie('sig_device', deviceId, {
            httpOnly: false,
            sameSite: 'lax',
            maxAge: 365 * 24 * 60 * 60 * 1000,
            path: '/',
        });
    }
    return deviceId;
}

function verifyEnrollCookie(req) {
    const token = req.cookies?.sig_enroll;
    if (!token) return null;
    try {
        const p = jwt.verify(token, SESSION_SECRET());
        return p.purpose === 'enroll' ? p : null;
    } catch {
        return null;
    }
}

async function mailer() {
    if (!process.env.SMTP_HOST) return null;
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587'),
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
}

// ── GET /auth/session ─────────────────────────────────────────────────────────

router.get('/session', (req, res) => {
    const token = req.cookies?.sig_session;
    if (!token) return res.json({ authenticated: false });
    try {
        const p = jwt.verify(token, SESSION_SECRET());
        res.json({ authenticated: true, customer_id: p.customer_id, email: p.email, achieved_al: p.achieved_al });
    } catch {
        res.json({ authenticated: false });
    }
});

// ── GET /auth/user-info ───────────────────────────────────────────────────────

router.get('/user-info', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email required' });
    try {
        const cred = await credStore.getByEmail(email);
        res.json({
            has_passkey: !!(cred && cred.passkeys && cred.passkeys.length > 0),
            has_passcode: !!(cred && cred.passcode_hash),
        });
    } catch {
        res.json({ has_passkey: false, has_passcode: false });
    }
});

// ── POST /auth/magic-link/request ────────────────────────────────────────────

router.post('/magic-link/request', async (req, res) => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });

    // Ensure credential record exists (creates app user if needed)
    let cred = await credStore.getByEmail(email);
    if (!cred) {
        // New user not in users.json — create with derived customer_id from email local part
        const customerId = email.split('@')[0]
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .slice(0, 32);
        await store.createUser({
            customer_id: customerId,
            email,
            fraud_score: 10,
            geography: 'UNKNOWN',
            known_device_ids: [],
        });
        await credStore.upsertUser(email, { customer_id: customerId, email });
        cred = await credStore.getByEmail(email);
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = Date.now() + 15 * 60 * 1000;
    credStore.setMagicToken(email, tokenHash, expiresAt);

    const link = `${SITE_URL()}/auth/magic-link/verify?token=${rawToken}&email=${encodeURIComponent(email)}`;

    const transport = await mailer();
    if (transport) {
        await transport.sendMail({
            from: process.env.SMTP_FROM || 'noreply@trustdecision.letsinvent.co.uk',
            to: email,
            subject: 'Sign in to Signal Trust Platform',
            text: `Click to sign in:\n\n${link}\n\nExpires in 15 minutes.`,
            html: `<p>Click to sign in:</p><p><a href="${link}">${link}</a></p><p>Expires in 15 minutes.</p>`,
        }).catch(() => {});
        return res.json({ ok: true });
    }

    // Dev mode — return link in response
    return res.json({ ok: true, dev_link: link });
});

// ── GET /auth/magic-link/verify ───────────────────────────────────────────────

router.get('/magic-link/verify', async (req, res) => {
    const { token, email } = req.query;
    if (!token || !email) return res.redirect('/login?error=invalid');

    const cred = await credStore.getByEmail(email);
    if (!cred || !cred.magic_token_hash || !cred.magic_token_expires) {
        return res.redirect('/login?error=invalid');
    }
    if (Date.now() > cred.magic_token_expires) {
        return res.redirect('/login?error=expired');
    }
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    if (hash !== cred.magic_token_hash) {
        return res.redirect('/login?error=invalid');
    }

    credStore.clearMagicToken(email);

    const enrollToken = jwt.sign({ email, purpose: 'enroll' }, SESSION_SECRET(), { expiresIn: '10m' });
    res.cookie('sig_enroll', enrollToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: 10 * 60 * 1000,
    });
    res.redirect('/login?step=register');
});

// ── POST /auth/webauthn/register/start ────────────────────────────────────────

router.post('/webauthn/register/start', async (req, res) => {
    const enroll = verifyEnrollCookie(req);
    if (!enroll) return res.status(401).json({ error: 'Enrollment session required' });

    const { email } = enroll;
    const cred = await credStore.getByEmail(email);
    const existingKeys = (cred?.passkeys || []).map(pk => ({ id: pk.id, type: 'public-key' }));

    const options = await generateRegistrationOptions({
        rpID: RP_ID(),
        rpName: RP_NAME(),
        userName: email,
        excludeCredentials: existingKeys,
        authenticatorSelection: {
            residentKey: 'preferred',
            userVerification: 'preferred',
        },
    });

    chalStore.set(email, options.challenge);
    res.json(options);
});

// ── POST /auth/webauthn/register/finish ───────────────────────────────────────

router.post('/webauthn/register/finish', async (req, res) => {
    const enroll = verifyEnrollCookie(req);
    if (!enroll) return res.status(401).json({ error: 'Enrollment session required' });

    const { email } = enroll;
    const expectedChallenge = chalStore.get(email);
    if (!expectedChallenge) return res.status(400).json({ error: 'Challenge expired' });

    let verification;
    try {
        verification = await verifyRegistrationResponse({
            response: req.body,
            expectedChallenge,
            expectedOrigin: ORIGIN(),
            expectedRPID: RP_ID(),
        });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    if (!verification.verified) return res.status(400).json({ error: 'Verification failed' });

    const { registrationInfo } = verification;
    const credential = {
        id: registrationInfo.credential.id,
        publicKey: Buffer.from(registrationInfo.credential.publicKey).toString('base64'),
        counter: registrationInfo.credential.counter,
        transports: req.body.response?.transports || [],
    };

    credStore.addPasskey(email, credential);
    chalStore.del(email);

    // Register device
    const deviceId = ensureDeviceCookie(req, res);
    const cred = await credStore.getByEmail(email);
    if (cred?.customer_id) {
        await store.addKnownDevice(cred.customer_id, deviceId);
    }

    // Clear enroll cookie
    res.clearCookie('sig_enroll', { path: '/' });

    const customer_id = cred?.customer_id || email;
    issueSessionCookie(res, { customer_id, email, achieved_al: 'AL2', device_id: deviceId });
    res.json({ ok: true, customer_id, achieved_al: 'AL2' });
});

// ── POST /auth/webauthn/login/start ───────────────────────────────────────────

router.post('/webauthn/login/start', async (req, res) => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });

    const cred = await credStore.getByEmail(email);
    if (!cred || !cred.passkeys?.length) {
        return res.status(400).json({ error: 'No passkey registered for this email' });
    }

    const allowCredentials = cred.passkeys.map(pk => ({
        id: pk.id,
        type: 'public-key',
        transports: pk.transports || [],
    }));

    const options = await generateAuthenticationOptions({
        rpID: RP_ID(),
        allowCredentials,
        userVerification: 'preferred',
    });

    chalStore.set(email, options.challenge);
    res.json(options);
});

// ── POST /auth/webauthn/login/finish ──────────────────────────────────────────

router.post('/webauthn/login/finish', async (req, res) => {
    const { email, response } = req.body || {};
    if (!email || !response) return res.status(400).json({ error: 'email and response required' });

    const expectedChallenge = chalStore.get(email);
    if (!expectedChallenge) return res.status(400).json({ error: 'Challenge expired' });

    const found = credStore.getPasskeyById(response.id);
    if (!found) return res.status(400).json({ error: 'Unknown credential' });

    const { passkey } = found;
    let verification;
    try {
        verification = await verifyAuthenticationResponse({
            response,
            expectedChallenge,
            expectedOrigin: ORIGIN(),
            expectedRPID: RP_ID(),
            credential: {
                id: passkey.id,
                publicKey: Buffer.from(passkey.publicKey, 'base64'),
                counter: passkey.counter,
                transports: passkey.transports || [],
            },
        });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    if (!verification.verified) return res.status(400).json({ error: 'Verification failed' });

    credStore.updateCounter(email, passkey.id, verification.authenticationInfo.newCounter);
    chalStore.del(email);

    const cred = await credStore.getByEmail(email);
    const customer_id = cred?.customer_id || email;
    const deviceId = ensureDeviceCookie(req, res);

    const result = await getDecision({
        customer_id,
        action: 'login',
        device_id: deviceId,
        current_auth_level: 'AL2',
        ip: req.ip,
        email,
    });

    if (result.decision === 'ALLOW') {
        await store.addKnownDevice(customer_id, deviceId);
        issueSessionCookie(res, { customer_id, email, achieved_al: 'AL2', device_id: deviceId });
        return res.json({ ok: true, customer_id, achieved_al: 'AL2' });
    }
    if (result.decision === 'STEP_UP') {
        return res.status(403).json({ decision: 'STEP_UP', step_up_type: result.step_up_type });
    }
    return res.status(403).json({ decision: 'DENY', rule_id: result.rule_id });
});

// ── POST /auth/passcode/set ───────────────────────────────────────────────────

router.post('/passcode/set', requireSession, requireAL('AL2'), async (req, res) => {
    const { passcode } = req.body || {};
    if (!passcode || !/^\d{4,8}$/.test(String(passcode))) {
        return res.status(400).json({ error: 'Passcode must be 4–8 digits' });
    }
    const hash = await bcrypt.hash(String(passcode), 10);
    credStore.setPasscodeHash(req.user.email, hash);
    res.json({ ok: true });
});

// ── POST /auth/passcode/login ─────────────────────────────────────────────────

router.post('/passcode/login', async (req, res) => {
    const { email, passcode } = req.body || {};
    if (!email || !passcode) return res.status(400).json({ error: 'email and passcode required' });

    const cred = await credStore.getByEmail(email);
    if (!cred?.passcode_hash) return res.status(401).json({ error: 'No passcode set' });

    const match = await bcrypt.compare(String(passcode), cred.passcode_hash);
    if (!match) return res.status(401).json({ error: 'Invalid passcode' });

    const customer_id = cred.customer_id || email;
    const deviceId = ensureDeviceCookie(req, res);

    const result = await getDecision({
        customer_id,
        action: 'login',
        device_id: deviceId,
        current_auth_level: 'AL1',
        ip: req.ip,
        email,
    });

    if (result.decision === 'ALLOW') {
        issueSessionCookie(res, { customer_id, email, achieved_al: 'AL1', device_id: deviceId });
        return res.json({ ok: true, customer_id, achieved_al: 'AL1' });
    }
    if (result.decision === 'STEP_UP') {
        return res.status(403).json({ decision: 'STEP_UP', step_up_type: result.step_up_type });
    }
    return res.status(403).json({ decision: 'DENY', rule_id: result.rule_id });
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────

router.post('/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
});

module.exports = router;
