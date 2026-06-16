import path from 'path';

const isRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_PUBLIC_DOMAIN);

export const STORAGE_BASE_DIR =
    process.env.STORAGE_BASE_DIR ||
    process.env.RAILWAY_VOLUME_MOUNT_PATH ||
    (isRailway ? '/storage' : process.cwd());

export const SESSIONS_BASE_DIR =
    process.env.SESSIONS_BASE_DIR ||
    process.env.SESSIONS_DIR ||
    path.join(STORAGE_BASE_DIR, 'sessions');

export const MEDIA_BASE_DIR =
    process.env.MEDIA_DIR ||
    path.join(STORAGE_BASE_DIR, 'media');

export const resolveSessionPath = (sessionId: string) => {
    return path.join(SESSIONS_BASE_DIR, sessionId);
};
