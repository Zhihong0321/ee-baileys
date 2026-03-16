import dotenv from 'dotenv';
import { startServer } from './api/server';
import { manager } from './whatsapp/SocketManager';
import { postgresMessageWriter } from './db/PostgresMessageWriter';

dotenv.config();

async function bootstrap() {
    console.log('--- Baileys Multi-API Server Starting ---');

    // 1. Restore previous sessions with staggered startup
    await manager.restoreSessions();

    // 2. Retry any inbound messages that were durably queued but not fully processed.
    postgresMessageWriter.startInboundInboxProcessor();

    // 3. Start REST API
    startServer();
}

bootstrap().catch(err => {
    console.error('Critical Fail during Bootstrap:', err);
    process.exit(1);
});
