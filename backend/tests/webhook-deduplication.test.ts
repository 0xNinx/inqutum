import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryIdempotencyStore } from '../src/idempotency/memory-store';
import { processWebhook } from '../src/webhooks/process-webhook';

describe('webhook duplicate suppression (#294)', () => {
  it('processes a valid event once and acknowledges a duplicate without rerunning it', async () => {
    const store = new MemoryIdempotencyStore();
    let handled = 0;
    const input = { provider: 'ExamplePay', eventId: 'evt_12345678', rawBody: '{"id":"evt_12345678"}', verifySignature: () => true, handle: () => ++handled };
    assert.deepEqual(await processWebhook(store, input), { accepted: true, duplicate: false, result: 1 });
    assert.deepEqual(await processWebhook(store, input), { accepted: true, duplicate: true, result: 1 });
    assert.equal(handled, 1);
  });

  it('rejects normalized event IDs longer than 255 characters', async () => {
    const result = await processWebhook(new MemoryIdempotencyStore(), {
      provider: 'ExamplePay', eventId: 'evt_' + 'x'.repeat(256), rawBody: '{}',
      verifySignature: () => true, handle: () => 'ok',
    });
    assert.deepEqual(result, { accepted: false, status: 400, code: 'WEBHOOK_EVENT_ID_INVALID' });
  });

  it('checks signature before reserving an event ID', async () => {
    const store = new MemoryIdempotencyStore();
    let handled = 0;
    const input = { provider: 'ExamplePay', eventId: 'evt_12345678', rawBody: '{}', verifySignature: () => false, handle: () => ++handled };
    assert.deepEqual(await processWebhook(store, input), { accepted: false, status: 401, code: 'WEBHOOK_SIGNATURE_INVALID' });
    assert.deepEqual(await processWebhook(store, { ...input, verifySignature: () => true }), { accepted: true, duplicate: false, result: 1 });
    assert.equal(handled, 1);
  });

  it('releases failed attempts so a provider retry can succeed', async () => {
    const store = new MemoryIdempotencyStore();
    let attempts = 0;
    const input = { provider: 'ExamplePay', eventId: 'evt_retry_123', rawBody: '{"x":1}', verifySignature: () => true, handle: () => { attempts++; if (attempts === 1) throw new Error('temporary'); return 'ok'; } };
    await assert.rejects(() => processWebhook(store, input), /temporary/);
    assert.deepEqual(await processWebhook(store, input), { accepted: true, duplicate: false, result: 'ok' });
    assert.equal(attempts, 2);
  });

  it('rejects reuse of an event ID with a different payload', async () => {
    const store = new MemoryIdempotencyStore();
    const base = { provider: 'ExamplePay', eventId: 'evt_12345678', verifySignature: () => true, handle: () => 'ok' };
    await processWebhook(store, { ...base, rawBody: '{"x":1}' });
    assert.deepEqual(await processWebhook(store, { ...base, rawBody: '{"x":2}' }), { accepted: false, status: 422, code: 'WEBHOOK_EVENT_ID_CONFLICT' });
  });

  describe('concurrency tests for duplicate submissions (#360)', () => {
    it('normal path: concurrent distinct event submissions process without collision', async () => {
      const store = new MemoryIdempotencyStore();
      let handledCount = 0;
      const count = 10;

      const submissions = Array.from({ length: count }, (_, i) => ({
        provider: 'ExamplePay',
        eventId: `evt_distinct_${i}`,
        rawBody: JSON.stringify({ index: i }),
        verifySignature: () => true,
        handle: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          handledCount++;
          return `result_${i}`;
        },
      }));

      const results = await Promise.all(submissions.map((input) => processWebhook(store, input)));

      assert.equal(handledCount, count, 'Each distinct event must execute handle() exactly once');
      for (let i = 0; i < count; i++) {
        assert.deepEqual(results[i], {
          accepted: true,
          duplicate: false,
          result: `result_${i}`,
        });
      }
    });

    it('failure path: concurrent in-flight duplicates return 409 WEBHOOK_EVENT_IN_PROGRESS with single execution', async () => {
      const store = new MemoryIdempotencyStore();
      let executionCount = 0;
      const eventId = 'evt_concurrent_dup_1';
      const rawBody = JSON.stringify({ item: 'invoice_paid', id: eventId });
      const concurrentRequests = 10;

      const results = await Promise.all(
        Array.from({ length: concurrentRequests }, () =>
          processWebhook(store, {
            provider: 'ExamplePay',
            eventId,
            rawBody,
            verifySignature: () => true,
            handle: async () => {
              // Simulate in-flight asynchronous work
              await new Promise((resolve) => setTimeout(resolve, 20));
              executionCount++;
              return { processed: true };
            },
          })
        )
      );

      const successes = results.filter((r) => r.accepted && !r.duplicate);
      const inProgressFailures = results.filter(
        (r) => !r.accepted && r.status === 409 && r.code === 'WEBHOOK_EVENT_IN_PROGRESS'
      );

      assert.equal(executionCount, 1, 'Under race conditions, handler must execute exactly once');
      assert.equal(successes.length, 1, 'Exactly one concurrent submission must win the lock');
      assert.equal(
        inProgressFailures.length,
        concurrentRequests - 1,
        'Remaining concurrent submissions must fail with 409 WEBHOOK_EVENT_IN_PROGRESS'
      );
    });

    it('retry path: concurrent duplicate submissions after completion return cached replay without re-executing', async () => {
      const store = new MemoryIdempotencyStore();
      let executionCount = 0;
      const eventId = 'evt_concurrent_replay_1';
      const rawBody = JSON.stringify({ eventId, status: 'PAID' });

      // First submission completes
      const first = await processWebhook(store, {
        provider: 'ExamplePay',
        eventId,
        rawBody,
        verifySignature: () => true,
        handle: () => {
          executionCount++;
          return { settled: true };
        },
      });
      assert.deepEqual(first, { accepted: true, duplicate: false, result: { settled: true } });
      assert.equal(executionCount, 1);

      // Concurrent replays
      const replayResults = await Promise.all(
        Array.from({ length: 8 }, () =>
          processWebhook(store, {
            provider: 'ExamplePay',
            eventId,
            rawBody,
            verifySignature: () => true,
            handle: () => {
              executionCount++;
              return { settled: true };
            },
          })
        )
      );

      assert.equal(executionCount, 1, 'Handler must not execute again for completed events');
      for (const res of replayResults) {
        assert.deepEqual(res, {
          accepted: true,
          duplicate: true,
          result: { settled: true },
        });
      }
    });

    it('retry path: rollback on failed execution unlocks the key for subsequent retry attempts', async () => {
      const store = new MemoryIdempotencyStore();
      let attempt = 0;
      const eventId = 'evt_transient_failure_1';
      const rawBody = JSON.stringify({ eventId });

      const input = {
        provider: 'ExamplePay',
        eventId,
        rawBody,
        verifySignature: () => true,
        handle: async () => {
          attempt++;
          if (attempt === 1) {
            throw new Error('Database connection failed');
          }
          return { recovered: true };
        },
      };

      // First attempt crashes and releases lock
      await assert.rejects(() => processWebhook(store, input), /Database connection failed/);

      // Subsequent retry succeeds
      const retryResult = await processWebhook(store, input);
      assert.deepEqual(retryResult, { accepted: true, duplicate: false, result: { recovered: true } });
      assert.equal(attempt, 2);
    });

    it('authorization path: concurrent unauthorized requests fail with 401 without claiming lock', async () => {
      const store = new MemoryIdempotencyStore();
      let handleExecuted = false;
      const eventId = 'evt_auth_race_1';
      const rawBody = JSON.stringify({ eventId });

      // Multiple unauthorized submissions racing
      const unauthResults = await Promise.all(
        Array.from({ length: 5 }, () =>
          processWebhook(store, {
            provider: 'ExamplePay',
            eventId,
            rawBody,
            verifySignature: () => false,
            handle: () => {
              handleExecuted = true;
              return 'secret';
            },
          })
        )
      );

      for (const res of unauthResults) {
        assert.deepEqual(res, { accepted: false, status: 401, code: 'WEBHOOK_SIGNATURE_INVALID' });
      }
      assert.equal(handleExecuted, false, 'Handler must never execute for unauthorized requests');
      assert.equal(store.size(), 0, 'Store must not lock or reserve keys for unauthorized requests');

      // Valid request following unauthorized attempts succeeds normally
      const authResult = await processWebhook(store, {
        provider: 'ExamplePay',
        eventId,
        rawBody,
        verifySignature: () => true,
        handle: () => 'authenticated',
      });
      assert.deepEqual(authResult, { accepted: true, duplicate: false, result: 'authenticated' });
    });

    it('failure path: degraded store returns 503 WEBHOOK_DEDUPE_STORE_UNAVAILABLE', async () => {
      const failingStore = {
        begin: async () => {
          throw new Error('Redis pool exhausted');
        },
        complete: async () => {},
        release: async () => {},
      };

      const result = await processWebhook(failingStore, {
        provider: 'ExamplePay',
        eventId: 'evt_store_down',
        rawBody: '{}',
        verifySignature: () => true,
        handle: () => 'ok',
      });

      assert.deepEqual(result, {
        accepted: false,
        status: 503,
        code: 'WEBHOOK_DEDUPE_STORE_UNAVAILABLE',
      });
    });

    it('failure path: expired event returns 410 WEBHOOK_EVENT_ID_EXPIRED', async () => {
      const store = new MemoryIdempotencyStore();
      const baseTime = new Date('2026-01-01T00:00:00Z');
      const eventId = 'evt_expired_1';
      const rawBody = JSON.stringify({ eventId });

      // First submission at baseTime
      await processWebhook(store, {
        provider: 'ExamplePay',
        eventId,
        rawBody,
        verifySignature: () => true,
        handle: () => 'done',
        now: () => baseTime,
      });

      // Attempt replay 8 days later (past 7-day TTL)
      const expiredTime = new Date('2026-01-09T00:00:00Z');
      const result = await processWebhook(store, {
        provider: 'ExamplePay',
        eventId,
        rawBody,
        verifySignature: () => true,
        handle: () => 'done',
        now: () => expiredTime,
      });

      assert.deepEqual(result, {
        accepted: false,
        status: 410,
        code: 'WEBHOOK_EVENT_ID_EXPIRED',
      });
    });
  });
});
