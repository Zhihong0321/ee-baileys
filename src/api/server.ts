import express from 'express';
import path from 'path';
import { manager } from '../whatsapp/SocketManager';

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

        res.json({
            sessionId: req.params.id,
            status: isConnected ? 'connected' : 'initializing',
            qr: qr || null,
            message: qr ? 'Scan code' : (isConnected ? 'Connected' : 'Waiting for connection update')
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
    manager.getInstance(req.params.id).then(instance => {
        const qr = instance.getQRCode();
        if (!qr) return res.status(404).json({ error: 'QR not ready or already connected' });
        res.json({ qr });
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
