import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    ConnectionState,
    WASocket,
    proto
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'path';
import fs from 'fs-extra';
import pino from 'pino';
import { deduper } from '../lib/Deduper';
import { dispatchWebhook, formatMessage } from '../utils/webhook';
import { Mutex } from 'async-mutex';
import QRCode from 'qrcode';

const logger = pino({ level: 'info' });

export class WhatsAppInstance {
    public sock?: WASocket;
    private qr?: string;
    public lastError?: string;
    private saveMutex = new Mutex();

    constructor(public readonly sessionId: string) { }

    async init() {
        try {
            console.log(`[${this.sessionId}] Initializing session...`);
            const sessionPath = path.join(process.cwd(), 'sessions', this.sessionId);
            await fs.ensureDir(sessionPath);
            console.log(`[${this.sessionId}] Session path: ${sessionPath}`);

            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            console.log(`[${this.sessionId}] Auth state loaded`);

            // Timeout version fetch to 5s
            const fetchVersion = async () => {
                const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Version fetch timeout')), 5000));
                return Promise.race([fetchLatestBaileysVersion(), timeout]) as any;
            };

            const versionResult = await fetchVersion().catch((err: any) => {
                console.log(`[${this.sessionId}] Version fetch failed/timed out, using fallback: ${err.message}`);
                return { version: [2, 3100, 1015901307] };
            });
            const version = versionResult.version;
            console.log(`[${this.sessionId}] Using Baileys version: ${version}`);

            this.sock = makeWASocket({
                version: version as any,
                logger,
                printQRInTerminal: true,
                browser: ['Mac OS', 'Chrome', '121.0.6167.85'],
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, logger),
                },
                // PRO FINDING: Auto-recreate session on Bad MAC/Corruption
                enableAutoSessionRecreation: true,
                // Add a small delay for retries
                retryRequestDelayMs: 5000,
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000,
            });
            console.log(`[${this.sessionId}] Socket created`);

            // Atomic Save wrapper
            const atomicSave = async () => {
                await this.saveMutex.runExclusive(async () => {
                    await saveCreds();
                });
            };

            this.sock.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
                console.log(`[${this.sessionId}] Connection Update:`, JSON.stringify(update, null, 2));
                const { connection, lastDisconnect, qr } = update;
                if (qr) this.qr = qr;

                if (qr) {
                    try {
                        const qrImage = await QRCode.toDataURL(qr);
                        dispatchWebhook({ sessionId: this.sessionId, event: 'qr', data: { qr, qrImage } });
                    } catch (err) {
                        console.error('Error generating QR DataURL:', err);
                        dispatchWebhook({ sessionId: this.sessionId, event: 'qr', data: { qr } });
                    }
                }

                if (connection === 'close') {
                    const error = lastDisconnect?.error as Boom;
                    const statusCode = error?.output?.statusCode;
                    const message = error?.message || 'Unknown error';
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                    this.lastError = `Connection closed: ${message} (${statusCode})`;
                    console.log(`[${this.sessionId}] ${this.lastError}. Reconnect: ${shouldReconnect}`);

                    if (shouldReconnect) {
                        this.init();
                    } else {
                        console.log(`[${this.sessionId}] Logged out. Cleaning up...`);
                        await fs.remove(sessionPath);
                    }
                } else if (connection === 'open') {
                    console.log(`[${this.sessionId}] Connection active`);
                    this.qr = undefined;
                    dispatchWebhook({ sessionId: this.sessionId, event: 'connection', data: { status: 'open' } });
                }
            });

            this.sock.ev.on('creds.update', atomicSave);

            // PRO FINDING: Handle LID Mapping
            this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
                if (type !== 'notify') return;

                for (const msg of messages) {
                    // Deduplication
                    if (deduper.shouldIgnore(msg.key.id!)) continue;

                    // Don't forward own messages
                    if (msg.key.fromMe) continue;

                    console.log(`[${this.sessionId}] New message from ${msg.pushName || msg.key.remoteJid}`);

                    dispatchWebhook({
                        sessionId: this.sessionId,
                        event: 'message',
                        data: formatMessage(msg)
                    });
                }
            });

            // PRO FINDING: Listen for LID Mappings explicitly if needed
            // (Note: Baileys v7 handles the internal store, but we expose an event if we want database sync)
            this.sock.ev.on('labels.association', (data) => {
                console.log(`[${this.sessionId}] Label/Identity change detected`, data);
            });

            return this.sock;
        } catch (err: any) {
            this.lastError = `Initialization failed: ${err.message}`;
            console.error(`[${this.sessionId}] ${this.lastError}`);
            throw err;
        }
    }

    getQRCode() {
        return this.qr;
    }

    async logout() {
        if (this.sock) {
            await this.sock.logout();
            this.sock = undefined;
        }
    }
}
