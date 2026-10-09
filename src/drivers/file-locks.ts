import { randomUUID } from "node:crypto";

export interface FileLocks {
  acquire(path: string, signal?: AbortSignal): Promise<string>;
  release(leaseId: string): Promise<void>;
}

interface Waiter {
  id: string;
  resolve(id: string): void;
  stop(): void;
}

/** Lease identity prevents a delayed release from unlocking another operation. */
export class FileLockManager implements FileLocks {
  private readonly queues = new Map<string, Waiter[]>();
  private readonly leases = new Map<string, string>();

  acquire(path: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(path) ?? [];
      this.queues.set(path, queue);
      const id = randomUUID();
      const cancel = () => {
        const index = queue.findIndex(item => item.id === id);
        if (index <= 0) return;
        queue.splice(index, 1); signal?.removeEventListener("abort", cancel); reject(signal?.reason);
      };
      queue.push({ id, resolve, stop: () => signal?.removeEventListener("abort", cancel) });
      if (queue.length === 1) { this.leases.set(id, path); resolve(id); }
      else signal?.addEventListener("abort", cancel, { once: true });
    });
  }

  async release(leaseId: string): Promise<void> {
    const path = this.leases.get(leaseId);
    if (path === undefined) return;
    this.leases.delete(leaseId);
    const queue = this.queues.get(path)!;
    queue.shift()!.stop();
    const next = queue[0];
    if (next) { next.stop(); this.leases.set(next.id, path); next.resolve(next.id); }
    else this.queues.delete(path);
  }
}
