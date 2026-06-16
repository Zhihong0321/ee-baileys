import axios from 'axios';
import { WAMessage } from '@whiskeysockets/baileys';
import fs from 'fs-extra';
import path from 'path';
import { resolveSessionPath } from '../config/paths';

export interface WebhookPayload {
    sessionId: string;
    event: 'message' | 'connection' | 'qr';
    data: any;
}

export interface SessionWebhookConfig {
    sessionId: string;
    webhookUrl: string;
    updatedAt: string;
}

const SESSION_WEBHOOK_FILE = 'webhook.json';

export const parseWebhookUrl = (value: unknown): string | null => {
    const raw = String(value || '').trim();
    if (!raw) return null;

    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }
        return parsed.toString();
    } catch {
        return null;
    }
};

const resolveSessionWebhookPath = (sessionId: string) => {
    return path.join(resolveSessionPath(sessionId), SESSION_WEBHOOK_FILE);
};

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

export const getSessionWebhookConfig = async (sessionId: string): Promise<SessionWebhookConfig | null> => {
    const configPath = resolveSessionWebhookPath(sessionId);
    if (!(await fs.pathExists(configPath))) return null;

    try {
        const config = await fs.readJson(configPath);
        const webhookUrl = parseWebhookUrl(config?.webhookUrl);
        if (!webhookUrl) return null;

        return {
            sessionId,
            webhookUrl,
            updatedAt: String(config.updatedAt || ''),
        };
    } catch (err: any) {
        console.error(`[Webhook] Failed reading session webhook for ${sessionId}: ${err.message}`);
        return null;
    }
};

export const setSessionWebhookConfig = async (sessionId: string, webhookUrl: string): Promise<SessionWebhookConfig> => {
    const parsedWebhookUrl = parseWebhookUrl(webhookUrl);
    if (!parsedWebhookUrl) {
        throw new Error('Invalid webhookUrl. Use an http:// or https:// URL.');
    }

    const config: SessionWebhookConfig = {
        sessionId,
        webhookUrl: parsedWebhookUrl,
        updatedAt: new Date().toISOString(),
    };

    const sessionPath = resolveSessionPath(sessionId);
    await fs.ensureDir(sessionPath);
    await fs.writeJson(resolveSessionWebhookPath(sessionId), config, { spaces: 2 });
    return config;
};

export const clearSessionWebhookConfig = async (sessionId: string): Promise<void> => {
    await fs.remove(resolveSessionWebhookPath(sessionId));
};

export const dispatchSessionWebhook = async (payload: WebhookPayload) => {
    if (payload.event !== 'message') return;

    const config = await getSessionWebhookConfig(payload.sessionId);
    if (!config) return;

    try {
        await axios.post(config.webhookUrl, payload, { timeout: 10000 });
        console.log(`[Webhook] Dispatched session message webhook for ${payload.sessionId} -> ${config.webhookUrl}`);
    } catch (err: any) {
        console.error(`[Webhook Error] Session ${payload.sessionId} -> ${config.webhookUrl}: ${err.message}`);
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
