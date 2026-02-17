import { proto } from '@whiskeysockets/baileys';

type PgPool = {
    query: (text: string, params?: unknown[]) => Promise<{ rowCount: number }>;
};

class PostgresMessageWriter {
    private pool?: PgPool;
    private warnedMissingTenant = false;
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
            // Use require so the app still boots even when pg is not installed yet.
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

    async storeInboundMessage(sessionId: string, msg: proto.IWebMessageInfo): Promise<void> {
        const pool = this.getPool();
        if (!pool) return;

        const messageId = msg.key?.id;
        const remoteJid = msg.key?.remoteJid;
        if (!messageId || !remoteJid) return;

        const tenantId = this.resolveTenantId(sessionId);
        if (tenantId === null) {
            if (!this.warnedMissingTenant) {
                this.warnedMissingTenant = true;
                console.warn('[Postgres] Tenant ID not resolved. Set DEFAULT_TENANT_ID or use numeric sessionId prefix like "101:my-session".');
            }
            return;
        }

        const senderJid = msg.key?.participant || remoteJid;
        const leadId = this.resolveLeadId(senderJid);
        const timestamp = this.resolveTimestampMs(msg.messageTimestamp);
        const messageType = this.resolveMessageType(msg);
        const textContent = this.resolveTextContent(msg);
        const mediaUrl = null;

        const sql = `
            INSERT INTO et_messages (
                tenant_id,
                lead_id,
                channel,
                message_id,
                timestamp,
                direction,
                message_type,
                text_content,
                media_url,
                raw_json
            ) VALUES ($1, $2, 'whatsapp', $3, $4, 'inbound', $5, $6, $7, $8::jsonb)
            ON CONFLICT (channel, lead_id, message_id) DO NOTHING
        `;

        try {
            const result = await pool.query(sql, [
                tenantId,
                leadId,
                messageId,
                timestamp,
                messageType,
                textContent,
                mediaUrl,
                JSON.stringify(msg),
            ]);

            if (result.rowCount === 0) {
                return;
            }

            console.log(`[Postgres] Stored inbound message ${messageId} (tenant=${tenantId}, lead=${leadId})`);
        } catch (err: any) {
            console.error(`[Postgres] Failed to store inbound message ${messageId}: ${err.message}`);
        }
    }

    private resolveTenantId(sessionId: string): number | null {
        const envTenant = process.env.DEFAULT_TENANT_ID;
        if (envTenant && /^\d+$/.test(envTenant)) {
            return Number(envTenant);
        }

        const prefix = sessionId.split(':')[0];
        if (/^\d+$/.test(prefix)) {
            return Number(prefix);
        }

        return null;
    }

    private resolveLeadId(jid: string): number {
        const digits = jid.split('@')[0].replace(/\D/g, '');
        if (digits && Number(digits) <= 2147483647) {
            return Number(digits);
        }
        return this.hashToInt32(jid);
    }

    private hashToInt32(input: string): number {
        let hash = 0;
        for (let i = 0; i < input.length; i++) {
            hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
        }
        const positive = Math.abs(hash);
        return positive === 0 ? 1 : positive;
    }

    private resolveTimestampMs(value: unknown): number {
        if (typeof value === 'number') {
            return value > 1_000_000_000_000 ? value : value * 1000;
        }

        if (typeof value === 'string') {
            const n = Number(value);
            if (!Number.isNaN(n)) return n > 1_000_000_000_000 ? n : n * 1000;
        }

        if (value && typeof value === 'object') {
            const maybeToNumber = (value as { toNumber?: () => number }).toNumber;
            if (typeof maybeToNumber === 'function') {
                const n = maybeToNumber();
                return n > 1_000_000_000_000 ? n : n * 1000;
            }
        }

        return Date.now();
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
