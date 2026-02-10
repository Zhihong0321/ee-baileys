import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    ConnectionState,
    WASocket
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'path';
import fs from 'fs-extra';
import pino from 'pino';
import { dispatchWebhook } from './webhooks';

const logger = pino({ level: 'info' });

export class SessionManager {
    private sessions: Map<string, WASocket> = new Map();
    private qrCodes: Map<string, string> = new Map();
    private sessionsDir: string;

    constructor() {
        this.sessionsDir = path.join(process.cwd(), 'sessions');
        fs.ensureDirSync(this.sessionsDir);
    }

    async initSession(sessionId: string) {
        if (this.sessions.has(sessionId)) {
            return this.sessions.get(sessionId);
        }

        const sessionPath = path.join(this.sessionsDir, sessionId);
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            printQRInTerminal: true,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            logger,
        });

        sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                this.qrCodes.set(sessionId, qr);
                console.log(`QR Code for session ${sessionId} generated.`);
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log(`Connection closed for ${sessionId}. Reconnecting: ${shouldReconnect}`);

                if (shouldReconnect) {
                    this.initSession(sessionId);
                } else {
                    this.sessions.delete(sessionId);
                    this.qrCodes.delete(sessionId);
                    fs.removeSync(sessionPath);
                }
            } else if (connection === 'open') {
                console.log(`Connection opened for ${sessionId}`);
                this.sessions.set(sessionId, sock);
                this.qrCodes.delete(sessionId);
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // Listen for messages
        sock.ev.on('messages.upsert', async (m) => {
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    if (!msg.key.fromMe) {
                        const content = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
                        console.log(`New message in ${sessionId}: ${msg.pushName}: ${content}`);
                        await dispatchWebhook(sessionId, msg);
                    }
                }
            }
        });

        return sock;
    }

    async getSession(sessionId: string) {
        return this.sessions.get(sessionId);
    }

    getQR(sessionId: string) {
        return this.qrCodes.get(sessionId);
    }

    listSessions() {
        return Array.from(this.sessions.keys());
    }

    async sendMessage(sessionId: string, to: string, text: string) {
        const sock = this.sessions.get(sessionId);
        if (!sock) throw new Error('Session not found or not connected');

        const jid = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`;
        return await sock.sendMessage(jid, { text });
    }

    async logout(sessionId: string) {
        const sock = this.sessions.get(sessionId);
        if (sock) {
            await sock.logout();
            this.sessions.delete(sessionId);
        }
    }
}

export const sessionManager = new SessionManager();
