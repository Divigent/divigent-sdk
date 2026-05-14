import type { Hex, PublicClient, WalletClient } from 'viem';
import { routerAbi } from '../abis';
import { vaultTypeFromId } from '../core/vaultTypes';
import { DivigentError, runRead, runSign, runWrite } from '../errors';
import {
  type EvmAddress,
  type FeeOverrides,
  type PermitSig,
  type Position,
  type TxHash,
  type VaultAllocation,
  type VaultCapacity,
  type VaultType,
  txHash,
} from '../types';

// Reads

// Position and valuation

export async function readRouterPosition(
  client: PublicClient,
  router: EvmAddress,
  wallet: EvmAddress,
): Promise<Position> {
  const [depositedUSDC, currentValue, accruedYield] = await runRead(() => client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'getPosition',
    args: [wallet],
  }), routerAbi);
  return { depositedUSDC, currentValue, accruedYield };
}

export async function readRouterWithdrawCapacity(
  client: PublicClient,
  router: EvmAddress,
): Promise<VaultCapacity> {
  const cap = await runRead(() => client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'withdrawCapacity',
  }), routerAbi);
  return {
    aaveAssetsHeld:    cap.aaveAssetsHeld,
    aaveIdleLiquidity: cap.aaveIdleLiquidity,
    aaveWithdrawCap:   cap.aaveWithdrawCap,
    morphoAssetsHeld:  cap.morphoAssetsHeld,
    morphoWithdrawCap: cap.morphoWithdrawCap,
    morphoReachable:   cap.morphoReachable,
    totalWithdrawCap:  cap.totalWithdrawCap,
  };
}

export async function readRouterCurrentAllocation(
  client: PublicClient,
  router: EvmAddress,
): Promise<VaultAllocation> {
  const [aaveAssets, morphoAssets] = await runRead(() => client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'getCurrentAllocation',
  }), routerAbi);
  return { aaveAssets, morphoAssets };
}

export async function readRouterRecommendedRoute(
  client: PublicClient,
  router: EvmAddress,
  amount: bigint,
): Promise<VaultType> {
  const routeId = await runRead(() => client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'getRecommendedRoute',
    args: [amount],
  }), routerAbi);
  return vaultTypeFromId(routeId);
}

export function readRouterPricePerShare(
  client: PublicClient,
  router: EvmAddress,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'pricePerShare',
  }), routerAbi);
}

export function readRouterTotalVaultAssets(
  client: PublicClient,
  router: EvmAddress,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'totalVaultAssets',
  }), routerAbi);
}

export function readRouterCurrentTVLCap(
  client: PublicClient,
  router: EvmAddress,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'currentTVLCap',
  }), routerAbi);
}

export function readRouterMinDeposit(
  client: PublicClient,
  router: EvmAddress,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'MIN_DEPOSIT',
  }), routerAbi);
}

export function readRouterCostBasis(
  client: PublicClient,
  router: EvmAddress,
  wallet: EvmAddress,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'costBasisUSDC',
    args: [wallet],
  }), routerAbi);
}

// Preview and conversion

export function readRouterPreviewDeposit(
  client: PublicClient,
  router: EvmAddress,
  amount: bigint,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'previewDeposit',
    args: [amount],
  }), routerAbi);
}

export function readRouterPreviewRedeem(
  client: PublicClient,
  router: EvmAddress,
  shares: bigint,
  wallet: EvmAddress,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'previewRedeem',
    args: [shares, wallet],
  }), routerAbi);
}

export function readRouterPreviewWithdrawNet(
  client: PublicClient,
  router: EvmAddress,
  desiredUsdc: bigint,
  wallet: EvmAddress,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'previewWithdrawNet',
    args: [desiredUsdc, wallet],
  }), routerAbi);
}

export function readRouterConvertToShares(
  client: PublicClient,
  router: EvmAddress,
  assets: bigint,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'convertToShares',
    args: [assets],
  }), routerAbi);
}

