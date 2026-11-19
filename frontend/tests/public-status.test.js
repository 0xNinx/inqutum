const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePublicStatus,
  publicStatusBanner,
  isCapabilityAvailable,
} = require('../lib/public-status');

const paused = {
  state: 'paused',
  title: 'Payments temporarily paused',
  message: 'New invoices and payment verification are paused.',
  since: '2026-11-18T10:00:00.000Z',
  expectedResolutionAt: '2026-11-18T12:00:00.000Z',
  retryAfterSeconds: 120,
  capabilities: {
    invoice_creation: 'unavailable',
    invoice_viewing: 'available',
    invoice_cancellation: 'available',
    payment_verification: 'unavailable',
    exports: 'available',
    email_notifications: 'limited',
  },
  updatedAt: '2026-11-18T10:00:01.000Z',
};

test('operational renders no banner', () => {
  assert.equal(publicStatusBanner({ ...paused, state: 'operational' }), null);
});

test('paused renders an alert listing unavailable and limited actions', () => {
  const banner = publicStatusBanner(paused);
  assert.equal(banner.tone, 'critical');
  assert.equal(banner.role, 'alert');
  assert.deepEqual(banner.unavailable, ['Creating invoices', 'Verifying payments']);
  assert.deepEqual(banner.limited, ['Email notifications']);
  assert.equal(banner.expectedResolutionAt, paused.expectedResolutionAt);
});

test('degraded is announced politely, maintenance as an alert', () => {
  assert.equal(publicStatusBanner({ ...paused, state: 'degraded' }).role, 'status');
  assert.equal(publicStatusBanner({ ...paused, state: 'maintenance' }).tone, 'info');
});

test('unknown states, capabilities and values are ignored', () => {
  assert.equal(normalizePublicStatus({ state: 'on-fire' }), null);
  assert.equal(publicStatusBanner('not json'), null);
  assert.equal(publicStatusBanner(null), null);
  const status = normalizePublicStatus({
    ...paused,
    capabilities: { invoice_creation: 'broken', admin_panel: 'unavailable', exports: 'unavailable' },
    retryAfterSeconds: 'soon',
    expectedResolutionAt: 'tomorrow',
  });
  assert.deepEqual(status.capabilities, { exports: 'unavailable' });
  assert.equal(status.retryAfterSeconds, 0);
  assert.equal(status.expectedResolutionAt, null);
});

test('long or non-string text is clamped, never rendered raw', () => {
  const status = normalizePublicStatus({ ...paused, message: 'x'.repeat(5000), title: { html: '<b>' } });
  assert.equal(status.message.length, 280);
  assert.equal(status.title, '');
  assert.equal(publicStatusBanner({ ...paused, title: 42 }).title, 'Service status changed');
});

test('a missing or unreachable status never blocks an action', () => {
  assert.equal(isCapabilityAvailable(undefined, 'invoice_creation'), true);
  assert.equal(isCapabilityAvailable(paused, 'invoice_creation'), false);
  assert.equal(isCapabilityAvailable(paused, 'invoice_viewing'), true);
});
