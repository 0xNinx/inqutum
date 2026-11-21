/**
 * Malformed payload and replay-attack fixtures for webhook ingestion (#356).
 *
 * These fixtures are deterministic inputs for `processWebhook` and the
 * signature verifier. They cover malformed headers, malformed JSON, forged or
 * stale signatures, duplicate delivery, conflicting payloads and expired
 * event-id records. None of them perform I/O; tests wire them into the memory
 * idempotency store.
 */

import { signWebhookPayload } from '../webhooks/webhook-verification';

export const MALFORMED_WEBHOOK_SECRET = 'malformed_payload_fixture_secret_2026';

export interface MalformedWebhookPayloadFixture {
  name: string;
  provider: string;
  eventId: string;
  rawBody: string;
  secret: string;
  timestamp: string;
  signature: string;
  expected: { status: 400 | 401 | 409 | 410 | 422 | 503; code: string };
}

export type ReplayScenario = 'duplicate' | 'conflict' | 'expired' | 'in_progress';

export interface WebhookReplayAttackFixture {
  name: string;
  scenario: ReplayScenario;
  provider: string;
  eventId: string;
  secret: string;
  firstBody: string;
  secondBody: string;
  timestamp: string;
  firstSignature: string;
  secondSignature: string;
  expected:
    | { accepted: true; duplicate: boolean }
    | { accepted: false; status: 400 | 401 | 409 | 410 | 422 | 503; code: string };
}

function timestampSeconds(offsetSeconds = 0): string {
  return String(Math.floor(Date.now() / 1000) + offsetSeconds);
}

export function createMalformedWebhookPayloadFixtures(): MalformedWebhookPayloadFixture[] {
  const provider = 'stripe';
  const eventId = 'evt_malformed_001';
  const rawBody = JSON.stringify({ event: 'invoice.paid', invoiceId: 'inv-malformed-001' });
  const timestamp = timestampSeconds();
  const signature = signWebhookPayload(rawBody, MALFORMED_WEBHOOK_SECRET, timestamp);
  const staleTimestamp = timestampSeconds(-600);

  return [
    {
      name: 'missing provider',
      provider: '',
      eventId,
      rawBody,
      secret: MALFORMED_WEBHOOK_SECRET,
      timestamp,
      signature,
      expected: { status: 400, code: 'WEBHOOK_EVENT_ID_INVALID' },
    },
    {
      name: 'missing event id',
      provider,
      eventId: '',
      rawBody,
      secret: MALFORMED_WEBHOOK_SECRET,
      timestamp,
      signature,
      expected: { status: 400, code: 'WEBHOOK_EVENT_ID_INVALID' },
    },
    {
      name: 'oversized event id',
      provider,
      eventId: 'e'.repeat(256),
      rawBody,
      secret: MALFORMED_WEBHOOK_SECRET,
      timestamp,
      signature,
      expected: { status: 400, code: 'WEBHOOK_EVENT_ID_INVALID' },
    },
    {
      name: 'malformed JSON body',
      provider,
      eventId,
      rawBody: '{"event":',
      secret: MALFORMED_WEBHOOK_SECRET,
      timestamp,
      signature,
      expected: { status: 401, code: 'WEBHOOK_SIGNATURE_INVALID' },
    },
    {
      name: 'missing signature header',
      provider,
      eventId,
      rawBody,
      secret: MALFORMED_WEBHOOK_SECRET,
      timestamp,
      signature: '',
      expected: { status: 401, code: 'WEBHOOK_SIGNATURE_INVALID' },
    },
    {
      name: 'forged signature',
      provider,
      eventId,
      rawBody,
      secret: MALFORMED_WEBHOOK_SECRET,
      timestamp,
      signature: 'sha256=' + '0'.repeat(64),
      expected: { status: 401, code: 'WEBHOOK_SIGNATURE_INVALID' },
    },
    {
      name: 'stale timestamp replay',
      provider,
      eventId,
      rawBody,
      secret: MALFORMED_WEBHOOK_SECRET,
      timestamp: staleTimestamp,
      signature: signWebhookPayload(rawBody, MALFORMED_WEBHOOK_SECRET, staleTimestamp),
      expected: { status: 401, code: 'WEBHOOK_SIGNATURE_INVALID' },
    },
  ];
}

