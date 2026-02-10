import { WhatsAppInstance } from './Instance';
import { staggerer } from '../lib/Staggerer';
import fs from 'fs-extra';
import path from 'path';

export class WhatsAppManager {
    private instances = new Map<string, WhatsAppInstance>();

    async getInstance(sessionId: string): Promise<WhatsAppInstance> {
        let instance = this.instances.get(sessionId);
        if (!instance) {
            instance = new WhatsAppInstance(sessionId);
            this.instances.set(sessionId, instance);
            // Stagger the initialization
            await staggerer.schedule(() => instance!.init().then(() => { }));
        }
        return instance;
    }

    async restoreSessions() {
        const sessionsDir = path.join(process.cwd(), 'sessions');
        if (await fs.pathExists(sessionsDir)) {
            const dirs = await fs.readdir(sessionsDir);
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

    async removeInstance(sessionId: string) {
        const instance = this.instances.get(sessionId);
        if (instance) {
            await instance.logout();
            this.instances.delete(sessionId);
        }
    }
}

export const manager = new WhatsAppManager();
