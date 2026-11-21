import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MemoryIdempotencyStore } from '../src/idempotency/memory-store';
import { processWebhook } from '../src/webhooks/process-webhook';
import { isTimestampStale, signWebhookPayload, verifyWebhookSignature } from '../src/webhooks/webhook-verification';
import {
  createMalformedWebhookPayloadFixtures,
  createWebhookReplayAttackFixtures,
  type MalformedWebhookPayloadFixture,
  type WebhookReplayAttackFixture,
} from '../src/sandbox/malformed-payload-fixtures';

const REPLAY_WINDOW_SECONDS = 300;

function verifierFor(body: string, signature: string, secret: string, timestamp: string): () => boolean {
  return () =>
    verifyWebhookSignature(body, signature, secret, timestamp) &&
    !isTimestampStale(timestamp, REPLAY_WINDOW_SECONDS);
}

function runWebhook(
  store: MemoryIdempotencyStore,
  input: {
    provider: string;
    eventId: string;
    body: string;
    signature: string;
    secret: string;
    timestamp: string;
  },
  options: { now?: Date; handle?: () => unknown } = {}
) {
  return processWebhook(store, {
    provider: input.provider,
    eventId: input.eventId,
    rawBody: input.body,
    verifySignature: verifierFor(input.body, input.signature, input.secret, input.timestamp),
    handle: options.handle ?? (() => ({ accepted: true })),
    now: () => options.now ?? new Date(),
  });
}

function malformedInput(fixture: MalformedWebhookPayloadFixture) {
  return {
    provider: fixture.provider,
    eventId: fixture.eventId,
    body: fixture.rawBody,
    signature: fixture.signature,
    secret: fixture.secret,
    timestamp: fixture.timestamp,
  };
}

function replayInput(fixture: WebhookReplayAttackFixture, second: boolean) {
  return {
    provider: fixture.provider,
    eventId: fixture.eventId,
    body: second ? fixture.secondBody : fixture.firstBody,
    signature: second ? fixture.secondSignature : fixture.firstSignature,
    secret: fixture.secret,
    timestamp: fixture.timestamp,
  };
}

