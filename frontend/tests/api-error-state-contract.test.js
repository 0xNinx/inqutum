const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  API_ERROR_STATE_COPY,
  resolveApiErrorViewModel,
  nextApiErrorRetryState,
} = require('../lib/api-error-state-contract');

const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'ApiErrorState.tsx'), 'utf8');

test('API error state exposes an alert and retry affordance', () => {
  assert.match(source, /role="alert"/);
  assert.match(source, /aria-live="assertive"/);
  assert.match(source, /disabled=\{retrying\}/);
  assert.match(source, /retrying \? API_ERROR_STATE_COPY\.retrying/);
});

test('component: the rendered copy and lifecycle come from the shared contract', () => {
  assert.match(source, /resolveApiErrorViewModel\(\{ message, error, explanation \}\)/);
  assert.match(source, /nextApiErrorRetryState/);
  assert.match(source, /API_ERROR_STATE_COPY\.retrying/);
  assert.doesNotMatch(source, /resolved\?\./);
});

test('success: a structured backend rejection keeps its stable code and recovery guidance', () => {
  const view = resolveApiErrorViewModel({
    message: 'Request failed',
    error: {
      response: {
        data: {
          reasonCode: 'STALE_STATE_CONFLICT',
          error: 'Another session changed this invoice.',
          retryable: true,
          recoveryAction: 'Refresh the invoice and retry.',
        },
      },
    },
  });
  assert.equal(view.title, 'Record state changed since last read');
  assert.equal(view.reasonCode, 'STALE_STATE_CONFLICT');
  assert.equal(view.summary, 'Another session changed this invoice.');
  assert.deepEqual(view.recoveryHints.map((hint) => hint.action), ['Refresh the invoice and retry.']);
});

test('success: an explicit explanation takes precedence over the raw error', () => {
  const view = resolveApiErrorViewModel({
    message: 'ignored',
    error: new Error('raw transport error'),
    explanation: {
      reasonCode: 'INVOICE_EXPIRED',
      summary: 'This invoice can no longer accept payment.',
      recoveryHints: [{ step: 2, action: 'Ask the seller for a new invoice.' }],
    },
  });
  assert.equal(view.reasonCode, 'INVOICE_EXPIRED');
  assert.equal(view.summary, 'This invoice can no longer accept payment.');
  assert.deepEqual(view.recoveryHints, [{ step: 2, action: 'Ask the seller for a new invoice.' }]);
});

test('validation: unknown codes resolve to the shared unexpected-failure code', () => {
  const view = resolveApiErrorViewModel({ error: { code: 'MAKE_PAYMENT', message: 'oops' } });
  assert.equal(view.reasonCode, 'UNEXPECTED_FAILURE');
  assert.equal(view.title, 'Operation could not be completed');
  assert.equal(view.summary, 'oops');
});

test('validation: malformed input and empty hints never throw', () => {
  for (const input of [undefined, null, 'broken', { explanation: 'broken' }, { error: 42 }]) {
    const view = resolveApiErrorViewModel(input);
    assert.equal(typeof view.title, 'string');
    assert.equal(typeof view.summary, 'string');
    assert.ok(Array.isArray(view.recoveryHints));
  }
  const partial = resolveApiErrorViewModel({
    explanation: { reasonCode: 'VALIDATION_FAILED', recoveryHints: [null, {}, { step: 3, action: '  ' }] },
  });
  assert.ok(partial.recoveryHints.every((hint) => hint.action.trim().length > 0));
  assert.ok(!partial.recoveryHints.some((hint) => hint.action === '  '));
});

test('degraded dependency: secret keys and stack traces are never rendered', () => {
  const secret = `S${'A'.repeat(55)}`;
  const view = resolveApiErrorViewModel({
    message: `select * from invoices at handler (/app/dist/api.js:12:3) key=${secret}`,
  });
  assert.doesNotMatch(JSON.stringify(view), /select |pg_catalog|at handler|S[A-Z2-7]{55}/);
  assert.equal(view.reasonCode, null);
  assert.equal(view.title, API_ERROR_STATE_COPY.title);
  assert.equal(view.summary, API_ERROR_STATE_COPY.summary);
});

test('retry: a second press during an in-flight retry is ignored', () => {
  const started = nextApiErrorRetryState({ retrying: false }, { type: 'RETRY_STARTED' });
  assert.deepEqual(started, { retrying: true });
  assert.equal(nextApiErrorRetryState(started, { type: 'RETRY_STARTED' }), started);
  assert.deepEqual(nextApiErrorRetryState(started, { type: 'RETRY_SETTLED' }), { retrying: false });
});

test('retry: settlement, unknown events and missing state are safe', () => {
  assert.deepEqual(nextApiErrorRetryState(undefined, { type: 'RETRY_SETTLED' }), { retrying: false });
  assert.deepEqual(nextApiErrorRetryState({ retrying: true }, null), { retrying: true });
  assert.deepEqual(nextApiErrorRetryState({ retrying: true }, { type: 'OTHER' }), { retrying: true });
});
