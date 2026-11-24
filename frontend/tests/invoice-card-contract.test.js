const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  INVOICE_CARD_COPY,
  resolvePaymentUrl,
  resolveEmailRecipient,
  resolveInvoiceCardViewModel,
  resolveCopyToast,
  resolveExportToast,
} = require('../lib/invoice-card-contract');

const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'InvoiceCard.tsx'), 'utf8');

const PENDING = {
  id: 'inv/1042',
  status: 'PENDING',
  expiresAt: '2030-01-01T00:00:00.000Z',
  customerEmail: 'client@example.com',
};
const PAID = { ...PENDING, status: 'PAID' };

test('success: a pending invoice offers only a safe copy-link action', () => {
  const view = resolveInvoiceCardViewModel(PENDING, { origin: 'https://quittance.app/' });
  assert.equal(view.status, 'PENDING');
  assert.equal(view.paymentUrl, 'https://quittance.app/pay/inv%2F1042');
  assert.equal(view.canCopyLink, true);
  assert.equal(view.canDownloadProof, false);
  assert.equal(view.canEmailProof, false);
});

test('success: a paid invoice offers proof download and a verified recipient', () => {
  const view = resolveInvoiceCardViewModel(PAID);
  assert.equal(view.canDownloadProof, true);
  assert.equal(view.canEmailProof, true);
  assert.equal(view.emailProofLabel, INVOICE_CARD_COPY.emailProof);
  assert.equal(view.canCopyLink, false);
  assert.equal(view.paymentUrl, '/pay/inv%2F1042');
});

test('validation: missing ids, unknown statuses and bad recipients fail closed', () => {
  for (const invoice of [null, undefined, 'broken', {}, { id: '  ', status: 'PENDING' }]) {
    const view = resolveInvoiceCardViewModel(invoice);
    assert.equal(view.paymentUrl, null);
    assert.equal(view.canCopyLink, false);
    assert.equal(view.canEmailProof, false);
  }
  const unknown = resolveInvoiceCardViewModel({ id: 'inv1', status: 'REFUNDED' });
  assert.equal(unknown.status, 'REFUNDED');
  assert.equal(unknown.canCopyLink, false);
  assert.equal(unknown.canDownloadProof, false);
  assert.equal(resolveEmailRecipient('not-an-email'), null);
  assert.equal(resolveInvoiceCardViewModel({ ...PAID, customerEmail: 'bad' }).emailProofLabel, INVOICE_CARD_COPY.noEmail);
});

test('retry: a retryable export failure shows its recovery action as guidance', () => {
  const feedback = resolveExportToast(
    {
      ok: false,
      code: 'EXPORT_POPUP_BLOCKED',
      message: 'Pop-up blocked.',
      retryable: true,
      recoveryAction: 'Allow pop-ups, then retry.',
    },
    INVOICE_CARD_COPY.proofSuccess
  );
  assert.equal(feedback.kind, 'error');
  assert.equal(feedback.message, 'Pop-up blocked.');
  assert.equal(feedback.description, 'Allow pop-ups, then retry.');
});

test('validation: a terminal failure keeps its code but offers no misleading retry', () => {
  const feedback = resolveExportToast({
    ok: false,
    code: 'EXPORT_PROOF_UNAVAILABLE',
    message: 'Payment proof is available only after the invoice is paid',
    retryable: false,
    recoveryAction: 'Share the payment link instead.',
  });
  assert.equal(feedback.kind, 'error');
  assert.equal(feedback.description, undefined);
  const codeOnly = resolveExportToast({ ok: false, code: 'EXPORT_FAILED' });
  assert.equal(codeOnly.message, 'EXPORT_FAILED');
  assert.equal(codeOnly.description, INVOICE_CARD_COPY.degradedRecovery);
});

test('degraded dependency: absent export results and clipboard failures are explicit', () => {
  assert.deepEqual(resolveCopyToast(true), { kind: 'success', message: INVOICE_CARD_COPY.copySuccess });
  assert.deepEqual(resolveCopyToast(false), { kind: 'error', message: INVOICE_CARD_COPY.copyFailure });
  const missing = resolveExportToast(undefined, INVOICE_CARD_COPY.emailSuccess);
  assert.equal(missing.kind, 'error');
  assert.equal(missing.message, INVOICE_CARD_COPY.degradedExport);
  assert.equal(missing.description, INVOICE_CARD_COPY.degradedRecovery);
  const thrown = resolveExportToast({ ok: false, message: null, retryable: true, recoveryAction: null });
  assert.equal(thrown.message, INVOICE_CARD_COPY.degradedExport);
  assert.equal(thrown.description, INVOICE_CARD_COPY.degradedRecovery);
});

test('component: actions and feedback are gated by the shared contract', () => {
  assert.match(source, /resolveInvoiceCardViewModel\(invoice, \{/);
  assert.match(source, /typeof window === 'undefined'/);
  assert.match(source, /view\.canCopyLink/);
  assert.match(source, /view\.canDownloadProof/);
  assert.match(source, /view\.canEmailProof/);
  assert.match(source, /resolveExportToast\(openInvoicePDF/);
  assert.match(source, /resolveExportToast\(shareInvoiceByEmail/);
  assert.match(source, /resolveCopyToast\(await copyToClipboard\(view\.paymentUrl\)\)/);
  assert.doesNotMatch(source, /window\.location\.origin\}\/pay/);
  assert.doesNotMatch(source, /!invoice\.customerEmail/);
});
