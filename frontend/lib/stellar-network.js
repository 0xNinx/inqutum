/**
 * Pure, Stellar-SDK-free network, URL, error and key contract for the frontend
 * wallet boundary (issue #154). Kept as plain CommonJS so node's test runner can
 * load it directly, like the other lib/*.js modules.
 *
 * stellar.ts consumes these primitives, so its network/URL/error behaviour is
 * regression-tested against the real implementation rather than a spec copy.
 * The response and error-code strings here are the stable conventions shared by
 * the MVP and persistent paths; do not change them without coordinating both.
 */

const NETWORK_PASSPHRASES = Object.freeze({
  TESTNET: 'Test SDF Network ; September 2015',
  PUBLIC: 'Public Global Stellar Network ; September 2015',
});

/** Canonical network name; defaults to PUBLIC for anything that is not TESTNET. */
function normalizeNetworkName(network) {
  const name = typeof network === 'string' ? network.trim().toUpperCase() : '';
  return name === 'TESTNET' ? 'TESTNET' : 'PUBLIC';
}

/** Canonical Stellar network passphrase for the given network. */
function resolveNetworkPassphrase(network) {
  return NETWORK_PASSPHRASES[normalizeNetworkName(network)];
}

/** Horizon base URL for the given network. */
function resolveHorizonUrl(network) {
  return normalizeNetworkName(network) === 'TESTNET'
    ? 'https://horizon-testnet.stellar.org'
    : 'https://horizon.stellar.org';
}

/**
 * True when the wallet-reported network does not match the expected one.
 * Falsy/empty values are treated as "unknown, not wrong" (no false alarm);
 * non-string values degrade to a mismatch instead of throwing.
 */
function isWrongNetwork(current, expected = 'TESTNET') {
  if (!current) return false;
  const cur = String(current).trim();
  const exp = typeof expected === 'string' ? expected.trim().toUpperCase() : '';
  const expectedPassphrase =
    exp === 'TESTNET' ? NETWORK_PASSPHRASES.TESTNET : NETWORK_PASSPHRASES.PUBLIC;
  if (cur.toUpperCase() === exp || cur === expectedPassphrase) return false;
  if (exp === 'TESTNET' && cur.toLowerCase().includes('test sdf network')) return false;
  if (exp === 'PUBLIC' && cur.toLowerCase().includes('public global stellar network')) return false;
  return true;
}

/**
 * Map a Stellar/Horizon error to a stable, user-facing message. Preserves the
 * response/error-code conventions shared by the MVP and persistent paths.
 */
function describeStellarNetworkError(error) {
  if (error?.message?.includes('Not Found') || error?.response?.status === 404) {
    return 'Account needs funding on the selected Stellar network.';
  }
  if (!error?.response || ['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT'].includes(error?.code)) {
    return 'Stellar Horizon is temporarily unreachable. Your wallet can stay connected; retry shortly.';
  }
  return error?.message || 'Stellar network request failed.';
}

const STELLAR_PUBLIC_KEY_RE = /^G[A-Z2-7]{55}$/;

/** True for a canonical 56-character Stellar public key (G + base-32). */
function isStellarPublicKey(publicKey) {
  return STELLAR_PUBLIC_KEY_RE.test(String(publicKey ?? ''));
}

module.exports = {
  NETWORK_PASSPHRASES,
  normalizeNetworkName,
  resolveNetworkPassphrase,
  resolveHorizonUrl,
  isWrongNetwork,
  describeStellarNetworkError,
  STELLAR_PUBLIC_KEY_RE,
  isStellarPublicKey,
};
