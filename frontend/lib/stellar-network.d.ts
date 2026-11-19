/** Pure Stellar network/URL/error/key contract (issue #154). See stellar-network.js. */
export const NETWORK_PASSPHRASES: {
  readonly TESTNET: string;
  readonly PUBLIC: string;
};
export function normalizeNetworkName(network: unknown): 'TESTNET' | 'PUBLIC';
export function resolveNetworkPassphrase(network: unknown): string;
export function resolveHorizonUrl(network: unknown): string;
export function isWrongNetwork(current: unknown, expected?: string): boolean;
export function describeStellarNetworkError(error: any): string;
export const STELLAR_PUBLIC_KEY_RE: RegExp;
export function isStellarPublicKey(publicKey: unknown): boolean;
