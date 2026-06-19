import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadMediaMessage,
    ConnectionState,
    WASocket,
    GroupMetadata,
    LIDMapping,
    proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'path';
import fs from 'fs-extra';
import pino from 'pino';
import { deduper } from '../lib/Deduper';
import { dispatchSessionWebhook, dispatchWebhook, formatMessage } from '../utils/webhook';
import { Mutex } from 'async-mutex';
import QRCode from 'qrcode';
import { postgresMessageWriter } from '../db/PostgresMessageWriter';
import { MEDIA_BASE_DIR, resolveSessionPath } from '../config/paths';

const logger = pino({ level: 'info' });

export class WhatsAppInstance {
    public sock?: WASocket;
    private qr?: string;
    public lastError?: string;
    private destroyed = false;
    private saveMutex = new Mutex();
    private groupCreateMutex = new Mutex();
    private chats = new Map<string, any>();
    private messagesByChat = new Map<string, Map<string, proto.IWebMessageInfo>>();
    private lidToPn = new Map<string, string>();
    private pnToLid = new Map<string, string>();
    private maxCachedMessagesPerChat: number;

    constructor(public readonly sessionId: string) {
        const rawLimit = Number(process.env.MAX_CACHED_MESSAGES_PER_CHAT || 500);
        this.maxCachedMessagesPerChat = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 500;
    }

