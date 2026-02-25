import express from 'express';
import path from 'path';
import axios from 'axios';
import { manager } from '../whatsapp/SocketManager';
import QRCode from 'qrcode';
import { postgresMessageWriter } from '../db/PostgresMessageWriter';

const app = express();
app.use(express.json());

// Serve the dashboard UI
const publicDir = path.join(process.cwd(), 'public');
app.use(express.static(publicDir));

// Serve downloaded media files (voice notes, etc.)
const mediaDir = path.join(process.cwd(), 'media');
app.use('/media', express.static(mediaDir));

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
            'GET /chats?sessionId=...',
            'GET /chats/:jid/messages?sessionId=...&limit=50&beforeTimestamp=...',
            'DELETE /sessions/:id'
        ]
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
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
    const { sessionId, to, text, audioUrl, imageUrl, videoUrl, documentUrl, ptt, replyTo, fileName, mimetype } = req.body;

    if (!sessionId || !to) {
        return res.status(400).json({ error: 'Missing required fields: sessionId and to' });
    }

    if (!text && !audioUrl && !imageUrl && !videoUrl && !documentUrl) {
        return res.status(400).json({ error: 'Missing message content: provide text or a media URL' });
    }

    try {
        const instance = await manager.getInstance(sessionId);
        if (!instance.sock) throw new Error('Socket not initialized');

        // Ensure the session is actually "Connected"
        if (!instance.sock.user) {
            return res.status(401).json({
                error: 'Session not connected',
                message: 'Your session is initializing or disconnected. Please ensure you have scanned the QR code.'
            });
        }

        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        const options: any = {};

        if (replyTo) {
            options.quoted = { key: { id: replyTo, remoteJid: jid, fromMe: false }, message: { conversation: '...' } };
        }

        let messageContent: any = {};

        // Helper to get buffer from URL
        const getBuffer = async (url: string) => {
            const res = await axios.get(url, { responseType: 'arraybuffer' });
            return Buffer.from(res.data, 'binary');
        };

        if (audioUrl) {
            console.log(`[${sessionId}] Downloading audio: ${audioUrl}`);
            const buffer = await getBuffer(audioUrl);
            const defaultMime = ptt ? 'audio/ogg; codecs=opus' : 'audio/mp4';
            messageContent = {
                audio: buffer,
                mimetype: mimetype || defaultMime,
                ptt: !!ptt
            };
        } else if (imageUrl) {
            console.log(`[${sessionId}] Downloading image: ${imageUrl}`);
            const buffer = await getBuffer(imageUrl);
            messageContent = { image: buffer, caption: text };
        } else if (videoUrl) {
            console.log(`[${sessionId}] Downloading video: ${videoUrl}`);
            const buffer = await getBuffer(videoUrl);
            messageContent = { video: buffer, caption: text };
        } else if (documentUrl) {
            console.log(`[${sessionId}] Downloading document: ${documentUrl}`);
            const buffer = await getBuffer(documentUrl);
            messageContent = {
                document: buffer,
                mimetype: mimetype || 'application/pdf',
                fileName: fileName || text || 'document'
            };
        } else {
            messageContent = { text };
        }

        const finalMime = (messageContent as any).mimetype || 'N/A';
        const contentKey = Object.keys(messageContent)[0];
        const isBuffer = Buffer.isBuffer((messageContent as any)[contentKey]);
        console.log(`[${sessionId}] Ready to send ${contentKey}. Buffer: ${isBuffer}, Mime: ${finalMime}, PTT: ${!!ptt}`);
        const result = await instance.sock.sendMessage(jid, messageContent, options);
        console.log(`[${sessionId}] Message sent successfully. ID: ${result?.key?.id}`);

        // Store outbound message in Postgres asynchronously
        const sentMediaUrl = audioUrl || imageUrl || videoUrl || documentUrl || null;
        postgresMessageWriter.storeOutboundMessage(sessionId, result!, jid, sentMediaUrl).catch(err => {
            console.error(`[Postgres] Failed to store outbound message: ${err.message}`);
        });

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
