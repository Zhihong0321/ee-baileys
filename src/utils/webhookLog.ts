// In-memory ring buffer of every webhook dispatch attempt.
//
// Records each outbound webhook fire (session webhook, global webhook, OTP webhook)
// with its target URL, sender/content summary, and the HTTP result. Exposed on the
// dashboard via GET /webhook-log so you can see, live, exactly what fired and whether
// the receiver accepted it. Resets on restart — this is a live activity log, not an
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
}

const MAX_ENTRIES = 300;
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

export function getWebhookLog(limit = 100): WebhookLogEntry[] {
    return entries.slice(0, Math.max(0, Math.min(limit, MAX_ENTRIES)));
}

export function clearWebhookLog(): void {
    entries.length = 0;
}
