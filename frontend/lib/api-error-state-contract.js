'use strict';

const { CLIENT_REJECTION_CATALOG, resolveRejectionExplanation } = require('./rejection-explanation');

/**
 * ApiErrorState view and retry contract (issue #157).
 *
 * The component is the last thing between a rejected API operation and the
 * user, so it never renders an untrusted payload verbatim and never leaves a
 * retry in a half-finished state. Codes, titles and recovery guidance come
 * from the shared rejection-explanation catalogue, so the same reason code
 * reads the same way here as it does on the invoice and payment pages.
 */

const API_ERROR_STATE_COPY = Object.freeze({
  title: 'The Quittance API is unavailable',
  summary: 'The request could not be completed. Check your connection and try again.',
  retry: 'Retry',
  retrying: 'Retrying...',
});

/** Resolve what the alert may say. Never throws for malformed input. */
function resolveApiErrorViewModel(input) {
  const source = input && typeof input === 'object' ? input : {};
  const explanation =
    source.explanation && typeof source.explanation === 'object' ? source.explanation : null;
  const safeExplanation = explanation
    ? {
        ...explanation,
        ...(Array.isArray(explanation.recoveryHints)
          ? {
              recoveryHints: explanation.recoveryHints.filter(
                (hint) => hint && typeof hint === 'object' && typeof hint.action === 'string'
              ),
            }
          : {}),
      }
    : null;
  const resolved = safeExplanation
    ? resolveRejectionExplanation({ ...safeExplanation, explanation: safeExplanation })
    : source.error
      ? resolveRejectionExplanation(source.error)
      : null;
  // Reuse the shared sanitiser for the plain message fallback: it redacts
  // secret keys and rejects stack-trace / SQL text without duplicating rules.
  const sanitizedMessage =
    typeof source.message === 'string' && source.message.trim()
      ? resolveRejectionExplanation({ message: source.message }).summary
      : '';
  const fallback =
    !sanitizedMessage || sanitizedMessage === CLIENT_REJECTION_CATALOG.UNEXPECTED_FAILURE.summary
      ? API_ERROR_STATE_COPY.summary
      : sanitizedMessage;

  return {
    title: resolved?.title || API_ERROR_STATE_COPY.title,
    summary: resolved?.summary || fallback,
    reasonCode: resolved?.reasonCode || null,
    recoveryHints: Array.isArray(resolved?.recoveryHints)
      ? resolved.recoveryHints
          .filter((hint) => hint && typeof hint.action === 'string' && hint.action.trim())
          .map((hint) => ({ step: Number(hint.step) || 1, action: hint.action.trim() }))
      : [],
  };
}

/** Retry state is a two-event lifecycle: a start is ignored while one is running. */
const RETRY_IDLE = Object.freeze({ retrying: false });

function nextApiErrorRetryState(previous, event) {
  const prev = previous ?? RETRY_IDLE;
  switch (event?.type) {
    case 'RETRY_STARTED':
      return prev.retrying ? prev : { retrying: true };
    case 'RETRY_SETTLED':
      return RETRY_IDLE;
    default:
      return prev;
  }
}

module.exports = {
  API_ERROR_STATE_COPY,
  resolveApiErrorViewModel,
  nextApiErrorRetryState,
};
