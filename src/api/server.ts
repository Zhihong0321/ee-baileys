import express from 'express';
import path from 'path';
import axios from 'axios';
import { manager } from '../whatsapp/SocketManager';
import QRCode from 'qrcode';
import { postgresMessageWriter } from '../db/PostgresMessageWriter';
import { WhatsAppInstance } from '../whatsapp/Instance';
import {
    clearSessionWebhookConfig,
    dispatchSessionWebhook,
    getSessionWebhookConfig,
    parseWebhookUrl,
    setSessionWebhookConfig,
} from '../utils/webhook';
import { buildHealthReport } from '../health';

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
            'GET /sessions/:id',
            'GET /sessions/:id/qr',
            'PUT /sessions/:id/webhook',
            'GET /sessions/:id/webhook',
            'DELETE /sessions/:id/webhook',
            'POST /messages/send',
            'POST /simulate/inbound',
            'POST /groups/create',
            'DELETE /groups/:jid?sessionId=...',
            'GET /chats?sessionId=...',
            'GET /chats/:jid/messages?sessionId=...&limit=50&beforeTimestamp=...',
            'DELETE /sessions/:id'
        ]
    });
});

app.get('/health', (req, res) => {
    buildHealthReport()
        .then(report => res.status(report.ok ? 200 : 503).json(report))
        .catch((err: any) => res.status(500).json({
            ok: false,
            status: 'error',
            checkedAt: new Date().toISOString(),
            service: 'baileys-multi-api',
            error: err.message,
        }));
});

app.get('/full-health', (req, res) => {
    res.sendFile(path.join(publicDir, 'full-health.html'));
});

const buildSessionResponse = async (sessionId: string, instance: WhatsAppInstance) => {
    const qr = instance.getQRCode();
    const isConnected = !!instance.sock?.user;
    const me = instance.getMe();

    let qrImage = null;
    if (qr) {
        try {
            qrImage = await QRCode.toDataURL(qr);
        } catch (err) {
            console.error('Error generating QR DataURL:', err);
        }
    }

    return {
        sessionId,
        status: isConnected ? 'connected' : 'initializing',
        qr: qr || null,
        qrImage,
        error: instance.lastError || null,
        message: qr ? 'Scan code' : (isConnected ? 'Connected' : (instance.lastError ? 'Error occurred' : 'Waiting for connection update')),
        connectedNumber: instance.getConnectedNumber(),
        me,
        webhook: await getSessionWebhookConfig(sessionId),
    };
};