    async init() {
        try {
            if (this.destroyed) {
                console.log(`[${this.sessionId}] Init skipped because session was deleted`);
                return;
            }

            console.log(`[${this.sessionId}] Initializing session...`);
            const sessionPath = resolveSessionPath(this.sessionId);
            await fs.ensureDir(sessionPath);
            if (this.destroyed) {
                await fs.remove(sessionPath);
                console.log(`[${this.sessionId}] Init aborted after deletion`);
                return;
            }
            console.log(`[${this.sessionId}] Session path: ${sessionPath}`);

            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            if (this.destroyed) {
                await fs.remove(sessionPath);
                console.log(`[${this.sessionId}] Init aborted after auth load because session was deleted`);
                return;
            }
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
            if (this.destroyed) {
                await fs.remove(sessionPath);
                console.log(`[${this.sessionId}] Init aborted after version fetch because session was deleted`);
                return;
            }
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
                if (this.destroyed) return;
                await this.saveMutex.runExclusive(async () => {
                    if (this.destroyed) return;
                    await saveCreds();
                });
            };

            this.sock.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
                if (this.destroyed) return;
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
                    if (this.destroyed) return;
                    const error = lastDisconnect?.error as Boom;
                    const statusCode = error?.output?.statusCode;
                    const message = error?.message || 'Unknown error';
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                    this.lastError = `Connection closed: ${message} (${statusCode})`;
                    console.log(`[${this.sessionId}] ${this.lastError}. Reconnect: ${shouldReconnect}`);

                    if (shouldReconnect) {
                        if (this.destroyed) return;
                        this.init();
                    } else {
                        console.log(`[${this.sessionId}] Logged out. Cleaning up...`);
                        await fs.remove(sessionPath);
                    }
                } else if (connection === 'open') {
                    console.log(`[${this.sessionId}] Connection active`);
                    this.qr = undefined;
                    this.lastError = undefined;
                    dispatchWebhook({ sessionId: this.sessionId, event: 'connection', data: { status: 'open' } });
                }
            });

            this.sock.ev.on('creds.update', atomicSave);

            this.sock.ev.on('messaging-history.set', ({ chats, contacts, messages, lidPnMappings }) => {
                if (this.destroyed) return;
                this.recordLidMappings(lidPnMappings || []);
                this.recordContactMappings(contacts || []);
                this.upsertChats(chats);
                this.cacheMessages(messages);
            });

            this.sock.ev.on('chats.upsert', (chats) => {
                if (this.destroyed) return;
                this.upsertChats(chats);
            });

            this.sock.ev.on('chats.update', (updates) => {
                if (this.destroyed) return;
                for (const update of updates) {
                    this.recordChatMapping(update);
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

            this.sock.ev.on('contacts.upsert', (contacts) => {
                if (this.destroyed) return;
                this.recordContactMappings(contacts || []);
            });

            this.sock.ev.on('contacts.update', (contacts) => {
                if (this.destroyed) return;
                this.recordContactMappings(contacts || []);
            });

            this.sock.ev.on('lid-mapping.update', (mapping) => {
                if (this.destroyed) return;
                this.recordLidMapping(mapping);
            });

            this.sock.ev.on('chats.delete', (jids) => {
                if (this.destroyed) return;
                for (const jid of jids) {
                    this.chats.delete(jid);
                    this.messagesByChat.delete(jid);
                }
            });

            this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
                if (this.destroyed) return;
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

                    const senderJid = await this.resolveInboundSenderPhoneJid(msg);
                    if (!senderJid) {
                        console.error(
                            `[${this.sessionId}] Cannot persist inbound ${msg.key.id}: ` +
                            `no phone-number JID found for ${remoteJid}. Waiting for LID mapping.`
                        );
                        continue;
                    }

                    console.log(`[${this.sessionId}] New message from ${msg.pushName || senderJid} (jid=${senderJid})`);

                    // Recipient = this logged-in WA account's phone number
                    const recipientPhone = this.extractPhoneNumber(this.sock?.user?.id ?? '');

                    // Durable queue first: store the raw inbound payload before any media work.
                    await postgresMessageWriter.storeInboundMessage(this.sessionId, msg, senderJid, null, recipientPhone);

                    // Download and attach supported media after the message is already durable.
                    const mediaUrl = await this.persistSupportedInboundMedia(msg);
                    if (mediaUrl && msg.key?.id) {
                        await postgresMessageWriter.attachInboundMedia(this.sessionId, msg.key.id, mediaUrl);
                    }

                    const webhookMessage = formatMessage(msg, mediaUrl);
                    dispatchWebhook({
                        sessionId: this.sessionId,
                        event: 'message',
                        data: webhookMessage
                    });
                    dispatchSessionWebhook({
                        sessionId: this.sessionId,
                        event: 'message',
                        data: webhookMessage
                    });
                }
            });

            return this.sock;
        } catch (err: any) {
            if (this.destroyed) {
                console.log(`[${this.sessionId}] Init aborted because session was deleted`);
                return;
            }
            this.lastError = `Initialization failed: ${err.message}`;
            console.error(`[${this.sessionId}] ${this.lastError}`);
            throw err;
        }
    }

    getQRCode() {
        return this.qr;
    }

    getMe(): { id: string; phone: string | null } | null {
        const id = this.sock?.user?.id;
        if (!id) return null;

        return {
            id,
            phone: this.extractPhoneNumber(id),
        };
    }

    getConnectedNumber(): string | null {
        return this.getMe()?.phone || null;
    }

    /**
     * Canonicalize a member identifier for exact group membership comparisons.
     * Raw numbers are normalized to PN JIDs; existing JIDs are preserved.
     */
    private canonicalizeMemberId(value: string | null | undefined): string | null {
        const raw = String(value || '').trim().toLowerCase();
        if (!raw) return null;

        if (raw.endsWith('@s.whatsapp.net') || raw.endsWith('@lid') || raw.endsWith('@g.us')) {
            return raw;
        }

        const digits = raw.replace(/[^\d]/g, '');
        if (!digits) return null;
        return `${digits}@s.whatsapp.net`;
    }

    private canonicalizeGroupParticipant(participant: { id?: string; phoneNumber?: string } | string): string | null {
        if (typeof participant === 'string') {
            return this.canonicalizeMemberId(participant);
        }

        return this.canonicalizeMemberId(participant.phoneNumber || participant.id || null);
    }

    private buildGroupMemberSet(group: GroupMetadata): Set<string> {
        const members = new Set<string>();

        for (const participant of group.participants || []) {
            const canonical = this.canonicalizeGroupParticipant(participant);
            if (canonical) members.add(canonical);
        }

        const owner = this.canonicalizeMemberId(group.ownerPn || group.owner || null);
        if (owner) members.add(owner);

        return members;
    }

    private buildRequestedMemberSet(participants: string[]): Set<string> {
        const members = new Set<string>();

        for (const participant of participants || []) {
            const canonical = this.canonicalizeMemberId(participant);
            if (canonical) members.add(canonical);
        }

        const me = this.getMe();
        const self = this.canonicalizeMemberId(me?.phone ? `${me.phone}@s.whatsapp.net` : me?.id || null);
        if (self) members.add(self);

        return members;
    }

    async findExistingGroupByParticipants(participants: string[]): Promise<GroupMetadata | null> {
        if (!this.sock?.user) {
            throw new Error('Session not connected');
        }

        const requestedMembers = this.buildRequestedMemberSet(participants);
        const existingGroups = await this.sock.groupFetchAllParticipating();

        for (const group of Object.values(existingGroups || {})) {
            const existingMembers = this.buildGroupMemberSet(group);
            if (existingMembers.size !== requestedMembers.size) continue;

            let isSame = true;
            for (const member of requestedMembers) {
                if (!existingMembers.has(member)) {
                    isSame = false;
                    break;
                }
            }

            if (isSame) {
                return group;
            }
        }

        return null;
    }

    async createGroupIfMissing(subject: string, participants: string[]): Promise<{ status: 'created' | 'duplicate'; group: GroupMetadata }> {
        if (!this.sock?.user) {
            throw new Error('Session not connected');
        }

        return this.groupCreateMutex.runExclusive(async () => {
            const existingGroup = await this.findExistingGroupByParticipants(participants);
            if (existingGroup) {
                return { status: 'duplicate', group: existingGroup };
            }

            const group = await this.sock!.groupCreate(subject, participants);
            return { status: 'created', group };
        });
    }

    async leaveGroup(groupJid: string): Promise<GroupMetadata> {
        if (!this.sock?.user) {
            throw new Error('Session not connected');
        }

        const group = await this.sock.groupMetadata(groupJid);
        await this.sock.groupLeave(group.id);
        return group;
    }

    forgetChat(jid: string) {
        const normalized = String(jid || '').trim();
        if (!normalized) return;

        this.chats.delete(normalized);
        this.messagesByChat.delete(normalized);
    }

    async logout() {
        if (this.sock) {
            await this.sock.logout();
            this.sock = undefined;
        }
    }

    async destroy() {
        this.destroyed = true;
        this.qr = undefined;
        this.lastError = undefined;
        this.chats.clear();
        this.messagesByChat.clear();
        this.lidToPn.clear();
        this.pnToLid.clear();

        if (this.sock) {
            try {
                await this.sock.logout();
            } catch (err) {
                console.error(`[${this.sessionId}] Error while destroying session:`, err);
            } finally {
                this.sock = undefined;
            }
        }
    }

    async getChats(limit: number = 100) {
        const items = Array.from(this.chats.values());
        items.sort((a, b) => this.getChatSortTimestamp(b) - this.getChatSortTimestamp(a));
        const selected = items.slice(0, limit);
        await this.hydrateMappingsForJids(selected.map(chat => chat.id));

        return selected.map(chat => ({
            id: chat.id,
            phoneNumber: this.extractPhoneNumber(this.resolvePhoneJid(chat.id) || chat.id),
            name: chat.name || chat.formattedName || null,
            unreadCount: chat.unreadCount || 0,
            archived: !!chat.archived,
            muteEndTime: chat.muteEndTime || null,
            isGroup: !!chat.isGroup,
            lastMessageTimestamp: this.getChatSortTimestamp(chat) || null,
        }));
    }

    async getChatMessages(jid: string, limit: number = 50, beforeTimestamp?: number) {
        await this.hydrateMappingsForJids([jid]);

        const lookupJids = this.resolveMessageLookupJids(jid);
        const combined = new Map<string, proto.IWebMessageInfo>();
        for (const lookupJid of lookupJids) {
            const map = this.messagesByChat.get(lookupJid);
            if (!map) continue;
            for (const [messageId, msg] of map.entries()) {
                combined.set(messageId, msg);
            }
        }

        if (!combined.size) return [];

        let items = Array.from(combined.values());
        items.sort((a, b) => this.messageTimestampMs(a) - this.messageTimestampMs(b));

        if (beforeTimestamp && Number.isFinite(beforeTimestamp)) {
            items = items.filter(msg => this.messageTimestampMs(msg) < beforeTimestamp);
        }

        if (items.length > limit) {
            items = items.slice(items.length - limit);
        }

        return items.map(msg => ({
            id: msg.key?.id || null,
            phoneNumber: this.extractPhoneNumber(this.resolveMessagePhoneJid(msg, jid) || jid),
            fromMe: !!msg.key?.fromMe,
            timestamp: this.messageTimestampMs(msg),
            type: msg.message ? Object.keys(msg.message)[0] : 'unknown',
            content: this.extractMessageText(msg),
        }));
    }

    private upsertChats(chats: any[]) {
        for (const chat of chats || []) {
            this.recordChatMapping(chat);
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
            const rawJid = msg.key?.remoteJid;
            if (!rawJid) continue;

            // Normalise LID → phone-number JID using the alt field when present
            const key = msg.key as any;
            this.recordMappingFromJids(rawJid, key?.remoteJidAlt);
            const cacheJids = this.resolveMessageLookupJids(rawJid, key?.remoteJidAlt);

            const messageId = msg.key?.id || `${this.messageTimestampMs(msg)}-${Math.random()}`;
            for (const jid of cacheJids) {
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
    }

    private resolveChatJid(chat: any): string | undefined {
        return chat?.id || chat?.jid;
    }

    private resolveMessageLookupJids(primary: string, alt?: string): string[] {
        const jids = new Set<string>();
        const normalizedPrimary = this.normalizeJid(primary);
        const normalizedAlt = this.normalizeJid(alt);

        if (normalizedPrimary) jids.add(normalizedPrimary);
        if (normalizedAlt) jids.add(normalizedAlt);

        const phoneJid = this.resolvePhoneJid(normalizedPrimary || primary) || this.resolvePhoneJid(normalizedAlt || alt || '');
        const lidJid = this.resolveLidJid(normalizedPrimary || primary) || this.resolveLidJid(normalizedAlt || alt || '');

        if (phoneJid) jids.add(phoneJid);
        if (lidJid) jids.add(lidJid);

        return Array.from(jids);
    }

    private recordContactMappings(contacts: any[]) {
        for (const contact of contacts || []) {
            this.recordChatMapping(contact);
        }
    }

    private recordChatMapping(value: any) {
        const id = this.normalizeJid(value?.id || value?.jid);
        const lid = this.normalizeLidJid(value?.lid || value?.lidJid || value?.accountLid);
        const pn = this.normalizePnJid(value?.phoneNumber || value?.pnJid);

        this.recordMappingFromJids(id, pn || lid || undefined);
        this.recordMappingFromJids(lid || undefined, pn || id || undefined);
    }

    private recordLidMappings(mappings: LIDMapping[]) {
        for (const mapping of mappings || []) {
            this.recordLidMapping(mapping);
        }
    }

    private recordLidMapping(mapping?: Partial<LIDMapping> | null) {
        if (!mapping) return;
        const lid = this.normalizeLidJid(mapping.lid);
        const pn = this.normalizePnJid(mapping.pn);
        if (!lid || !pn) return;

        this.lidToPn.set(lid, pn);
        this.pnToLid.set(pn, lid);
    }

    private recordMappingFromJids(a?: string | null, b?: string | null) {
        const first = this.normalizeJid(a);
        const second = this.normalizeJid(b);
        if (!first || !second) return;

        const lid = this.normalizeLidJid(first) || this.normalizeLidJid(second);
        const pn = this.normalizePnJid(first) || this.normalizePnJid(second);
        if (lid && pn) {
            this.recordLidMapping({ lid, pn });
        }
    }

    private async hydrateMappingsForJids(jids: Array<string | undefined | null>) {
        const lidMapping = (this.sock as any)?.signalRepository?.lidMapping;
        if (!lidMapping) return;

        const lids = Array.from(new Set(
            jids
                .map(jid => this.normalizeLidJid(jid))
                .filter((jid): jid is string => !!jid && !this.lidToPn.has(jid))
        ));
        const pns = Array.from(new Set(
            jids
                .map(jid => this.normalizePnJid(jid))
                .filter((jid): jid is string => !!jid && !this.pnToLid.has(jid))
        ));

        try {
            if (lids.length > 0) {
                const mappings = await lidMapping.getPNsForLIDs(lids);
                this.recordLidMappings(mappings || []);
            }
            if (pns.length > 0) {
                const mappings = await lidMapping.getLIDsForPNs(pns);
                this.recordLidMappings(mappings || []);
            }
        } catch (err: any) {
            console.warn(`[${this.sessionId}] Failed to hydrate LID mapping: ${err.message}`);
        }
    }

    private resolvePhoneJid(jid?: string | null): string | null {
        const normalized = this.normalizeJid(jid);
        if (!normalized) return null;

        const pn = this.normalizePnJid(normalized);
        if (pn) return pn;

        const lid = this.normalizeLidJid(normalized);
        return lid ? this.lidToPn.get(lid) || null : null;
    }

    private resolveLidJid(jid?: string | null): string | null {
        const normalized = this.normalizeJid(jid);
        if (!normalized) return null;

        const lid = this.normalizeLidJid(normalized);
        if (lid) return lid;

        const pn = this.normalizePnJid(normalized);
        return pn ? this.pnToLid.get(pn) || null : null;
    }

    private resolveMessagePhoneJid(msg: proto.IWebMessageInfo, fallbackJid?: string): string | null {
        const key = msg.key as any;
        return this.resolvePhoneJid(key?.remoteJid)
            || this.resolvePhoneJid(key?.remoteJidAlt)
            || this.resolvePhoneJid(fallbackJid);
    }

    private async resolveInboundSenderPhoneJid(msg: proto.IWebMessageInfo): Promise<string | null> {
        const key = msg.key as any;
        this.recordMappingFromJids(key?.remoteJid, key?.remoteJidAlt);

        let phoneJid = this.resolveMessagePhoneJid(msg);
        if (phoneJid) return phoneJid;

        await this.hydrateMappingsForJids([key?.remoteJid, key?.remoteJidAlt]);
        phoneJid = this.resolveMessagePhoneJid(msg);

        if (phoneJid) {
            key.remoteJidAlt = key.remoteJidAlt || phoneJid;
        }

        return phoneJid;
    }

    private normalizeJid(jid?: string | null): string | null {
        const raw = String(jid || '').trim().toLowerCase();
        return raw || null;
    }

    private normalizePnJid(jid?: string | null): string | null {
        const normalized = this.normalizeJid(jid);
        if (!normalized) return null;

        if (normalized.endsWith('@s.whatsapp.net')) {
            return normalized;
        }

        if (normalized.includes('@')) {
            return null;
        }

        const digits = normalized.replace(/[^\d]/g, '');
        return digits ? `${digits}@s.whatsapp.net` : null;
    }

    private normalizeLidJid(jid?: string | null): string | null {
        const normalized = this.normalizeJid(jid);
        if (!normalized) return null;
        return normalized.endsWith('@lid') ? normalized : null;
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
            const mediaDir = path.join(MEDIA_BASE_DIR, mediaMeta.kind);
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
