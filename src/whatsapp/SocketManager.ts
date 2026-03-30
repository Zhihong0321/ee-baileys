import { WhatsAppInstance } from './Instance';
import { staggerer } from '../lib/Staggerer';
import fs from 'fs-extra';
import { SESSIONS_BASE_DIR, resolveSessionPath } from '../config/paths';

export class WhatsAppManager {
    private instances = new Map<string, WhatsAppInstance>();

    async getInstance(sessionId: string): Promise<WhatsAppInstance> {
        let instance = this.instances.get(sessionId);
        if (!instance) {
            instance = new WhatsAppInstance(sessionId);
            this.instances.set(sessionId, instance);
            console.log(`[Manager] Creating new session: ${sessionId}`);
            // Stagger the initialization
            staggerer.schedule(async () => {
                try {
                    await instance!.init();
                } catch (err) {
                    console.error(`[Manager] Failed to initialize session ${sessionId}:`, err);
                }
            });
        }
        return instance;
    }

    async restoreSessions() {
        const sessionsDir = SESSIONS_BASE_DIR;
        if (await fs.pathExists(sessionsDir)) {
            const entries = await fs.readdir(sessionsDir);
            const dirs = entries.filter(id => id !== '.DS_Store');
            console.log(`[Manager] Restoring ${dirs.length} sessions...`);
            for (const id of dirs) {
                this.getInstance(id).catch(err => {
                    console.error(`[Manager] Failed to restore session ${id}:`, err);
                });
            }
        }
    }

    listInstances() {
        return Array.from(this.instances.keys());
    }

    getExistingInstance(sessionId: string) {
        return this.instances.get(sessionId);
    }

    async removeInstance(sessionId: string) {
        const instance = this.instances.get(sessionId);
        if (instance) {
            try {
                await instance.logout();
            } catch (err) {
                console.error(`[Manager] Error during logout for ${sessionId}:`, err);
            }
            this.instances.delete(sessionId);
        }

        // Force delete session folder if it still exists
        const sessionPath = resolveSessionPath(sessionId);
        if (await fs.pathExists(sessionPath)) {
            console.log(`[Manager] Deleting session folder: ${sessionPath}`);
            await fs.remove(sessionPath);
        }
    }
}

export const manager = new WhatsAppManager();
