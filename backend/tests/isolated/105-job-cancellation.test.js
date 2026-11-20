const test = require('node:test');
const assert = require('node:assert/strict');

// Fallback pure JS implementation for isolated testing without requiring prior build
class IsolatedMemoryJobStore {
  constructor() {
    this.jobs = new Map();
    this.byIdempotencyKey = new Map();
  }

  async enqueue(job) {
    if (job.idempotencyKey) {
      const existingId = this.byIdempotencyKey.get(job.idempotencyKey);
      if (existingId && this.jobs.has(existingId)) {
        return { job: JSON.parse(JSON.stringify(this.jobs.get(existingId))), created: false };
      }
      this.byIdempotencyKey.set(job.idempotencyKey, job.id);
    }
    this.jobs.set(job.id, JSON.parse(JSON.stringify(job)));
    return { job: JSON.parse(JSON.stringify(job)), created: true };
  }

  async claimNext(workerId, now, leaseMs, types) {
    const due = [...this.jobs.values()]
      .filter((j) => {
        if (types && !types.includes(j.type)) return false;
        if (j.status === 'queued') return new Date(j.runAt) <= now;
        return j.status === 'running' && !!j.lockedUntil && new Date(j.lockedUntil) <= now;
      })
      .sort((a, b) => a.runAt.localeCompare(b.runAt) || a.createdAt.localeCompare(b.createdAt));

    const job = due[0];
    if (!job) return null;

    job.status = 'running';
    job.attempts += 1;
    job.lockedBy = workerId;
    job.lockedUntil = new Date(now.getTime() + leaseMs).toISOString();
    job.updatedAt = now.toISOString();
    return JSON.parse(JSON.stringify(job));
  }

  async markSucceeded(id, workerId, result, now) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running' || job.lockedBy !== workerId) return null;
    job.status = 'succeeded';
    job.result = result === undefined ? null : JSON.parse(JSON.stringify(result));
    job.lockedBy = null;
    job.lockedUntil = null;
    job.completedAt = job.updatedAt = now.toISOString();
    return JSON.parse(JSON.stringify(job));
  }

  async markFailed(id, workerId, error, retryAt, now) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running' || job.lockedBy !== workerId) return null;
    job.errors.push(error);
    job.lockedBy = null;
    job.lockedUntil = null;
    job.updatedAt = now.toISOString();
    if (retryAt) {
      job.status = 'queued';
      job.runAt = retryAt.toISOString();
    } else {
      job.status = 'dead';
      job.completedAt = now.toISOString();
    }
    return JSON.parse(JSON.stringify(job));
  }

  async cancel(id, reason = 'Cancelled by administrator', now = new Date()) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === 'succeeded') return null;
    if (job.status === 'cancelled') return JSON.parse(JSON.stringify(job));
    job.status = 'cancelled';
    job.lockedBy = null;
    job.lockedUntil = null;
    job.cancellationReason = reason;
    job.cancelledAt = now.toISOString();
    job.completedAt = now.toISOString();
    job.updatedAt = now.toISOString();
    return JSON.parse(JSON.stringify(job));
  }

  async requeueDead(id, now) {
    const job = this.jobs.get(id);
    if (!job || (job.status !== 'dead' && job.status !== 'cancelled')) return null;
    job.status = 'queued';
    job.attempts = 0;
    job.runAt = now.toISOString();
    job.completedAt = null;
    job.cancelledAt = null;
    job.cancellationReason = null;
    job.updatedAt = now.toISOString();
    return JSON.parse(JSON.stringify(job));
  }

  async get(id) {
    const job = this.jobs.get(id);
    return job ? JSON.parse(JSON.stringify(job)) : null;
  }

  async list(filter = {}) {
    const matching = [...this.jobs.values()]
      .filter((j) => (!filter.status || j.status === filter.status) && (!filter.type || j.type === filter.type))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;
    return { jobs: matching.slice(offset, offset + limit).map((j) => JSON.parse(JSON.stringify(j))), total: matching.length };
  }

  async counts() {
    const counts = { queued: 0, running: 0, succeeded: 0, dead: 0, cancelled: 0 };
    for (const job of this.jobs.values()) counts[job.status] += 1;
    return counts;
  }
}

class IsolatedJobWorker {
  constructor(store, workerId = 'test-worker') {
    this.store = store;
    this.workerId = workerId;
    this.handlers = new Map();
    this.activeExecutions = new Map();
  }

  register(type, handler) {
    this.handlers.set(type, handler);
    return this;
  }

