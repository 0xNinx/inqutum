// View model for GET /api/status (backend/src/ops/public-status.ts, #254).
// Pure functions so the banner logic is testable without React. Unknown
// states, capabilities or values are dropped rather than trusted: an older or
// newer backend can never make the UI show something the API did not mean.

const PUBLIC_STATES = ['operational', 'degraded', 'paused', 'maintenance'];
const AVAILABILITY = ['available', 'limited', 'unavailable'];

const CAPABILITY_LABELS = {
  invoice_creation: 'Creating invoices',
  invoice_viewing: 'Viewing invoices',
  invoice_cancellation: 'Cancelling invoices',
  payment_verification: 'Verifying payments',
  exports: 'Exports',
  email_notifications: 'Email notifications',
};

const TONES = {
  operational: null,
  degraded: 'warning',
  paused: 'critical',
  maintenance: 'info',
};

const MAX_TEXT = 280;

function text(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : '';
}

function isoOrNull(value) {
  if (typeof value !== 'string') return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/** Returns a sanitised status, or null when the payload is not a public status. */
function normalizePublicStatus(payload) {
  if (!payload || typeof payload !== 'object' || !PUBLIC_STATES.includes(payload.state)) return null;
  const capabilities = {};
  const raw = payload.capabilities && typeof payload.capabilities === 'object' ? payload.capabilities : {};
  for (const key of Object.keys(CAPABILITY_LABELS)) {
    if (AVAILABILITY.includes(raw[key])) capabilities[key] = raw[key];
  }
  const retry = Number(payload.retryAfterSeconds);
  return {
    state: payload.state,
    title: text(payload.title),
    message: text(payload.message),
    since: isoOrNull(payload.since),
    expectedResolutionAt: isoOrNull(payload.expectedResolutionAt),
    retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? Math.min(Math.round(retry), 3600) : 0,
    capabilities,
  };
}

/** Banner to render, or null when everything is operational (or the payload is unusable). */
function publicStatusBanner(payload) {
  const status = normalizePublicStatus(payload);
  if (!status || status.state === 'operational') return null;
  const affected = (availability) =>
    Object.entries(status.capabilities)
      .filter(([, value]) => value === availability)
      .map(([key]) => CAPABILITY_LABELS[key]);
  return {
    state: status.state,
    tone: TONES[status.state],
    // Alerts interrupt; a degraded notice should not.
    role: status.state === 'degraded' ? 'status' : 'alert',
    title: status.title || 'Service status changed',
    message: status.message,
    unavailable: affected('unavailable'),
    limited: affected('limited'),
    expectedResolutionAt: status.expectedResolutionAt,
    retryAfterSeconds: status.retryAfterSeconds,
  };
}

/** False only when the status explicitly marks the capability unavailable. */
function isCapabilityAvailable(payload, capability) {
  const status = normalizePublicStatus(payload);
  return !status || status.capabilities[capability] !== 'unavailable';
}

module.exports = {
  CAPABILITY_LABELS,
  PUBLIC_STATES,
  normalizePublicStatus,
  publicStatusBanner,
  isCapabilityAvailable,
};
