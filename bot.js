const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const fs = require('fs');
const path = require('path');

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
// Prefer explicit backend, otherwise fall back to Next.js API
const API_BASE_URL = process.env.BACKEND_API_URL || `${String(APP_URL).replace(/\/$/, '')}/api`;
const BOT_CLIENT_ID = process.env.BOT_CLIENT_ID || 'bot-dev';

// Determine a writable session directory for whatsapp-web.js LocalAuth
function getWritableSessionDir() {
    const preferred = process.env.SESSION_DIR || '.wwebjs_auth';
    try {
        fs.mkdirSync(preferred, { recursive: true });
        fs.accessSync(preferred, fs.constants.W_OK);
        console.log('Using WhatsApp session dir:', preferred);
        return preferred;
    } catch (e) {
        const fallback = '/tmp/wwebjs_auth';
        try {
            fs.mkdirSync(fallback, { recursive: true });
            fs.accessSync(fallback, fs.constants.W_OK);
            console.warn(`SESSION_DIR "${preferred}" not writable; falling back to "${fallback}"`);
            return fallback;
        } catch (e2) {
            // Last-resort: current directory
            const local = '.wwebjs_auth';
            try {
                fs.mkdirSync(local, { recursive: true });
                fs.accessSync(local, fs.constants.W_OK);
                console.warn(`Fallback session dir "${fallback}" not writable; using local dir "${local}"`);
                return local;
            } catch (e3) {
                console.error('No writable session directory available; bot may fail to persist session.');
                return local;
            }
        }
    }
}


// Initialize WhatsApp Client with LocalAuth to persist sessions
const client = new Client({
    authStrategy: new LocalAuth({ clientId: BOT_CLIENT_ID, dataPath: getWritableSessionDir() }),
    puppeteer: (() => {
        // Allow overriding via env var; otherwise use Puppeteer's bundled Chromium when available
        let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
        if (!executablePath) {
            try {
                const pp = require('puppeteer');
                if (pp && typeof pp.executablePath === 'function') {
                    executablePath = pp.executablePath();
                } else if (pp && typeof pp.executablePath === 'string') {
                    executablePath = pp.executablePath;
                }
            } catch (_) {
                // Fallback to common OS paths if puppeteer isn't available
                const platform = process.platform;
                if (platform === 'darwin') {
                    executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
                } else if (platform === 'linux') {
                    executablePath = '/usr/bin/google-chrome-stable';
                } else if (platform === 'win32') {
                    executablePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
                }
            }
        }
        console.log('Using Chrome executable:', executablePath || '(puppeteer default)');
        return {
            executablePath,
            headless: String(process.env.HEADLESS || '').toLowerCase() === 'true',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        };
    })()
})
;

// (send-message route is declared after app initialization)

// Helper to call backend with fetch; polyfills when needed
async function postJson(url, body, extraHeaders = {}) {
    let doFetch = global.fetch;
    if (typeof doFetch !== 'function') {
        try {
            const mod = await import('node-fetch');
            doFetch = mod.default;
        } catch (e) {
            console.error('Fetch polyfill failed:', e);
            throw new Error('Fetch is not available in this Node version. Please use Node 18+ or install node-fetch.');
        }
    }
    const res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify(body)
    });

    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
}

client.on('qr', (qr) => {
    // Generate and scan this code with your phone
    qrcode.generate(qr, { small: true });
});

let isReady = false;
client.on('ready', () => {
    isReady = true;
    console.log('Client is ready!');
});

client.on('disconnected', (reason) => {
    isReady = false;
    console.log('Client was disconnected:', reason);
});

client.on('auth_failure', (message) => {
    console.error('Authentication failure:', message);
});

