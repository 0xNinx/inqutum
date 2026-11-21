/**
 * In-memory keyed mutex lock manager to prevent race conditions during
 * async operations (e.g., awaiting Horizon verification) on the same invoice ID.
 *
 * Waiting is unbounded by default (existing behaviour). Pass `timeoutMs` to
 * give up with LockTimeoutError instead (#208): a waiter that times out never
 * acquires the lock later, so a caller that has already answered "try again"
 * cannot run its critical section behind the client's back.
 */

export class LockTimeoutError extends Error {
  readonly code = 'LOCK_TIMEOUT' as const;

  constructor(readonly key: string, readonly timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for the lock on ${key}; another request is still processing it`);
    this.name = 'LockTimeoutError';
  }
}

export interface AcquireOptions {
  /** Give up after this many milliseconds. Omit to wait indefinitely. */
  timeoutMs?: number;
}

export class InvoiceLockManager {
  private locks = new Map<string, Promise<void>>();

  /**
   * Acquire a lock for a specific invoice ID.
   * Returns a release function that MUST be invoked when the operation completes.
   *
   * Time Complexity: O(1)
   * Space Complexity: O(1) per active locked invoice
   */
  async acquire(invoiceId: string, options: AcquireOptions = {}): Promise<() => void> {
    const { timeoutMs } = options;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
      throw new RangeError('timeoutMs must be a non-negative finite number');
    }
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;

    while (this.locks.has(invoiceId)) {
      const held = this.locks.get(invoiceId)!;
      if (deadline === undefined) {
        await held;
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new LockTimeoutError(invoiceId, timeoutMs!);
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        held.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), remaining);
        }),
      ]);
      clearTimeout(timer);
      if (timedOut) throw new LockTimeoutError(invoiceId, timeoutMs!);
    }

    let releaseLock!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    this.locks.set(invoiceId, lockPromise);

    return () => {
      if (this.locks.get(invoiceId) === lockPromise) {
        this.locks.delete(invoiceId);
      }
      releaseLock();
    };
  }

  /** Run `fn` while holding the lock; the lock is released even if `fn` throws. */
  async withLock<T>(invoiceId: string, fn: () => Promise<T> | T, options: AcquireOptions = {}): Promise<T> {
    const release = await this.acquire(invoiceId, options);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  isLocked(invoiceId: string): boolean {
    return this.locks.has(invoiceId);
  }

  get activeLocks(): number {
    return this.locks.size;
  }
}

export const invoiceLockManager = new InvoiceLockManager();
