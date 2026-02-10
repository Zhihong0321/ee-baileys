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

const logger = pino({ level: 'info' });

export class WhatsAppInstance {
    public sock?: WASocket;
    private qr?: string;
    private saveMutex = new Mutex();

    constructor(public readonly sessionId: string) { }

    async init() {
        const sessionPath = path.join(process.cwd(), 'sessions', this.sessionId);
        await fs.ensureDir(sessionPath);

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        this.sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: true,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            // PRO FINDING: Auto-recreate session on Bad MAC/Corruption
            enableAutoSessionRecreation: true,
            // Add a small delay for retries
            retryRequestDelayMs: 2000,
        });

        // Atomic Save wrapper
        const atomicSave = async () => {
            await this.saveMutex.runExclusive(async () => {
                await saveCreds();
            });
        };

        this.sock.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
            const { connection, lastDisconnect, qr } = update;
            this.qr = qr;

            if (qr) {
                dispatchWebhook({ sessionId: this.sessionId, event: 'qr', data: { qr } });
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                console.log(`[${this.sessionId}] Connection closed. Status: ${statusCode}. Reconnect: ${shouldReconnect}`);

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
