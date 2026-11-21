import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHmac } from 'crypto';

import { createWebhookMiddleware } from '../src/webhooks/webhook-middleware';
import { MemoryReplayStore } from '../src/webhooks/replay-store';

// Issue #430: webhook deduplication recovery (release on failure, authorization
// ordering, replay-window expiry). Written for node:test; not executed here.

const SECRET = 'test-webhook-secret-key';
const PAYLOAD = JSON.stringify({ type: 'invoice.paid', invoiceId: '123' });
const config = { signingSecret: SECRET, toleranceSeconds: 300, replayWindowMs: 5 * 60 * 1000 };

function sign(payload: string, timestamp: string, secret: string = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(timestamp + '.' + payload).digest('hex');
}

function nowTs(): string {
  return String(Math.floor(Date.now() / 1000));
}

function delivery(eventId: string, opts: { signature?: string; timestamp?: string } = {}) {
  const timestamp = opts.timestamp ?? nowTs();
  const signature = opts.signature ?? sign(PAYLOAD, timestamp);
  const headers: Record<string, string> = {
    'x-webhook-signature': signature,
    'x-webhook-timestamp': timestamp,
    'x-webhook-event-id': eventId,
  };
  const state: { status?: number; json?: any; nextCalled: boolean } = { nextCalled: false };
  const req: any = { headers, body: JSON.parse(PAYLOAD) };
  const res: any = {
    status(code: number) { state.status = code; return res; },
    json(body: unknown) { state.json = body; return res; },
  };
  const next = () => { state.nextCalled = true; };
  return { req, res, next, state };
}

describe('webhook replay release (#430)', () => {
  describe('normal path', () => {
    it('accepts the first delivery and reserves the event ID', () => {
      const middleware = createWebhookMiddleware(config, new MemoryReplayStore());
      const first = delivery('evt-n1');
      middleware(first.req, first.res, first.next);
      assert.strictEqual(first.state.nextCalled, true);
      assert.strictEqual(first.req.webhookEventId, 'evt-n1');
      assert.strictEqual(typeof first.req.releaseWebhookEvent, 'function');
    });
  });

  describe('failure and retry path', () => {
    it('rejects a duplicate with 409 while the first handling is not released', () => {
      const middleware = createWebhookMiddleware(config, new MemoryReplayStore());
      middleware(delivery('evt-f1').req, delivery('evt-f1').res, () => {});
      const second = delivery('evt-f1');
      middleware(second.req, second.res, () => { throw new Error('should not call next'); });
      assert.strictEqual(second.state.status, 409);
      assert.strictEqual(second.state.json.code, 'DUPLICATE_EVENT');
    });

    it('accepts the provider redelivery after the failed handling releases the event ID', () => {
      const middleware = createWebhookMiddleware(config, new MemoryReplayStore());
      const first = delivery('evt-f2');
      middleware(first.req, first.res, first.next);
      assert.strictEqual(first.state.nextCalled, true);

      // Simulate handler failure: the route calls the release hook.
      first.req.releaseWebhookEvent();

      const retry = delivery('evt-f2');
      middleware(retry.req, retry.res, retry.next);
      assert.strictEqual(retry.state.nextCalled, true);
      assert.strictEqual(retry.state.status, undefined);
    });

    it('release is idempotent and safe for unknown event IDs', () => {
      const store = new MemoryReplayStore();
      assert.doesNotThrow(() => store.release('never-seen'));
      const middleware = createWebhookMiddleware(config, store);
      const first = delivery('evt-f3');
      middleware(first.req, first.res, first.next);
      first.req.releaseWebhookEvent();
      first.req.releaseWebhookEvent();
      const retry = delivery('evt-f3');
      middleware(retry.req, retry.res, retry.next);
      assert.strictEqual(retry.state.nextCalled, true);
    });

    it('a release does not free other event IDs', () => {
      const middleware = createWebhookMiddleware(config, new MemoryReplayStore());
      const a = delivery('evt-f4a');
      const b = delivery('evt-f4b');
      middleware(a.req, a.res, a.next);
      middleware(b.req, b.res, b.next);
      a.req.releaseWebhookEvent();
      const dupB = delivery('evt-f4b');
      middleware(dupB.req, dupB.res, () => { throw new Error('should not call next'); });
      assert.strictEqual(dupB.state.status, 409);
    });
  });

  describe('authorization path', () => {
    it('a bad signature does not reserve the event ID, so the genuine delivery still succeeds', () => {
      const middleware = createWebhookMiddleware(config, new MemoryReplayStore());
      const forged = delivery('evt-a1', { signature: 'sha256=' + '0'.repeat(64) });
      middleware(forged.req, forged.res, () => { throw new Error('should not call next'); });
      assert.strictEqual(forged.state.status, 401);
      assert.strictEqual(forged.state.json.code, 'INVALID_SIGNATURE');

      const genuine = delivery('evt-a1');
      middleware(genuine.req, genuine.res, genuine.next);
      assert.strictEqual(genuine.state.nextCalled, true);
    });

    it('a stale timestamp does not reserve the event ID', () => {
      const middleware = createWebhookMiddleware(config, new MemoryReplayStore());
      const staleTs = String(Math.floor(Date.now() / 1000) - 600);
      const stale = delivery('evt-a2', { timestamp: staleTs, signature: sign(PAYLOAD, staleTs) });
      middleware(stale.req, stale.res, () => { throw new Error('should not call next'); });
      assert.strictEqual(stale.state.status, 408);

      const fresh = delivery('evt-a2');
      middleware(fresh.req, fresh.res, fresh.next);
      assert.strictEqual(fresh.state.nextCalled, true);
    });

    it('a wrong-secret signature cannot release or consume an event reserved by a genuine delivery', () => {
      const store = new MemoryReplayStore();
      const middleware = createWebhookMiddleware(config, store);
      const genuine = delivery('evt-a3');
      middleware(genuine.req, genuine.res, genuine.next);

      const forged = delivery('evt-a3', { signature: sign(PAYLOAD, nowTs(), 'wrong-secret') });
      middleware(forged.req, forged.res, () => { throw new Error('should not call next'); });
      assert.strictEqual(forged.state.status, 401);
      assert.strictEqual(store.has('evt-a3'), true);
    });
  });

  describe('recovery path', () => {
    it('an event ID becomes reusable once the replay window has expired', async () => {
      const middleware = createWebhookMiddleware(
        config,
        new MemoryReplayStore({ replayWindowMs: 20 })
      );
      const first = delivery('evt-r1');
      middleware(first.req, first.res, first.next);
      assert.strictEqual(first.state.nextCalled, true);

      await new Promise((resolve) => setTimeout(resolve, 40));

      const later = delivery('evt-r1');
      middleware(later.req, later.res, later.next);
      assert.strictEqual(later.state.nextCalled, true);
    });
  });
});
