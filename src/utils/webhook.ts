import axios from 'axios';
import { WAMessage } from '@whiskeysockets/baileys';
import fs from 'fs-extra';
import path from 'path';
import { resolveSessionPath } from '../config/paths';
import {
    buildWebhookError,
    buildWebhookRequest,
    buildWebhookResponse,
    recordWebhook,
} from './webhookLog';

const previewPayload = (payload: WebhookPayload): { from: string | null; content: string | null } => {
    const data: any = payload?.data || {};
    return {
        from: data.from || data.remoteJid || data.senderPhone || null,
        content:
            typeof data.content === 'string'
                ? data.content.slice(0, 120)
                : data.text
                ? String(data.text).slice(0, 120)
                : null,
    };
};

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

    const { from, content } = previewPayload(payload);
    const request = buildWebhookRequest(url, payload);
    const startedAt = Date.now();
    try {
        const resp = await axios.post(url, payload, { timeout: 5000 });
        const response = buildWebhookResponse(resp);
        console.log(`[Webhook] Dispatched ${payload.event} for ${payload.sessionId}`);
        recordWebhook({
            kind: 'global', sessionId: payload.sessionId, url, from, event: payload.event,
            contentPreview: content, ok: true, status: resp.status, durationMs: Date.now() - startedAt, error: null,
            request, response, errorDetails: null,
        });
    } catch (err: any) {
        const errorDetails = buildWebhookError(err);
        console.error(`[Webhook Error] ${payload.sessionId}: ${err.message}`);
        recordWebhook({
            kind: 'global', sessionId: payload.sessionId, url, from, event: payload.event,
            contentPreview: content, ok: false, status: err?.response?.status ?? null,
            durationMs: Date.now() - startedAt, error: errorDetails.message,
            request, response: errorDetails.response, errorDetails,
        });
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

    const { from, content } = previewPayload(payload);
    const request = buildWebhookRequest(config.webhookUrl, payload);
    const startedAt = Date.now();
    try {
        const resp = await axios.post(config.webhookUrl, payload, { timeout: 10000 });
        const response = buildWebhookResponse(resp);
        console.log(`[Webhook] Dispatched session message webhook for ${payload.sessionId} -> ${config.webhookUrl}`);
        recordWebhook({
            kind: 'session', sessionId: payload.sessionId, url: config.webhookUrl, from, event: payload.event,
            contentPreview: content, ok: true, status: resp.status, durationMs: Date.now() - startedAt, error: null,
            request, response, errorDetails: null,
        });
    } catch (err: any) {
        const errorDetails = buildWebhookError(err);
        console.error(`[Webhook Error] Session ${payload.sessionId} -> ${config.webhookUrl}: ${err.message}`);
        recordWebhook({
            kind: 'session', sessionId: payload.sessionId, url: config.webhookUrl, from, event: payload.event,
            contentPreview: content, ok: false, status: err?.response?.status ?? null,
            durationMs: Date.now() - startedAt, error: errorDetails.message,
            request, response: errorDetails.response, errorDetails,
        });
    }
};

export const formatMessage = (msg: WAMessage, mediaUrl?: string | null) => {
    const message = normalizeMessage(msg.message || null);
    const content = resolveMessagePreview(message) || '';

    return {
        id: msg.key.id,
        remoteJid: msg.key.remoteJid,
        pushName: msg.pushName,
        fromMe: msg.key.fromMe,
        timestamp: msg.messageTimestamp,
        content,
        type: resolveMessageType(message),
        isGroup: msg.key.remoteJid?.endsWith('@g.us'),
        mediaUrl: mediaUrl ?? null,
        contacts: resolveContactPayload(message),
    };
};

const normalizeMessage = (message: any): any => {
    let current = message;

    while (current) {
        if (current.ephemeralMessage?.message) {
            current = current.ephemeralMessage.message;
            continue;
        }
        if (current.viewOnceMessage?.message) {
            current = current.viewOnceMessage.message;
            continue;
        }
        if (current.viewOnceMessageV2?.message) {
            current = current.viewOnceMessageV2.message;
            continue;
        }
        if (current.viewOnceMessageV2Extension?.message) {
            current = current.viewOnceMessageV2Extension.message;
            continue;
        }
        if (current.documentWithCaptionMessage?.message) {
            current = current.documentWithCaptionMessage.message;
            continue;
        }
        break;
    }

    return current || null;
};

const resolveMessageType = (message: any): string => {
    if (!message) return 'unknown';
    if (message.conversation || message.extendedTextMessage) return 'text';
    if (message.contactMessage) return 'contact';
    if (message.contactsArrayMessage) return 'contacts';
    if (message.imageMessage) return 'image';
    if (message.videoMessage) return 'video';
    if (message.audioMessage) return 'audio';
    if (message.documentMessage) return 'document';
    if (message.stickerMessage) return 'sticker';
    if (message.reactionMessage) return 'reaction';
    if (message.locationMessage) return 'location';
    if (message.liveLocationMessage) return 'live_location';
    return Object.keys(message)[0] || 'unknown';
};

const resolveMessagePreview = (message: any): string | null => {
    if (!message) return null;

    return message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        resolveContactPreview(message) ||
        resolveLocationPreview(message) ||
        resolveMediaPreview(message) ||
        null;
};

const resolveContactPreview = (message: any): string | null => {
    const contacts = resolveContactPayload(message);
    if (!contacts.length) return null;

    const labels = contacts
        .slice(0, 5)
        .map(contact => contact.phone ? `${contact.displayName} (${contact.phone})` : contact.displayName);
    const suffix = contacts.length > labels.length ? ` +${contacts.length - labels.length} more` : '';
    return contacts.length === 1 ? labels[0] : `Contacts: ${labels.join(', ')}${suffix}`;
};

const resolveContactPayload = (message: any): Array<{ displayName: string; phone: string | null; vcard: string | null }> => {
    if (!message) return [];

    if (message.contactMessage) {
        return [formatContact(message.contactMessage)];
    }

    const contacts = Array.isArray(message.contactsArrayMessage?.contacts)
        ? message.contactsArrayMessage.contacts
        : [];
    return contacts.map(formatContact);
};

const formatContact = (contact: any): { displayName: string; phone: string | null; vcard: string | null } => {
    const vcard = typeof contact?.vcard === 'string' ? contact.vcard : null;
    return {
        displayName: contact?.displayName || contact?.display_name || 'Contact',
        phone: extractPhoneFromVCard(vcard),
        vcard,
    };
};

const resolveLocationPreview = (message: any): string | null => {
    const location = message.locationMessage || message.liveLocationMessage;
    if (!location) return null;

    const name = location.name || location.address;
    const latitude = location.degreesLatitude;
    const longitude = location.degreesLongitude;
    const coordinates = latitude !== undefined && longitude !== undefined ? `${latitude},${longitude}` : null;

    if (name && coordinates) return `${name} (${coordinates})`;
    return name || coordinates || 'Location';
};

const resolveMediaPreview = (message: any): string | null => {
    if (message.audioMessage) return message.audioMessage.ptt ? 'Voice note' : 'Audio';
    if (message.stickerMessage) return 'Sticker';
    if (message.documentMessage?.fileName) return message.documentMessage.fileName;
    return null;
};

const extractPhoneFromVCard = (vcard?: string | null): string | null => {
    if (!vcard) return null;

    const telLine = vcard
        .split(/\r?\n/)
        .find(line => /^TEL/i.test(line));
    if (!telLine) return null;

    const rawValue = telLine.split(':').slice(1).join(':').trim();
    const digits = rawValue.replace(/[^\d+]/g, '');
    return digits || null;
};
