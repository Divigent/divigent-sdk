import type { Address, Hex } from 'viem';
import { getAddress, isAddress, isHex } from 'viem';
import { DivigentError } from './errors';

// Brand primitives

declare const __brand: unique symbol;
type Tagged<TBase, TTag extends string> = TBase & { readonly [__brand]: TTag };

/** @notice Checksummed EVM address branded after runtime validation. */
export type EvmAddress = Tagged<Address, 'EvmAddress'>;

/** @notice 32-byte transaction hash branded after runtime validation. */
export type TxHash     = Tagged<Hex,     'TxHash'>;

/**
 * @notice Validate and checksum an EVM address.
 * @param v Address-like string.
 * @returns Checksummed branded EVM address.
 * @throws If `v` is not a valid EVM address.
 */
export function evmAddress(v: string): EvmAddress {
  if (!isAddress(v)) {
    throw new DivigentError(`[@divigent/sdk] invalid EVM address: "${v}"`, {
      code: 'DIVIGENT_INVALID_ADDRESS',
      category: 'validation',
      context: { value: v },
    });
  }
  // Canonicalize to EIP-55 checksummed form so downstream `===` comparisons
  // don't silently mismatch between lowercase and checksummed variants of
  // the same address.
  return getAddress(v) as EvmAddress;
}

/**
 * @notice Validate and normalize a transaction hash.
 * @param v Hash-like string.
 * @returns Lowercase branded transaction hash.
 * @throws If `v` is not 32 bytes.
 */
export function txHash(v: string): TxHash {
  if (!isHex(v) || v.length !== 66) {
    throw new DivigentError(`[@divigent/sdk] invalid tx hash: "${v}" (expected 0x + 64 hex chars)`, {
      code: 'DIVIGENT_INVALID_TX_HASH',
      category: 'validation',
      context: { value: v },
    });
  }
  return v.toLowerCase() as TxHash;
}

/**
 * @notice Per-call EIP-1559 fee override, plumbed through the hot-path writes.
 * viem's default fee estimator can overpay during Base sequencer spikes —
 * callers that monitor the base-fee can cap it here.
 */
export type FeeOverrides = {
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
};

// Utility types

/** @notice Expand intersections in editor/tooling displays. */
export type Prettify<T> = { [K in keyof T]: T[K] } & {};

// Router

/** @notice Wallet position returned by `Divigent.getPosition`. Values are USDC atomic units. */
export type Position = {
  depositedUSDC: bigint;
  currentValue: bigint;
  accruedYield: bigint;
};

/** @notice Current protocol liquidity and withdrawal capacity by venue. */
export type VaultCapacity = {
  aaveAssetsHeld: bigint;
  aaveIdleLiquidity: bigint;
  aaveWithdrawCap: bigint;
  morphoAssetsHeld: bigint;
  morphoWithdrawCap: bigint;
  morphoReachable: boolean;
  totalWithdrawCap: bigint;
};

/** @notice Current asset allocation across the supported yield venues. */
export type VaultAllocation = {
  aaveAssets: bigint;
  morphoAssets: bigint;
};

/** @notice Fee collector treasury rotation state. */
export type TreasuryStatus = {
  current: EvmAddress;
  pending: EvmAddress;
  effectiveAt: bigint;
};

// Oracle

/** @notice Yield venue identifier used by router/oracle reads. */
export type VaultType = 'AAVE' | 'MORPHO';

/** @notice Oracle-selected venue for the next deposit route. */
export type OptimalVault = {
  vault: EvmAddress;
  vaultType: VaultType;
  twarRate: bigint;
};

/** @notice Freshness status for the yield oracle. */
export type OracleStatus = {
  lastObservationTime: bigint;
  fresh: boolean;
};

/** @notice Per-vault rate data returned by the oracle. */
export type VaultRate = {
  vault: EvmAddress;
  vaultType: VaultType;
  spotRate: bigint;
  twarRate: bigint;
  isSafe: boolean;
};

// Signing

/** @notice EIP-2612 permit signature parts for USDC deposits. */
export type PermitSig = {
  v: number;
  r: Hex;
  s: Hex;
  deadline: bigint;
};

// Action results

/** @notice Common result shape for broadcasted transactions. */
export type TxResult = {
  txHash: TxHash;
};

/** @notice Parsed result of a successful Divigent deposit receipt. */
export type DepositResult = Prettify<TxResult & { sharesMinted: bigint }>;

/** @notice Parsed result of a successful Divigent withdraw receipt. */
export type WithdrawResult = Prettify<TxResult & { usdcReturned: bigint }>;

/** @notice Options forwarded to viem's `waitForTransactionReceipt`. */
export type WaitOptions = {
  /** @notice Number of confirmations before the helper resolves. viem default: 1. */
  confirmations?: number;
  /** @notice Polling interval in milliseconds, forwarded to viem. */
  pollingInterval?: number;
  /** @notice Timeout in milliseconds, forwarded to viem. */
  timeout?: number;
};
