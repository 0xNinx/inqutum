const test = require('node:test');
const assert = require('node:assert/strict');

// Boundary numeric & timestamp constants
const STROOP_DECIMALS = 7;
const STROOP_SCALE = 10 ** STROOP_DECIMALS;
const MAX_STELLAR_STROOPS = 9223372036854775807n; // 2^63 - 1
const MAX_STELLAR_AMOUNT = 922337203685.4775807;
const MIN_INVOICE_EXPIRY_DAYS = 1;
const MAX_INVOICE_EXPIRY_DAYS = 30;
const DEFAULT_INVOICE_EXPIRY_DAYS = 7;

function amountsMatch(expected, actual, toleranceStroops = 0) {
  if (!Number.isInteger(toleranceStroops) || toleranceStroops < 0) return false;
  const expectedStr = typeof expected === 'string' ? expected : String(expected);
  const actualStr = typeof actual === 'string' || typeof actual === 'number' ? String(actual) : '';
  if (expectedStr.trim() === '' || actualStr.trim() === '') return false;

  const expectedNum = Number(expectedStr);
  const actualNum = Number(actualStr);
  if (!Number.isFinite(expectedNum) || !Number.isFinite(actualNum)) return false;

  const expectedStroops = Math.round(expectedNum * STROOP_SCALE);
  const actualStroops = Math.round(actualNum * STROOP_SCALE);
  if (!Number.isSafeInteger(expectedStroops) || !Number.isSafeInteger(actualStroops)) return false;

  return Math.abs(expectedStroops - actualStroops) <= toleranceStroops;
}

function validateInvoiceExpiryDays(value) {
  const days = value === undefined || value === null ? DEFAULT_INVOICE_EXPIRY_DAYS : value;
  if (
    typeof days !== 'number' ||
    !Number.isInteger(days) ||
    days < MIN_INVOICE_EXPIRY_DAYS ||
    days > MAX_INVOICE_EXPIRY_DAYS
  ) {
    throw new RangeError(
      `Invoice expiry must be an integer between ${MIN_INVOICE_EXPIRY_DAYS} and ${MAX_INVOICE_EXPIRY_DAYS} days`
    );
  }
  return days;
}

function isPendingInvoiceExpired(invoice, now = new Date()) {
  if (!invoice || !invoice.expiresAt) return false;
  const validNow = now instanceof Date && !isNaN(now.getTime()) ? now : new Date();
  const expiresAt = new Date(invoice.expiresAt).getTime();
  return invoice.status === 'PENDING' && Number.isFinite(expiresAt) && expiresAt <= validNow.getTime();
}

function computeBackoffMs(policy, attempt) {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt) - 1) : 0;
  // Guard against exponent overflow
  const factor = Math.min(safeAttempt, 30);
  const exp = policy.baseDelayMs * Math.pow(policy.backoffFactor, factor);
  return Math.min(Number.isFinite(exp) ? exp : policy.maxDelayMs, policy.maxDelayMs);
}

