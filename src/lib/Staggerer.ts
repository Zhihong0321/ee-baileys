import PQueue from 'p-queue';

export class ConnectionStaggerer {
    private queue: PQueue;
    private delayMs: number;

    constructor(delayMs: number = 3000) {
        this.queue = new PQueue({ concurrency: 1 });
        this.delayMs = delayMs;
    }

    async schedule(task: () => Promise<void>) {
        return this.queue.add(async () => {
            await task();
            await new Promise(resolve => setTimeout(resolve, this.delayMs));
        });
    }
}

export const staggerer = new ConnectionStaggerer();
