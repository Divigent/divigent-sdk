import type { PublicClient, WalletClient } from 'viem';
import { oracleAbi } from '../abis';
import { DivigentError, runRead, runWrite } from '../errors';
import {
  type EvmAddress,
  type OptimalVault,
  type OracleStatus,
  type TxHash,
  type VaultRate,
  type VaultType,
  txHash,
} from '../types';

function vaultTypeFromId(id: number): VaultType {
  if (id === 0) return 'AAVE';
  if (id === 1) return 'MORPHO';
  throw new DivigentError(`[@divigent/sdk] unknown VaultType id: ${id}`, {
    code: 'DIVIGENT_UNKNOWN_VAULT_TYPE',
    category: 'validation',
    context: { id },
  });
}

function vaultTypeToId(vt: VaultType): 0 | 1 {
  return vt === 'AAVE' ? 0 : 1;
}

// Reads

export async function readOracleOptimalVault(
  client: PublicClient,
  oracle: EvmAddress,
): Promise<OptimalVault> {
  const [vault, vaultTypeId, twarRate] = await runRead(() => client.readContract({
    address: oracle,
    abi: oracleAbi,
    functionName: 'getOptimalVault',
  }), oracleAbi);
  return {
    vault:     vault as EvmAddress,
    vaultType: vaultTypeFromId(vaultTypeId),
    twarRate,
  };
}

export async function readOracleAllRates(
  client: PublicClient,
  oracle: EvmAddress,
): Promise<VaultRate[]> {
  const rates = await runRead(() => client.readContract({
    address: oracle,
    abi: oracleAbi,
    functionName: 'getAllRates',
  }), oracleAbi);
  return rates.map((r) => ({
    vault:     r.vault as EvmAddress,
    vaultType: vaultTypeFromId(r.vaultType),
    spotRate:  r.spotRate,
    twarRate:  r.twarRate,
    isSafe:    r.isSafe,
  }));
}

export function readOracleIsVaultSafe(
  client: PublicClient,
  oracle: EvmAddress,
  vaultType: VaultType,
): Promise<boolean> {
  return runRead(() => client.readContract({
    address: oracle,
    abi: oracleAbi,
    functionName: 'isVaultSafe',
    args: [vaultTypeToId(vaultType)],
  }), oracleAbi);
}

export function readOracleIsFresh(
  client: PublicClient,
  oracle: EvmAddress,
): Promise<boolean> {
  return runRead(() => client.readContract({
    address: oracle,
    abi: oracleAbi,
    functionName: 'isFresh',
  }), oracleAbi);
}

export function readOracleLastObservationTime(
  client: PublicClient,
  oracle: EvmAddress,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: oracle,
    abi: oracleAbi,
    functionName: 'lastObservationTime',
  }), oracleAbi);
}

export function readOracleLastGoodObservationAge(
  client: PublicClient,
  oracle: EvmAddress,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: oracle,
    abi: oracleAbi,
    functionName: 'lastGoodObservationAge',
  }), oracleAbi);
}

export function readOracleAaveSpotRate(
  client: PublicClient,
  oracle: EvmAddress,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: oracle,
    abi: oracleAbi,
    functionName: 'aaveSpotRate',
  }), oracleAbi);
}

export function readOracleMorphoSpotRate(
  client: PublicClient,
  oracle: EvmAddress,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: oracle,
    abi: oracleAbi,
    functionName: 'morphoSpotRate',
  }), oracleAbi);
}

export async function readOracleStatus(
  client: PublicClient,
  oracle: EvmAddress,
): Promise<OracleStatus> {
  const [lastObservationTime, fresh] = await Promise.all([
    readOracleLastObservationTime(client, oracle),
    readOracleIsFresh(client, oracle),
  ]);
  return { lastObservationTime, fresh };
}

// Writes

export async function recordObservation(params: {
  walletClient: WalletClient;
  publicClient: PublicClient;
  oracle: EvmAddress;
}): Promise<TxHash> {
  const { walletClient, publicClient, oracle } = params;
  const account = walletClient.account;
  const chain = walletClient.chain;
  if (!account) {
    throw new DivigentError('[@divigent/sdk] walletClient has no account', {
      code: 'DIVIGENT_WALLET_ACCOUNT_REQUIRED',
      category: 'wallet',
    });
  }
  if (!chain) {
    throw new DivigentError('[@divigent/sdk] walletClient has no chain', {
      code: 'DIVIGENT_WALLET_CHAIN_REQUIRED',
      category: 'wallet',
    });
  }
  const hash = await runWrite(async () => {
    const { request } = await publicClient.simulateContract({
      address: oracle,
      abi: oracleAbi,
      functionName: 'recordObservation',
      account,
    });
    return walletClient.writeContract(request);
  }, oracleAbi);
  return txHash(hash);
}
