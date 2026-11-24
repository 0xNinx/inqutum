const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  API_STATUS_BANNER_COPY,
  resolveConnectionMessage,
  resolveStatusBanner,
  resolveApiStatusViewModel,
} = require('../lib/api-status-banner-contract');

const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'ApiStatusBanner.tsx'), 'utf8');

const DEGRADED_STATUS = {
  state: 'degraded',
  title: 'Verification is slower than usual',
  message: 'Payments may take longer to confirm.',
  capabilities: { payment_verification: 'limited', exports: 'unavailable', exports_extra: 'unavailable' },
  expectedResolutionAt: '2030-01-01T00:00:00.000Z',
};

test('success: a valid non-operational status renders a safe banner', () => {
  const view = resolveApiStatusViewModel({ error: null, statusPayload: DEGRADED_STATUS });
  assert.equal(view.hasError, false);
  assert.equal(view.message, null);
  assert.equal(view.status.state, 'degraded');
  assert.equal(view.status.role, 'status');
  assert.equal(view.status.tone, 'warning');
  assert.deepEqual(view.status.limited, ['Verifying payments']);
  assert.deepEqual(view.status.unavailable, ['Exports']);
  assert.equal(view.status.title, 'Verification is slower than usual');
});

test('validation: malformed or operational status payloads render no banner', () => {
  for (const payload of [null, undefined, 'broken', { state: 'unknown' }, { state: 'operational' }]) {
    assert.equal(resolveStatusBanner(payload), null);
  }
  const view = resolveApiStatusViewModel({ statusPayload: { state: 'paused' } });
  assert.equal(view.hasError, false);
  assert.equal(view.status.state, 'paused');
  assert.equal(view.status.role, 'alert');
});

test('retry: the banner pins a single in-flight manual check and keeps buttons focusable', () => {
  assert.match(source, /if \(inFlight\.current\) return;/);
  assert.match(source, /inFlight\.current = false;/);
  assert.equal((source.match(/aria-disabled=\{checking\}/g) ?? []).length, 2);
  assert.equal((source.match(/onClick=\{\(\) => void check\(true\)\}/g) ?? []).length, 2);
  assert.match(source, /API_STATUS_BANNER_COPY\.checking/);
  assert.doesNotMatch(source, /(?<!aria-)disabled=\{checking\}/);
});

test('degraded dependency: a connection warning hides stale status even if one was fetched', () => {
  const view = resolveApiStatusViewModel({ error: 'Network error', statusPayload: DEGRADED_STATUS });
  assert.equal(view.hasError, true);
  assert.equal(view.message, 'Network error');
  assert.equal(view.status, null);
});

test('degraded dependency: a failed status fetch leaves no banner but no false warning', () => {
  const view = resolveApiStatusViewModel({ error: null, statusPayload: null });
  assert.deepEqual(view, { hasError: false, message: null, status: null });
});

test('validation: connection messages are bounded and never empty', () => {
  assert.equal(resolveConnectionMessage(null), API_STATUS_BANNER_COPY.connectionFallback);
  assert.equal(resolveConnectionMessage(42), API_STATUS_BANNER_COPY.connectionFallback);
  assert.equal(resolveConnectionMessage('   '), API_STATUS_BANNER_COPY.connectionFallback);
  assert.equal(resolveConnectionMessage('  Network error  '), 'Network error');
  assert.equal(resolveConnectionMessage('x'.repeat(500)).length, 280);
});

test('component: presentation and copy come from the shared contract', () => {
  assert.match(source, /resolveApiStatusViewModel\(\{ error, statusPayload \}\)/);
  assert.match(source, /API_STATUS_BANNER_COPY\.offline/);
  assert.match(source, /API_STATUS_BANNER_COPY\.connectionTitle/);
  assert.match(source, /resolveStatusBanner\(payload\)/);
  assert.doesNotMatch(source, /setServiceStatus/);
});
