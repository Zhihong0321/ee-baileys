import fs from 'fs';
import os from 'os';
import path from 'path';
import { manager } from './whatsapp/SocketManager';
import { SESSIONS_BASE_DIR } from './config/paths';
import { postgresMessageWriter } from './db/PostgresMessageWriter';

type StatHealth = {
    exists: boolean;
    isDirectory: boolean;
    readable: boolean;
    writable: boolean;
    parentWritable: boolean;
    mtime?: string;
    error?: string;
};

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, 'public');
const MEDIA_DIR = path.join(ROOT, 'media');

function canAccess(targetPath: string, mode: number): boolean {
    try {
        const dir = fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()
            ? targetPath
            : path.dirname(targetPath);
        fs.accessSync(dir, mode);
        return true;
    } catch {
        return false;
    }
}

function safeStat(targetPath: string): StatHealth {
    try {
        const stat = fs.statSync(targetPath);
        return {
            exists: true,
            isDirectory: stat.isDirectory(),
            readable: canAccess(targetPath, fs.constants.R_OK),
            writable: canAccess(targetPath, fs.constants.W_OK),
            parentWritable: canAccess(path.dirname(targetPath), fs.constants.W_OK),
            mtime: stat.mtime.toISOString(),
        };
    } catch (error: any) {
        return {
            exists: false,
            isDirectory: false,
            readable: false,
            writable: false,
            parentWritable: canAccess(path.dirname(targetPath), fs.constants.W_OK),
            error: error.message,
        };
    }
}

function checkRuntime() {
    return {
        ok: true,
        node: process.version,
        pid: process.pid,
        platform: process.platform,
        hostname: os.hostname(),
        uptimeSeconds: Math.round(process.uptime()),
        memory: process.memoryUsage(),
        loadAverage: os.loadavg(),
        env: {
            port: process.env.PORT || '3000',
            railway: Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_PUBLIC_DOMAIN),
            railwayEnvironment: process.env.RAILWAY_ENVIRONMENT || null,
            mediaBaseUrlConfigured: Boolean(process.env.MEDIA_BASE_URL || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL),
            sessionsBaseDir: SESSIONS_BASE_DIR,
            databaseUrlConfigured: Boolean(process.env.DATABASE_URL),
        },
    };
}

function checkStorage() {
    const checks = {
        root: safeStat(ROOT),
        public: safeStat(PUBLIC_DIR),
        sessions: safeStat(SESSIONS_BASE_DIR),
        media: safeStat(MEDIA_DIR),
    };
    const usable = {
        root: checks.root.exists && checks.root.writable,
        public: checks.public.exists && checks.public.readable,
        sessions: checks.sessions.exists ? checks.sessions.writable : checks.sessions.parentWritable,
        media: checks.media.exists ? checks.media.writable : checks.media.parentWritable,
    };
    return {
        ok: Object.values(usable).every(Boolean),
        usable,
        checks,
    };
}

function checkSessions() {
    const sessionIds = manager.listInstances();
    const details = sessionIds.map((sessionId) => {
        const instance = manager.getExistingInstance(sessionId);
        const connected = Boolean(instance?.sock?.user);
        const hasQr = Boolean(instance?.getQRCode());
        return {
            sessionId,
            status: connected ? 'connected' : (hasQr ? 'qr_pending' : 'initializing_or_disconnected'),
            connected,
            connectedNumber: instance?.getConnectedNumber() || null,
            hasQr,
            lastError: instance?.lastError || null,
            sessionPath: safeStat(path.join(SESSIONS_BASE_DIR, sessionId)),
        };
    });

    return {
        ok: details.every((item) => !item.lastError),
        count: sessionIds.length,
        connected: details.filter((item) => item.connected).length,
        qrPending: details.filter((item) => item.hasQr).length,
        errorCount: details.filter((item) => item.lastError).length,
        details,
    };
}

function checkEndpoints() {
    return {
        ok: true,
        routes: [
            'GET /',
            'GET /api',
            'GET /health',
            'GET /full-health',
            'GET /sessions',
            'GET /sessions/:id',
            'GET /sessions/:id/qr',
            'POST /sessions/:id',
            'DELETE /sessions/:id',
            'POST /messages/send',
            'POST /simulate/inbound',
            'POST /groups/create',
            'DELETE /groups/:jid?sessionId=...',
            'GET /chats?sessionId=...',
            'GET /chats/:jid/messages?sessionId=...',
        ],
    };
}

export async function buildHealthReport() {
    const checks = {
        runtime: checkRuntime(),
        storage: checkStorage(),
        postgres: await postgresMessageWriter.healthCheck(),
        sessions: checkSessions(),
        endpoints: checkEndpoints(),
    };
    const ok = Object.values(checks).every((check: any) => check.ok !== false);

    return {
        ok,
        status: ok ? 'ok' : 'degraded',
        checkedAt: new Date().toISOString(),
        service: 'baileys-multi-api',
        checks,
    };
}
