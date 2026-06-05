import axios from 'axios';
import dotenv from 'dotenv';

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
        await axios.post(url, payload);
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

    try {
        const payload = { from, message: content };
        console.log(`Sending OTP webhook to ${url}: ${JSON.stringify(payload)}`);
        await axios.post(url, payload, { timeout: 5000 });
    } catch (err: any) {
        console.error(`OTP Webhook Error: ${err.message}`);
    }
};

function getMessageType(msg: any) {
    if (msg.message?.conversation) return 'text';
    if (msg.message?.extendedTextMessage) return 'extended_text';
    if (msg.message?.imageMessage) return 'image';
    if (msg.message?.videoMessage) return 'video';
    return 'other';
}

function getMessageContent(msg: any) {
    return (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        ''
    );
}
