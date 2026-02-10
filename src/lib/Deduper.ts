import NodeCache from 'node-cache';

export class MessageDeduper {
    private cache: NodeCache;

    constructor(ttlSeconds: number = 60) {
        this.cache = new NodeCache({ stdTTL: ttlSeconds, checkperiod: 60 });
    }

    /**
     * Checks if a message ID has been seen before.
     * Returns true if it's a duplicate, false if it's new.
     */
    shouldIgnore(messageId: string): boolean {
        if (this.cache.has(messageId)) {
            return true;
        }
        this.cache.set(messageId, true);
        return false;
    }
}

export const deduper = new MessageDeduper();
