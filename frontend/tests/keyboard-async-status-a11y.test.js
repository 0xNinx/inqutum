/**
 * Keyboard and async status accessibility coverage (issue #494).
 *
 * This file is the entry-point test for issue #494. It covers the two
 * accessibility dimensions the issue asks for — keyboard operation and async
 * status announcements — across both the pay page and the API status banner.
 * The underlying reducers are exercised through the real state machines; the
 * component wiring contract is pinned against the source files, following the
 * established pattern in this test folder.
 *
 * Individual sub-issue coverage:
 *   issue #310  pay-page announcements and keyboard rules  tests/pay-status-a11y.test.js
 *   issue #446  API status banner announcements            tests/api-status-banner-a11y.test.js
 *
 * This file adds integration-level assertions that the two subsystems are
 * consistent with each other and that no regression is introduced at their
 * boundary.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  INITIAL_PAY_ANNOUNCEMENT,
  PAY_FOCUS_IDS,
  PAY_STATUS_REGION_IDS,
  nextPayAnnouncement,
} = require('../lib/pay-status-a11y');
const { initialPaymentState, paymentReducer, PAY_STATES } = require('../lib/payment-page-state');
const { WALLET_ERRORS } = require('../lib/payment-button-contract');
const {
  API_STATUS_COPY,
  initialApiStatusAnnouncement,
  nextApiStatusAnnouncement,
} = require('../lib/api-status-announcement');

const root = path.join(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const FUTURE = '2999-01-01T00:00:00.000Z';
const PENDING_INVOICE = { id: 'inv-494', status: 'PENDING', expiresAt: FUTURE };
const PAID_INVOICE = { ...PENDING_INVOICE, status: 'PAID', paymentTxHash: 'c'.repeat(64) };

/** Runs pay-state events through the reducer and the announcer in lockstep. */
function runPayFlow(events, invoice = PENDING_INVOICE) {
  let state = initialPaymentState(null);
  let announcement = nextPayAnnouncement(INITIAL_PAY_ANNOUNCEMENT, state);
  for (const event of [{ type: 'INVOICE_LOADED', invoice }, ...events]) {
    state = paymentReducer(state, event);
    announcement = nextPayAnnouncement(announcement, state);
  }
  return { state, announcement };
}

/** Runs API banner events through the banner reducer. */
function runBanner(events, configError = null) {
  let announcement = initialApiStatusAnnouncement(configError);
  for (const event of events) {
    announcement = nextApiStatusAnnouncement(announcement, event);
  }
  return announcement;
}

// ---------------------------------------------------------------------------
// Keyboard: pay-page form and button contract
// ---------------------------------------------------------------------------

test('keyboard/494: Enter submits the verify form; the busy submit button keeps focus', () => {
  const panel = source('components/PayVerifyPanel.tsx');
  // The form wraps the input so Enter in the field triggers onSubmit.
  assert.match(panel, /<form onSubmit=\{handleSubmit\}/, 'verify panel must be a <form>');
  // aria-disabled, not disabled: Chrome moves focus to <body> on a disabled focused button.
  assert.match(panel, /type="submit" aria-disabled=\{verifying\} aria-busy=\{verifying\}/);
  assert.doesNotMatch(panel, /\sdisabled=\{verifying\}/, 'disabled would drop focus in Chromium');
  // Handler guard prevents double-activation.
  assert.match(panel, /if \(verifying\) return;/);
});

test('keyboard/494: Pay with Freighter stays focusable while in-flight', () => {
  const button = source('components/PaymentButton.tsx');
  assert.match(button, /aria-disabled=\{loading\}/);
  // The structural disabled (no destination/amount/non-PENDING) is on the button,
  // but the in-flight guard uses aria-disabled so focus stays.
  assert.match(button, /disabled=\{!destination \|\| !amount \|\| invoiceStatus !== 'PENDING'\}/);
  assert.match(button, /if \(loading\) return;/);
});

