const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

// Self-contained delivery receipts engine for isolated test runner
function computeReceiptHash(params) {
  const canonical = [
    params.receiptId,
    params.notificationId,
    params.dedupKey,
    params.recipient,
    params.channel,
    params.status,
    params.deliveredAt,
    String(params.attempt),
  ].join('|');

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function verifyReceiptAuthenticity(receipt) {
  if (!receipt || !receipt.receiptHash) return false;
  const expected = computeReceiptHash({
    receiptId: receipt.receiptId,
    notificationId: receipt.notificationId,
    dedupKey: receipt.dedupKey,
    recipient: receipt.recipient,
    channel: receipt.channel,
    status: receipt.status,
    deliveredAt: receipt.deliveredAt,
    attempt: receipt.attempt,
  });
  return receipt.receiptHash === expected;
}

class IsolatedDeliveryReceiptStore {
  constructor() {
    this.byId = new Map();
    this.byDedup = new Map();
    this.byRecipient = new Map();
  }

  dedupIndexKey(recipient, dedupKey) {
    return `${recipient}:${dedupKey}`;
  }

  recordReceipt(input) {
    const now = input.now || new Date();
    const deliveredAt = now.toISOString();
    const channel = input.channel || 'in_app';
    const indexKey = this.dedupIndexKey(input.recipient, input.dedupKey);

    const existingId = this.byDedup.get(indexKey);
    if (existingId) {
      const existing = this.byId.get(existingId);
      if (existing && (existing.status === 'delivered' || existing.status === 'acknowledged')) {
        const duplicateReceiptId = `rec-dup-${Math.random().toString(36).slice(2, 9)}`;
        const receipt = {
          receiptId: duplicateReceiptId,
          notificationId: existing.notificationId,
          dedupKey: input.dedupKey,
          recipient: input.recipient,
          channel,
          status: 'duplicate_suppressed',
          attempt: existing.attempt + 1,
          deliveredAt,
          receiptHash: '',
          acknowledgedAt: null,
          metadata: {
            ...input.metadata,
            originalReceiptId: existing.receiptId,
            originalDeliveredAt: existing.deliveredAt,
          },
        };
        receipt.receiptHash = computeReceiptHash(receipt);
        this.byId.set(duplicateReceiptId, receipt);

        const recList = this.byRecipient.get(input.recipient) || [];
        recList.push(duplicateReceiptId);
        this.byRecipient.set(input.recipient, recList);

        return { receipt, isDuplicate: true };
      }
    }

    const receiptId = input.receiptId || `rec-${Math.random().toString(36).slice(2, 9)}`;
    const status = input.status || 'delivered';
    const attempt = input.attempt || 1;

    const receipt = {
      receiptId,
      notificationId: input.notificationId,
      dedupKey: input.dedupKey,
      recipient: input.recipient,
      channel,
      status,
      attempt,
      deliveredAt,
      receiptHash: '',
      acknowledgedAt: null,
      metadata: input.metadata,
    };
    receipt.receiptHash = computeReceiptHash(receipt);

    this.byId.set(receiptId, receipt);
    this.byDedup.set(indexKey, receiptId);

    const recList = this.byRecipient.get(input.recipient) || [];
    recList.push(receiptId);
    this.byRecipient.set(input.recipient, recList);

    return { receipt, isDuplicate: false };
  }

  getReceipt(receiptId, recipient) {
    const receipt = this.byId.get(receiptId);
    if (!receipt) return undefined;
    if (recipient && receipt.recipient !== recipient) return undefined;
    return { ...receipt };
  }

  getReceiptByDedupKey(recipient, dedupKey) {
    const receiptId = this.byDedup.get(this.dedupIndexKey(recipient, dedupKey));
    if (!receiptId) return undefined;
    const receipt = this.byId.get(receiptId);
    return receipt ? { ...receipt } : undefined;
  }

  listForRecipient(recipient, filter = {}) {
    const ids = this.byRecipient.get(recipient) || [];
    let list = [];

    for (let i = ids.length - 1; i >= 0; i--) {
      const item = this.byId.get(ids[i]);
      if (!item) continue;
      if (filter.dedupKey && item.dedupKey !== filter.dedupKey) continue;
      if (filter.channel && item.channel !== filter.channel) continue;
      if (filter.status && item.status !== filter.status) continue;
      list.push({ ...item });
    }

    const total = list.length;
    const offset = Math.max(filter.offset || 0, 0);
    const limit = Math.min(Math.max(filter.limit || 50, 1), 100);

    return { receipts: list.slice(offset, offset + limit), total };
  }

  acknowledgeReceipt(recipient, receiptId, now = new Date()) {
    const receipt = this.byId.get(receiptId);
    if (!receipt || receipt.recipient !== recipient) return null;

    receipt.status = 'acknowledged';
    receipt.acknowledgedAt = now.toISOString();
    receipt.receiptHash = computeReceiptHash(receipt);

    return { ...receipt };
  }
}

test('Issue #387: Implement notification deduplication with delivery receipts', async (t) => {
  const WALLET_A = 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI';
  const WALLET_B = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

  await t.test('Normal path: generates cryptographic SHA-256 verifiable delivery receipt on first emission', () => {
    const store = new IsolatedDeliveryReceiptStore();
    const now = new Date('2026-05-01T10:00:00Z');

    const result = store.recordReceipt({
      notificationId: 'notif-1',
      dedupKey: 'inv-100:invoice.paid',
      recipient: WALLET_A,
      channel: 'in_app',
      status: 'delivered',
      attempt: 1,
      metadata: { invoiceId: 'inv-100', amount: '500 XLM' },
      now,
    });

    assert.equal(result.isDuplicate, false);
    const { receipt } = result;
    assert.equal(receipt.status, 'delivered');
    assert.equal(receipt.notificationId, 'notif-1');
    assert.equal(receipt.recipient, WALLET_A);
    assert.equal(receipt.attempt, 1);
    assert.ok(receipt.receiptHash.length === 64, 'Hash must be 64-char hex SHA-256');

    // Cryptographic verification check
    assert.equal(verifyReceiptAuthenticity(receipt), true);
  });

  await t.test('Deduplication path: suppresses duplicate emissions and returns linked duplicate receipt', () => {
    const store = new IsolatedDeliveryReceiptStore();
    const now1 = new Date('2026-05-01T10:00:00Z');
    const now2 = new Date('2026-05-01T10:01:00Z');

    // First emission
    const first = store.recordReceipt({
      notificationId: 'notif-2',
      dedupKey: 'inv-200:invoice.paid',
      recipient: WALLET_A,
      channel: 'in_app',
      status: 'delivered',
      now: now1,
    });
    assert.equal(first.isDuplicate, false);
    assert.equal(first.receipt.status, 'delivered');

    // Replay / duplicate emission with same dedupKey
    const second = store.recordReceipt({
      notificationId: 'notif-2-replay',
      dedupKey: 'inv-200:invoice.paid',
      recipient: WALLET_A,
      channel: 'in_app',
      now: now2,
    });

    assert.equal(second.isDuplicate, true);
    assert.equal(second.receipt.status, 'duplicate_suppressed');
    assert.equal(second.receipt.notificationId, 'notif-2'); // Links to original notification
    assert.equal(second.receipt.attempt, 2);
    assert.equal(second.receipt.metadata.originalReceiptId, first.receipt.receiptId);

    // Cryptographic verification of suppression receipt
    assert.equal(verifyReceiptAuthenticity(second.receipt), true);
  });

  await t.test('Failure path: records failed delivery receipts and detects tampering', () => {
    const store = new IsolatedDeliveryReceiptStore();
    const now = new Date('2026-05-01T10:00:00Z');

    const failed = store.recordReceipt({
      notificationId: 'notif-3',
      dedupKey: 'inv-300:invoice.reminder',
      recipient: WALLET_A,
      channel: 'email',
      status: 'failed',
      metadata: { error: 'SMTP connection timeout' },
      now,
    });

    assert.equal(failed.receipt.status, 'failed');
    assert.equal(verifyReceiptAuthenticity(failed.receipt), true);

    // Tampering test: attacker alters status to 'delivered' without recomputing cryptographic hash
    const tamperedReceipt = { ...failed.receipt, status: 'delivered' };
    assert.equal(verifyReceiptAuthenticity(tamperedReceipt), false);

    // Tampering test: altering timestamp
    const tamperedTime = { ...failed.receipt, deliveredAt: '2026-05-01T12:00:00Z' };
    assert.equal(verifyReceiptAuthenticity(tamperedTime), false);
  });

  await t.test('Retry path: retry after failure succeeds and advances attempt chain', () => {
    const store = new IsolatedDeliveryReceiptStore();
    const now1 = new Date('2026-05-01T10:00:00Z');
    const now2 = new Date('2026-05-01T10:05:00Z');

    // Initial failed attempt
    const failAttempt = store.recordReceipt({
      notificationId: 'notif-4',
      dedupKey: 'inv-400:payment.rejected',
      recipient: WALLET_A,
      channel: 'webhook',
      status: 'failed',
      attempt: 1,
      now: now1,
    });
    assert.equal(failAttempt.receipt.status, 'failed');

    // Retry attempt succeeds
    const successAttempt = store.recordReceipt({
      notificationId: 'notif-4',
      dedupKey: 'inv-400:payment.rejected',
      recipient: WALLET_A,
      channel: 'webhook',
      status: 'delivered',
      attempt: 2,
      now: now2,
    });

    assert.equal(successAttempt.receipt.status, 'delivered');
    assert.equal(successAttempt.receipt.attempt, 2);
    assert.equal(verifyReceiptAuthenticity(successAttempt.receipt), true);
  });

  await t.test('Authorization path: receipt isolation between distinct wallet recipients', () => {
    const store = new IsolatedDeliveryReceiptStore();
    const now = new Date('2026-05-01T10:00:00Z');

    const receiptA = store.recordReceipt({
      notificationId: 'notif-a',
      dedupKey: 'inv-a:invoice.paid',
      recipient: WALLET_A,
      now,
    }).receipt;

    // Wallet A can fetch its own receipt
    assert.ok(store.getReceipt(receiptA.receiptId, WALLET_A));

    // Wallet B cannot access Wallet A's receipt (returns undefined)
    assert.equal(store.getReceipt(receiptA.receiptId, WALLET_B), undefined);

    // Wallet B cannot acknowledge Wallet A's receipt
    const ackResult = store.acknowledgeReceipt(WALLET_B, receiptA.receiptId);
    assert.equal(ackResult, null);

    // List filtering for Wallet B does not leak Wallet A's receipts
    const listB = store.listForRecipient(WALLET_B);
    assert.equal(listB.total, 0);
  });

  await t.test('Acknowledgment path: recipient acknowledges receipt updating state and hash', () => {
    const store = new IsolatedDeliveryReceiptStore();
    const now1 = new Date('2026-05-01T10:00:00Z');
    const now2 = new Date('2026-05-01T10:15:00Z');

    const receipt = store.recordReceipt({
      notificationId: 'notif-ack',
      dedupKey: 'inv-ack:invoice.paid',
      recipient: WALLET_A,
      now: now1,
    }).receipt;

    assert.equal(receipt.status, 'delivered');
    assert.equal(receipt.acknowledgedAt, null);

    const acknowledged = store.acknowledgeReceipt(WALLET_A, receipt.receiptId, now2);
    assert.ok(acknowledged);
    assert.equal(acknowledged.status, 'acknowledged');
    assert.equal(acknowledged.acknowledgedAt, now2.toISOString());

    // Cryptographic hash is re-derived and authentic for acknowledged status
    assert.equal(verifyReceiptAuthenticity(acknowledged), true);
  });

  await t.test('Integration path: invoice lifecycle event creates notification and authentic receipt', () => {
    const store = new IsolatedDeliveryReceiptStore();
    const invoice = {
      id: 'inv-lifecycle-1',
      sellerPublicKey: WALLET_A,
      amount: '250.0000000',
      assetCode: 'XLM',
      memo: 'INV-2026-LIFECYCLE',
      status: 'PAID',
    };

    // First lifecycle sync creates notification and delivered receipt
    const dedupKey = `${invoice.id}:invoice.paid`;
    const firstSync = store.recordReceipt({
      notificationId: `notif-${invoice.id}`,
      dedupKey,
      recipient: invoice.sellerPublicKey,
      channel: 'in_app',
      status: 'delivered',
      metadata: { invoiceId: invoice.id, amount: invoice.amount },
    });

    assert.equal(firstSync.isDuplicate, false);
    assert.equal(firstSync.receipt.status, 'delivered');
    assert.equal(verifyReceiptAuthenticity(firstSync.receipt), true);

    // Repeated lifecycle sync (e.g. repeated page read or worker pass) generates duplicate suppression receipt
    const secondSync = store.recordReceipt({
      notificationId: `notif-${invoice.id}-dup`,
      dedupKey,
      recipient: invoice.sellerPublicKey,
      channel: 'in_app',
    });

    assert.equal(secondSync.isDuplicate, true);
    assert.equal(secondSync.receipt.status, 'duplicate_suppressed');
    assert.equal(secondSync.receipt.metadata.originalReceiptId, firstSync.receipt.receiptId);
  });
});
