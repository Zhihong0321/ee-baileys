import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadMediaMessage,
    ConnectionState,
    WASocket,
    proto,
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
import { resolveSessionPath } from '../config/paths';

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
            const sessionPath = resolveSessionPath(this.sessionId);
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

                    // Download and decrypt supported media (voice, image, PDF) and return HTTP URL
                    const mediaUrl = await this.persistSupportedInboundMedia(msg);

                    // Recipient = this logged-in WA account's phone number
                    const recipientPhone = this.extractPhoneNumber(this.sock?.user?.id ?? '');

                    await postgresMessageWriter.storeInboundMessage(this.sessionId, msg, senderJid, mediaUrl, recipientPhone);

                    dispatchWebhook({
                        sessionId: this.sessionId,
                        event: 'message',
                        data: formatMessage(msg, mediaUrl)
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
        // NOTE: WhatsApp history sync stores many contacts under LID JIDs (@lid).
        // We cannot resolve LID → phone number from chat objects alone (no remoteJidAlt),
        // so we keep ALL chats and return phoneNumber: null for LID-only contacts.
        items.sort((a, b) => this.getChatSortTimestamp(b) - this.getChatSortTimestamp(a));
        return items.slice(0, limit).map(chat => ({
            id: chat.id,
            phoneNumber: this.extractPhoneNumber(chat.id),
            name: chat.name || chat.formattedName || null,
            unreadCount: chat.unreadCount || 0,
            archived: !!chat.archived,
            muteEndTime: chat.muteEndTime || null,
            isGroup: !!chat.isGroup,
            lastMessageTimestamp: this.getChatSortTimestamp(chat) || null,
        }));
    }

    getChatMessages(jid: string, limit: number = 50, beforeTimestamp?: number) {
        // Normalise the requested JID so a phone-number lookup always hits
        const storageJid = this.resolveStorageJid(jid);
        const map = this.messagesByChat.get(storageJid);
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
            phoneNumber: this.extractPhoneNumber(storageJid),
            fromMe: !!msg.key?.fromMe,
            timestamp: this.messageTimestampMs(msg),
            type: msg.message ? Object.keys(msg.message)[0] : 'unknown',
            content: this.extractMessageText(msg),
        }));
    }

    private upsertChats(chats: any[]) {
        for (const chat of chats || []) {
            const jid = this.resolveChatJid(chat);
            if (!jid) continue;
            // Chat objects do NOT carry remoteJidAlt — we store under whatever JID
            // WhatsApp gives us (phone-number or LID). resolveStorageJid is used
            // only for message keys where remoteJidAlt is actually present.
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
            const rawJid = msg.key?.remoteJid;
            if (!rawJid) continue;

            // Normalise LID → phone-number JID using the alt field when present
            const key = msg.key as any;
            const jid = this.resolveStorageJid(rawJid, key?.remoteJidAlt);

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

    /**
     * If the primary JID is a LID (@lid), swap it for the phone-number JID (@s.whatsapp.net)
     * when an alternate is available. Otherwise return primary as-is.
     */
    private resolveStorageJid(primary: string, alt?: string): string {
        if (primary?.endsWith('@lid') && alt && alt.endsWith('@s.whatsapp.net')) {
            return alt;
        }
        return primary;
    }

    /**
     * Extract a plain phone number string from a phone-number JID.
     * Returns null for groups or LID JIDs.
     */
    private extractPhoneNumber(jid: string): string | null {
        if (!jid || !jid.endsWith('@s.whatsapp.net')) return null;
        return jid.split('@')[0].split(':')[0];
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

    /**
     * Download, decrypt, and save supported inbound media (voice, image, PDF).
     * Saves to the global media/ directory served by Express and returns an HTTP URL,
     * or null if the message has no supported media or download fails.
     */
    private async persistSupportedInboundMedia(msg: proto.IWebMessageInfo): Promise<string | null> {
        if (!this.sock || !msg.message) return null;

        const normalizedMessage = this.normalizeMessage(msg.message);
        if (!normalizedMessage) return null;

        const mediaMeta = this.resolveSupportedMediaMeta(msg, normalizedMessage);
        if (!mediaMeta) return null;

        try {
            const mediaBuffer = await downloadMediaMessage(
                msg as any,
                'buffer',
                {},
                {
                    logger,
                    reuploadRequest: this.sock.updateMediaMessage
                }
            );

            const fileName = this.buildMediaFileName(msg.key?.id, mediaMeta.originalFileName, mediaMeta.defaultExt, mediaMeta.mimeType);
            const mediaDir = path.join(process.cwd(), 'media', mediaMeta.kind);
            await fs.ensureDir(mediaDir);

            const filePath = path.join(mediaDir, fileName);
            await fs.writeFile(filePath, mediaBuffer);

            const relativeUrl = `/media/${mediaMeta.kind}/${fileName}`;
            const baseUrl = this.resolvePublicMediaBaseUrl();
            const url = baseUrl ? `${baseUrl}${relativeUrl}` : relativeUrl;

            if (!baseUrl) {
                console.warn(`[${this.sessionId}] MEDIA_BASE_URL not set. Storing relative media URL: ${relativeUrl}`);
            }
            console.log(`[${this.sessionId}] Saved inbound ${mediaMeta.kind}: ${url}`);
            return url;
        } catch (err: any) {
            console.error(`[${this.sessionId}] Failed saving inbound media ${msg.key?.id || 'unknown'}: ${err.message}`);
            return null;
        }
    }

    private normalizeMessage(message: proto.IMessage): proto.IMessage | null {
        let current: any = message;

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

    private resolveSupportedMediaMeta(msg: proto.IWebMessageInfo, message: proto.IMessage): {
        kind: 'voice' | 'pdf' | 'image';
        defaultExt: string;
        mimeType?: string | null;
        originalFileName?: string | null;
    } | null {
        if (message.audioMessage) {
            return {
                kind: 'voice',
                defaultExt: 'ogg',
                mimeType: message.audioMessage.mimetype
            };
        }

        if (message.imageMessage) {
            return {
                kind: 'image',
                defaultExt: 'jpg',
                mimeType: message.imageMessage.mimetype
            };
        }

        if (message.documentMessage) {
            const mime = (message.documentMessage.mimetype || '').toLowerCase();
            const fileName = message.documentMessage.fileName || '';
            const isPdf = mime === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf');
            if (isPdf) {
                return {
                    kind: 'pdf',
                    defaultExt: 'pdf',
                    mimeType: message.documentMessage.mimetype,
                    originalFileName: fileName || `${msg.key?.id || 'document'}.pdf`
                };
            }
        }

        return null;
    }

    private buildMediaFileName(messageId: string | null | undefined, originalFileName: string | null | undefined, defaultExt: string, mimeType?: string | null): string {
        const safeMessageId = this.sanitizeFileComponent(messageId || `${Date.now()}`);
        const ext = this.resolveExtension(mimeType, defaultExt);
        const originalBase = originalFileName ? path.basename(originalFileName) : '';
        const safeOriginalBase = this.sanitizeFileComponent(originalBase);

        if (safeOriginalBase) {
            return `${safeMessageId}-${safeOriginalBase}`;
        }
        return `${safeMessageId}.${ext}`;
    }

    private resolveExtension(mimeType: string | null | undefined, fallback: string): string {
        if (!mimeType) return fallback;
        const cleanMime = mimeType.split(';')[0].trim().toLowerCase();

        const known: Record<string, string> = {
            'audio/ogg': 'ogg',
            'audio/opus': 'opus',
            'audio/mpeg': 'mp3',
            'audio/mp4': 'm4a',
            'audio/aac': 'aac',
            'audio/amr': 'amr',
            'application/pdf': 'pdf',
            'image/jpeg': 'jpg',
            'image/jpg': 'jpg',
            'image/png': 'png',
            'image/webp': 'webp',
            'image/heic': 'heic'
        };

        if (known[cleanMime]) {
            return known[cleanMime];
        }

        const slashIndex = cleanMime.indexOf('/');
        if (slashIndex >= 0 && slashIndex < cleanMime.length - 1) {
            const derived = cleanMime.slice(slashIndex + 1).replace(/[^a-z0-9]/g, '');
            if (derived) return derived;
        }

        return fallback;
    }

    private sanitizeFileComponent(input: string): string {
        return input.replace(/[^a-zA-Z0-9._-]/g, '_');
    }

    private resolvePublicMediaBaseUrl(): string | null {
        const configured = (process.env.MEDIA_BASE_URL || '').trim();
        if (configured) {
            return configured.replace(/\/+$/, '');
        }

        const railwayDomain = (process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL || '').trim();
        if (railwayDomain) {
            const normalizedDomain = railwayDomain.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
            return `https://${normalizedDomain}`;
        }

        return null;
    }
}
