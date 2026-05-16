import type { EvmAddress } from '../types';

const ownerLocks = new Map<string, Promise<unknown>>();

/**
 * @notice Serialize x402 liquidity mutations for one wallet owner.
 * @remarks Shared by recall, failure redeposit, settlement redeposit, and
 * manual idle deposits so concurrent hooks cannot move the same USDC twice.
 */
export function withOwnerLock<T>(owner: EvmAddress, fn: () => Promise<T>): Promise<T> {
  const key = owner.toLowerCase();
  const prev = ownerLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const cleanup = next.then(
    () => undefined,
    () => undefined,
  );
  ownerLocks.set(key, cleanup);
  void cleanup.then(() => {
    if (ownerLocks.get(key) === cleanup) {
      ownerLocks.delete(key);
    }
  });
  return next as Promise<T>;
}
