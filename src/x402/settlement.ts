import type { x402HTTPClient } from '@x402/core/client';
import type { x402ResourceServer } from '@x402/core/server';
import { parseEventLogs } from 'viem';
import { usdcAbi } from '../abis';
import type { Divigent } from '../divigent';
import type { EvmAddress, TxHash } from '../types';
import type { IdleDepositContext, X402WrapConfig } from './types';
import {
  reportNonFatal,
  ReserveFloor,
  shouldHandleResourceByPolicy,
} from './attach';

const ownerLocks = new Map<string, Promise<unknown>>();

function withOwnerLock<T>(owner: EvmAddress, fn: () => Promise<T>): Promise<T> {
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

async function resolveMinDeposit(
  minDeposit: DepositIdleOptions['minDeposit'] | undefined,
): Promise<bigint> {
  if (minDeposit === undefined) return 1n;
  return typeof minDeposit === 'function' ? await minDeposit() : minDeposit;
}

function walletAddress(divigent: Divigent): EvmAddress | undefined {
  return divigent.walletClient?.account?.address as EvmAddress | undefined;
}

function sameAddress(a: string | undefined, b: EvmAddress): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

function parseSettleAmount(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

async function settlementDebitReserve(
  divigent: Divigent,
  settle: { payer?: string; amount?: string; transaction?: string },
): Promise<bigint> {
  const wallet = walletAddress(divigent);
  if (!wallet) return 0n;

  const responseAmount = parseSettleAmount(settle.amount);
  if (responseAmount !== undefined && sameAddress(settle.payer, wallet)) {
    return responseAmount;
  }

  const publicClient = divigent.publicClient as
    | { getTransactionReceipt?: (args: { hash: TxHash }) => Promise<{ logs: readonly unknown[] }> }
    | undefined;
  if (typeof settle.transaction !== 'string' || typeof publicClient?.getTransactionReceipt !== 'function') {
    return 0n;
  }

  try {
    const receipt = await publicClient.getTransactionReceipt({
      hash: settle.transaction as TxHash,
    });
    const transfers = parseEventLogs({
      abi: usdcAbi,
      logs: receipt.logs as Parameters<typeof parseEventLogs>[0]['logs'],
      eventName: 'Transfer',
    });

    return transfers.reduce((sum, event) => {
      if (event.address.toLowerCase() !== divigent.addresses.usdc.toLowerCase()) return sum;
      if (event.args.from.toLowerCase() !== wallet.toLowerCase()) return sum;
      return sum + event.args.value;
    }, 0n);
  } catch {
    return 0n;
  }
}

export type DepositIdleOptions = {
  /** @notice Override which wallet to sweep. Defaults to `divigent.walletClient.account.address`. */
  wallet?: EvmAddress;
  /** @notice Skip the deposit if the idle amount is below this threshold. Default: 1n. */
  minDeposit?: bigint | (() => bigint | Promise<bigint>);
  /** @notice Idempotency key for settlement/income sweeps. */
  dedupeKey?: string;
  /** @notice Optional set used to remember settled transaction keys. */
  seenTxHashes?: Set<string>;
  /** @notice Receives successful idle-deposit telemetry. */
  onIdleDeposit?: (ctx: IdleDepositContext) => void | Promise<void>;
  /** @notice Receives non-fatal idle-deposit observer errors. */
  onNonFatalError?: X402WrapConfig['onNonFatalError'];
  /** @notice Extra USDC to keep liquid in addition to the reserve floor. */
  extraReserve?: bigint;
};

/**
 * @notice Deposit any wallet USDC above the reserve floor into the Divigent vault.
 * @param divigent Divigent facade used for balance reads and deposits.
 * @param reserveFloor Shared reserve floor that should stay liquid.
 * @param options Wallet, minimum deposit, and dedupe options.
 * @returns Redeposit transaction hash, or `undefined` when no sweep occurs.
 */
export async function depositIdleAboveFloor(
  divigent: Divigent,
  reserveFloor: ReserveFloor,
  options: DepositIdleOptions = {},
): Promise<TxHash | undefined> {
  const wallet =
    options.wallet ?? (divigent.walletClient?.account?.address as EvmAddress | undefined);
  if (!wallet) return undefined;

  if (options.dedupeKey && options.seenTxHashes?.has(options.dedupeKey)) return undefined;

  return await withOwnerLock(wallet, async () => {
    if (options.dedupeKey && options.seenTxHashes?.has(options.dedupeKey)) return undefined;

    const balance = await divigent.usdcBalance(wallet);
    const baseFloor = reserveFloor.required();
    const settlementReserve = options.extraReserve ?? 0n;
    const floor = baseFloor + settlementReserve;
    if (balance <= floor) return undefined;

    const idle = balance - floor;
    const min = await resolveMinDeposit(options.minDeposit);
    if (idle < min) return undefined;

    const result = await divigent.depositWithPermitAndWait({ amount: idle, wallet });
    const txHash = result.txHash;
    if (options.dedupeKey) options.seenTxHashes?.add(options.dedupeKey);
    if (options.onIdleDeposit) {
      try {
        await options.onIdleDeposit({
          wallet,
          walletBalance: balance,
          reserveFloor: baseFloor,
          ...(settlementReserve > 0n && { settlementReserve }),
          idleAmount: idle,
          txHash,
          ...(options.dedupeKey !== undefined && { dedupeKey: options.dedupeKey }),
        });
      } catch (err) {
        await reportNonFatal(options.onNonFatalError, {
          phase: 'observer',
          error: err,
          recoverable: true,
          label: 'onIdleDeposit',
        });
      }
    }
    return txHash;
  });
}

export type HandleSettlementOptions = {
  /** @notice Optional dedupe set keyed by `settle.transaction`. */
  seenTxHashes?: Set<string>;
  /** @notice Same policy config used by Divigent's x402 attach path. */
  config?: X402WrapConfig;
  /** @notice Resource URL to policy-check; defaults to response.url when available. */
  resource?: string;
  /** @notice Skip deposits below this idle amount. Default: 1n. */
  minDeposit?: DepositIdleOptions['minDeposit'];
  /** @notice Receives successful idle-deposit telemetry. */
  onIdleDeposit?: DepositIdleOptions['onIdleDeposit'];
  /** @notice Receives non-fatal idle-deposit observer errors. */
  onNonFatalError?: DepositIdleOptions['onNonFatalError'];
};

/**
 * @notice Inspect an HTTP response for an x402 PAYMENT-RESPONSE settlement header.
 * @param response Paid HTTP response to inspect.
 * @param http x402 HTTP client used to decode settlement headers.
 * @param divigent Divigent facade used for balance reads and deposits.
 * @param reserveFloor Shared reserve floor that should stay liquid.
 * @param options Dedupe and policy options.
 * @returns Redeposit transaction hash, or `undefined` when no action is taken.
 */
export async function handleDivigentSettlement(
  response: Response,
  http: x402HTTPClient,
  divigent: Divigent,
  reserveFloor: ReserveFloor,
  options: HandleSettlementOptions = {},
): Promise<TxHash | undefined> {
  let settle;
  try {
    settle = http.getPaymentSettleResponse((name) => response.headers.get(name));
  } catch {
    return undefined;
  }

  if (!settle.success) return undefined;
  if (typeof settle.transaction !== 'string' || settle.transaction.length === 0) {
    return undefined;
  }
  const resource = options.resource ?? (response.url || undefined);
  if (!shouldHandleResourceByPolicy(options.config, resource)) return undefined;

  const opts: DepositIdleOptions = { dedupeKey: settle.transaction };
  if (options.seenTxHashes !== undefined) opts.seenTxHashes = options.seenTxHashes;
  if (options.minDeposit !== undefined) opts.minDeposit = options.minDeposit;
  if (options.onIdleDeposit !== undefined) opts.onIdleDeposit = options.onIdleDeposit;
  if (options.onNonFatalError !== undefined) opts.onNonFatalError = options.onNonFatalError;
  const settlementReserve = await settlementDebitReserve(divigent, settle);
  if (settlementReserve > 0n) opts.extraReserve = settlementReserve;
  return depositIdleAboveFloor(divigent, reserveFloor, opts);
}

export type WrapFetchOptions = {
  /** @notice Maximum number of settled tx hashes to remember for dedupe. Default: 256. */
  dedupeCapacity?: number;
  /** @notice Existing dedupe set for plugin/shared-state integrations. */
  seenTxHashes?: Set<string>;
  /** @notice Same policy config used by Divigent's x402 attach path. */
  config?: X402WrapConfig;
  /** @notice Skip deposits below this idle amount. Default: 1n. */
  minDeposit?: DepositIdleOptions['minDeposit'];
  /** @notice Wait for the idle deposit before returning the paid response. */
  waitForIdleDeposit?: boolean;
  /** @notice Receives successful idle-deposit telemetry. */
  onIdleDeposit?: DepositIdleOptions['onIdleDeposit'];
  /** @notice Receives non-fatal idle-deposit observer errors. */
  onNonFatalError?: DepositIdleOptions['onNonFatalError'];
};

/**
 * @notice Wrap a paid fetch implementation so settled x402 responses redeposit idle USDC.
 * @param inner Existing fetch-with-payment implementation.
 * @param http x402 HTTP client used to decode settlement headers.
 * @param divigent Divigent facade used for redeposits.
 * @param reserveFloor Shared reserve floor that should stay liquid.
 * @param options Dedupe and policy options.
 * @returns Fetch-compatible wrapper.
 */
export function wrapFetchWithDivigentYield(
  inner: typeof fetch,
  http: x402HTTPClient,
  divigent: Divigent,
  reserveFloor: ReserveFloor,
  options: WrapFetchOptions = {},
): typeof fetch {
  const capacity = options.dedupeCapacity ?? 256;
  const seenTxHashes = options.seenTxHashes ?? new Set<string>();
  const pruneSeen = (): void => {
    while (seenTxHashes.size > capacity) {
      const oldest = seenTxHashes.values().next().value;
      if (oldest === undefined) break;
      seenTxHashes.delete(oldest);
    }
  };

  return async (input, init) => {
    const res = await inner(input, init);
    const resource = responseResource(input, res);
    const settlementOptions: HandleSettlementOptions = { seenTxHashes };
    if (options.config !== undefined) settlementOptions.config = options.config;
    if (resource !== undefined) settlementOptions.resource = resource;
    if (options.minDeposit !== undefined) settlementOptions.minDeposit = options.minDeposit;
    if (options.onIdleDeposit !== undefined) settlementOptions.onIdleDeposit = options.onIdleDeposit;
    settlementOptions.onNonFatalError = options.onNonFatalError ?? options.config?.onNonFatalError;
    const settlement = handleDivigentSettlement(res.clone(), http, divigent, reserveFloor, settlementOptions)
      .catch((err) => {
        void reportNonFatal(options.config?.onNonFatalError, {
          phase: 'settlement',
          error: err,
          recoverable: true,
        });
      })
      .finally(() => {
        pruneSeen();
      });
    if (options.waitForIdleDeposit === true) {
      await settlement;
    }
    return res;
  };
}

export type AttachIncomeOptions = {
  /** @notice Capacity for the per-attach dedupe set. Default: 256. */
  dedupeCapacity?: number;
  /** @notice Skip deposits below this idle amount. Default: 1n. */
  minDeposit?: bigint;
  /** @notice Receives non-fatal income redeposit errors. Exceptions are swallowed. */
  onNonFatalError?: X402WrapConfig['onNonFatalError'];
};

/**
 * @notice Register an onAfterSettle hook that auto-deposits received x402 income.
 * @param server Existing x402 resource server.
 * @param divigent Divigent facade used for income deposits.
 * @param reserveFloor Shared reserve floor that should stay liquid.
 * @param options Dedupe capacity and minimum deposit options.
 * @returns Detach handle.
 */
export function attachDivigentIncome(
  server: x402ResourceServer,
  divigent: Divigent,
  reserveFloor: ReserveFloor,
  options: AttachIncomeOptions = {},
): { detach: () => void } {
  const capacity = options.dedupeCapacity ?? 256;
  const seenTxHashes = new Set<string>();
  let detached = false;

  server.onAfterSettle(async (ctx) => {
    if (detached) return;
    if (!ctx.result.success) return;

    const opts: DepositIdleOptions = {
      dedupeKey: ctx.result.transaction,
      seenTxHashes,
    };
    if (options.minDeposit !== undefined) opts.minDeposit = options.minDeposit;
    try {
      await depositIdleAboveFloor(divigent, reserveFloor, opts);
    } catch (err) {
      await reportNonFatal(options.onNonFatalError, {
        phase: 'deposit-idle',
        error: err,
        recoverable: true,
      });
    }

    while (seenTxHashes.size > capacity) {
      const oldest = seenTxHashes.values().next().value;
      if (oldest === undefined) break;
      seenTxHashes.delete(oldest);
    }
  });

  return {
    detach: (): void => {
      detached = true;
    },
  };
}

function responseResource(input: Parameters<typeof fetch>[0], response: Response): string | undefined {
  if (response.url) return response.url;
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url || undefined;
}
