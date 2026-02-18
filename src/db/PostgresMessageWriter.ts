import { proto } from '@whiskeysockets/baileys';

type PgPool = {
    query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
};

interface SessionInfo {
    channelSessionId: number;
    tenantId: number;
}

class PostgresMessageWriter {
    private pool?: PgPool;
    private sessionCache = new Map<string, SessionInfo | null>();
    private warnedMissingPg = false;
    private warnedMissingDbUrl = false;

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

    /**
     * Resolve tenant_id and channel_session_id from et_channel_sessions.
     * Results are cached per sessionId since session mappings don't change at runtime.
     */
    private async resolveSession(pool: PgPool, sessionId: string): Promise<SessionInfo | null> {
        if (this.sessionCache.has(sessionId)) {
            return this.sessionCache.get(sessionId)!;
        }

        const sql = `
            SELECT id, tenant_id
            FROM et_channel_sessions
            WHERE channel_type = 'whatsapp'
              AND session_identifier = $1
            LIMIT 1
        `;

        const result = await pool.query(sql, [sessionId]);

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
     * Resolve lead_id from et_leads by matching normalized phone digits within the tenant.
     */
    private async resolveLead(pool: PgPool, tenantId: number, remoteJid: string): Promise<number | null> {
        const digits = remoteJid.split('@')[0].replace(/\D/g, '');
        if (!digits) return null;

        const sql = `
            SELECT id
            FROM et_leads
            WHERE tenant_id = $1
              AND regexp_replace(external_id, '\\D', '', 'g') = $2
            ORDER BY id ASC
            LIMIT 1
        `;

        const result = await pool.query(sql, [tenantId, digits]);
        return result.rows.length > 0 ? result.rows[0].id : null;
    }

    async storeInboundMessage(sessionId: string, msg: proto.IWebMessageInfo): Promise<void> {
        const pool = this.getPool();
        if (!pool) return;

        const messageId = msg.key?.id;
        const remoteJid = msg.key?.remoteJid;
        if (!messageId || !remoteJid) return;

        // 1. Resolve session → tenant_id + channel_session_id
        const session = await this.resolveSession(pool, sessionId);
        if (!session) {
            console.error('[Postgres] Session not found in et_channel_sessions', {
                sessionId,
                messageKey: msg.key?.id,
                remoteJid,
            });
            return;
        }

        // 2. Resolve lead within tenant
        const senderJid = msg.key?.participant || remoteJid;
        const leadId = await this.resolveLead(pool, session.tenantId, senderJid);
        if (leadId === null) {
            console.warn('[Postgres] Lead not found in et_leads', {
                tenant_id: session.tenantId,
                sessionId,
                remoteJid: senderJid,
                messageKey: msg.key?.id,
            });
            return;
        }

        // 3. Build external_message_id
        const externalMessageId = messageId;

        const messageType = this.resolveMessageType(msg);
        const textContent = this.resolveTextContent(msg);
        const mediaUrl = null;

        // 4. Upsert into et_messages
        const sql = `
            INSERT INTO et_messages (
                tenant_id, lead_id, thread_id, channel_session_id,
                channel, external_message_id, direction, message_type,
                text_content, media_url, raw_payload, delivery_status,
                created_at, updated_at
            ) VALUES (
                $1, $2, NULL, $3,
                'whatsapp', $4, 'inbound', $5,
                $6, $7, $8::jsonb, 'received',
                NOW(), NOW()
            )
            ON CONFLICT (tenant_id, channel, external_message_id)
            DO UPDATE SET
                raw_payload = EXCLUDED.raw_payload,
                updated_at = NOW()
        `;

        try {
            const result = await pool.query(sql, [
                session.tenantId,
                leadId,
                session.channelSessionId,
                externalMessageId,
                messageType,
                textContent,
                mediaUrl,
                JSON.stringify(msg),
            ]);

            console.log(`[Postgres] Stored inbound message ${externalMessageId} (tenant=${session.tenantId}, lead=${leadId}, session=${session.channelSessionId})`);
        } catch (err: any) {
            console.error(`[Postgres] Failed to store inbound message ${externalMessageId}: ${err.message}`);
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