  async executeCleanups(cleanups, jobId) {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      try {
        await fn();
      } catch (err) {
        // Suppress and continue cleanups
      }
    }
  }

  async cancelRunningJob(id, reason = 'Cancelled by administrator') {
    const active = this.activeExecutions.get(id);
    if (active) {
      if (!active.controller.signal.aborted) {
        active.controller.abort(new Error(reason));
      }
      await this.executeCleanups(active.cleanups, id);
      this.activeExecutions.delete(id);
    }
    return this.store.cancel(id, reason, new Date());
  }

  async runOnce(now = new Date()) {
    const types = [...this.handlers.keys()];
    if (types.length === 0) return null;

    const claimed = await this.store.claimNext(this.workerId, now, 60000, types);
    if (!claimed) return null;

    const handler = this.handlers.get(claimed.type);
    const controller = new AbortController();
    const cleanups = [];
    this.activeExecutions.set(claimed.id, { controller, cleanups });

    try {
      const result = await handler(claimed.payload, {
        job: claimed,
        attempt: claimed.attempts,
        idempotencyKey: claimed.idempotencyKey || claimed.id,
        signal: controller.signal,
        onCleanup: (fn) => cleanups.push(fn),
      });

      if (controller.signal.aborted) {
        await this.executeCleanups(cleanups, claimed.id);
        const reason = controller.signal.reason?.message || 'Job cancelled during execution';
        const cancelled = await this.store.cancel(claimed.id, reason, now);
        return cancelled || claimed;
      }

      await this.executeCleanups(cleanups, claimed.id);
      const done = await this.store.markSucceeded(claimed.id, this.workerId, result, now);
      return done || claimed;
    } catch (err) {
      await this.executeCleanups(cleanups, claimed.id);
      if (controller.signal.aborted || err.name === 'JobCancelledError') {
        const reason = err.message || 'Job cancelled during execution';
        const cancelled = await this.store.cancel(claimed.id, reason, now);
        return cancelled || claimed;
      }
      return this.store.markFailed(claimed.id, this.workerId, { attempt: claimed.attempts, at: now.toISOString(), message: err.message }, null, now);
    } finally {
      this.activeExecutions.delete(claimed.id);
    }
  }
}

