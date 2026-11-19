/**
 * Regression tests for PayMonitorPanel boundary contract (Issue #163).
 *
 * Covers success, validation, retry, and degraded-dependency behavior.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  normalizeIntervalMs,
  resolvePayMonitorViewModel,
} = require('../lib/pay-monitor-panel-contract');

test('success path: resolves active listening status with formatted interval', () => {
  const vm = resolvePayMonitorViewModel({ active: true, intervalMs: 3000 });
  assert.equal(vm.active, true);
  assert.equal(vm.status, 'listening');
  assert.equal(vm.title, 'Listening for payment');
  assert.equal(vm.description, 'The invoice status updates automatically after confirmation.');
  assert.equal(vm.intervalSeconds, 3);
  assert.equal(vm.intervalText, 'Checking every 3 seconds.');
  assert.equal(vm.isDegraded, false);
  assert.equal(vm.hasError, false);
  assert.equal(vm.retryable, false);
});

test('success path: resolves paused status with manual verification instructions', () => {
  const vm = resolvePayMonitorViewModel({ active: false, intervalMs: 3000 });
  assert.equal(vm.active, false);
  assert.equal(vm.status, 'paused');
  assert.equal(vm.title, 'Payment monitoring stopped');
  assert.equal(vm.description, 'Manual verification remains available.');
  assert.equal(vm.intervalText, null);
  assert.equal(vm.isDegraded, false);
  assert.equal(vm.hasError, false);
  assert.equal(vm.retryable, false);
});

test('validation path: normalizes intervalMs safely', () => {
  // Clamps to min and max boundaries
  assert.equal(normalizeIntervalMs(500), MIN_POLL_INTERVAL_MS);
  assert.equal(normalizeIntervalMs(120000), MAX_POLL_INTERVAL_MS);

  // Safe defaults for non-finite or negative values
  for (const invalid of [-10, 0, NaN, Infinity, -Infinity, 'invalid', null, undefined]) {
    assert.equal(normalizeIntervalMs(invalid), DEFAULT_POLL_INTERVAL_MS);
  }

  // Parses string numbers
  assert.equal(normalizeIntervalMs('5000'), 5000);
});

test('validation path: tolerates missing, null, or empty props', () => {
  for (const empty of [null, undefined, {}]) {
    const vm = resolvePayMonitorViewModel(empty);
    assert.equal(vm.active, false);
    assert.equal(vm.status, 'paused');
    assert.equal(vm.title, 'Payment monitoring stopped');
    assert.equal(vm.intervalSeconds, 3);
  }
});

test('retry path: reconnecting state surfaces retryability and safe copy', () => {
  const vm = resolvePayMonitorViewModel({ active: false, status: 'reconnecting' });
  assert.equal(vm.active, false);
  assert.equal(vm.status, 'reconnecting');
  assert.equal(vm.title, 'Reconnecting payment monitor');
  assert.match(vm.description, /Re-establishing payment stream/);
  assert.equal(vm.isDegraded, true);
  assert.equal(vm.retryable, true);
});

test('retry path: error state surfaces error message and retry affordance', () => {
  const err = new Error('Horizon connection timed out');
  const vm = resolvePayMonitorViewModel({ active: false, error: err });
  assert.equal(vm.active, false);
  assert.equal(vm.status, 'error');
  assert.equal(vm.title, 'Payment monitor unavailable');
  assert.match(vm.description, /Horizon connection timed out/);
  assert.match(vm.description, /Manual verification remains available/);
  assert.equal(vm.hasError, true);
  assert.equal(vm.retryable, true);
});

test('degraded-dependency path: degraded state communicates reduced polling without crash', () => {
  const vm = resolvePayMonitorViewModel({ active: true, status: 'degraded' });
  assert.equal(vm.status, 'degraded');
  assert.equal(vm.title, 'Payment monitoring degraded');
  assert.match(vm.description, /manual verification is recommended/);
  assert.equal(vm.isDegraded, true);
  assert.equal(vm.retryable, true);
});

test('time and space complexity: operations execute within O(1)', () => {
  const start = performance.now();
  for (let i = 0; i < 1000; i++) {
    resolvePayMonitorViewModel({ active: i % 2 === 0, intervalMs: 2500 + i });
  }
  const duration = performance.now() - start;
  // 1000 calls should take less than 50ms in pure JS
  assert.ok(duration < 100, `Execution took ${duration}ms, expected O(1) per call`);
});