export function readRouterConvertToAssets(
  client: PublicClient,
  router: EvmAddress,
  shares: bigint,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'convertToAssets',
    args: [shares],
  }), routerAbi);
}

// Authorization and permissions

export function readRouterIsAuthorized(
  client: PublicClient,
  router: EvmAddress,
  wallet: EvmAddress,
): Promise<boolean> {
  return runRead(() => client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'authorizedWallets',
    args: [wallet],
  }), routerAbi);
}

export function readRouterIsOperator(
  client: PublicClient,
  router: EvmAddress,
  wallet: EvmAddress,
  operator: EvmAddress,
): Promise<boolean> {
  return runRead(() => client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'isOperator',
    args: [wallet, operator],
  }), routerAbi);
}

export function readRouterNonce(
  client: PublicClient,
  router: EvmAddress,
  wallet: EvmAddress,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'nonces',
    args: [wallet],
  }), routerAbi);
}

// Emergency pause

export function readRouterDepositsPaused(
  client: PublicClient,
  router: EvmAddress,
): Promise<boolean> {
  return runRead(() => client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'depositsPaused',
  }), routerAbi);
}

// Self-identification

export function readRouterUsdc(
  client: PublicClient,
  router: EvmAddress,
): Promise<EvmAddress> {
  return runRead(() => client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'USDC',
  }), routerAbi) as Promise<EvmAddress>;
}

export function readRouterDvUsdc(
  client: PublicClient,
  router: EvmAddress,
): Promise<EvmAddress> {
  return runRead(() => client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'DV_USDC',
  }), routerAbi) as Promise<EvmAddress>;
}

export function readRouterFeeCollector(
  client: PublicClient,
  router: EvmAddress,
): Promise<EvmAddress> {
  return runRead(() => client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'FEE_COLLECTOR',
  }), routerAbi) as Promise<EvmAddress>;
}

export function readRouterOracle(
  client: PublicClient,
  router: EvmAddress,
): Promise<EvmAddress> {
  return runRead(() => client.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'ORACLE',
  }), routerAbi) as Promise<EvmAddress>;
}

// Writes

function assertSigner(wc: WalletClient): { account: NonNullable<WalletClient['account']>; chain: NonNullable<WalletClient['chain']> } {
  if (!wc.account) {
    throw new DivigentError('[@divigent/sdk] walletClient has no account', {
      code: 'DIVIGENT_WALLET_ACCOUNT_REQUIRED',
      category: 'wallet',
    });
  }
  if (!wc.chain) {
    throw new DivigentError('[@divigent/sdk] walletClient has no chain', {
      code: 'DIVIGENT_WALLET_CHAIN_REQUIRED',
      category: 'wallet',
    });
  }
  return { account: wc.account, chain: wc.chain };
}

/**
 * @notice Simulate a router call and broadcast the simulated request.
 * @remarks The `as never` casts are local to this internal helper because
 * viem cannot preserve concrete overloads after `simulateContract` requests
 * are passed through a generic function.
 * @param publicClient viem public client.
 * @param walletClient viem wallet client.
 * @param request Contract simulation request.
 * @param fees Optional EIP-1559 fee overrides.
 * @returns Raw transaction hash.
 */
async function simulateAndWrite(
  publicClient: PublicClient,
  walletClient: WalletClient,
  request: Parameters<PublicClient['simulateContract']>[0],
  fees?: FeeOverrides,
): Promise<`0x${string}`> {
  return runWrite(async () => {
    const { request: simulated } = await publicClient.simulateContract(request as never);
    const final = fees ? { ...simulated, ...fees } : simulated;
    return walletClient.writeContract(final as never);
  }, routerAbi);
}

// Wallet registration

export async function initialize(params: {
  walletClient: WalletClient;
  publicClient: PublicClient;
  router: EvmAddress;
}): Promise<TxHash> {
  const { account, chain } = assertSigner(params.walletClient);
  const hash = await simulateAndWrite(params.publicClient, params.walletClient, {
    address: params.router,
    abi: routerAbi,
    functionName: 'initialize',
    account,
    chain,
  });
  return txHash(hash);
}

