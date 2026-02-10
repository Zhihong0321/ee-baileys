import dotenv from 'dotenv';
import { startServer } from './api/server';
import { manager } from './whatsapp/SocketManager';

dotenv.config();

async function bootstrap() {
    console.log('--- Baileys Multi-API Server Starting ---');

    // 1. Restore previous sessions with staggered startup
    await manager.restoreSessions();

    // 2. Start REST API
    startServer();
}

bootstrap().catch(err => {
    console.error('Critical Fail during Bootstrap:', err);
    process.exit(1);
});
