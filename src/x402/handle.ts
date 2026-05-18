import type { x402Client } from '@x402/core/client';
import type { x402ResourceServer } from '@x402/core/server';
import type { Divigent } from '../divigent';
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

type ReserveFloorConfig = Pick<X402WrapConfig, 'minIdleThreshold' | 'reserveRatio' | 'reserveMultiplier'>;

function reserveFloor(config: ReserveFloorConfig): ReserveFloor {
  return new ReserveFloor({
    minIdleThreshold: config.minIdleThreshold,
    reserveRatio: config.reserveRatio,
    reserveMultiplier: config.reserveMultiplier,
  });
}

function createProtocolMinDeposit(divigent: Divigent): () => Promise<bigint> {
  let minDepositPromise: Promise<bigint> | undefined;
  return () => {
    minDepositPromise ??= divigent.minDeposit();
    return minDepositPromise;
  };
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
