import express from 'express';
import path from 'path';
import { manager } from '../whatsapp/SocketManager';
import QRCode from 'qrcode';

const app = express();
app.use(express.json());

// Serve the dashboard UI
const publicDir = path.join(process.cwd(), 'public');
app.use(express.static(publicDir));

// Basic API info/health endpoints
app.get('/api', (req, res) => {
    res.json({
        status: 'ok',
        service: 'baileys-multi-api',
        endpoints: [
            'POST /sessions/:id',
            'GET /sessions',
            'GET /sessions/:id/qr',
            'POST /messages/send',
            'POST /leads/verify-whatsapp',
            'GET /chats?sessionId=...',
            'GET /chats/:jid/messages?sessionId=...&limit=50&beforeTimestamp=...',
            'DELETE /sessions/:id'
        ]
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Verify WhatsApp number and pre-resolve LID for a lead
app.post('/leads/verify-whatsapp', async (req, res) => {
    const { sessionId, phone } = req.body;
    if (!sessionId || !phone) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, phone' });
    }

    const digits = String(phone).replace(/\D/g, '');
    if (!digits) {
        return res.status(400).json({ error: 'Invalid phone number' });
    }

    try {
        // 1. Get or restore session (auto-init if not in memory)
        const instance = await manager.getInstance(sessionId);
        if (!instance.sock) {
            return res.status(400).json({ error: 'Socket not initialized — session is still starting up' });
        }
        if (!instance.sock.user) {
            return res.status(400).json({ error: 'Session not connected — may need QR scan or is reconnecting' });
        }

        // 2. Check if phone is a WhatsApp user
        let isWhatsApp = false;
        let verifyError: string | null = null;
        try {
            const results = await instance.sock.onWhatsApp(digits + '@s.whatsapp.net');
            isWhatsApp = !!results?.[0]?.exists;
        } catch (err: any) {
            verifyError = err.message;
            console.error(`[verify-whatsapp] onWhatsApp failed for ${digits}: ${err.message}`);
        }

        // 3. Resolve LID (only if WhatsApp user)
        // getLIDForPN does cache lookup first, then falls back to USync LID protocol query
        let lid: string | null = null;
        if (isWhatsApp && instance.sock.signalRepository?.lidMapping?.getLIDForPN) {
            try {
                const pnJid = digits + '@s.whatsapp.net';
                lid = await instance.sock.signalRepository.lidMapping.getLIDForPN(pnJid);
                console.log(`[verify-whatsapp] getLIDForPN(${pnJid}) → ${lid}`);
            } catch (err: any) {
                console.warn(`[verify-whatsapp] LID resolution failed for ${digits}: ${err.message}`);
            }
        } else if (isWhatsApp) {
            console.warn(`[verify-whatsapp] lidMapping.getLIDForPN not available on signalRepository`);
        }

        // 4. Always update lead in DB when we have a verification result
        let leadUpdated = false;
        const databaseUrl = process.env.DATABASE_URL;
        if (databaseUrl) {
            try {
                const { Pool } = require('pg');
                const pool = new Pool({ connectionString: databaseUrl });

                // Resolve tenant_id from session
                const sessionResult = await pool.query(
                    `SELECT tenant_id FROM et_channel_sessions WHERE channel_type = 'WHATSAPP' AND session_identifier = $1 LIMIT 1`,
                    [sessionId]
                );

                if (sessionResult.rows.length > 0) {
                    const tenantId = sessionResult.rows[0].tenant_id;
                    const updateResult = await pool.query(
                        `UPDATE et_leads
                         SET whatsapp_lid = COALESCE($1, whatsapp_lid),
                             is_whatsapp_valid = $2,
                             last_verify_at = NOW(),
                             verify_error = $3
                         WHERE tenant_id = $4
                           AND regexp_replace(external_id, '\\D', '', 'g') = $5`,
                        [lid, isWhatsApp, verifyError, tenantId, digits]
                    );
                    leadUpdated = (updateResult.rowCount ?? 0) > 0;
                }

                await pool.end();
            } catch (err: any) {
                console.error(`[verify-whatsapp] DB update failed: ${err.message}`);
            }
        }

        res.json({ phone: digits, isWhatsApp, lid, leadUpdated, verifyError });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// Init or Get status
app.post('/sessions/:id', async (req, res) => {
    try {
        const instance = await manager.getInstance(req.params.id);
        const qr = instance.getQRCode();
        const isConnected = !!instance.sock?.user;

        let qrImage = null;
        if (qr) {
            try {
                qrImage = await QRCode.toDataURL(qr);
            } catch (err) {
                console.error('Error generating QR DataURL:', err);
            }
        }

        res.json({
            sessionId: req.params.id,
            status: isConnected ? 'connected' : 'initializing',
            qr: qr || null,
            qrImage: qrImage,
            error: instance.lastError || null,
            message: qr ? 'Scan code' : (isConnected ? 'Connected' : (instance.lastError ? 'Error occurred' : 'Waiting for connection update'))
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// List
app.get('/sessions', (req, res) => {
    res.json({ sessions: manager.listInstances() });
});

// Get QR for a session
app.get('/sessions/:id/qr', (req, res) => {
    manager.getInstance(req.params.id).then(async instance => {
        const qr = instance.getQRCode();
        if (!qr) return res.status(404).json({ error: 'QR not ready or already connected' });

        let qrImage = null;
        try {
            qrImage = await QRCode.toDataURL(qr);
        } catch (err) {
            console.error('Error generating QR DataURL:', err);
        }

        res.json({ qr, qrImage });
    }).catch((err: any) => {
        res.status(500).json({ error: err.message });
    });
});

// Send Message (The main endpoint for AI)
app.post('/messages/send', async (req, res) => {
    const { sessionId, to, text, replyTo } = req.body;
    if (!sessionId || !to || !text) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const instance = await manager.getInstance(sessionId);
        if (!instance.sock) throw new Error('Socket not initialized');

        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        const options: any = {};

        if (replyTo) {
            options.quoted = { key: { id: replyTo, remoteJid: jid, fromMe: false }, message: { conversation: '...' } };
        }

        const result = await instance.sock.sendMessage(jid, { text }, options);
        res.json({ status: 'sent', result });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// List chats in a connected session (from in-memory cache/history sync)
app.get('/chats', async (req, res) => {
    const sessionId = String(req.query.sessionId || '').trim();
    const rawLimit = Number(req.query.limit || 100);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;

    if (!sessionId) {
        return res.status(400).json({ error: 'Missing required query: sessionId' });
    }

    const instance = manager.getExistingInstance(sessionId);
    if (!instance) {
        return res.status(404).json({ error: 'Session not found' });
    }

    return res.json({
        sessionId,
        count: instance.getChats(limit).length,
        chats: instance.getChats(limit),
    });
});

// List messages for a chat in a connected session (from in-memory cache/history sync)
app.get('/chats/:jid/messages', async (req, res) => {
    const sessionId = String(req.query.sessionId || '').trim();
    const jid = String(req.params.jid || '').trim();
    const rawLimit = Number(req.query.limit || 50);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 50;
    const beforeTimestampRaw = req.query.beforeTimestamp;
    const beforeTimestamp = beforeTimestampRaw !== undefined ? Number(beforeTimestampRaw) : undefined;

    if (!sessionId || !jid) {
        return res.status(400).json({ error: 'Missing required fields: sessionId and chat jid' });
    }

    const instance = manager.getExistingInstance(sessionId);
    if (!instance) {
        return res.status(404).json({ error: 'Session not found' });
    }

    const messages = instance.getChatMessages(jid, limit, beforeTimestamp);
    return res.json({
        sessionId,
        jid,
        count: messages.length,
        messages,
    });
});

// Logout/Delete
app.delete('/sessions/:id', async (req, res) => {
    try {
        await manager.removeInstance(req.params.id);
        res.json({ status: 'deleted' });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
export const startServer = () => {
    app.listen(PORT, () => {
        console.log(`WhatsApp Multi-API Server running on port ${PORT}`);
    });
};
