import axios from 'axios';
import { WAMessage } from '@whiskeysockets/baileys';

export interface WebhookPayload {
    sessionId: string;
    event: 'message' | 'connection' | 'qr';
    data: any;
}

export const dispatchWebhook = async (payload: WebhookPayload) => {
    const url = process.env.WEBHOOK_URL;
    if (!url) return;

    try {
        await axios.post(url, payload, { timeout: 5000 });
        console.log(`[Webhook] Dispatched ${payload.event} for ${payload.sessionId}`);
    } catch (err: any) {
        console.error(`[Webhook Error] ${payload.sessionId}: ${err.message}`);
    }
};

export const formatMessage = (msg: WAMessage, mediaUrl?: string | null) => {
    const content = msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        '';

    return {
        id: msg.key.id,
        remoteJid: msg.key.remoteJid,
        pushName: msg.pushName,
        fromMe: msg.key.fromMe,
        timestamp: msg.messageTimestamp,
        content,
        type: msg.message ? Object.keys(msg.message)[0] : 'unknown',
        isGroup: msg.key.remoteJid?.endsWith('@g.us'),
        mediaUrl: mediaUrl ?? null,
    };
};
