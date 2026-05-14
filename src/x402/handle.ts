import type { x402Client } from '@x402/core/client';
import type { Divigent } from '../divigent';
import { attachX402HooksWithReserveFloor, ReserveFloor } from './attach';
import { depositIdleAboveFloor, wrapFetchWithDivigentYield } from './settlement';
import type { X402AttachHandle, X402AutoDepositOptions, X402WrapConfig } from './types';

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
  const reserveFloor = new ReserveFloor({
    minIdleThreshold: config.minIdleThreshold,
    reserveRatio: config.reserveRatio,
    reserveMultiplier: config.reserveMultiplier,
  });
  const hookHandle = attachX402HooksWithReserveFloor(client, divigent, config, reserveFloor);
  let minDepositPromise: Promise<bigint> | undefined;
  const protocolMinDeposit = (): Promise<bigint> => {
    minDepositPromise ??= divigent.minDeposit();
    return minDepositPromise;
  };
  const withProtocolMinDeposit = (
    options: X402AutoDepositOptions = {},
  ): X402AutoDepositOptions & { minDeposit: NonNullable<X402AutoDepositOptions['minDeposit']> } => {
    const next: X402AutoDepositOptions & {
      minDeposit: NonNullable<X402AutoDepositOptions['minDeposit']>;
    } = {
      ...options,
      minDeposit: options.minDeposit ?? protocolMinDeposit,
    };
    const onNonFatalError = options.onNonFatalError ?? config.onNonFatalError;
    if (onNonFatalError !== undefined) next.onNonFatalError = onNonFatalError;
    return next;
  };

  return {
    detach: hookHandle.detach,
    wrapFetchWithYield: (fetchWithPayment, http, options = {}) => (
      wrapFetchWithDivigentYield(fetchWithPayment, http, divigent, reserveFloor, {
        ...withProtocolMinDeposit(options),
        config,
      })
    ),
    depositIdle: (options = {}) => (
      depositIdleAboveFloor(divigent, reserveFloor, withProtocolMinDeposit(options))
    ),
  };
}
