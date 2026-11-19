const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Stellar network contract tests (#154).
 *
 * These tests import the REAL pure implementation from lib/stellar-network.js —
 * the single source of truth that stellar.ts consumes — so the network/URL/error
 * contract is regression-tested against the code in the running boundary rather
 * than a duplicated spec.
 */
const {
  NETWORK_PASSPHRASES,
  normalizeNetworkName,
  resolveNetworkPassphrase,
  resolveHorizonUrl,
  isWrongNetwork,
  describeStellarNetworkError,
  STELLAR_PUBLIC_KEY_RE,
  isStellarPublicKey,
} = require('../lib/stellar-network');

const NETWORKS = NETWORK_PASSPHRASES;

// ─── network name normalisation ─────────────────────────────────────────────

test('normalizeNetworkName maps TESTNET variants to TESTNET and everything else to PUBLIC', () => {
  assert.equal(normalizeNetworkName('TESTNET'), 'TESTNET');
  assert.equal(normalizeNetworkName('testnet'), 'TESTNET');
  assert.equal(normalizeNetworkName('  Testnet '), 'TESTNET');
  assert.equal(normalizeNetworkName('PUBLIC'), 'PUBLIC');
  assert.equal(normalizeNetworkName('mainnet'), 'PUBLIC');
  assert.equal(normalizeNetworkName(''), 'PUBLIC');
  assert.equal(normalizeNetworkName(null), 'PUBLIC');
  assert.equal(normalizeNetworkName(undefined), 'PUBLIC');
  assert.equal(normalizeNetworkName(123), 'PUBLIC');
});

// ─── network matching (success / validation / degraded) ─────────────────────

test('network matching accepts exact names and passphrases', () => {
  assert.equal(isWrongNetwork('TESTNET', 'TESTNET'), false);
  assert.equal(isWrongNetwork('PUBLIC', 'PUBLIC'), false);
  assert.equal(isWrongNetwork(NETWORKS.TESTNET, 'TESTNET'), false);
  assert.equal(isWrongNetwork(NETWORKS.PUBLIC, 'PUBLIC'), false);
});

test('network matching is case-insensitive', () => {
  assert.equal(isWrongNetwork('testnet', 'TESTNET'), false);
  assert.equal(isWrongNetwork('Testnet', 'TESTNET'), false);
  assert.equal(isWrongNetwork('public', 'PUBLIC'), false);
});

test('network matching detects mismatches', () => {
  assert.equal(isWrongNetwork('PUBLIC', 'TESTNET'), true);
  assert.equal(isWrongNetwork('TESTNET', 'PUBLIC'), true);
  assert.equal(isWrongNetwork(NETWORKS.PUBLIC, 'TESTNET'), true);
});

test('network matching handles null and empty values gracefully', () => {
  assert.equal(isWrongNetwork(null, 'TESTNET'), false);
  assert.equal(isWrongNetwork(undefined, 'TESTNET'), false);
  assert.equal(isWrongNetwork('', 'TESTNET'), false);
});

test('network matching degrades safely for non-string current instead of throwing', () => {
  // A non-string network reported by the wallet is treated as a mismatch and
  // never crashes the caller (graceful degraded-dependency handling).
  assert.equal(isWrongNetwork(123, 'TESTNET'), true);
  assert.equal(isWrongNetwork({}, 'TESTNET'), true);
  assert.equal(typeof isWrongNetwork([], 'PUBLIC'), 'boolean');
});

// ─── horizon URL (success / degraded default) ───────────────────────────────

test('horizon URL defaults to testnet for TESTNET, public otherwise', () => {
  assert.equal(resolveHorizonUrl('TESTNET'), 'https://horizon-testnet.stellar.org');
  assert.equal(resolveHorizonUrl('PUBLIC'), 'https://horizon.stellar.org');
  assert.equal(resolveHorizonUrl(null), 'https://horizon.stellar.org');
  assert.equal(resolveHorizonUrl(undefined), 'https://horizon.stellar.org');
});

test('horizon URL resolution is case-insensitive and defaults unknown networks to public', () => {
  assert.equal(resolveHorizonUrl('testnet'), 'https://horizon-testnet.stellar.org');
  assert.equal(resolveHorizonUrl('  Testnet '), 'https://horizon-testnet.stellar.org');
  assert.equal(resolveHorizonUrl('mainnet'), 'https://horizon.stellar.org');
  assert.equal(resolveHorizonUrl(42), 'https://horizon.stellar.org');
});

// ─── network passphrase ──────────────────────────────────────────────────────

test('resolveNetworkPassphrase returns the canonical Stellar passphrase per network', () => {
  assert.equal(resolveNetworkPassphrase('TESTNET'), NETWORKS.TESTNET);
  assert.equal(resolveNetworkPassphrase('PUBLIC'), NETWORKS.PUBLIC);
});

test('resolveNetworkPassphrase defaults unknown networks to the PUBLIC passphrase', () => {
  assert.equal(resolveNetworkPassphrase('mainnet'), NETWORKS.PUBLIC);
  assert.equal(resolveNetworkPassphrase(''), NETWORKS.PUBLIC);
  assert.equal(resolveNetworkPassphrase(null), NETWORKS.PUBLIC);
  assert.equal(resolveNetworkPassphrase(undefined), NETWORKS.PUBLIC);
});

// ─── error mapping (success / validation / retry / degraded) ─────────────────

test('404 errors produce the funding message', () => {
  assert.match(describeStellarNetworkError({ response: { status: 404 } }), /funding/);
  assert.match(describeStellarNetworkError({ message: 'Not Found' }), /funding/);
});

test('network errors produce the retry message', () => {
  assert.match(describeStellarNetworkError({ code: 'ERR_NETWORK' }), /retry shortly/);
  assert.match(describeStellarNetworkError({ code: 'ETIMEDOUT' }), /retry shortly/);
  assert.match(describeStellarNetworkError({ code: 'ECONNABORTED' }), /retry shortly/);
  assert.match(describeStellarNetworkError({}), /retry shortly/);
});

test('nullish errors degrade to the retry message instead of throwing', () => {
  assert.match(describeStellarNetworkError(null), /retry shortly/);
  assert.match(describeStellarNetworkError(undefined), /retry shortly/);
});

test('server errors fall through to message or generic fallback', () => {
  assert.equal(describeStellarNetworkError({ response: { status: 500 }, message: 'Server error' }), 'Server error');
  assert.equal(describeStellarNetworkError({ response: { status: 500 } }), 'Stellar network request failed.');
});

// ─── public key contract ────────────────────────────────────────────────────

const STELLAR_PUBLIC_KEY = STELLAR_PUBLIC_KEY_RE;

test('public key pattern accepts valid Stellar keys', () => {
  assert.ok(STELLAR_PUBLIC_KEY.test('G' + 'A'.repeat(55)));
  assert.ok(STELLAR_PUBLIC_KEY.test('G' + 'B'.repeat(55)));
});

test('public key pattern rejects invalid keys', () => {
  assert.ok(!STELLAR_PUBLIC_KEY.test(''));
  assert.ok(!STELLAR_PUBLIC_KEY.test('G' + 'A'.repeat(54)));
  assert.ok(!STELLAR_PUBLIC_KEY.test('G' + 'A'.repeat(56)));
  assert.ok(!STELLAR_PUBLIC_KEY.test('H' + 'A'.repeat(55)));
  assert.ok(!STELLAR_PUBLIC_KEY.test('G' + 'a'.repeat(55)));
  assert.ok(!STELLAR_PUBLIC_KEY.test('G' + '0'.repeat(55)));
});

test('isStellarPublicKey matches the pattern for strings and rejects non-strings', () => {
  assert.equal(isStellarPublicKey('G' + 'A'.repeat(55)), true);
  assert.equal(isStellarPublicKey('G' + 'B'.repeat(55)), true);
  assert.equal(isStellarPublicKey('GSHORT'), false);
  assert.equal(isStellarPublicKey(''), false);
  assert.equal(isStellarPublicKey(null), false);
  assert.equal(isStellarPublicKey(undefined), false);
  assert.equal(isStellarPublicKey(123), false);
  assert.equal(isStellarPublicKey({ g: 'G...' }), false);
});
