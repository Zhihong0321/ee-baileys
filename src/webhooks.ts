import axios from 'axios';
import dotenv from 'dotenv';
import {
    buildWebhookError,
    buildWebhookRequest,
    buildWebhookResponse,
    recordWebhook,
} from './utils/webhookLog';

dotenv.config();

// Regex to match exactly 6 consecutive digits (OTP code)
const OTP_REGEX = /^\d{6}$/;

export const dispatchWebhook = async (sessionId: string, message: any) => {
    const url = process.env.WEBHOOK_URL;
    if (!url) return;

    try {
        const payload = {
            sessionId,
            from: message.key.remoteJid,
            pushName: message.pushName,
            timestamp: message.messageTimestamp,
            type: getMessageType(message),
            content: getMessageContent(message),
            raw: message
        };

        console.log(`Sending webhook to ${url} for ${sessionId}`);
        const request = buildWebhookRequest(url, payload);
        const startedAt = Date.now();
        try {
            const resp = await axios.post(url, payload);
            const response = buildWebhookResponse(resp);
            recordWebhook({
                kind: 'global', sessionId, url, from: payload.from, event: 'message',
                contentPreview: String(payload.content || '').slice(0, 120),
                ok: true, status: resp.status, durationMs: Date.now() - startedAt, error: null,
                request, response, errorDetails: null,
            });
        } catch (postErr: any) {
            const errorDetails = buildWebhookError(postErr);
            recordWebhook({
                kind: 'global', sessionId, url, from: payload.from, event: 'message',
                contentPreview: String(payload.content || '').slice(0, 120),
                ok: false, status: postErr?.response?.status ?? null,
                durationMs: Date.now() - startedAt, error: errorDetails.message,
                request, response: errorDetails.response, errorDetails,
            });
            throw postErr;
        }
    } catch (err: any) {
        console.error(`Webhook Dispatch Error: ${err.message}`);
    }
};

/**
 * Dispatch to OTP webhook if message contains a 6-digit integer.
 * POSTs to WEBHOOK_OTP_URL with {from, message} payload.
 */
export const dispatchOtpWebhook = async (message: any) => {
    const url = process.env.WEBHOOK_OTP_URL;
    if (!url) return;

    const content = getMessageContent(message);
    // Check if message contains a 6-digit number
    if (!/\d{6}/.test(content)) return;

    // Extract the 6-digit number
    const match = content.match(/\d{6}/);
    if (!match) return;

    const otp = match[0];
    if (!OTP_REGEX.test(otp)) return;

    const from = message.key?.remoteJid;

    const payload = { from, message: content };
    const request = buildWebhookRequest(url, payload);
    const startedAt = Date.now();
    try {
        console.log(`Sending OTP webhook to ${url}: ${JSON.stringify(payload)}`);
        const resp = await axios.post(url, payload, { timeout: 5000 });
        const response = buildWebhookResponse(resp);
        recordWebhook({
            kind: 'otp', sessionId: null, url, from: from || null, event: 'otp',
            contentPreview: otp, ok: true, status: resp.status, durationMs: Date.now() - startedAt, error: null,
            request, response, errorDetails: null,
        });
    } catch (err: any) {
        const errorDetails = buildWebhookError(err);
        console.error(`OTP Webhook Error: ${err.message}`);
        recordWebhook({
            kind: 'otp', sessionId: null, url, from: from || null, event: 'otp',
            contentPreview: otp, ok: false, status: err?.response?.status ?? null,
            durationMs: Date.now() - startedAt, error: errorDetails.message,
            request, response: errorDetails.response, errorDetails,
        });
    }
};

function getMessageType(msg: any) {
    const message = normalizeMessage(msg.message);
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

    return Object.keys(message)[0] || 'other';
}

function getMessageContent(msg: any) {
    const message = normalizeMessage(msg.message);
    if (!message) return '';

    return (
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        getContactContent(message) ||
        getLocationContent(message) ||
        getMediaContent(message) ||
        ''
    );
}

function normalizeMessage(message: any): any {
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
}

function getContactContent(message: any): string | null {
    if (message.contactMessage) {
        return formatContact(message.contactMessage);
    }

    const contacts = Array.isArray(message.contactsArrayMessage?.contacts)
        ? message.contactsArrayMessage.contacts
        : [];
    if (contacts.length === 0) return null;

    const labels = contacts.slice(0, 5).map(formatContact);
    const suffix = contacts.length > labels.length ? ` +${contacts.length - labels.length} more` : '';
    return `Contacts: ${labels.join(', ')}${suffix}`;
}

function formatContact(contact: any): string {
    const displayName = contact?.displayName || contact?.display_name || 'Contact';
    const phone = extractPhoneFromVCard(contact?.vcard);
    return phone ? `${displayName} (${phone})` : displayName;
}

function getLocationContent(message: any): string | null {
    const location = message.locationMessage || message.liveLocationMessage;
    if (!location) return null;

    const name = location.name || location.address;
    const latitude = location.degreesLatitude;
    const longitude = location.degreesLongitude;
    const coordinates = latitude !== undefined && longitude !== undefined ? `${latitude},${longitude}` : null;

    if (name && coordinates) return `${name} (${coordinates})`;
    return name || coordinates || 'Location';
}

function getMediaContent(message: any): string | null {
    if (message.audioMessage) return message.audioMessage.ptt ? 'Voice note' : 'Audio';
    if (message.stickerMessage) return 'Sticker';
    if (message.documentMessage?.fileName) return message.documentMessage.fileName;
    return null;
}

function extractPhoneFromVCard(vcard?: string | null): string | null {
    if (!vcard) return null;

    const telLine = vcard
        .split(/\r?\n/)
        .find(line => /^TEL/i.test(line));
    if (!telLine) return null;

    const rawValue = telLine.split(':').slice(1).join(':').trim();
    const digits = rawValue.replace(/[^\d+]/g, '');
    return digits || null;
}