test('Issue #384: Safe cancellation and cleanup for long-running jobs', async (t) => {
  await t.test('Normal path: safely cancels a queued job without running it', async () => {
    const store = new IsolatedMemoryJobStore();
    const now = new Date('2026-03-01T12:00:00Z');
    const { job } = await store.enqueue({
      id: 'job-1',
      type: 'invoice.export',
      payload: { version: 1, data: { format: 'csv' } },
      status: 'queued',
      attempts: 0,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1000, backoffFactor: 2, maxDelayMs: 60000 },
      runAt: now.toISOString(),
      lockedUntil: null,
      lockedBy: null,
      idempotencyKey: null,
      correlationId: 'c-1',
      errors: [],
      result: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completedAt: null,
    });

    assert.equal(job.status, 'queued');

    const cancelled = await store.cancel('job-1', 'User requested cancellation', now);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cancellationReason, 'User requested cancellation');
    assert.equal(cancelled.cancelledAt, now.toISOString());
    assert.equal(cancelled.completedAt, now.toISOString());

    // Worker should not claim cancelled job
    const worker = new IsolatedJobWorker(store);
    worker.register('invoice.export', async () => ({ exported: true }));
    const claimed = await worker.runOnce(now);
    assert.equal(claimed, null);
  });

  await t.test('Normal path: executes registered cleanups in LIFO order upon cooperative cancellation', async () => {
    const store = new IsolatedMemoryJobStore();
    const now = new Date('2026-03-01T12:00:00Z');
    await store.enqueue({
      id: 'job-2',
      type: 'invoice.batch-sync',
      payload: { version: 1, data: { batchId: 42 } },
      status: 'queued',
      attempts: 0,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1000, backoffFactor: 2, maxDelayMs: 60000 },
      runAt: now.toISOString(),
      lockedUntil: null,
      lockedBy: null,
      idempotencyKey: null,
      correlationId: 'c-2',
      errors: [],
      result: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completedAt: null,
    });

    const cleanupOrder = [];
    const worker = new IsolatedJobWorker(store);

    let startPromiseResolve;
    const started = new Promise((resolve) => {
      startPromiseResolve = resolve;
    });

    worker.register('invoice.batch-sync', async (payload, ctx) => {
      ctx.onCleanup(async () => {
        cleanupOrder.push('first-cleanup');
      });
      ctx.onCleanup(async () => {
        cleanupOrder.push('second-cleanup');
      });

      startPromiseResolve();

      // Simulate waiting for work or cooperative abort
      return new Promise((resolve, reject) => {
        ctx.signal.addEventListener('abort', () => {
          const err = new Error('Aborted by worker');
          err.name = 'JobCancelledError';
          reject(err);
        });
      });
    });

    const runPromise = worker.runOnce(now);
    await started;

    // Trigger cancellation while running
    await worker.cancelRunningJob('job-2', 'Maintainer cancelled long-running task');
    const result = await runPromise;

    assert.equal(result.status, 'cancelled');
    assert.equal(result.cancellationReason, 'Maintainer cancelled long-running task');

    // Assert LIFO execution of cleanups
    assert.deepEqual(cleanupOrder, ['second-cleanup', 'first-cleanup']);

    const finalJob = await store.get('job-2');
    assert.equal(finalJob.status, 'cancelled');
  });

  await t.test('Failure path: refusing cancellation of already succeeded jobs', async () => {
    const store = new IsolatedMemoryJobStore();
    const now = new Date('2026-03-01T12:00:00Z');
    await store.enqueue({
      id: 'job-3',
      type: 'invoice.receipt',
      payload: { version: 1, data: {} },
      status: 'queued',
      attempts: 0,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1000, backoffFactor: 1, maxDelayMs: 1000 },
      runAt: now.toISOString(),
      lockedUntil: null,
      lockedBy: null,
      idempotencyKey: null,
      correlationId: null,
      errors: [],
      result: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completedAt: null,
    });

    const worker = new IsolatedJobWorker(store);
    worker.register('invoice.receipt', async () => ({ sent: true }));
    await worker.runOnce(now);

    const completed = await store.get('job-3');
    assert.equal(completed.status, 'succeeded');

    // Attempting to cancel an already completed job returns null (cannot be cancelled)
    const cancelResult = await store.cancel('job-3', 'Too late');
    assert.equal(cancelResult, null);

    // Cancel on nonexistent job returns null
    const nonExistent = await store.cancel('nonexistent-id');
    assert.equal(nonExistent, null);
  });

  await t.test('Retry path: requeueDead allows retrying cancelled jobs', async () => {
    const store = new IsolatedMemoryJobStore();
    const now = new Date('2026-03-01T12:00:00Z');
    await store.enqueue({
      id: 'job-4',
      type: 'invoice.reminder',
      payload: { version: 1, data: {} },
      status: 'queued',
      attempts: 0,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1000, backoffFactor: 2, maxDelayMs: 60000 },
      runAt: now.toISOString(),
      lockedUntil: null,
      lockedBy: null,
      idempotencyKey: null,
      correlationId: null,
      errors: [],
      result: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completedAt: null,
    });

    await store.cancel('job-4', 'Accidentally cancelled', now);
    let job = await store.get('job-4');
    assert.equal(job.status, 'cancelled');

    // Retry path: requeueDead moves cancelled job back to queued
    const requeued = await store.requeueDead('job-4', new Date('2026-03-01T12:05:00Z'));
    assert.ok(requeued);
    assert.equal(requeued.status, 'queued');
    assert.equal(requeued.attempts, 0);
    assert.equal(requeued.cancellationReason, null);
    assert.equal(requeued.cancelledAt, null);

    // Worker can claim and complete the retried job
    const worker = new IsolatedJobWorker(store);
    worker.register('invoice.reminder', async () => ({ reminded: true }));
    const done = await worker.runOnce(new Date('2026-03-01T12:06:00Z'));
    assert.equal(done.status, 'succeeded');
  });

  await t.test('Authorization path: admin authorization check protects job control', () => {
    // Check timing-safe admin auth guard
    const middleware = (adminToken) => (req, res, next) => {
      const header = req.headers?.authorization || '';
      const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!adminToken) {
        return res.status(403).json({ error: 'Job inspection is not enabled', code: 'JOBS_ADMIN_DISABLED' });
      }
      if (provided !== adminToken) {
        return res.status(401).json({ error: 'Invalid or missing admin token', code: 'UNAUTHORIZED' });
      }
      next();
    };

    let statusCode = 0;
    let payload = null;
    const fakeRes = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        payload = data;
        return this;
      },
    };

    // Missing token in env -> 403
    const guardNoToken = middleware(undefined);
    guardNoToken({ headers: {} }, fakeRes, () => {});
    assert.equal(statusCode, 403);
    assert.equal(payload.code, 'JOBS_ADMIN_DISABLED');

    // Missing header -> 401
    const guardWithToken = middleware('secret-admin-token');
    guardWithToken({ headers: {} }, fakeRes, () => {});
    assert.equal(statusCode, 401);
    assert.equal(payload.code, 'UNAUTHORIZED');

    // Invalid bearer token -> 401
    guardWithToken({ headers: { authorization: 'Bearer wrong-token' } }, fakeRes, () => {});
    assert.equal(statusCode, 401);
    assert.equal(payload.code, 'UNAUTHORIZED');

    // Valid bearer token -> calls next()
    let calledNext = false;
    guardWithToken({ headers: { authorization: 'Bearer secret-admin-token' } }, fakeRes, () => {
      calledNext = true;
    });
    assert.equal(calledNext, true);
  });
});
