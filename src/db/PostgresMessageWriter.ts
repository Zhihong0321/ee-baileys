import { proto } from '@whiskeysockets/baileys';

type PgQueryable = {
    query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
};

type PgClient = PgQueryable & {
    release: () => void;
};

type PgPool = PgQueryable & {
    connect: () => Promise<PgClient>;
};

interface SessionInfo {
    channelSessionId: number;
    tenantId: number;
}

interface InboundInboxRow {
    id: number;
    session_identifier: string;
    external_message_id: string;
    sender_jid: string;
    sender_phone: string | null;
    recipient_phone: string | null;
    message_type: string | null;
    raw_payload: proto.IWebMessageInfo | string;
    media_url: string | null;
    process_status: string;
    process_attempts: number;
    last_error: string | null;
}

class PostgresMessageWriter {
    private pool?: PgPool;
    private sessionCache = new Map<string, SessionInfo | null>();
    private warnedMissingPg = false;
    private warnedMissingDbUrl = false;
    private inboxSchemaReady?: Promise<void>;
    private inboxDrainTimer?: NodeJS.Timeout;
    private drainingInbox = false;

    private getPool(): PgPool | undefined {
        const databaseUrl = process.env.DATABASE_URL;
        if (!databaseUrl) {
            if (!this.warnedMissingDbUrl) {
                this.warnedMissingDbUrl = true;
                console.warn('[Postgres] DATABASE_URL is not set. DB writes are disabled.');
            }
            return undefined;
        }

        if (this.pool) return this.pool;

        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { Pool } = require('pg');
            this.pool = new Pool({ connectionString: databaseUrl }) as PgPool;
            return this.pool;
        } catch (err: any) {
            if (!this.warnedMissingPg) {
                this.warnedMissingPg = true;
                console.error('[Postgres] Package "pg" is not installed. Run: npm install pg');
            }
            return undefined;
        }
    }

    private async ensureInboxSchema(): Promise<void> {
        const pool = this.getPool();
        if (!pool) return;

        if (!this.inboxSchemaReady) {
            this.inboxSchemaReady = (async () => {
                const sql = `
                    CREATE TABLE IF NOT EXISTS wa_inbound_inbox (
                        id BIGSERIAL PRIMARY KEY,
                        session_identifier VARCHAR(255) NOT NULL,
                        external_message_id VARCHAR(255) NOT NULL,
                        sender_jid VARCHAR(255) NOT NULL,
                        sender_phone VARCHAR(64),
                        recipient_phone VARCHAR(64),
                        message_type VARCHAR(50),
                        raw_payload JSONB NOT NULL,
                        media_url TEXT,
                        process_status VARCHAR(20) NOT NULL DEFAULT 'pending',
                        process_attempts INTEGER NOT NULL DEFAULT 0,
                        last_error TEXT,
                        last_error_at TIMESTAMP,
                        processed_at TIMESTAMP,
                        locked_at TIMESTAMP,
                        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        CONSTRAINT uq_wa_inbound_inbox_session_message UNIQUE (session_identifier, external_message_id)
                    );

                    CREATE INDEX IF NOT EXISTS idx_wa_inbox_status_created
                        ON wa_inbound_inbox (process_status, created_at);

                    CREATE INDEX IF NOT EXISTS idx_wa_inbox_locked_at
                        ON wa_inbound_inbox (locked_at);
                `;

                await pool.query(sql);
            })().catch(err => {
                this.inboxSchemaReady = undefined;
                throw err;
            });
        }

        await this.inboxSchemaReady;
    }

    /**
     * Resolve tenant_id and channel_session_id from et_channel_sessions.
     * Results are cached per sessionId since session mappings don't change at runtime.
     */
    private async resolveSession(queryable: PgQueryable, sessionId: string): Promise<SessionInfo | null> {
        if (this.sessionCache.has(sessionId)) {
            return this.sessionCache.get(sessionId)!;
        }

        const sql = `
            SELECT id, tenant_id
            FROM et_channel_sessions
            WHERE channel_type = 'WHATSAPP'
              AND session_identifier = $1
            LIMIT 1
        `;

        const result = await queryable.query(sql, [sessionId]);

        if (result.rows.length === 0) {
            this.sessionCache.set(sessionId, null);
            return null;
        }

        const info: SessionInfo = {
            channelSessionId: result.rows[0].id,
            tenantId: result.rows[0].tenant_id,
        };
        this.sessionCache.set(sessionId, info);
        return info;
    }

    /**
     * Resolve lead_id from et_leads.
     *
     * Match order:
     * 1. whatsapp_lid from the inbound message (when present)
     * 2. phone digits extracted from a phone-number JID (@s.whatsapp.net)
     */
    private async resolveLead(queryable: PgQueryable, tenantId: number, senderJid: string, msg?: proto.IWebMessageInfo): Promise<number | null> {
        const lidCandidates = this.extractLidCandidates(msg, senderJid);
        if (lidCandidates.length > 0) {
            const lidSql = `
                SELECT id
                FROM et_leads
                WHERE tenant_id = $1
                  AND whatsapp_lid = ANY($2::varchar[])
                ORDER BY id ASC
                LIMIT 1
            `;

            const lidResult = await queryable.query(lidSql, [tenantId, lidCandidates]);
            if (lidResult.rows.length > 0) {
                return lidResult.rows[0].id;
            }
        }

        const digits = this.extractPhoneDigitsFromJid(senderJid);
        if (!digits) return null;

        const sql = `
            SELECT id
            FROM et_leads
            WHERE tenant_id = $1
              AND regexp_replace(external_id, '\\D', '', 'g') = $2
            ORDER BY id ASC
            LIMIT 1
        `;

        const result = await queryable.query(sql, [tenantId, digits]);
        return result.rows.length > 0 ? result.rows[0].id : null;
    }

    private async resolveOrCreateInboundLead(queryable: PgQueryable, tenantId: number, senderJid: string, msg: proto.IWebMessageInfo): Promise<number | null> {
        let leadId = await this.resolveLead(queryable, tenantId, senderJid, msg);
        if (leadId !== null) {
            await this.syncLeadWhatsAppIdentity(queryable, tenantId, leadId, msg, senderJid);
            return leadId;
        }

        const senderPhone = this.extractPhoneDigitsFromJid(senderJid);
        if (!senderPhone) {
            return null;
        }

        await queryable.query('LOCK TABLE et_leads IN SHARE ROW EXCLUSIVE MODE');

        leadId = await this.resolveLead(queryable, tenantId, senderJid, msg);
        if (leadId !== null) {
            await this.syncLeadWhatsAppIdentity(queryable, tenantId, leadId, msg, senderJid);
            return leadId;
        }

        const leadName = this.resolveInboundLeadName(msg, senderPhone);
        const whatsappLid = this.extractLidCandidates(msg, senderJid)[0] || null;

        const insertSql = `
            INSERT INTO et_leads (
                tenant_id,
                external_id,
                name,
                stage,
                whatsapp_lid,
                is_whatsapp_valid,
                last_verify_at,
                created_at
            ) VALUES (
                $1,
                $2,
                $3,
                'NEW',
                $4,
                TRUE,
                NOW(),
                NOW()
            )
            RETURNING id
        `;

        const insertResult = await queryable.query(insertSql, [
            tenantId,
            senderPhone,
            leadName,
            whatsappLid,
        ]);

        return insertResult.rows.length > 0 ? insertResult.rows[0].id : null;
    }

    private async syncLeadWhatsAppIdentity(queryable: PgQueryable, tenantId: number, leadId: number, msg: proto.IWebMessageInfo, senderJid: string): Promise<void> {
        const whatsappLid = this.extractLidCandidates(msg, senderJid)[0] || null;
        const sql = `
            UPDATE et_leads
            SET
                whatsapp_lid = COALESCE(whatsapp_lid, $3),
                is_whatsapp_valid = TRUE,
                last_verify_at = NOW()
            WHERE tenant_id = $1
              AND id = $2
        `;

        await queryable.query(sql, [tenantId, leadId, whatsappLid]);
    }

    private extractLidCandidates(msg?: proto.IWebMessageInfo, senderJid?: string): string[] {
        const key = (msg?.key || {}) as any;
        const rawCandidates = [
            senderJid,
            key.remoteJid,
            key.remoteJidAlt,
            key.participant,
            key.participantAlt,
        ];

        return Array.from(new Set(
            rawCandidates.filter((value): value is string => typeof value === 'string' && value.endsWith('@lid'))
        ));
    }

    private extractPhoneDigitsFromJid(jid?: string | null): string | null {
        if (!jid || !jid.endsWith('@s.whatsapp.net')) {
            return null;
        }

        const userPart = jid.split('@')[0].split(':')[0];
        const digits = userPart.replace(/\D/g, '');
        return digits || null;
    }

    private resolveInboundLeadName(msg: proto.IWebMessageInfo, senderPhone: string): string {
        const pushName = (msg.pushName || '').trim();
        if (pushName) {
            return pushName;
        }
        return `Prospect ${senderPhone}`;
    }

    private normalizeRawMessage(raw: proto.IWebMessageInfo | string): proto.IWebMessageInfo {
        if (typeof raw === 'string') {
            return JSON.parse(raw) as proto.IWebMessageInfo;
        }
        return raw;
    }

    private async upsertInboundEtMessage(
        queryable: PgQueryable,
        session: SessionInfo,
        leadId: number,
        msg: proto.IWebMessageInfo,
        senderJid: string,
        mediaUrl?: string | null,
        recipientPhone?: string | null
    ): Promise<void> {
        const messageId = msg.key?.id;
        if (!messageId) {
            throw new Error('Inbound message is missing key.id');
        }

        const messageType = this.resolveMessageType(msg);
        const textContent = this.resolveTextContent(msg);
        const resolvedMediaUrl = mediaUrl ?? null;
        const senderPhone = this.extractPhoneDigitsFromJid(senderJid);
        const resolvedRecipientPhone = recipientPhone ?? null;

        const sql = `
            INSERT INTO et_messages (
                tenant_id, lead_id, thread_id, channel_session_id,
                channel, external_message_id, direction, message_type,
                text_content, media_url, raw_payload, delivery_status,
                sender_phone, recipient_phone,
                created_at, updated_at
            ) VALUES (
                $1, $2, NULL, $3,
                'whatsapp', $4, 'inbound', $5,
                $6, $7, $8::jsonb, 'received',
                $9, $10,
                NOW(), NOW()
            )
            ON CONFLICT (tenant_id, channel, external_message_id)
            DO UPDATE SET
                lead_id = EXCLUDED.lead_id,
                channel_session_id = EXCLUDED.channel_session_id,
                message_type = EXCLUDED.message_type,
                text_content = EXCLUDED.text_content,
                media_url = COALESCE(EXCLUDED.media_url, et_messages.media_url),
                raw_payload = EXCLUDED.raw_payload,
                sender_phone = EXCLUDED.sender_phone,
                recipient_phone = EXCLUDED.recipient_phone,
                updated_at = NOW()
        `;

        await queryable.query(sql, [
            session.tenantId,
            leadId,
            session.channelSessionId,
            messageId,
            messageType,
            textContent,
            resolvedMediaUrl,
            JSON.stringify(msg),
            senderPhone,
            resolvedRecipientPhone,
        ]);
    }

    private async enqueueInboundInboxMessage(
        sessionId: string,
        msg: proto.IWebMessageInfo,
        senderJid: string,
        recipientPhone?: string | null
    ): Promise<void> {
        const pool = this.getPool();
        if (!pool) return;

        const messageId = msg.key?.id;
        if (!messageId) return;

        await this.ensureInboxSchema();

        const senderPhone = this.extractPhoneDigitsFromJid(senderJid);
        const messageType = this.resolveMessageType(msg);

        const sql = `
            INSERT INTO wa_inbound_inbox (
                session_identifier,
                external_message_id,
                sender_jid,
                sender_phone,
                recipient_phone,
                message_type,
                raw_payload,
                process_status,
                process_attempts,
                updated_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7::jsonb, 'pending', 0, NOW()
            )
            ON CONFLICT (session_identifier, external_message_id)
            DO UPDATE SET
                sender_jid = EXCLUDED.sender_jid,
                sender_phone = EXCLUDED.sender_phone,
                recipient_phone = EXCLUDED.recipient_phone,
                message_type = EXCLUDED.message_type,
                raw_payload = EXCLUDED.raw_payload,
                process_status = CASE
                    WHEN wa_inbound_inbox.process_status = 'processed' THEN wa_inbound_inbox.process_status
                    ELSE 'pending'
                END,
                last_error = CASE
                    WHEN wa_inbound_inbox.process_status = 'processed' THEN wa_inbound_inbox.last_error
                    ELSE NULL
                END,
                last_error_at = CASE
                    WHEN wa_inbound_inbox.process_status = 'processed' THEN wa_inbound_inbox.last_error_at
                    ELSE NULL
                END,
                locked_at = NULL,
                updated_at = NOW()
        `;

        await pool.query(sql, [
            sessionId,
            messageId,
            senderJid,
            senderPhone,
            recipientPhone ?? null,
            messageType,
            JSON.stringify(msg),
        ]);
    }

    private async claimSpecificInboundInboxMessage(sessionId: string, messageId: string): Promise<InboundInboxRow | null> {
        const pool = this.getPool();
        if (!pool) return null;

        const sql = `
            WITH target AS (
                SELECT id
                FROM wa_inbound_inbox
                WHERE session_identifier = $1
                  AND external_message_id = $2
                  AND process_status <> 'processed'
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            )
            UPDATE wa_inbound_inbox inbox
            SET
                process_status = 'processing',
                process_attempts = inbox.process_attempts + 1,
                locked_at = NOW(),
                updated_at = NOW()
            FROM target
            WHERE inbox.id = target.id
            RETURNING inbox.*
        `;

        const result = await pool.query(sql, [sessionId, messageId]);
        return result.rows.length > 0 ? result.rows[0] as InboundInboxRow : null;
    }

    private async claimNextInboundInboxMessage(): Promise<InboundInboxRow | null> {
        const pool = this.getPool();
        if (!pool) return null;

        const sql = `
            WITH target AS (
                SELECT id
                FROM wa_inbound_inbox
                WHERE process_status IN ('pending', 'failed')
                  AND (locked_at IS NULL OR locked_at < NOW() - INTERVAL '5 minutes')
                ORDER BY created_at ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            )
            UPDATE wa_inbound_inbox inbox
            SET
                process_status = 'processing',
                process_attempts = inbox.process_attempts + 1,
                locked_at = NOW(),
                updated_at = NOW()
            FROM target
            WHERE inbox.id = target.id
            RETURNING inbox.*
        `;

        const result = await pool.query(sql);
        return result.rows.length > 0 ? result.rows[0] as InboundInboxRow : null;
    }

    private async markInboxMessageProcessed(queryable: PgQueryable, inboxId: number): Promise<void> {
        const sql = `
            UPDATE wa_inbound_inbox
            SET
                process_status = 'processed',
                processed_at = NOW(),
                last_error = NULL,
                last_error_at = NULL,
                locked_at = NULL,
                updated_at = NOW()
            WHERE id = $1
        `;

        await queryable.query(sql, [inboxId]);
    }

    private async markInboxMessageFailed(inboxId: number, errorMessage: string): Promise<void> {
        const pool = this.getPool();
        if (!pool) return;

        const sql = `
            UPDATE wa_inbound_inbox
            SET
                process_status = 'failed',
                last_error = $2,
                last_error_at = NOW(),
                locked_at = NULL,
                updated_at = NOW()
            WHERE id = $1
        `;

        await pool.query(sql, [inboxId, errorMessage.slice(0, 2000)]);
    }

    private async processClaimedInboundInboxMessage(row: InboundInboxRow): Promise<void> {
        const pool = this.getPool();
        if (!pool) return;

        const msg = this.normalizeRawMessage(row.raw_payload);
        let client: PgClient | undefined;

        try {
            client = await pool.connect();
            await client.query('BEGIN');

            const session = await this.resolveSession(client, row.session_identifier);
            if (!session) {
                throw new Error(`Session not found: ${row.session_identifier}`);
            }

            const leadId = await this.resolveOrCreateInboundLead(client, session.tenantId, row.sender_jid, msg);
            if (leadId === null) {
                throw new Error(`Lead could not be resolved or created for ${row.sender_jid}`);
            }

            await this.upsertInboundEtMessage(
                client,
                session,
                leadId,
                msg,
                row.sender_jid,
                row.media_url,
                row.recipient_phone
            );

            await this.markInboxMessageProcessed(client, row.id);
            await client.query('COMMIT');

            console.log(`[Postgres] Processed inbound inbox ${row.external_message_id} (session=${row.session_identifier}, lead=${leadId})`);
        } catch (err: any) {
            try {
                if (client) {
                    await client.query('ROLLBACK');
                }
            } catch {
                // no-op
            }

            const message = err?.message || String(err);
            await this.markInboxMessageFailed(row.id, message);
            console.error(`[Postgres] Failed processing inbound inbox ${row.external_message_id}: ${message}`);
        } finally {
            client?.release();
        }
    }

    private async processSpecificInboundInboxMessage(sessionId: string, messageId: string): Promise<void> {
        await this.ensureInboxSchema();
        const row = await this.claimSpecificInboundInboxMessage(sessionId, messageId);
        if (!row) return;
        await this.processClaimedInboundInboxMessage(row);
    }

    private async drainInboundInbox(limit: number = 10): Promise<void> {
        if (this.drainingInbox) return;

        const pool = this.getPool();
        if (!pool) return;

        await this.ensureInboxSchema();
        this.drainingInbox = true;

        try {
            for (let i = 0; i < limit; i++) {
                const row = await this.claimNextInboundInboxMessage();
                if (!row) break;
                await this.processClaimedInboundInboxMessage(row);
            }
        } finally {
            this.drainingInbox = false;
        }
    }

    startInboundInboxProcessor(intervalMs?: number): void {
        if (this.inboxDrainTimer) return;

        const configured = Number(process.env.INBOUND_INBOX_RETRY_INTERVAL_MS || 5000);
        const effectiveInterval = Number.isFinite(intervalMs) && intervalMs && intervalMs > 0
            ? intervalMs
            : (Number.isFinite(configured) && configured > 0 ? configured : 5000);

        this.ensureInboxSchema().catch(err => {
            console.error(`[Postgres] Failed ensuring inbound inbox schema: ${err.message}`);
        });

        void this.drainInboundInbox();
        this.inboxDrainTimer = setInterval(() => {
            void this.drainInboundInbox();
        }, effectiveInterval);
    }

    async attachInboundMedia(sessionId: string, messageId: string, mediaUrl: string): Promise<void> {
        const pool = this.getPool();
        if (!pool || !messageId || !mediaUrl) return;

        await this.ensureInboxSchema();

        await pool.query(`
            UPDATE wa_inbound_inbox
            SET media_url = $3,
                updated_at = NOW()
            WHERE session_identifier = $1
              AND external_message_id = $2
        `, [sessionId, messageId, mediaUrl]);

        const session = await this.resolveSession(pool, sessionId);
        if (!session) return;

        await pool.query(`
            UPDATE et_messages
            SET media_url = COALESCE($3, media_url),
                updated_at = NOW()
            WHERE tenant_id = $1
              AND channel = 'whatsapp'
              AND external_message_id = $2
        `, [session.tenantId, messageId, mediaUrl]);
    }

    /**
     * Store an inbound WhatsApp message durably before enrichment.
     *
     * @param sessionId      - The Baileys session identifier (maps to et_channel_sessions)
     * @param msg            - Raw Baileys message object
     * @param senderJid      - Always a phone-number JID (@s.whatsapp.net), resolved by Instance.ts
     * @param mediaUrl       - Optional HTTP URL for media discovered after durable queueing
     * @param recipientPhone - Plain phone number of the logged-in WA account (sock.user.id digits)
     */
    async storeInboundMessage(sessionId: string, msg: proto.IWebMessageInfo, senderJid: string, mediaUrl?: string | null, recipientPhone?: string | null): Promise<void> {
        const messageId = msg.key?.id;
        if (!messageId || !senderJid) return;

        try {
            await this.enqueueInboundInboxMessage(sessionId, msg, senderJid, recipientPhone);
            await this.processSpecificInboundInboxMessage(sessionId, messageId);

            if (mediaUrl) {
                await this.attachInboundMedia(sessionId, messageId, mediaUrl);
            }
        } catch (err: any) {
            console.error(`[Postgres] Failed to queue inbound message ${messageId}: ${err.message}`);
        }
    }

    private resolveMessageType(msg: proto.IWebMessageInfo): string {
        const message = msg.message;
        if (!message) return 'unknown';

        if (message.conversation || message.extendedTextMessage) return 'text';
        if (message.imageMessage) return 'image';
        if (message.videoMessage) return 'video';
        if (message.audioMessage) return 'audio';
        if (message.documentMessage) return 'document';
        if (message.stickerMessage) return 'sticker';
        if (message.reactionMessage) return 'reaction';

        const key = Object.keys(message)[0];
        return key || 'unknown';
    }

    /**
     * Store an outbound WhatsApp message into et_messages.
     *
     * @param sessionId      - The Baileys session identifier (maps to et_channel_sessions)
     * @param msg            - Result from sock.sendMessage
     * @param recipientJid   - The JID of the contact being sent to
     * @param mediaUrl       - Optional media URL that was sent
     */
    async storeOutboundMessage(sessionId: string, msg: proto.IWebMessageInfo, recipientJid: string, mediaUrl?: string | null): Promise<void> {
        const pool = this.getPool();
        if (!pool) return;

        const messageId = msg.key?.id;
        if (!messageId || !recipientJid) return;

        const session = await this.resolveSession(pool, sessionId);
        if (!session) return;

        const leadId = await this.resolveLead(pool, session.tenantId, recipientJid);
        if (leadId === null) return;

        const messageType = this.resolveMessageType(msg);
        const textContent = this.resolveTextContent(msg);
        const resolvedMediaUrl = mediaUrl || null;
        const recipientPhone = this.extractPhoneDigitsFromJid(recipientJid);

        const sql = `
            INSERT INTO et_messages (
                tenant_id, lead_id, thread_id, channel_session_id,
                channel, external_message_id, direction, message_type,
                text_content, media_url, raw_payload, delivery_status,
                recipient_phone,
                created_at, updated_at
            ) VALUES (
                $1, $2, NULL, $3,
                'whatsapp', $4, 'outbound', $5,
                $6, $7, $8::jsonb, 'sent',
                $9,
                NOW(), NOW()
            )
            ON CONFLICT (tenant_id, channel, external_message_id)
            DO NOTHING
        `;

        try {
            await pool.query(sql, [
                session.tenantId,
                leadId,
                session.channelSessionId,
                messageId,
                messageType,
                textContent,
                resolvedMediaUrl,
                JSON.stringify(msg),
                recipientPhone,
            ]);
            console.log(`[Postgres] Stored outbound message ${messageId}`);
        } catch (err: any) {
            console.error(`[Postgres] Failed to store outbound message ${messageId}: ${err.message}`);
        }
    }

    private resolveTextContent(msg: proto.IWebMessageInfo): string | null {
        const message = msg.message;
        if (!message) return null;

        return (
            message.conversation ||
            message.extendedTextMessage?.text ||
            message.imageMessage?.caption ||
            message.videoMessage?.caption ||
            null
        );
    }
}

export const postgresMessageWriter = new PostgresMessageWriter();