test('keyboard/494: API banner retry buttons stay focusable while checking', () => {
  const banner = source('components/ApiStatusBanner.tsx');
  assert.doesNotMatch(banner, /disabled=\{checking\}/, 'disabled drops focus in Chromium');
  // Both buttons in the banner (error path + status path) must use aria-disabled.
  assert.equal((banner.match(/aria-disabled=\{checking\}/g) ?? []).length, 2);
  // The in-flight ref guard prevents double-activation without re-renders.
  assert.match(banner, /if \(inFlight\.current\) return;/);
});

// ---------------------------------------------------------------------------
// Async status: pay-page live regions
// ---------------------------------------------------------------------------

test('async/494: pay-page has two persistent non-conditional live regions', () => {
  const region = source('components/PayStatusRegion.tsx');
  // Both regions must be present in the render output on every render, never behind &&.
  assert.doesNotMatch(region, /&&\s*\(?\s*<div[^>]*role=/, 'regions must not be conditional');
  // Polite region: role="status" + explicit aria-live for compat (MDN recommendation).
  assert.match(region, /id=\{PAY_STATUS_REGION_IDS\.polite\} role="status" aria-live="polite"/);
  // Alert region: role="alert" only, no aria-live (double-speaks on iOS VoiceOver).
  assert.match(region, /id=\{PAY_STATUS_REGION_IDS\.assertive\} role="alert" className/);
  assert.doesNotMatch(region, /aria-busy/, 'aria-busy on a live region can suppress updates');
});

test('async/494: StrictMode double-run does not announce the on-load state', () => {
  // The ref guard in PayStatusRegion prevents the same state object from being
  // processed twice, which is what React StrictMode's double-invoke would cause.
  const region = source('components/PayStatusRegion.tsx');
  assert.match(region, /if \(announced\.current === state\) return;/);
});

test('async/494: pay-page regions are mounted in app/pay/[id]/page.tsx', () => {
  const page = source('app/pay/[id]/page.tsx');
  assert.match(page, /<PayStatusRegion state=\{page\.paymentState\} \/>/);
});

test('async/494: polite region carries waiting, verifying and settled states', () => {
  const { announcement: paying } = runPayFlow([{ type: 'PAY_STARTED' }]);
  assert.equal(paying.polite, 'Waiting for you to confirm the payment in Freighter.');
  assert.equal(paying.assertive, '');

  const { announcement: verifying } = runPayFlow([
    { type: 'PAY_STARTED' },
    { type: 'PAY_SENT', txHash: 'a'.repeat(64) },
  ]);
  assert.equal(verifying.polite, 'Verifying the transaction on the Stellar network.');
  assert.equal(verifying.assertive, '');

  const { announcement: paid } = runPayFlow([
    { type: 'PAY_STARTED' },
    { type: 'PAY_SENT', txHash: 'a'.repeat(64) },
    { type: 'POLL_RESULT', invoice: PAID_INVOICE },
  ]);
  assert.equal(paid.polite, 'Payment verified. Your payment proof is ready.');
  assert.equal(paid.assertive, '');
});

test('async/494: assertive region carries failures; polite region is cleared', () => {
  const { announcement } = runPayFlow([
    { type: 'VERIFY_STARTED' },
    { type: 'VERIFY_FAILED', error: 'Memo mismatch' },
  ]);
  assert.equal(announcement.assertive, 'Memo mismatch.');
  assert.equal(announcement.polite, '', 'polite region must be cleared on failure');
});

test('async/494: a repeated identical failure is re-announced with an attempt counter', () => {
  let state = initialPaymentState(null);
  let ann = nextPayAnnouncement(INITIAL_PAY_ANNOUNCEMENT, state);

  const events = [
    { type: 'INVOICE_LOADED', invoice: PENDING_INVOICE },
    { type: 'VERIFY_STARTED' },
    { type: 'VERIFY_FAILED', error: 'Amount mismatch' },
    { type: 'VERIFY_STARTED' },
    { type: 'VERIFY_FAILED', error: 'Amount mismatch' },
    { type: 'VERIFY_STARTED' },
    { type: 'VERIFY_FAILED', error: 'Amount mismatch' },
  ];

  const assertions = [];
  for (const event of events) {
    state = paymentReducer(state, event);
    ann = nextPayAnnouncement(ann, state);
    if (state.status === PAY_STATES.ERROR) assertions.push(ann.assertive);
    // The VERIFY_STARTED step must clear the previous failure.
    if (event.type === 'VERIFY_STARTED' && assertions.length > 0) {
      assert.equal(ann.assertive, '', 'retry must clear the assertive region');
    }
  }

  assert.deepEqual(assertions, [
    'Amount mismatch.',
    'Amount mismatch. Attempt 2.',
    'Amount mismatch. Attempt 3.',
  ]);
  // Every successive attempt changes the region text so it is re-announced.
  for (let i = 1; i < assertions.length; i++) {
    assert.notEqual(assertions[i], assertions[i - 1]);
  }
});

test('async/494: wallet denial is announced with actionable guidance', () => {
  const { announcement } = runPayFlow([
    { type: 'PAY_STARTED' },
    { type: 'PAY_FAILED', error: WALLET_ERRORS.ACCESS_DENIED },
  ]);
  assert.match(announcement.assertive, /Freighter access was denied/);
  assert.match(announcement.assertive, /Approve Quittance in Freighter/);
  assert.match(announcement.assertive, /QR code/);
});

test('async/494: Freighter not installed is announced with a way forward', () => {
  const { announcement } = runPayFlow([
    { type: 'PAY_STARTED' },
    { type: 'PAY_FAILED', error: WALLET_ERRORS.NOT_INSTALLED },
  ]);
  assert.match(announcement.assertive, /Freighter is not installed/);
  assert.match(announcement.assertive, /Install Freighter/);
  assert.match(announcement.assertive, /QR code/);
});

test('async/494: an expiring invoice is announced politely', () => {
  const { announcement } = runPayFlow([
    { type: 'POLL_RESULT', invoice: { ...PENDING_INVOICE, status: 'EXPIRED' } },
  ]);
  assert.equal(announcement.polite, 'This invoice has expired and can no longer be paid.');
});

// ---------------------------------------------------------------------------
// Async status: API banner live region
// ---------------------------------------------------------------------------

test('async/494: API banner outcome lives in a persistent polite region', () => {
  const banner = source('components/ApiStatusBanner.tsx');
  // The polite region is defined before any early return, so it is always mounted.
  assert.match(banner, /<div role="status" aria-live="polite" className="sr-only">\s*\{announcement\.polite\}/);
  // The early return uses the region variable, never null.
  assert.match(banner, /if \(!serviceStatus \|\| statusDismissed\) return region;/);
  assert.doesNotMatch(banner, /if \(!serviceStatus \|\| statusDismissed\) return null;/);
  assert.doesNotMatch(banner, /aria-busy/, 'aria-busy on a live region can suppress updates');
});

test('async/494: on-load check is silent when backend is up (no double-announcement)', () => {
  const result = runBanner([
    { type: 'CHECK_STARTED', manual: false },
    { type: 'CHECK_SUCCEEDED', manual: false },
  ]);
  assert.equal(result.polite, '');
  assert.equal(result.status, 'up');
});

test('async/494: manual check announces "Checking" then the outcome', () => {
  const history = [];
  let ann = initialApiStatusAnnouncement(null);
  for (const event of [
    { type: 'CHECK_STARTED', manual: true },
    { type: 'CHECK_SUCCEEDED', manual: true },
  ]) {
    ann = nextApiStatusAnnouncement(ann, event);
    history.push(ann.polite);
  }
  assert.equal(history[0], API_STATUS_COPY.checking);
  assert.equal(history[1], 'The Quittance API is available.');
});

test('async/494: recovery is always announced so the banner does not vanish silently', () => {
  // Manual recovery.
  const manualRestored = runBanner([
    { type: 'CHECK_FAILED', manual: true },
    { type: 'CHECK_SUCCEEDED', manual: true },
  ]);
  assert.equal(manualRestored.polite, API_STATUS_COPY.restored);

  // Automatic recovery (browser comes back online).
  const autoRestored = runBanner([
    { type: 'CHECK_FAILED', manual: false },
    { type: 'CHECK_STARTED', manual: false },
    { type: 'CHECK_SUCCEEDED', manual: false },
  ]);
  assert.equal(autoRestored.polite, API_STATUS_COPY.restored);
});

test('async/494: repeated manual failures are re-announced with an attempt counter', () => {
  const history = [];
  let ann = initialApiStatusAnnouncement(null);
  const events = [
    { type: 'CHECK_STARTED', manual: true },
    { type: 'CHECK_FAILED', manual: true },
    { type: 'CHECK_STARTED', manual: true },
    { type: 'CHECK_FAILED', manual: true },
    { type: 'CHECK_STARTED', manual: true },
    { type: 'CHECK_FAILED', manual: true },
  ];
  for (const event of events) {
    ann = nextApiStatusAnnouncement(ann, event);
    if (event.type === 'CHECK_FAILED') history.push(ann.polite);
  }
  assert.deepEqual(history, ['', 'Still unavailable. Attempt 2.', 'Still unavailable. Attempt 3.']);
  // Each non-empty entry is unique so the region text changes and is re-announced.
  assert.notEqual(history[1], history[2]);
});

test('async/494: automatic failures while already down stay silent', () => {
  // Background polling should not chatter when the payer did not ask.
  const result = runBanner([
    { type: 'CHECK_FAILED', manual: true },
    { type: 'CHECK_STARTED', manual: false },
    { type: 'CHECK_FAILED', manual: false },
    { type: 'CHECK_STARTED', manual: false },
    { type: 'CHECK_FAILED', manual: false },
  ]);
  assert.equal(result.polite, '');
  assert.equal(result.failures, 4);
});

// ---------------------------------------------------------------------------
// Cross-cutting: decorative icons are hidden from assistive technology
// ---------------------------------------------------------------------------

test('a11y/494: decorative Loader2 spinners are hidden on the pay page and banner', () => {
  const files = [
    'components/PayVerifyPanel.tsx',
    'components/PaymentButton.tsx',
    'components/PayMonitorPanel.tsx',
  ];
  for (const file of files) {
    const src = source(file);
    for (const icon of src.match(/<Loader2[^>]*\/>/g) ?? []) {
      assert.match(icon, /aria-hidden="true"/, `${file}: Loader2 missing aria-hidden — ${icon}`);
    }
  }
  // API banner icons.
  const banner = source('components/ApiStatusBanner.tsx');
  for (const icon of banner.match(/<(ServerOff|RefreshCw|X|AlertTriangle) [^>]*\/>/g) ?? []) {
    assert.match(icon, /aria-hidden="true"/, `ApiStatusBanner: icon missing aria-hidden — ${icon}`);
  }
});

test('a11y/494: dismiss buttons have accessible names', () => {
  const banner = source('components/ApiStatusBanner.tsx');
  assert.match(banner, /aria-label="Dismiss service status"/);
  assert.match(banner, /aria-label="Dismiss backend warning"/);
});

// ---------------------------------------------------------------------------
// Focus management
// ---------------------------------------------------------------------------

test('focus/494: focus moves to the proof section only when an in-flight payment settles', () => {
  // PAY_STARTED → PAY_SENT → POLL_RESULT(PAID): in-flight, so focus moves.
  const { announcement: inFlight } = runPayFlow([
    { type: 'PAY_STARTED' },
    { type: 'PAY_SENT', txHash: 'a'.repeat(64) },
    { type: 'POLL_RESULT', invoice: PAID_INVOICE },
  ]);
  assert.equal(inFlight.focusId, PAY_FOCUS_IDS.proof);

  // POLL_RESULT(PAID) with no prior in-flight: focus stays put.
  const { announcement: observed } = runPayFlow([
    { type: 'POLL_RESULT', invoice: PAID_INVOICE },
  ]);
  assert.equal(observed.focusId, null, 'passive poll must not move focus');
});

test('focus/494: on failure, the verify input is refocused by the panel (not the reducer)', () => {
  // The reducer returns focusId: null on failure; the component's handleSubmit
  // calls inputRef.current?.focus() when onVerify returns false.
  const { announcement } = runPayFlow([
    { type: 'VERIFY_STARTED' },
    { type: 'VERIFY_FAILED', error: 'Transaction not found on Stellar' },
  ]);
  assert.equal(announcement.focusId, null, 'reducer must not set focusId on failure');

  const panel = source('components/PayVerifyPanel.tsx');
  assert.match(panel, /if \(!\(await onVerify\(\)\)\) inputRef\.current\?\.focus\(\)/);
});

test('focus/494: the proof section has the correct id and tabIndex for programmatic focus', () => {
  const proof = source('components/PayProofPanel.tsx');
  assert.match(proof, /id=\{PAY_FOCUS_IDS\.proof\} tabIndex=\{-1\}/);
});

test('focus/494: the hash input id, aria-invalid and aria-describedby are wired correctly', () => {
  const panel = source('components/PayVerifyPanel.tsx');
  assert.match(panel, /id=\{PAY_FOCUS_IDS\.verifyInput\}/);
  assert.match(panel, /aria-invalid=\{Boolean\(error\)\}/);
  // With error: hint + error paragraph; without: hint only.
  assert.match(panel, /aria-describedby=\{error \? `tx-hash-hint \$\{PAY_FOCUS_IDS\.verifyError\}` : 'tx-hash-hint'\}/);
});

// ---------------------------------------------------------------------------
// Constant consistency: WALLET_ERRORS used in both announcer and button
// ---------------------------------------------------------------------------

test('contract/494: WALLET_ERRORS constants are used in both the announcer and the button', () => {
  // The pay-status-a11y module imports WALLET_ERRORS to build its guidance strings.
  const a11ySource = source('lib/pay-status-a11y.js');
  assert.match(a11ySource, /WALLET_ERRORS/);
  // The component also uses them so the button label and the announcement cannot drift.
  const buttonSource = source('components/PaymentButton.tsx');
  assert.match(buttonSource, /WALLET_ERRORS/);
});

test('contract/494: PAY_STATUS_REGION_IDS are defined in the lib and consumed by the component', () => {
  const region = source('components/PayStatusRegion.tsx');
  assert.match(region, /PAY_STATUS_REGION_IDS/);
  // Both IDs are distinct so the two regions can be targeted individually.
  assert.notEqual(PAY_STATUS_REGION_IDS.polite, PAY_STATUS_REGION_IDS.assertive);
});

test('contract/494: the reducer is pure — equal inputs produce equal outputs', () => {
  const prev = Object.freeze({ ...INITIAL_PAY_ANNOUNCEMENT, seen: true });
  const st = { status: PAY_STATES.ERROR, error: 'Destination mismatch', invoice: PENDING_INVOICE };
  assert.deepEqual(nextPayAnnouncement(prev, st), nextPayAnnouncement(prev, st));

  const bannerPrev = Object.freeze({ status: 'down', polite: '', failures: 2 });
  const event = { type: 'CHECK_FAILED', manual: true };
  assert.deepEqual(
    nextApiStatusAnnouncement(bannerPrev, event),
    nextApiStatusAnnouncement(bannerPrev, event)
  );
});
