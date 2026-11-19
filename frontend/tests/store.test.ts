/**
 * Regression tests for frontend/lib/store.ts (issue #180).
 *
 * Covers the success path, input validation, degraded-dependency (corrupt
 * persisted state) recovery, and error-state lifecycle.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { validatePublicKey, validateBalance, rehydrateWalletState, useWalletStore } from '../lib/store';

// ─── validatePublicKey ───────────────────────────────────────────────────────

describe('validatePublicKey', () => {
  const VALID_KEY = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

  it('accepts a canonical Stellar public key', () => {
    assert.equal(validatePublicKey(VALID_KEY), VALID_KEY);
  });

  it('trims surrounding whitespace before validating', () => {
    assert.equal(validatePublicKey(`  ${VALID_KEY}  `), VALID_KEY);
  });

  it('rejects an empty string', () => {
    assert.throws(() => validatePublicKey(''), /non-empty/);
  });

  it('rejects a key that does not start with G', () => {
    const bad = `A${'B'.repeat(55)}`;
    assert.throws(() => validatePublicKey(bad), /G/);
  });

  it('rejects a key that is too short', () => {
    assert.throws(() => validatePublicKey('GSHORT'), /56/);
  });

  it('rejects a key that is too long', () => {
    assert.throws(() => validatePublicKey(`G${'A'.repeat(56)}`), /56/);
  });

  it('rejects a key containing lowercase characters', () => {
    const lower = `g${'b'.repeat(55)}`;
    assert.throws(() => validatePublicKey(lower), /G/);
  });

  it('rejects a non-string argument', () => {
    // @ts-expect-error deliberate wrong type
    assert.throws(() => validatePublicKey(null), /non-empty/);
    // @ts-expect-error deliberate wrong type
    assert.throws(() => validatePublicKey(undefined), /non-empty/);
  });
});

// ─── validateBalance ─────────────────────────────────────────────────────────

describe('validateBalance', () => {
  it('accepts a zero balance', () => {
    assert.equal(validateBalance('0'), '0');
  });

  it('accepts a positive decimal balance', () => {
    assert.equal(validateBalance('1234.5678900'), '1234.5678900');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(validateBalance('  100  '), '100');
  });

  it('rejects an empty string', () => {
    assert.throws(() => validateBalance(''), /non-negative/);
  });

  it('rejects a negative number', () => {
    assert.throws(() => validateBalance('-1'), /non-negative/);
  });

  it('rejects non-numeric text', () => {
    assert.throws(() => validateBalance('abc'), /non-negative/);
  });

  it('rejects NaN string', () => {
    assert.throws(() => validateBalance('NaN'), /non-negative/);
  });

  it('rejects a non-string argument', () => {
    // @ts-expect-error deliberate wrong type
    assert.throws(() => validateBalance(100), /string/);
  });
});

// ─── rehydrateWalletState (degraded-dependency / corrupt-storage recovery) ──

describe('rehydrateWalletState', () => {
  const VALID_KEY = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

  // Minimal stand-in for the WalletState "current" defaults.
  function makeDefaults(): any {
    return {
      publicKey: null,
      balance: '0',
      connected: false,
      lastError: null,
      setWallet: () => {},
      updateBalance: () => {},
      disconnect: () => {},
      clearError: () => {},
    };
  }

  it('restores valid persisted fields verbatim', () => {
    const result = rehydrateWalletState(
      { publicKey: VALID_KEY, balance: '12.5', connected: true },
      makeDefaults()
    );
    assert.equal(result.publicKey, VALID_KEY);
    assert.equal(result.balance, '12.5');
    assert.equal(result.connected, true);
  });

  it('falls back to null publicKey when persisted value is not a string', () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      const result = rehydrateWalletState({ publicKey: bad, balance: '0', connected: false }, makeDefaults());
      assert.equal(result.publicKey, null, String(bad));
    }
  });

  it('falls back to "0" balance when persisted value is not a string', () => {
    for (const bad of [undefined, null, 42, NaN, {}]) {
      const result = rehydrateWalletState({ publicKey: null, balance: bad, connected: false }, makeDefaults());
      assert.equal(result.balance, '0', String(bad));
    }
  });

  it('falls back to false connected when persisted value is not a boolean', () => {
    for (const bad of [undefined, null, 1, 'true', {}]) {
      const result = rehydrateWalletState({ publicKey: null, balance: '0', connected: bad }, makeDefaults());
      assert.equal(result.connected, false, String(bad));
    }
  });

  it('handles a fully null/undefined persisted object without throwing', () => {
    const result = rehydrateWalletState(null, makeDefaults());
    assert.equal(result.publicKey, null);
    assert.equal(result.balance, '0');
    assert.equal(result.connected, false);
  });

  it('handles an empty persisted object without throwing', () => {
    const result = rehydrateWalletState({}, makeDefaults());
    assert.equal(result.publicKey, null);
    assert.equal(result.balance, '0');
    assert.equal(result.connected, false);
  });

  it('preserves the action functions from the current (live) defaults', () => {
    const defaults = makeDefaults();
    const result = rehydrateWalletState({ publicKey: VALID_KEY, balance: '1', connected: true }, defaults);
    assert.equal(result.setWallet, defaults.setWallet);
    assert.equal(result.disconnect, defaults.disconnect);
    assert.equal(result.clearError, defaults.clearError);
  });
});

// ─── useWalletStore — store boundary (success / validation / error lifecycle) ─

describe('useWalletStore', () => {
  const VALID_KEY = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

  it('setWallet succeeds with a valid key and balance and clears lastError', () => {
    const store = useWalletStore.getState();
    // Start clean.
    store.disconnect();
    const result = store.setWallet(VALID_KEY, '10.5');
    const s = useWalletStore.getState();
    assert.equal(result.ok, true);
    assert.equal(s.publicKey, VALID_KEY);
    assert.equal(s.balance, '10.5');
    assert.equal(s.connected, true);
    assert.equal(s.lastError, null);
  });

  it('setWallet returns ok:false and records lastError for an invalid public key', () => {
    const store = useWalletStore.getState();
    store.disconnect();
    const result = store.setWallet('NOT_A_KEY', '1');
    const s = useWalletStore.getState();
    assert.equal(result.ok, false);
    assert.ok(typeof result.error === 'string' && result.error.length > 0);
    assert.equal(s.connected, false);
    assert.ok(s.lastError !== null);
  });

  it('setWallet returns ok:false and records lastError for an invalid balance', () => {
    const store = useWalletStore.getState();
    store.disconnect();
    const result = store.setWallet(VALID_KEY, '-5');
    const s = useWalletStore.getState();
    assert.equal(result.ok, false);
    assert.ok(s.lastError !== null);
  });

  it('updateBalance succeeds and clears lastError', () => {
    const store = useWalletStore.getState();
    store.disconnect();
    store.setWallet(VALID_KEY, '1');
    const result = store.updateBalance('99.0000000');
    const s = useWalletStore.getState();
    assert.equal(result.ok, true);
    assert.equal(s.balance, '99.0000000');
    assert.equal(s.lastError, null);
  });

  it('updateBalance returns ok:false for a negative balance', () => {
    const store = useWalletStore.getState();
    store.disconnect();
    store.setWallet(VALID_KEY, '1');
    const result = store.updateBalance('-1');
    assert.equal(result.ok, false);
    assert.ok(useWalletStore.getState().lastError !== null);
  });

  it('clearError resets lastError to null without touching other fields', () => {
    const store = useWalletStore.getState();
    // Force an error into the store.
    store.setWallet('BAD', '0');
    assert.ok(useWalletStore.getState().lastError !== null);
    store.clearError();
    assert.equal(useWalletStore.getState().lastError, null);
  });

  it('disconnect resets every field to safe defaults', () => {
    const store = useWalletStore.getState();
    store.setWallet(VALID_KEY, '50');
    store.disconnect();
    const s = useWalletStore.getState();
    assert.equal(s.publicKey, null);
    assert.equal(s.balance, '0');
    assert.equal(s.connected, false);
    assert.equal(s.lastError, null);
  });

  it('a second valid setWallet overwrites state from the first (retry path)', () => {
    const store = useWalletStore.getState();
    store.disconnect();
    const KEY2 = 'G' + 'C'.repeat(55);
    store.setWallet(VALID_KEY, '1');
    const result = store.setWallet(KEY2, '2');
    const s = useWalletStore.getState();
    assert.equal(result.ok, true);
    assert.equal(s.publicKey, KEY2);
    assert.equal(s.balance, '2');
  });
});