export async function initializeFor(params: {
  walletClient: WalletClient;
  publicClient: PublicClient;
  router: EvmAddress;
  wallet: EvmAddress;
  deadline: bigint;
  sig: Hex;
}): Promise<TxHash> {
  const { account, chain } = assertSigner(params.walletClient);
  const hash = await simulateAndWrite(params.publicClient, params.walletClient, {
    address: params.router,
    abi: routerAbi,
    functionName: 'initializeFor',
    args: [params.wallet, params.deadline, params.sig],
    account,
    chain,
  });
  return txHash(hash);
}

export async function setOperator(params: {
  walletClient: WalletClient;
  publicClient: PublicClient;
  router: EvmAddress;
  operator: EvmAddress;
  approved: boolean;
}): Promise<TxHash> {
  const { account, chain } = assertSigner(params.walletClient);
  const hash = await simulateAndWrite(params.publicClient, params.walletClient, {
    address: params.router,
    abi: routerAbi,
    functionName: 'setOperator',
    args: [params.operator, params.approved],
    account,
    chain,
  });
  return txHash(hash);
}

// Deposit and withdraw

export async function deposit(params: {
  walletClient: WalletClient;
  publicClient: PublicClient;
  router: EvmAddress;
  amount: bigint;
  wallet: EvmAddress;
  minSharesOut: bigint;
  fees?: FeeOverrides;
}): Promise<TxHash> {
  const { account, chain } = assertSigner(params.walletClient);
  const hash = await simulateAndWrite(
    params.publicClient,
    params.walletClient,
    {
      address: params.router,
      abi: routerAbi,
      functionName: 'deposit',
      args: [params.amount, params.wallet, params.minSharesOut],
      account,
      chain,
    },
    params.fees,
  );
  return txHash(hash);
}

export async function depositWithPermit(params: {
  walletClient: WalletClient;
  publicClient: PublicClient;
  router: EvmAddress;
  amount: bigint;
  wallet: EvmAddress;
  permit: PermitSig;
  minSharesOut: bigint;
  fees?: FeeOverrides;
}): Promise<TxHash> {
  const { account, chain } = assertSigner(params.walletClient);
  const hash = await simulateAndWrite(
    params.publicClient,
    params.walletClient,
    {
      address: params.router,
      abi: routerAbi,
      functionName: 'depositWithPermit',
      args: [
        params.amount,
        params.wallet,
        params.permit.deadline,
        params.permit.v,
        params.permit.r,
        params.permit.s,
        params.minSharesOut,
      ],
      account,
      chain,
    },
    params.fees,
  );
  return txHash(hash);
}

export async function withdraw(params: {
  walletClient: WalletClient;
  publicClient: PublicClient;
  router: EvmAddress;
  shares: bigint;
  wallet: EvmAddress;
  minUsdcOut: bigint;
  fees?: FeeOverrides;
}): Promise<TxHash> {
  const { account, chain } = assertSigner(params.walletClient);
  const hash = await simulateAndWrite(
    params.publicClient,
    params.walletClient,
    {
      address: params.router,
      abi: routerAbi,
      functionName: 'withdraw',
      args: [params.shares, params.wallet, params.minUsdcOut],
      account,
      chain,
    },
    params.fees,
  );
  return txHash(hash);
}

// Treasury rotation

export async function proposeTreasuryRotation(params: {
  walletClient: WalletClient;
  publicClient: PublicClient;
  router: EvmAddress;
  newTreasury: EvmAddress;
}): Promise<TxHash> {
  const { account, chain } = assertSigner(params.walletClient);
  const hash = await simulateAndWrite(params.publicClient, params.walletClient, {
    address: params.router,
    abi: routerAbi,
    functionName: 'proposeTreasuryRotation',
    args: [params.newTreasury],
    account,
    chain,
  });
  return txHash(hash);
}

