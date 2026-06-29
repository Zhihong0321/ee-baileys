// In-memory ring buffer of every webhook dispatch attempt.
//
// Records each outbound webhook fire (session webhook, global webhook, OTP webhook)
// with the full request payload, HTTP response/error details, and a compact summary
// for dashboard scanning. Resets on restart - this is a live activity log, not an
// audit trail.

export interface WebhookLogEntry {
    id: number;
    at: string;
    kind: 'session' | 'global' | 'otp';
    sessionId: string | null;
    url: string;
    from: string | null;
    event: string | null;
    contentPreview: string | null;
    ok: boolean;
    status: number | null;
    durationMs: number | null;
    error: string | null;
    request: WebhookLogRequest | null;
    response: WebhookLogResponse | null;
    errorDetails: WebhookLogError | null;
}

export interface WebhookLogRequest {
    method: 'POST';
    url: string;
    headers: Record<string, string>;
    body: unknown;
}

export interface WebhookLogResponse {
    status: number;
    statusText: string | null;
    headers: Record<string, unknown>;
    body: unknown;
}

export interface WebhookLogError {
    name: string | null;
    message: string;
    code: string | null;
    stack: string | null;
    response: WebhookLogResponse | null;
}

export interface WebhookLogFilters {
    limit?: number;
    kind?: WebhookLogEntry['kind'];
    sessionId?: string;
    ok?: boolean;
}

const MAX_ENTRIES = 500;
const MAX_SERIALIZED_CHARS = 80_000;
const entries: WebhookLogEntry[] = [];
let nextId = 1;

export function recordWebhook(entry: Omit<WebhookLogEntry, 'id' | 'at'>): void {
    entries.unshift({
        id: nextId++,
        at: new Date().toISOString(),
        ...entry,
    });
    if (entries.length > MAX_ENTRIES) {
        entries.length = MAX_ENTRIES;
    }
}

export function getWebhookLog(filters: number | WebhookLogFilters = 100): WebhookLogEntry[] {
    const normalized = typeof filters === 'number' ? { limit: filters } : filters;
    const limit = Math.max(0, Math.min(normalized.limit || 100, MAX_ENTRIES));
    return entries
        .filter(entry => !normalized.kind || entry.kind === normalized.kind)
        .filter(entry => !normalized.sessionId || entry.sessionId === normalized.sessionId)
        .filter(entry => normalized.ok === undefined || entry.ok === normalized.ok)
        .slice(0, limit);
}

export function getWebhookLogEntry(id: number): WebhookLogEntry | null {
    return entries.find(entry => entry.id === id) || null;
}

export function clearWebhookLog(): void {
    entries.length = 0;
}

export function buildWebhookRequest(url: string, body: unknown): WebhookLogRequest {
    return {
        method: 'POST',
        url,
        headers: {
            'content-type': 'application/json',
        },
        body: safeClone(body),
    };
}

export function buildWebhookResponse(resp: any): WebhookLogResponse {
    return {
        status: Number(resp?.status || 0),
        statusText: typeof resp?.statusText === 'string' ? resp.statusText : null,
        headers: safeClone(resp?.headers || {}) as Record<string, unknown>,
        body: safeClone(resp?.data),
    };
}

export function buildWebhookError(err: any): WebhookLogError {
    return {
        name: typeof err?.name === 'string' ? err.name : null,
        message: String(err?.message || 'Webhook request failed'),
        code: typeof err?.code === 'string' ? err.code : null,
        stack: typeof err?.stack === 'string' ? err.stack : null,
        response: err?.response ? buildWebhookResponse(err.response) : null,
    };
}

export function safeClone(value: unknown): unknown {
    const seen = new WeakSet<object>();

    try {
        const json = JSON.stringify(value, (_key, item) => {
            if (typeof item === 'bigint') return item.toString();
            if (typeof item === 'function') return `[Function ${item.name || 'anonymous'}]`;
            if (Buffer.isBuffer(item)) {
                return {
                    type: 'Buffer',
                    bytes: item.length,
                    previewBase64: item.toString('base64', 0, Math.min(item.length, 96)),
                };
            }
            if (item && typeof item === 'object') {
                if (seen.has(item)) return '[Circular]';
                seen.add(item);
            }
            return item;
        });

        if (!json) return value ?? null;
        if (json.length > MAX_SERIALIZED_CHARS) {
            return {
                truncated: true,
                totalChars: json.length,
                preview: json.slice(0, MAX_SERIALIZED_CHARS),
            };
        }

        return JSON.parse(json);
    } catch (err: any) {
        return `[Unserializable: ${err?.message || 'unknown error'}]`;
    }
}
