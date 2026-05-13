import type { PublicClient } from 'viem';
import { dvUsdcAbi } from '../abis';
import { runRead } from '../errors';
import type { EvmAddress } from '../types';

// Reads. dvUSDC writes are router-gated and intentionally not exposed.

export function readDvUsdcBalance(
  client: PublicClient,
  dvUsdc: EvmAddress,
  account: EvmAddress,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: dvUsdc,
    abi: dvUsdcAbi,
    functionName: 'balanceOf',
    args: [account],
  }), dvUsdcAbi);
}

export function readDvUsdcTotalSupply(
  client: PublicClient,
  dvUsdc: EvmAddress,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: dvUsdc,
    abi: dvUsdcAbi,
    functionName: 'totalSupply',
  }), dvUsdcAbi);
}

export function readDvUsdcDecimals(
  client: PublicClient,
  dvUsdc: EvmAddress,
): Promise<number> {
  return runRead(() => client.readContract({
    address: dvUsdc,
    abi: dvUsdcAbi,
    functionName: 'decimals',
  }), dvUsdcAbi);
}

export function readDvUsdcName(
  client: PublicClient,
  dvUsdc: EvmAddress,
): Promise<string> {
  return runRead(() => client.readContract({
    address: dvUsdc,
    abi: dvUsdcAbi,
    functionName: 'name',
  }), dvUsdcAbi);
}

export function readDvUsdcSymbol(
  client: PublicClient,
  dvUsdc: EvmAddress,
): Promise<string> {
  return runRead(() => client.readContract({
    address: dvUsdc,
    abi: dvUsdcAbi,
    functionName: 'symbol',
  }), dvUsdcAbi);
}

export function readDvUsdcRouter(
  client: PublicClient,
  dvUsdc: EvmAddress,
): Promise<EvmAddress> {
  return runRead(() => client.readContract({
    address: dvUsdc,
    abi: dvUsdcAbi,
    functionName: 'VAULT_ROUTER',
  }), dvUsdcAbi) as Promise<EvmAddress>;
}