export function createWebhookReplayAttackFixtures(): WebhookReplayAttackFixture[] {
  const provider = 'stripe';
  const timestamp = timestampSeconds();
  const eventId = 'evt_replay_001';
  const firstBody = JSON.stringify({ event: 'invoice.paid', invoiceId: 'inv-replay-001', amount: '10.0000000' });
  const conflictingBody = JSON.stringify({ event: 'invoice.paid', invoiceId: 'inv-replay-001', amount: '999.0000000' });
  const secondEventId = 'evt_replay_002';
  const secondBody = JSON.stringify({ event: 'invoice.paid', invoiceId: 'inv-replay-002', amount: '20.0000000' });

  return [
    {
      name: 'duplicate delivery',
      scenario: 'duplicate',
      provider,
      eventId,
      secret: MALFORMED_WEBHOOK_SECRET,
      firstBody,
      secondBody: firstBody,
      timestamp,
      firstSignature: signWebhookPayload(firstBody, MALFORMED_WEBHOOK_SECRET, timestamp),
      secondSignature: signWebhookPayload(firstBody, MALFORMED_WEBHOOK_SECRET, timestamp),
      expected: { accepted: true, duplicate: true },
    },
    {
      name: 'same event id with different payload',
      scenario: 'conflict',
      provider,
      eventId,
      secret: MALFORMED_WEBHOOK_SECRET,
      firstBody,
      secondBody: conflictingBody,
      timestamp,
      firstSignature: signWebhookPayload(firstBody, MALFORMED_WEBHOOK_SECRET, timestamp),
      secondSignature: signWebhookPayload(conflictingBody, MALFORMED_WEBHOOK_SECRET, timestamp),
      expected: { accepted: false, status: 422, code: 'WEBHOOK_EVENT_ID_CONFLICT' },
    },
    {
      name: 'expired event id record',
      scenario: 'expired',
      provider,
      eventId: secondEventId,
      secret: MALFORMED_WEBHOOK_SECRET,
      firstBody: secondBody,
      secondBody,
      timestamp,
      firstSignature: signWebhookPayload(secondBody, MALFORMED_WEBHOOK_SECRET, timestamp),
      secondSignature: signWebhookPayload(secondBody, MALFORMED_WEBHOOK_SECRET, timestamp),
      expected: { accepted: false, status: 410, code: 'WEBHOOK_EVENT_ID_EXPIRED' },
    },
    {
      name: 'event id held by an in-flight worker',
      scenario: 'in_progress',
      provider,
      eventId: 'evt_replay_003',
      secret: MALFORMED_WEBHOOK_SECRET,
      firstBody: JSON.stringify({ event: 'invoice.paid', invoiceId: 'inv-replay-003' }),
      secondBody: JSON.stringify({ event: 'invoice.paid', invoiceId: 'inv-replay-003' }),
      timestamp,
      firstSignature: signWebhookPayload(
        JSON.stringify({ event: 'invoice.paid', invoiceId: 'inv-replay-003' }),
        MALFORMED_WEBHOOK_SECRET,
        timestamp
      ),
      secondSignature: signWebhookPayload(
        JSON.stringify({ event: 'invoice.paid', invoiceId: 'inv-replay-003' }),
        MALFORMED_WEBHOOK_SECRET,
        timestamp
      ),
      expected: { accepted: false, status: 409, code: 'WEBHOOK_EVENT_IN_PROGRESS' },
    },
  ];
}

export const MalformedPayloadFixtures = {
  webhook: createMalformedWebhookPayloadFixtures,
  replay: createWebhookReplayAttackFixtures,
};