// Pseudo-random generator for deterministic, repeatable property test runs
function makePrng(seed = 1337) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('Issue #382: Property tests for boundary numeric and timestamp values', async (t) => {
  const rand = makePrng(42);

  await t.test('Normal path property: amountsMatch symmetry and reflexivity across randomized amounts', () => {
    for (let i = 0; i < 200; i++) {
      const units = Math.floor(rand() * 100000);
      const decimals = Math.floor(rand() * 10000000);
      const strVal = `${units}.${String(decimals).padStart(7, '0')}`;
      const numVal = Number(strVal);

      // Property 1: Reflexivity
      assert.equal(amountsMatch(strVal, strVal, 0), true, `Reflexivity failed for ${strVal}`);
      assert.equal(amountsMatch(numVal, numVal, 0), true, `Reflexivity failed for ${numVal}`);

      // Property 2: String vs numeric representation equivalence
      assert.equal(amountsMatch(strVal, numVal, 0), true, `String vs number equivalence failed for ${strVal}`);

      // Property 3: Symmetry with tolerance
      const tolerance = Math.floor(rand() * 5);
      const deltaStroops = Math.floor(rand() * (tolerance + 1));
      const deltaUnits = deltaStroops / STROOP_SCALE;
      const actualVal = numVal + deltaUnits;

      assert.equal(
        amountsMatch(strVal, actualVal, tolerance),
        amountsMatch(actualVal, strVal, tolerance),
        `Symmetry failed for ${strVal} vs ${actualVal} with tolerance ${tolerance}`
      );
    }
  });

  await t.test('Normal path property: trailing zeros invariance in decimal representation', () => {
    const testCases = [
      ['10.5000000', '10.5'],
      ['1.0000000', '1'],
      ['0.0000001', '0.00000010000'],
      ['100.1234500', '100.12345'],
      ['500', '500.0000000'],
    ];

    for (const [a, b] of testCases) {
      assert.equal(amountsMatch(a, b, 0), true, `Trailing zeros failed for ${a} vs ${b}`);
      assert.equal(amountsMatch(b, a, 0), true, `Trailing zeros failed for ${b} vs ${a}`);
    }
  });

  await t.test('Failure path property: rejects non-finite, sub-stroop or negative numbers gracefully', () => {
    const invalidInputs = [
      -1,
      -0.0000001,
      0, // Zero cannot satisfy positive requirement
      NaN,
      Infinity,
      -Infinity,
      'abc',
      '',
      '   ',
      null,
      undefined,
      {},
      [],
      '1e20', // Out of safe integer range
      '999999999999999999999999',
    ];

    for (const bad of invalidInputs) {
      assert.equal(amountsMatch(10, bad, 0), false, `Should reject invalid input: ${String(bad)}`);
      assert.equal(amountsMatch(bad, 10, 0), false, `Should reject invalid input: ${String(bad)}`);
    }
  });

  await t.test('Failure path property: expiry days range validation strictly enforces 1..30 whole days', () => {
    // Valid days
    for (let d = 1; d <= 30; d++) {
      assert.equal(validateInvoiceExpiryDays(d), d);
    }
    assert.equal(validateInvoiceExpiryDays(undefined), 7);
    assert.equal(validateInvoiceExpiryDays(null), 7);

    // Invalid days
    const invalidDays = [0, -1, -30, 31, 32, 100, 1.5, 7.2, 29.99, NaN, Infinity, -Infinity, '7', '1', true, false, {}];
    for (const bad of invalidDays) {
      assert.throws(
        () => validateInvoiceExpiryDays(bad),
        RangeError,
        `Expected RangeError for invalid expiry days: ${String(bad)}`
      );
    }
  });

  await t.test('Retry path property: exponential backoff bounds and monotonicity', () => {
    const policy = {
      maxAttempts: 5,
      baseDelayMs: 1000,
      backoffFactor: 2,
      maxDelayMs: 300000,
    };

    // Property: Monotonic growth up to maxDelayMs
    let prev = 0;
    for (let attempt = 1; attempt <= 30; attempt++) {
      const delay = computeBackoffMs(policy, attempt);
      assert.ok(delay >= prev, `Delay at attempt ${attempt} (${delay}) should be >= previous (${prev})`);
      assert.ok(delay <= policy.maxDelayMs, `Delay at attempt ${attempt} (${delay}) should not exceed maxDelayMs`);
      assert.ok(Number.isFinite(delay), `Delay must be finite`);
      prev = delay;
    }

    // Property: Extreme attempt values (overflow protection)
    assert.equal(computeBackoffMs(policy, 1000), policy.maxDelayMs);
    assert.equal(computeBackoffMs(policy, 1000000000), policy.maxDelayMs);
    assert.equal(computeBackoffMs(policy, -5), policy.baseDelayMs);
    assert.equal(computeBackoffMs(policy, 0), policy.baseDelayMs);
    assert.equal(computeBackoffMs(policy, NaN), policy.baseDelayMs);
  });

  await t.test('Authorization & Lifecycle path property: millisecond timestamp boundary and monotonicity', () => {
    const baseTime = new Date('2026-06-15T12:00:00.000Z').getTime();
    const invoice = {
      status: 'PENDING',
      expiresAt: new Date(baseTime).toISOString(),
    };

    // Exactly at expiry -> Expired (inclusive boundary)
    assert.equal(isPendingInvoiceExpired(invoice, new Date(baseTime)), true);

    // 1 millisecond before expiry -> NOT expired
    assert.equal(isPendingInvoiceExpired(invoice, new Date(baseTime - 1)), false);

    // 1 millisecond after expiry -> Expired
    assert.equal(isPendingInvoiceExpired(invoice, new Date(baseTime + 1)), true);

    // Monotonicity property: if expired at T, must remain expired for all T' > T
    for (let delta = 1; delta <= 10000; delta += 500) {
      assert.equal(isPendingInvoiceExpired(invoice, new Date(baseTime + delta)), true);
    }

    // Terminal status property: PAID invoices never transition to expired
    assert.equal(isPendingInvoiceExpired({ status: 'PAID', expiresAt: new Date(baseTime).toISOString() }, new Date(baseTime + 1000)), false);
  });

  await t.test('Timezone and epoch boundary properties', () => {
    // Leap year date (2024-02-29)
    const leapDate = new Date('2024-02-29T23:59:59.999Z');
    assert.equal(isPendingInvoiceExpired({ status: 'PENDING', expiresAt: leapDate.toISOString() }, leapDate), true);

    // Year 2038 Unix 32-bit rollover boundary
    const y2038 = new Date('2038-01-19T03:14:07.000Z');
    assert.equal(isPendingInvoiceExpired({ status: 'PENDING', expiresAt: y2038.toISOString() }, y2038), true);

    // Timezone offsets invariance (same absolute epoch time)
    const utcIso = '2026-04-10T15:00:00.000Z';
    const estIso = '2026-04-10T11:00:00.000-04:00';
    const istIso = '2026-04-10T20:30:00.000+05:30';

    const testInstant = new Date(utcIso);
    assert.equal(isPendingInvoiceExpired({ status: 'PENDING', expiresAt: utcIso }, testInstant), true);
    assert.equal(isPendingInvoiceExpired({ status: 'PENDING', expiresAt: estIso }, testInstant), true);
    assert.equal(isPendingInvoiceExpired({ status: 'PENDING', expiresAt: istIso }, testInstant), true);
  });
});
