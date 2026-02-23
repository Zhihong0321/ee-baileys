import path from 'path';

export const SESSIONS_BASE_DIR = process.env.SESSIONS_BASE_DIR || process.env.SESSIONS_DIR || '/app/sessions';

export const resolveSessionPath = (sessionId: string) => {
    return path.join(SESSIONS_BASE_DIR, sessionId);
};