client.on('message', async message => {
    try {
        const sender = message.from;
        const text = (message.body || '').trim();
        console.log(`Received message from ${sender}: ${text}`);

        // Handle BUY / STOP commands
        const lower = text.toLowerCase();
        const phoneDigitsCmd = String(sender || '').replace(/\D/g, '');
        if (lower === 'buy' || lower === '/buy' || lower === 'buy plan') {
            const purchaseLink = process.env.PAYMENT_LINK_URL || process.env.NEXT_PUBLIC_PAYMENT_LINK_URL || `${APP_URL}/pricing`;
            await message.reply(`🛒 Purchase link: ${purchaseLink}`);
            return;
        }
        if (lower === 'stop' || lower === '/stop' || lower === 'unsubscribe') {
            try {
                const resp = await postJson(`${API_BASE_URL}/bot/whatsapp-optout`, { phone: phoneDigitsCmd }, { 'x-internal-key': process.env.BOT_INTERNAL_KEY || 'dev-secret-key' });
                if (resp.ok && resp.data && resp.data.success) {
                    await message.reply('✅ You have been unsubscribed from WhatsApp notifications.');
                } else {
                    await message.reply('⚠️ Unable to unsubscribe at the moment. Please try again later.');
                }
            } catch (e) {
                await message.reply('⚠️ Unable to unsubscribe at the moment. Please try again later.');
            }
            return;
        }

        // Commands: /login <hash>
        let hash = '';
        const parts = text.split(/\s+/);
        if (parts[0].toLowerCase() === '/login' && parts[1]) {
            hash = parts[1].trim();
        } else {
            // Fallback: treat entire message as hash if it looks like a hex/alphanumeric token
            if (/^[A-Za-z0-9]{6,}$/.test(text)) {
                hash = text;
            }
        }

        if (!hash) {
            // Ignore non-login messages
            return;
        }

        // Verify via backend; include sender phone when available
        const phoneDigits = String(sender || '').replace(/\D/g, '');
        let resp = await postJson(`${API_BASE_URL}/auth/verify-hash-code`, { hash, phone: phoneDigits });

        // Fallback to Next.js API if primary backend fails
        if (!(resp && resp.ok && resp.data && resp.data.success)) {
            try {
                const fallbackUrl = `${String(APP_URL).replace(/\/$/, '')}/api/auth/verify-hash-code`;
                const alt = await postJson(fallbackUrl, { hash, phone: phoneDigits });
                if (alt && alt.ok && alt.data && alt.data.success) {
                    resp = alt;
                }
            } catch (e) {
                // swallow and proceed to error handling below
            }
        }
        // Retry without phone if still failing (phone normalization mismatch)
        if (!(resp && resp.ok && resp.data && resp.data.success)) {
            try {
                const altPrimary = await postJson(`${API_BASE_URL}/auth/verify-hash-code`, { hash });
                if (altPrimary && altPrimary.ok && altPrimary.data && altPrimary.data.success) {
                    resp = altPrimary;
                }
            } catch {}
        }
        if (!(resp && resp.ok && resp.data && resp.data.success)) {
            try {
                const fallbackUrl = `${String(APP_URL).replace(/\/$/, '')}/api/auth/verify-hash-code`;
                const altNoPhone = await postJson(fallbackUrl, { hash });
                if (altNoPhone && altNoPhone.ok && altNoPhone.data && altNoPhone.data.success) {
                    resp = altNoPhone;
                }
            } catch {}
        }
        if (resp.ok && resp.data && resp.data.success) {
            const token = resp.data?.data?.token;
            const user = resp.data?.data?.user || {};
            const phone = user?.phone || '';

            // Reply without any login link per requirement
            await message.reply(
                `✅ Login successful${phone ? ` for ${phone}` : ''}.\n\n` +
                `• If you are on your computer, your browser will log in automatically within a few seconds.\n` +
                `• If you are on your phone, please open the app or website directly to continue.`
            );
        } else {
            const errMsg = resp.data?.message || 'Invalid or expired code.';
            await message.reply(`❌ Login failed: ${errMsg}`);
        }
    } catch (e) {
        console.error('Bot handler error:', e);
        try { await message.reply('⚠️ An error occurred while processing your request. Please try again.'); } catch {}
    }
});

// Utilities
function phoneToJid(phone) {
    let digits = String(phone || '').replace(/\D/g, '');
    if (!digits) throw new Error('Invalid phone');
    // Remove leading zeros
    digits = digits.replace(/^0+/, '');
    // Ensure country code present; default to 91 (IN) if missing
    const DEFAULT_CC = process.env.DEFAULT_COUNTRY_CODE || '91';
    if (!digits.startsWith(DEFAULT_CC) && digits.length <= 10) {
        digits = `${DEFAULT_CC}${digits}`;
    }
    return `${digits}@c.us`;
}

// Minimal HTTP server to receive OTP dispatch requests from backend
const app = express();
app.use(express.json());

// Health and root endpoints for Render/Railway health checks
app.get('/', (_req, res) => res.json({ ok: true, status: 'ok' }));
app.get('/health', (_req, res) => res.json({ ok: true }));

// Allow internal services to send generic WhatsApp messages
app.post('/send-message', async (req, res) => {
    try {
        const internalKey = process.env.BOT_INTERNAL_KEY || 'dev-secret-key';
        if ((req.headers['x-internal-key'] || '') !== internalKey) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (!isReady) {
            return res.status(503).json({ success: false, message: 'WhatsApp client not ready' });
        }
        const { phone, text } = req.body || {};
        if (!phone || !text) {
            return res.status(400).json({ success: false, message: 'phone and text are required' });
        }
        const jid = phoneToJid(phone);
        await client.sendMessage(jid, String(text));
        return res.json({ success: true });
    } catch (e) {
        console.error('send-message error:', e);
        return res.status(500).json({ success: false, message: 'Failed to send message' });
    }
});

app.post('/send-otp', async (req, res) => {
    try {
        const internalKey = process.env.BOT_INTERNAL_KEY || 'dev-secret-key';
        if ((req.headers['x-internal-key'] || '') !== internalKey) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (!isReady) {
            return res.status(503).json({ success: false, message: 'WhatsApp client not ready' });
        }
        const { phone, code, type } = req.body || {};
        if (!phone || !code) {
            return res.status(400).json({ success: false, message: 'phone and code are required' });
        }
        const jid = phoneToJid(phone);
        const appName = process.env.APP_NAME || 'True-OTP';
        const label = type === 'reset' ? 'Password Reset ' : '';
        const text = `Your ${appName} ${label}OTP is ${code}. It expires in 10 minutes. Do not share this code.`;
        await client.sendMessage(jid, text);
        return res.json({ success: true });
    } catch (e) {
        console.error('send-otp error:', e);
        return res.status(500).json({ success: false, message: 'Failed to send OTP' });
    }
});

const PORT = Number(process.env.PORT || process.env.BOT_PORT || 4002);
const HOST = process.env.HOST || '0.0.0.0';
const server = app.listen(PORT, HOST, () => {
    console.log(`OTP HTTP server running on http://${HOST}:${PORT}`);
});

// Graceful shutdown to avoid leaving Chrome profile locks behind
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}. Shutting down bot and browser...`);
    try {
        if (server && server.close) {
            await new Promise((resolve) => server.close(resolve));
            console.log('HTTP server closed.');
        }
    } catch (e) {
        console.error('Error closing HTTP server:', e);
    }
    try {
        await client.destroy();
        console.log('WhatsApp client destroyed.');
    } catch (e) {
        console.error('Error destroying WhatsApp client:', e);
    }
    process.exit(0);
}

['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((sig) => {
    process.on(sig, () => shutdown(sig));
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    shutdown('unhandledRejection');
});

client.initialize();