// Init or Get status
app.post('/sessions/:id', async (req, res) => {
    try {
        const instance = await manager.getInstance(req.params.id);
        res.json(await buildSessionResponse(req.params.id, instance));
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// List
app.get('/sessions', async (req, res) => {
    try {
        const sessions = manager.listInstances();
        const sessionDetails = await Promise.all(
            sessions.map(async (sessionId) => {
                const instance = manager.getExistingInstance(sessionId);
                if (!instance) return null;
                return buildSessionResponse(sessionId, instance);
            })
        );

        res.json({
            sessions,
            sessionDetails: sessionDetails.filter((session): session is NonNullable<typeof session> => !!session),
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// Get a single session status without reinitializing it
app.get('/sessions/:id', async (req, res) => {
    try {
        const instance = manager.getExistingInstance(req.params.id);
        if (!instance) {
            return res.status(404).json({ error: 'Session not found' });
        }

        res.json(await buildSessionResponse(req.params.id, instance));
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
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

// Configure automatic inbound message webhook for one session
app.put('/sessions/:id/webhook', async (req, res) => {
    const webhookUrl = parseWebhookUrl(req.body?.webhookUrl || req.body?.url);
    if (!webhookUrl) {
        return res.status(400).json({ error: 'Missing or invalid webhookUrl. Use an http:// or https:// URL.' });
    }

    try {
        const config = await setSessionWebhookConfig(req.params.id, webhookUrl);
        res.json({
            status: 'configured',
            ...config,
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/sessions/:id/webhook', async (req, res) => {
    const webhookUrl = parseWebhookUrl(req.body?.webhookUrl || req.body?.url);
    if (!webhookUrl) {
        return res.status(400).json({ error: 'Missing or invalid webhookUrl. Use an http:// or https:// URL.' });
    }

    try {
        const config = await setSessionWebhookConfig(req.params.id, webhookUrl);
        res.json({
            status: 'configured',
            ...config,
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/sessions/:id/webhook', async (req, res) => {
    try {
        const config = await getSessionWebhookConfig(req.params.id);
        if (!config) {
            return res.status(404).json({ error: 'Webhook not configured for session', sessionId: req.params.id });
        }

        res.json(config);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/sessions/:id/webhook', async (req, res) => {
    try {
        await clearSessionWebhookConfig(req.params.id);
        res.json({ status: 'deleted', sessionId: req.params.id });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
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

app.post('/simulate/inbound', async (req, res) => {
    const { sessionId, recipientPhone, senderPhone, text, pushName, messageId } = req.body || {};

    if (!senderPhone) {
        return res.status(400).json({ error: 'Missing required field: senderPhone' });
    }

    if (!sessionId && !recipientPhone) {
        return res.status(400).json({ error: 'Provide sessionId or recipientPhone' });
    }

    try {
        const result = await postgresMessageWriter.simulateInboundTextMessage({
            sessionId,
            recipientPhone,
            senderPhone,
            text,
            pushName,
            messageId,
        });

        dispatchSessionWebhook({
            sessionId: result.sessionId,
            event: 'message',
            data: {
                id: result.messageId,
                remoteJid: `${result.senderPhone}@s.whatsapp.net`,
                pushName,
                fromMe: false,
                timestamp: Math.floor(Date.now() / 1000),
                content: text || null,
                type: 'text',
                isGroup: false,
                mediaUrl: null,
            },
        });

        res.json({
            status: 'simulated',
            ...result,
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/groups/create', async (req, res) => {
    const { sessionId, subject, participants, profileImageUrl, profileImage } = req.body;
    const imageSource = String(profileImageUrl || profileImage || '').trim();

    if (!sessionId || !subject || !participants || !Array.isArray(participants)) {
        return res.status(400).json({ error: 'Missing or invalid parameters. Required: sessionId, subject, participants (array of strings)' });
    }

    try {
        const instance = await manager.getInstance(sessionId);
        if (!instance.sock?.user) {
            return res.status(400).json({ error: 'Session not connected' });
        }

        // Format participants to ensure they are full JIDs if they are just raw numbers.
        const jids = participants.map(p => {
            const str = String(p).trim().toLowerCase();
            if (!str) return str;
            if (str.endsWith('@s.whatsapp.net') || str.endsWith('@lid') || str.endsWith('@g.us')) {
                return str;
            }

            const digits = str.replace(/[^\d]/g, '');
            return digits ? `${digits}@s.whatsapp.net` : str;
        });

        console.log(`[${sessionId}] Group create request for "${subject}" with ${jids.length} participants`);
        const result = await instance.createGroupIfMissing(subject, jids);

        if (result.status === 'duplicate') {
            console.log(`[${sessionId}] Duplicate group blocked for members: ${jids.join(', ')}`);
            return res.status(409).json({
                error: `A group with the same member list already exists (groupUid: ${result.group.id})`,
                status: 'duplicate',
                groupUid: result.group.id,
                group: result.group,
                profileImageStatus: imageSource ? 'skipped_duplicate' : 'skipped',
            });
        }

        let profileImageStatus: 'skipped' | 'applied' | 'failed' = 'skipped';
        let profileImageError: string | null = null;

        if (imageSource) {
            try {
                const getBuffer = async (source: string) => {
                    const trimmed = String(source || '').trim();
                    if (!trimmed) {
                        throw new Error('Empty profile image source');
                    }

                    if (trimmed.startsWith('data:')) {
                        const commaIndex = trimmed.indexOf(',');
                        if (commaIndex === -1) {
                            throw new Error('Invalid data URL');
                        }

                        const meta = trimmed.slice(5, commaIndex);
                        const payload = trimmed.slice(commaIndex + 1);
                        return Buffer.from(payload, meta.includes(';base64') ? 'base64' : 'utf8');
                    }

                    const imageRes = await axios.get(trimmed, { responseType: 'arraybuffer' });
                    return Buffer.from(imageRes.data, 'binary');
                };

                console.log(`[${sessionId}] Downloading group profile image: ${imageSource}`);
                const imageBuffer = await getBuffer(imageSource);
                await instance.sock!.updateProfilePicture(result.group.id, imageBuffer);
                profileImageStatus = 'applied';
            } catch (err: any) {
                profileImageStatus = 'failed';
                profileImageError = err.message;
                console.error(`[${sessionId}] Failed to apply group profile image:`, err);
            }
        }

        res.json({
            status: 'created',
            groupUid: result.group.id,
            group: result.group,
            profileImageStatus,
            ...(profileImageError ? { profileImageError } : {}),
        });
    } catch (err: any) {
        console.error(`[${sessionId}] Failed to create group:`, err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/groups/:jid', async (req, res) => {
    const sessionId = String(req.query.sessionId || req.body?.sessionId || '').trim();
    const rawJid = String(req.params.jid || '').trim();

    if (!sessionId || !rawJid) {
        return res.status(400).json({ error: 'Missing required fields: sessionId and group jid' });
    }

    const groupJid = rawJid.includes('@') ? rawJid : `${rawJid}@g.us`;

    try {
        const instance = manager.getExistingInstance(sessionId);
        if (!instance) {
            return res.status(404).json({ error: 'Session not found' });
        }

        if (!instance.sock?.user) {
            return res.status(400).json({ error: 'Session not connected' });
        }

        const group = await instance.leaveGroup(groupJid);
        instance.forgetChat(group.id);

        return res.json({
            status: 'left',
            operation: 'group_leave',
            groupUid: group.id,
            group: {
                id: group.id,
                subject: group.subject,
                participants: group.participants,
                size: group.size,
            },
            message: 'Connected session left the group. WhatsApp does not support permanent server-side deletion of a group.',
        });
    } catch (err: any) {
        console.error(`[${sessionId}] Failed to leave group ${groupJid}:`, err);
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

// Logout and permanently delete session data
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
