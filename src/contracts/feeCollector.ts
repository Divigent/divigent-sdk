import type { PublicClient } from 'viem';
import { feeCollectorAbi } from '../abis';
import { runRead } from '../errors';
import type { EvmAddress, TreasuryStatus } from '../types';

// Reads. Fee-collector writes are routed through governance-only router paths.

export function readFeeCollectorVaultRouter(
  client: PublicClient,
  feeCollector: EvmAddress,
): Promise<EvmAddress> {
  return runRead(() => client.readContract({
    address: feeCollector,
    abi: feeCollectorAbi,
    functionName: 'VAULT_ROUTER',
  }), feeCollectorAbi) as Promise<EvmAddress>;
}

export function readFeeCollectorUsdc(
  client: PublicClient,
  feeCollector: EvmAddress,
): Promise<EvmAddress> {
  return runRead(() => client.readContract({
    address: feeCollector,
    abi: feeCollectorAbi,
    functionName: 'USDC',
  }), feeCollectorAbi) as Promise<EvmAddress>;
}

export function readFeeCollectorTreasury(
  client: PublicClient,
  feeCollector: EvmAddress,
): Promise<EvmAddress> {
  return runRead(() => client.readContract({
    address: feeCollector,
    abi: feeCollectorAbi,
    functionName: 'treasury',
  }), feeCollectorAbi) as Promise<EvmAddress>;
}

export function readFeeCollectorPendingTreasury(
  client: PublicClient,
  feeCollector: EvmAddress,
): Promise<EvmAddress> {
  return runRead(() => client.readContract({
    address: feeCollector,
    abi: feeCollectorAbi,
    functionName: 'pendingTreasury',
  }), feeCollectorAbi) as Promise<EvmAddress>;
}

export function readFeeCollectorRotationEffectiveAt(
  client: PublicClient,
  feeCollector: EvmAddress,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: feeCollector,
    abi: feeCollectorAbi,
    functionName: 'treasuryRotationEffectiveAt',
  }), feeCollectorAbi).then(BigInt);
}

export async function readFeeCollectorTreasuryStatus(
  client: PublicClient,
  feeCollector: EvmAddress,
): Promise<TreasuryStatus> {
  const [current, pending, effectiveAt] = await Promise.all([
    readFeeCollectorTreasury(client, feeCollector),
    readFeeCollectorPendingTreasury(client, feeCollector),
    readFeeCollectorRotationEffectiveAt(client, feeCollector),
  ]);
  return { current, pending, effectiveAt };
}

export function readFeeCollectorCalculateFee(
  client: PublicClient,
  feeCollector: EvmAddress,
  yieldEarned: bigint,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: feeCollector,
    abi: feeCollectorAbi,
    functionName: 'calculateFee',
    args: [yieldEarned],
  }), feeCollectorAbi);
}

export function readFeeCollectorFeeBps(
  client: PublicClient,
  feeCollector: EvmAddress,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: feeCollector,
    abi: feeCollectorAbi,
    functionName: 'FEE_BPS',
  }), feeCollectorAbi);
}

export function readFeeCollectorBpsDenominator(
  client: PublicClient,
  feeCollector: EvmAddress,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: feeCollector,
    abi: feeCollectorAbi,
    functionName: 'BPS_DENOMINATOR',
  }), feeCollectorAbi);
}

export function readFeeCollectorRotationDelay(
  client: PublicClient,
  feeCollector: EvmAddress,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: feeCollector,
    abi: feeCollectorAbi,
    functionName: 'TREASURY_ROTATION_DELAY',
  }), feeCollectorAbi);
}

export function readFeeCollectorRotationGracePeriod(
  client: PublicClient,
  feeCollector: EvmAddress,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: feeCollector,
    abi: feeCollectorAbi,
    functionName: 'TREASURY_ROTATION_GRACE_PERIOD',
  }), feeCollectorAbi);
}