export async function executeTreasuryRotation(params: {
  walletClient: WalletClient;
  publicClient: PublicClient;
  router: EvmAddress;
}): Promise<TxHash> {
  const { account, chain } = assertSigner(params.walletClient);
  const hash = await simulateAndWrite(params.publicClient, params.walletClient, {
    address: params.router,
    abi: routerAbi,
    functionName: 'executeTreasuryRotation',
    account,
    chain,
  });
  return txHash(hash);
}

export async function cancelTreasuryRotation(params: {
  walletClient: WalletClient;
  publicClient: PublicClient;
  router: EvmAddress;
}): Promise<TxHash> {
  const { account, chain } = assertSigner(params.walletClient);
  const hash = await simulateAndWrite(params.publicClient, params.walletClient, {
    address: params.router,
    abi: routerAbi,
    functionName: 'cancelTreasuryRotation',
    account,
    chain,
  });
  return txHash(hash);
}

// Emergency pause

export async function pauseDeposits(params: {
  walletClient: WalletClient;
  publicClient: PublicClient;
  router: EvmAddress;
}): Promise<TxHash> {
  const { account, chain } = assertSigner(params.walletClient);
  const hash = await simulateAndWrite(params.publicClient, params.walletClient, {
    address: params.router,
    abi: routerAbi,
    functionName: 'pauseDeposits',
    account,
    chain,
  });
  return txHash(hash);
}

export async function unpauseDeposits(params: {
  walletClient: WalletClient;
  publicClient: PublicClient;
  router: EvmAddress;
}): Promise<TxHash> {
  const { account, chain } = assertSigner(params.walletClient);
  const hash = await simulateAndWrite(params.publicClient, params.walletClient, {
    address: params.router,
    abi: routerAbi,
    functionName: 'unpauseDeposits',
    account,
    chain,
  });
  return txHash(hash);
}

// Signing

export async function signInitializeFor(params: {
  walletClient: WalletClient;
  publicClient: PublicClient;
  router: EvmAddress;
  wallet: EvmAddress;
  deadline: bigint;
}): Promise<Hex> {
  const { account, chain } = assertSigner(params.walletClient);
  const { publicClient, router, wallet, deadline } = params;

  // Trust contract-declared name/version, but pin chain and verifying contract locally.
  const [domain, nonce] = await Promise.all([
    runRead(() => publicClient.readContract({ address: router, abi: routerAbi, functionName: 'eip712Domain' }), routerAbi),
    runRead(() => publicClient.readContract({ address: router, abi: routerAbi, functionName: 'nonces', args: [wallet] }), routerAbi),
  ]);

  const [, name, version, domainChainId, domainVerifyingContract] = domain;

  // Refuse to sign if the RPC-returned domain disagrees with local configuration.
  if (Number(domainChainId) !== chain.id) {
    throw new DivigentError(
      `[@divigent/sdk] router eip712Domain.chainId=${domainChainId} does not match ` +
        `walletClient.chain.id=${chain.id}`,
      {
        code: 'DIVIGENT_EIP712_DOMAIN_MISMATCH',
        category: 'config',
        context: { field: 'chainId', expected: chain.id, actual: domainChainId },
      },
    );
  }
  if (domainVerifyingContract.toLowerCase() !== router.toLowerCase()) {
    throw new DivigentError(
      `[@divigent/sdk] router eip712Domain.verifyingContract=${domainVerifyingContract} ` +
        `does not match configured router=${router}`,
      {
        code: 'DIVIGENT_EIP712_DOMAIN_MISMATCH',
        category: 'config',
        context: {
          field: 'verifyingContract',
          expected: router,
          actual: domainVerifyingContract,
        },
      },
    );
  }

  return runSign(() => params.walletClient.signTypedData({
    account,
    domain: {
      name,
      version,
      chainId: chain.id,
      verifyingContract: router,
    },
    types: {
      InitializeFor: [
        { name: 'wallet', type: 'address' },
        { name: 'deadline', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    primaryType: 'InitializeFor',
    message: { wallet, deadline, nonce },
  }));
}
