import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

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
