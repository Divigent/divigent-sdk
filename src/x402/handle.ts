import type { x402Client } from '@x402/core/client';
import type { x402ResourceServer } from '@x402/core/server';
import type { AssessLiquidityParams, Divigent } from '../divigent';
import type { TxHash } from '../types';
import { attachX402HooksWithReserveFloor, ReserveFloor } from './attach';
import { attachDivigentIncome, depositIdleAboveFloor, wrapFetchWithDivigentYield } from './settlement';
import type {
  X402AttachHandle,
  X402AutoDepositOptions,
  X402IdleDepositOptions,
  X402IncomeAttachHandle,
  X402IncomeConfig,
  X402WrapConfig,
} from './types';

// Shared reserve knobs used by both buyer-side recall hooks and seller-side
// income sweeps. Keeping this small lets both handles share the same reserve
// floor implementation without depending on unrelated x402 policy fields.
type ReserveFloorConfig = Pick<X402WrapConfig, 'minIdleThreshold' | 'reserveRatio' | 'reserveMultiplier'>;

function reserveFloor(config: ReserveFloorConfig): ReserveFloor {
  return new ReserveFloor({
    minIdleThreshold: config.minIdleThreshold,
    reserveRatio: config.reserveRatio,
    reserveMultiplier: config.reserveMultiplier,
  });
}

// The router MIN_DEPOSIT is stable during a process lifetime, so wrapper helpers
// cache it and reuse the value for idle-sweep dust checks.
function createProtocolMinDeposit(divigent: Divigent): () => Promise<bigint> {
  let minDepositPromise: Promise<bigint> | undefined;
  return () => {
    minDepositPromise ??= divigent.minDeposit();
    return minDepositPromise;
  };
}

// Bridge the x402 hook's observed reserve floor into the public liquidity
// intelligence API. This is what lets `handle.assessLiquidity()` include the
// same EMA that the hook learned from recent payments.
function assessWithReserveFloor(
  divigent: Divigent,
  floor: ReserveFloor,
  config: ReserveFloorConfig & { wallet?: AssessLiquidityParams['wallet'] },
  options: AssessLiquidityParams = {},
) {
  const params: AssessLiquidityParams = {
    ...options,
    minOperatingBalance: options.minOperatingBalance ??
      options.policyContext?.minOperatingBalance ??
      floor.minimum,
    recentPaymentEma: options.recentPaymentEma ??
      options.policyContext?.recentPaymentEma ??
      floor.ema,
  };
  const wallet = options.wallet ?? config.wallet;
  const reserveRatio = options.reserveRatio ??
    options.policyContext?.reserveRatio ??
    config.reserveRatio;
  const reserveMultiplier = options.reserveMultiplier ??
    options.policyContext?.reserveMultiplier ??
    config.reserveMultiplier;

  if (wallet !== undefined) params.wallet = wallet;
  if (reserveRatio !== undefined) params.reserveRatio = reserveRatio;
  if (reserveMultiplier !== undefined) params.reserveMultiplier = reserveMultiplier;

  return divigent.assessLiquidity(params);
}

function withProtocolMinDeposit<T extends {
  minDeposit?: X402AutoDepositOptions['minDeposit'];
  onNonFatalError?: X402WrapConfig['onNonFatalError'];
}>(
  minDeposit: () => Promise<bigint>,
  options: T,
  fallbackOnNonFatalError?: X402WrapConfig['onNonFatalError'],
): T & { minDeposit: NonNullable<X402AutoDepositOptions['minDeposit']> } {
  const next: T & { minDeposit: NonNullable<X402AutoDepositOptions['minDeposit']> } = {
    ...options,
    minDeposit: options.minDeposit ?? minDeposit,
  };
  const onNonFatalError = options.onNonFatalError ?? fallbackOnNonFatalError;
  if (onNonFatalError !== undefined) next.onNonFatalError = onNonFatalError;
  return next;
}

/**
 * @notice Attach Divigent x402 hooks and expose post-settlement yield helpers.
 * @param client Existing x402 client instance.
 * @param divigent Divigent facade used for wallet/vault operations.
 * @param config Divigent x402 policy and observer config.
 * @returns Handle for detaching hooks and composing paid fetch wrappers.
 */
export function createX402AttachHandle(
  client: x402Client,
  divigent: Divigent,
  config: X402WrapConfig = {},
): X402AttachHandle {
  const floor = reserveFloor(config);
  const hookHandle = attachX402HooksWithReserveFloor(client, divigent, config, floor);
  const minDeposit = createProtocolMinDeposit(divigent);

  return {
    detach: hookHandle.detach,
    assessLiquidity: (options = {}) => assessWithReserveFloor(divigent, floor, config, options),
    wrapFetchWithYield: (fetchWithPayment, http, options = {}) => (
      wrapFetchWithDivigentYield(fetchWithPayment, http, divigent, floor, {
        ...withProtocolMinDeposit(minDeposit, options, config.onNonFatalError),
        config,
      })
    ),
    depositIdle: (options = {}) => (
      depositIdleAboveFloor(divigent, floor, withProtocolMinDeposit(minDeposit, options, config.onNonFatalError))
    ),
  };
}

/**
 * @notice Deposit wallet USDC above a caller-provided reserve floor.
 * @param divigent Divigent facade used for balance reads and deposits.
 * @param options Reserve and observer options.
 * @returns Deposit transaction hash, or `undefined` when no sweep occurs.
 */
export function depositIdleWithReserveFloor(
  divigent: Divigent,
  options: X402IdleDepositOptions = {},
): Promise<TxHash | undefined> {
  return depositIdleAboveFloor(
    divigent,
    reserveFloor(options),
    withProtocolMinDeposit(createProtocolMinDeposit(divigent), options),
  );
}

/**
 * @notice Attach Divigent income-deposit hooks to an x402 resource server.
 * @param server Existing x402 resource server instance.
 * @param divigent Divigent facade used for wallet/vault operations.
 * @param config Seller-side reserve and observer config.
 * @returns Handle for detaching hooks and manually sweeping idle income.
 */
export function createX402IncomeAttachHandle(
  server: x402ResourceServer,
  divigent: Divigent,
  config: X402IncomeConfig = {},
): X402IncomeAttachHandle {
  const floor = reserveFloor(config);
  const minDeposit = createProtocolMinDeposit(divigent);
  const incomeHandle = attachDivigentIncome(server, divigent, floor, withProtocolMinDeposit(minDeposit, config));

  return {
    detach: incomeHandle.detach,
    assessLiquidity: (options = {}) => assessWithReserveFloor(divigent, floor, config, options),
    depositIdle: (options = {}) => (
      depositIdleAboveFloor(
        divigent,
        floor,
        withProtocolMinDeposit(minDeposit, {
          ...options,
          onNonFatalError: options.onNonFatalError ?? config.onNonFatalError,
        }),
      )
    ),
  };
}
