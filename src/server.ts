import express from 'express';
import { sessionManager } from './whatsapp';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

// Basic root/health endpoints for platform checks
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'baileys-api',
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

// Create or get status of a session
app.post('/sessions/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await sessionManager.initSession(id);
        const qr = sessionManager.getQR(id);
        const isConnected = !!(await sessionManager.getSession(id));

        res.json({
            sessionId: id,
            status: isConnected ? 'connected' : 'initializing',
            qr: qr || null,
            message: qr ? 'Scan this QR code' : (isConnected ? 'Already connected' : 'Initializing signal')
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// List all sessions
app.get('/sessions', (req, res) => {
    res.json({ sessions: sessionManager.listSessions() });
});

// Get QR Code for a session
app.get('/sessions/:id/qr', (req, res) => {
    const { id } = req.params;
    const qr = sessionManager.getQR(id);
    if (!qr) return res.status(404).json({ error: 'QR not ready or already connected' });
    res.json({ qr });
});

// Send Message
app.post('/messages/send', async (req, res) => {
    const { sessionId, to, text } = req.body;
    if (!sessionId || !to || !text) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const result = await sessionManager.sendMessage(sessionId, to, text);
        res.json({ status: 'sent', result });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// Delete Session (Logout)
app.delete('/sessions/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await sessionManager.logout(id);
        res.json({ status: 'logged out' });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
export const startServer = () => {
    app.listen(PORT, () => {
        console.log(`WhatsApp API Server running on port ${PORT}`);
    });
};
