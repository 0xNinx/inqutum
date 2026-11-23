/**
 * Accessibility coverage for the backend connection banner's async status
 * (issue #446): keyboard operation of Retry / Check status again, announced
 * outcomes for normal, failure, retry and recovery paths, and a persistent
 * status region. The announcement reducer is exercised directly; component
 * wiring is pinned against the source, as the other component contract tests
 * in this folder do.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  API_STATUS_COPY,
  initialApiStatusAnnouncement,
  nextApiStatusAnnouncement,
} = require('../lib/api-status-announcement');

const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

/** Feeds events through the reducer, as the banner's useReducer does. */
function run(events, configError = null) {
  let announcement = initialApiStatusAnnouncement(configError);
  const history = [];
  for (const event of events) {
    announcement = nextApiStatusAnnouncement(announcement, event);
    history.push(announcement);
  }
  return history;
}

const auto = (type) => ({ type, manual: false });
const manual = (type) => ({ type, manual: true });

test('baseline: the on-load check is silent when the backend is up', () => {
  const [, loaded] = run([auto('CHECK_STARTED'), auto('CHECK_SUCCEEDED')]);
  assert.equal(loaded.polite, '');
  assert.equal(loaded.status, 'up');
});

test('baseline: a backend already known to be down at load is not announced again', () => {
  const initial = initialApiStatusAnnouncement('Network error');
  assert.equal(initial.status, 'down');
  assert.equal(initial.polite, '');
  assert.equal(initial.failures, 1);
  const [started, failed] = run([auto('CHECK_STARTED'), auto('CHECK_FAILED')], 'Network error');
  assert.equal(started.polite, '');
  assert.equal(failed.polite, '');
});

test('normal path: a manual check announces that it is running, then that the API is available', () => {
  const [started, succeeded] = run([manual('CHECK_STARTED'), manual('CHECK_SUCCEEDED')]);
  assert.equal(started.polite, API_STATUS_COPY.checking);
  assert.equal(succeeded.polite, 'The Quittance API is available.');
  assert.equal(succeeded.status, 'up');
});

test('failure path: a first manual failure from up is left to the alert, not spoken twice', () => {
  const [, failed] = run([manual('CHECK_STARTED'), manual('CHECK_FAILED')]);
  assert.equal(failed.status, 'down');
  assert.equal(failed.failures, 1);
  assert.equal(failed.polite, '');
});

test('retry path: repeated manual failures are re-announced with an attempt number', () => {
  const history = run([
    manual('CHECK_STARTED'),
    manual('CHECK_FAILED'),
    manual('CHECK_STARTED'),
    manual('CHECK_FAILED'),
    manual('CHECK_STARTED'),
    manual('CHECK_FAILED'),
  ]);
  const failedSteps = history.filter((_, i) => i % 2 === 1).map((step) => step.polite);
  assert.deepEqual(failedSteps, ['', 'Still unavailable. Attempt 2.', 'Still unavailable. Attempt 3.']);
  assert.notEqual(failedSteps[1], failedSteps[2]);
});

test('retry path: "Checking" is spoken again on each manual retry, replacing the previous outcome', () => {
  const history = run([manual('CHECK_STARTED'), manual('CHECK_FAILED'), manual('CHECK_STARTED')]);
  assert.equal(history[2].polite, API_STATUS_COPY.checking);
});

test('retry path: automatic failures while down stay silent, so background checks do not chatter', () => {
  const history = run([
    manual('CHECK_STARTED'),
    manual('CHECK_FAILED'),
    auto('CHECK_STARTED'),
    auto('CHECK_FAILED'),
    auto('CHECK_STARTED'),
    auto('CHECK_FAILED'),
  ]);
  assert.equal(history.at(-1).polite, '');
  assert.equal(history.at(-1).failures, 3);
});

test('recovery: a successful retry after failures announces the restored connection', () => {
  const restored = run([manual('CHECK_STARTED'), manual('CHECK_FAILED'), manual('CHECK_SUCCEEDED')]).at(-1);
  assert.equal(restored.polite, API_STATUS_COPY.restored);
  assert.equal(restored.status, 'up');
});

