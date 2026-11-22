'use strict';

/**
 * InvoiceCard action and feedback contract (issue #160).
 *
 * The card offers actions with real consequences: copying a payment link,
 * opening a payment proof and emailing a client. Actions are gated on the
 * effective lifecycle status and on the record actually carrying the data the
 * action needs. A degraded or malformed export result becomes an explicit,
 * bounded toast with the shared retry guidance instead of a silent no-op.
 */

const INVOICE_CARD_COPY = Object.freeze({
  copySuccess: 'Invoice link copied',
  copyFailure: 'Could not copy invoice link',
  proofSuccess: 'Opening payment proof',
  emailSuccess: 'Opening email',
  noEmail: 'No client email on this invoice',
  emailProof: 'Email Proof',
  unknownStatus: 'Invoice status is unavailable',
  degradedExport: 'This action is unavailable right now. Try again.',
  degradedRecovery: 'Reload the invoice and retry.',
});

function safeText(value, maxLength) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : null;
}

/** SSR-safe payment URL. A missing id has no safe link, so copy is disabled. */
function resolvePaymentUrl(invoiceId, origin) {
  const id = safeText(invoiceId, 200);
  if (!id) return null;
  const path = `/pay/${encodeURIComponent(id)}`;
  const safeOrigin =
    typeof origin === 'string' && /^https?:\/\/[^\s]+$/.test(origin.trim())
      ? origin.trim().replace(/\/$/, '')
      : '';
  return `${safeOrigin}${path}`;
}

function resolveEmailRecipient(email) {
  const value = safeText(email, 254);
  return value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

function resolveInvoiceCardViewModel(invoice, options) {
  const input = options && typeof options === 'object' ? options : {};
  const record = invoice && typeof invoice === 'object' ? invoice : {};
  const status = safeText(input.status ?? record.status, 40) || INVOICE_CARD_COPY.unknownStatus;
  const paymentUrl = resolvePaymentUrl(record.id, input.origin);
  const recipient = resolveEmailRecipient(record.customerEmail);

  return {
    status,
    paymentUrl,
    canCopyLink: status === 'PENDING' && Boolean(paymentUrl),
    canDownloadProof: status === 'PAID',
    canEmailProof: status === 'PAID' && Boolean(recipient),
    emailProofLabel: recipient ? INVOICE_CARD_COPY.emailProof : INVOICE_CARD_COPY.noEmail,
  };
}

function resolveToast(kind, message, description) {
  return {
    kind,
    message,
    ...(description ? { description } : {}),
  };
}

function resolveCopyToast(success) {
  return resolveToast(
    success ? 'success' : 'error',
    success ? INVOICE_CARD_COPY.copySuccess : INVOICE_CARD_COPY.copyFailure
  );
}

/** Maps the shared export envelope to the toast the card can safely show. */
function resolveExportToast(result, successMessage) {
  if (result && result.ok) {
    return resolveToast('success', safeText(successMessage, 120) || INVOICE_CARD_COPY.proofSuccess);
  }
  const message =
    safeText(result?.message, 280) ||
    (result && result.code ? safeText(result.code, 80) : null) ||
    INVOICE_CARD_COPY.degradedExport;
  const recovery = safeText(result?.recoveryAction, 280) || INVOICE_CARD_COPY.degradedRecovery;
  // An envelope without an explicit retryable flag is treated as degraded:
  // offer the recovery step rather than dead-ending the user.
  return resolveToast('error', message, result?.retryable === false ? undefined : recovery);
}

module.exports = {
  INVOICE_CARD_COPY,
  resolvePaymentUrl,
  resolveEmailRecipient,
  resolveInvoiceCardViewModel,
  resolveCopyToast,
  resolveExportToast,
};
