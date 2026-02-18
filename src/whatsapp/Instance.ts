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
import { postgresMessageWriter } from '../db/PostgresMessageWriter';

const logger = pino({ level: 'info' });

export class WhatsAppInstance {
    public sock?: WASocket;
    private qr?: string;
    public lastError?: string;
    private saveMutex = new Mutex();
    private chats = new Map<string, any>();
    private messagesByChat = new Map<string, Map<string, proto.IWebMessageInfo>>();
    private maxCachedMessagesPerChat: number;

    constructor(public readonly sessionId: string) {
        const rawLimit = Number(process.env.MAX_CACHED_MESSAGES_PER_CHAT || 500);
        this.maxCachedMessagesPerChat = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 500;
    }

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
                enableAutoSessionRecreation: true,
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

            this.sock.ev.on('messaging-history.set', ({ chats, messages }) => {
                this.upsertChats(chats);
                this.cacheMessages(messages);
            });

            this.sock.ev.on('chats.upsert', (chats) => {
                this.upsertChats(chats);
            });

            this.sock.ev.on('chats.update', (updates) => {
                for (const update of updates) {
                    const jid = this.resolveChatJid(update);
                    if (!jid) continue;
                    const prev = this.chats.get(jid) || {};
                    this.chats.set(jid, {
                        ...prev,
                        ...update,
                        id: jid,
                        isGroup: jid.endsWith('@g.us'),
                    });
                }
            });

            this.sock.ev.on('chats.delete', (jids) => {
                for (const jid of jids) {
                    this.chats.delete(jid);
                    this.messagesByChat.delete(jid);
                }
            });

            this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
                this.cacheMessages(messages);
                if (type !== 'notify') return;

                for (const msg of messages) {
                    const remoteJid = msg.key?.remoteJid;

                    // Skip own messages
                    if (msg.key.fromMe) continue;

                    // Skip groups
                    if (remoteJid?.endsWith('@g.us')) continue;

                    // Skip status/broadcast
                    if (remoteJid === 'status@broadcast') continue;

                    // Skip empty message payloads
                    if (!msg.message) continue;

                    // Deduplication
                    if (deduper.shouldIgnore(msg.key.id!)) continue;

                    // Resolve sender phone number JID.
                    // WhatsApp sends BOTH a phone-number JID (@s.whatsapp.net) and a LID (@lid)
                    // on every message. The primary (remoteJid) can be either format.
                    // remoteJidAlt always holds the OTHER format.
                    // We always want the phone-number JID for lead matching.
                    const key = msg.key as any;
                    const senderJid = remoteJid?.endsWith('@lid')
                        ? (key.remoteJidAlt || remoteJid)   // primary is LID → use alt (PN)
                        : remoteJid!;                        // primary is already PN → use directly

                    console.log(`[${this.sessionId}] New message from ${msg.pushName || senderJid} (jid=${senderJid})`);

                    await postgresMessageWriter.storeInboundMessage(this.sessionId, msg, senderJid);

                    dispatchWebhook({
                        sessionId: this.sessionId,
                        event: 'message',
                        data: formatMessage(msg)
                    });
                }
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

    getChats(limit: number = 100) {
        const items = Array.from(this.chats.values());
        items.sort((a, b) => this.getChatSortTimestamp(b) - this.getChatSortTimestamp(a));
        return items.slice(0, limit).map(chat => ({
            id: chat.id,
            name: chat.name || chat.formattedName || null,
            unreadCount: chat.unreadCount || 0,
            archived: !!chat.archived,
            muteEndTime: chat.muteEndTime || null,
            isGroup: !!chat.isGroup,
            lastMessageTimestamp: this.getChatSortTimestamp(chat) || null,
        }));
    }

    getChatMessages(jid: string, limit: number = 50, beforeTimestamp?: number) {
        const map = this.messagesByChat.get(jid);
        if (!map) return [];

        let items = Array.from(map.values());
        items.sort((a, b) => this.messageTimestampMs(a) - this.messageTimestampMs(b));

        if (beforeTimestamp && Number.isFinite(beforeTimestamp)) {
            items = items.filter(msg => this.messageTimestampMs(msg) < beforeTimestamp);
        }

        if (items.length > limit) {
            items = items.slice(items.length - limit);
        }

        return items.map(msg => ({
            id: msg.key?.id || null,
            remoteJid: msg.key?.remoteJid || null,
            participant: msg.key?.participant || null,
            fromMe: !!msg.key?.fromMe,
            timestamp: this.messageTimestampMs(msg),
            type: msg.message ? Object.keys(msg.message)[0] : 'unknown',
            content: this.extractMessageText(msg),
            raw: msg,
        }));
    }

    private upsertChats(chats: any[]) {
        for (const chat of chats || []) {
            const jid = this.resolveChatJid(chat);
            if (!jid) continue;
            const prev = this.chats.get(jid) || {};
            this.chats.set(jid, {
                ...prev,
                ...chat,
                id: jid,
                isGroup: jid.endsWith('@g.us'),
            });
        }
    }

    private cacheMessages(messages: proto.IWebMessageInfo[]) {
        for (const msg of messages || []) {
            const jid = msg.key?.remoteJid;
            if (!jid) continue;

            const messageId = msg.key?.id || `${this.messageTimestampMs(msg)}-${Math.random()}`;
            const existing = this.messagesByChat.get(jid) || new Map<string, proto.IWebMessageInfo>();
            existing.set(messageId, msg);

            if (existing.size > this.maxCachedMessagesPerChat) {
                const sorted = Array.from(existing.entries()).sort((a, b) => this.messageTimestampMs(a[1]) - this.messageTimestampMs(b[1]));
                const overflow = existing.size - this.maxCachedMessagesPerChat;
                for (let i = 0; i < overflow; i++) {
                    existing.delete(sorted[i][0]);
                }
            }

            this.messagesByChat.set(jid, existing);
        }
    }

    private resolveChatJid(chat: any): string | undefined {
        return chat?.id || chat?.jid;
    }

    private getChatSortTimestamp(chat: any): number {
        const cts = this.longToNumber(chat?.conversationTimestamp);
        if (cts > 0) return cts > 1_000_000_000_000 ? cts : cts * 1000;

        const lm = this.longToNumber(chat?.lastMessageRecvTimestamp);
        if (lm > 0) return lm > 1_000_000_000_000 ? lm : lm * 1000;

        return 0;
    }

    private messageTimestampMs(msg: proto.IWebMessageInfo): number {
        const raw = msg.messageTimestamp;
        const n = this.longToNumber(raw);
        if (n <= 0) return 0;
        return n > 1_000_000_000_000 ? n : n * 1000;
    }

    private longToNumber(value: any): number {
        if (typeof value === 'number') return value;
        if (typeof value === 'string') {
            const n = Number(value);
            return Number.isNaN(n) ? 0 : n;
        }
        if (value && typeof value.toNumber === 'function') {
            return value.toNumber();
        }
        return 0;
    }

    private extractMessageText(msg: proto.IWebMessageInfo): string {
        return msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            '';
    }
}