test('recovery: an automatic recovery (browser back online) is still announced', () => {
  const restored = run([auto('CHECK_FAILED'), auto('CHECK_STARTED'), auto('CHECK_SUCCEEDED')]).at(-1);
  assert.equal(restored.polite, API_STATUS_COPY.restored);
});

test('recovery: a success resets the failure count, so the next outage starts at attempt 1', () => {
  const history = run([
    manual('CHECK_FAILED'),
    manual('CHECK_FAILED'),
    manual('CHECK_SUCCEEDED'),
    manual('CHECK_FAILED'),
  ]);
  assert.equal(history[2].failures, 0);
  assert.equal(history[3].failures, 1);
  assert.equal(history[3].polite, '');
});

test('offline: the browser going offline counts as a silent failure', () => {
  const [offline] = run([auto('CHECK_FAILED')]);
  assert.equal(offline.status, 'down');
  assert.equal(offline.polite, '');
});

test('the reducer is pure, tolerates missing input, and ignores unknown events', () => {
  const prev = Object.freeze({ status: 'down', polite: '', failures: 1 });
  assert.deepEqual(nextApiStatusAnnouncement(prev, manual('CHECK_FAILED')), nextApiStatusAnnouncement(prev, manual('CHECK_FAILED')));
  assert.equal(nextApiStatusAnnouncement(undefined, { type: 'CHECK_STARTED', manual: true }).polite, API_STATUS_COPY.checking);
  assert.equal(nextApiStatusAnnouncement(prev, { type: 'SOMETHING_NEW' }), prev);
  assert.equal(nextApiStatusAnnouncement(prev, null), prev);
  assert.equal(initialApiStatusAnnouncement(undefined).status, 'unknown');
});

test('component: the outcome lives in a persistent polite status region outside every early return', () => {
  const banner = source('components/ApiStatusBanner.tsx');
  assert.match(banner, /<div role="status" aria-live="polite" className="sr-only">\s*\{announcement\.polite\}/);
  assert.match(banner, /if \(!serviceStatus \|\| statusDismissed\) return region;/);
  assert.doesNotMatch(banner, /if \(!serviceStatus \|\| statusDismissed\) return null;/);
  assert.match(banner, /\{region\}\s*<aside\s+role="alert"/);
  assert.doesNotMatch(banner, /aria-busy/, 'busy regions can hold back the "Checking" update');
});

test('component: retry buttons stay focusable while busy and ignore re-activation', () => {
  const banner = source('components/ApiStatusBanner.tsx');
  assert.doesNotMatch(banner, /(?<!aria-)disabled=\{checking\}/);
  assert.equal((banner.match(/aria-disabled=\{checking\}/g) ?? []).length, 2);
  assert.equal((banner.match(/onClick=\{\(\) => void check\(true\)\}/g) ?? []).length, 2);
  assert.match(banner, /if \(inFlight\.current\) return;/);
  assert.match(banner, /inFlight\.current = false;/);
});

test('component: manual and automatic checks are distinguished, and offline reports a failure', () => {
  const banner = source('components/ApiStatusBanner.tsx');
  assert.match(banner, /const check = useCallback\(async \(manual = false\) => \{/);
  assert.match(banner, /const online = \(\) => void check\(\);/);
  assert.match(banner, /announce\(\{ type: 'CHECK_FAILED', manual: false \}\);\s*\};\s*const online/);
});

test('component: decorative icons are hidden and dismiss buttons keep their accessible names', () => {
  const banner = source('components/ApiStatusBanner.tsx');
  for (const icon of banner.match(/<(ServerOff|RefreshCw|X|AlertTriangle) [^>]*\/>/g) ?? []) {
    assert.match(icon, /aria-hidden="true"/, icon);
  }
  assert.match(banner, /aria-label="Dismiss service status"/);
  assert.match(banner, /aria-label="Dismiss backend warning"/);
});
