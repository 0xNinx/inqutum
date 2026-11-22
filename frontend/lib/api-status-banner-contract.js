'use strict';

const { publicStatusBanner } = require('./public-status');

/**
 * ApiStatusBanner presentation contract (issue #158).
 *
 * The banner has two independent dependencies: the health check, which decides
 * whether a connection warning is shown, and the public status feed, which is
 * best effort. A broken status feed must never hide a connection problem, and
 * a connection warning must never show a stale status. All copy is bounded and
 * falls back to stable strings so an unexpected transport value cannot leave
 * the user with an empty or misleading banner.
 */

const API_STATUS_BANNER_COPY = Object.freeze({
  connectionTitle: 'Backend connection problem',
  connectionFallback: 'The Quittance API is unreachable. Check your connection and retry.',
  offline: 'Your browser is offline. Reconnect, then retry.',
  retry: 'Retry connection',
  checking: 'Checking…',
  checkStatus: 'Check status again',
});

const MAX_MESSAGE = 280;

function resolveConnectionMessage(raw) {
  if (typeof raw !== 'string') return API_STATUS_BANNER_COPY.connectionFallback;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, MAX_MESSAGE) : API_STATUS_BANNER_COPY.connectionFallback;
}

/** A degraded or malformed status feed resolves to no banner, never a throw. */
function resolveStatusBanner(payload) {
  try {
    return publicStatusBanner(payload);
  } catch {
    return null;
  }
}

function resolveApiStatusViewModel({ error, statusPayload } = {}) {
  const message = error ? resolveConnectionMessage(error) : null;
  return {
    hasError: Boolean(message),
    message,
    status: message ? null : resolveStatusBanner(statusPayload),
  };
}

module.exports = {
  API_STATUS_BANNER_COPY,
  resolveConnectionMessage,
  resolveStatusBanner,
  resolveApiStatusViewModel,
};