describe('Malformed payload and replay attack fixtures (Issue #356)', () => {
  describe('normal path', () => {
    it('accepts a valid webhook exactly once and records the handler result', async () => {
      const fixture = createWebhookReplayAttackFixtures()[0];
      const store = new MemoryIdempotencyStore();
      let handled = 0;

      const first = await runWebhook(store, replayInput(fixture, false), { handle: () => ({ id: 'inv-replay-001' }) });
      assert.equal(first.accepted, true);
      if (first.accepted) {
        assert.equal(first.duplicate, false);
        assert.deepEqual(first.result, { id: 'inv-replay-001' });
      }
      handled += 1;

      const second = await runWebhook(store, replayInput(fixture, true), {
        handle: () => {
          handled += 1;
          return { id: 'should-not-run' };
        },
      });
      assert.equal(second.accepted, true);
      if (second.accepted) {
        assert.equal(second.duplicate, true);
        assert.deepEqual(second.result, { id: 'inv-replay-001' });
      }
      assert.equal(handled, 1);
    });
  });

  describe('failure path: malformed headers and payloads', () => {
    for (const fixture of createMalformedWebhookPayloadFixtures()) {
      it(`rejects ${fixture.name}`, async () => {
        const store = new MemoryIdempotencyStore();
        const result = await runWebhook(store, malformedInput(fixture));
        assert.equal(result.accepted, false);
        if (!result.accepted) {
          assert.equal(result.status, fixture.expected.status);
          assert.equal(result.code, fixture.expected.code);
        }
      });
    }
  });

  describe('retry path', () => {
    it('releases the idempotency key when the handler fails so a provider retry can succeed', async () => {
      const fixture = createWebhookReplayAttackFixtures()[0];
      const store = new MemoryIdempotencyStore();
      let attempts = 0;

      await assert.rejects(
        () =>
          runWebhook(store, replayInput(fixture, false), {
            handle: () => {
              attempts += 1;
              throw new Error('downstream timeout');
            },
          }),
        /downstream timeout/
      );

      const retry = await runWebhook(store, replayInput(fixture, false), {
        handle: () => {
          attempts += 1;
          return { recovered: true };
        },
      });
      assert.equal(retry.accepted, true);
      if (retry.accepted) {
        assert.equal(retry.duplicate, false);
        assert.deepEqual(retry.result, { recovered: true });
      }
      assert.equal(attempts, 2);
    });

    it('returns 409 while another worker holds the event id, then accepts after release', async () => {
      const fixture = createWebhookReplayAttackFixtures().find((f) => f.scenario === 'in_progress')!;
      const store = new MemoryIdempotencyStore();
      const now = new Date();
      const fingerprint = createHash('sha256').update(fixture.firstBody).digest('hex');

      const lock = await store.begin({
        scope: 'webhook:stripe',
        key: fixture.eventId,
        fingerprint,
        now,
        ttlMs: 7 * 24 * 60 * 60 * 1000,
        lockMs: 60 * 1000,
      });
      assert.equal(lock.kind, 'new');

      const inProgress = await runWebhook(store, replayInput(fixture, false), { now });
      assert.equal(inProgress.accepted, false);
      if (!inProgress.accepted) {
        assert.equal(inProgress.status, 409);
        assert.equal(inProgress.code, 'WEBHOOK_EVENT_IN_PROGRESS');
      }

      await store.release('webhook:stripe', fixture.eventId);
      const retried = await runWebhook(store, replayInput(fixture, false), { now });
      assert.equal(retried.accepted, true);
    });

    it('returns 410 after the seven-day event-id retention window', async () => {
      const fixture = createWebhookReplayAttackFixtures().find((f) => f.scenario === 'expired')!;
      const store = new MemoryIdempotencyStore();
      const now = new Date();
      const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
      const fingerprint = createHash('sha256').update(fixture.firstBody).digest('hex');
      const timestamp = String(Math.floor(now.getTime() / 1000));
      const signature = signWebhookPayload(fixture.firstBody, fixture.secret, timestamp);

      await store.begin({
        scope: 'webhook:stripe',
        key: fixture.eventId,
        fingerprint,
        now: eightDaysAgo,
        ttlMs: 7 * 24 * 60 * 60 * 1000,
        lockMs: 60 * 1000,
      });

      const expired = await runWebhook(
        store,
        { ...replayInput(fixture, false), timestamp, signature },
        { now }
      );
      assert.equal(expired.accepted, false);
      if (!expired.accepted) {
        assert.equal(expired.status, 410);
        assert.equal(expired.code, 'WEBHOOK_EVENT_ID_EXPIRED');
      }
    });
  });

  describe('authorization path', () => {
    it('rejects a forged signature before storing or handling the event', async () => {
      const fixture = createMalformedWebhookPayloadFixtures().find((f) => f.name === 'forged signature')!;
      const store = new MemoryIdempotencyStore();
      let handled = false;

      const result = await runWebhook(store, malformedInput(fixture), {
        handle: () => {
          handled = true;
          return { ok: true };
        },
      });
      assert.equal(result.accepted, false);
      if (!result.accepted) assert.equal(result.code, 'WEBHOOK_SIGNATURE_INVALID');
      assert.equal(handled, false);
      assert.equal(store.size(), 0);
    });

    it('rejects a stale timestamp replay even when the HMAC is correct', async () => {
      const fixture = createMalformedWebhookPayloadFixtures().find((f) => f.name === 'stale timestamp replay')!;
      const store = new MemoryIdempotencyStore();

      const result = await runWebhook(store, malformedInput(fixture));
      assert.equal(result.accepted, false);
      if (!result.accepted) assert.equal(result.code, 'WEBHOOK_SIGNATURE_INVALID');
      assert.equal(store.size(), 0);
    });

    it('rejects the same event id when a different payload is signed', async () => {
      const fixture = createWebhookReplayAttackFixtures().find((f) => f.scenario === 'conflict')!;
      const store = new MemoryIdempotencyStore();

      const first = await runWebhook(store, replayInput(fixture, false));
      assert.equal(first.accepted, true);

      const conflict = await runWebhook(store, replayInput(fixture, true));
      assert.equal(conflict.accepted, false);
      if (!conflict.accepted) {
        assert.equal(conflict.status, 422);
        assert.equal(conflict.code, 'WEBHOOK_EVENT_ID_CONFLICT');
      }
    });
  });
});
