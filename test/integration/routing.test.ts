import { expect } from 'vitest';
import {
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { base } from 'viem/chains';
import { routerAbi, usdcAbi } from '../../src/abis';
import { parseUsdc } from '../../src/core/utils';
import type { ContractAddresses } from '../../src/core/chains';
import type { Divigent } from '../../src/divigent';
import type { EvmAddress, OptimalVault, VaultAllocation, VaultRate, VaultType } from '../../src/types';
import {
  divigentBaseMainnetForkTest as test,
  REAL_BASE_FORK_DEPENDENCIES,
  rpcRequest,
  withForkSnapshot,
} from '../fork/setup';
import {
  approveUsdcAndWait,
  approveAndDepositAndAssert,
  createX402AgentForPrivateKey,
  depositAndAssert,
  expectFullExit,
  prepareX402Agent,
  sendAndExpectSuccess,
  vaultTypeId,
  withdrawAndAssert,
  X402_AGENT_DEPOSIT_PRIVATE_KEY,
  X402_AGENT_RECALL_PRIVATE_KEY,
  X402_AGENT_WITHDRAW_PRIVATE_KEY,
  X402_TEST_ETH_BALANCE,
} from './helpers/x402AgentFork';

const MIN_DIFFERENTIAL_RAY = 5n * 10n ** 24n;
const ROUTE_ASSERTION_TOLERANCE = 10n;
const AAVE_CASH_SINK = '0x000000000000000000000000000000000000dEaD' as const;

const morphoVaultAbi = [
  {
    type: 'function',
    name: 'asset',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'convertToAssets',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

type VenueHoldings = {
  routerUsdc: bigint;
  routerAaveAToken: bigint;
  routerMorphoShares: bigint;
  routerMorphoAssets: bigint;
};

type RoutingFacts = {
  optimalVault: OptimalVault;
  route: VaultType;
};

function rateFor(rates: VaultRate[], vaultType: VaultType): VaultRate {
  const rate = rates.find((r) => r.vaultType === vaultType);
  if (rate === undefined) throw new Error(`Missing ${vaultType} rate`);
  return rate;
}

function expectedOptimalVaultType(rates: VaultRate[]): VaultType {
  const aave = rateFor(rates, 'AAVE');
  const morpho = rateFor(rates, 'MORPHO');
  if (!aave.isSafe && !morpho.isSafe) throw new Error('No safe vault in test fixture');
  const morphoWins = morpho.isSafe &&
    morpho.twarRate > aave.twarRate &&
    morpho.twarRate - aave.twarRate >= MIN_DIFFERENTIAL_RAY;
  if (morphoWins || !aave.isSafe) return 'MORPHO';
  return 'AAVE';
}

function expectedVaultAddress(addresses: ContractAddresses, vaultType: VaultType): EvmAddress {
  return vaultType === 'AAVE' ? addresses.aavePool : addresses.steakhouseUSDCPrimeVault;
}

function allocationDelta(
  before: VaultAllocation,
  after: VaultAllocation,
  vaultType: VaultType,
): bigint {
  return vaultType === 'AAVE'
    ? after.aaveAssets - before.aaveAssets
    : after.morphoAssets - before.morphoAssets;
}

async function expectRealBaseVenueWiring(params: {
  publicClient: PublicClient;
  addresses: ContractAddresses;
}): Promise<void> {
  const { publicClient, addresses } = params;
  expect(await publicClient.getChainId()).toBe(REAL_BASE_FORK_DEPENDENCIES.chainId);
  expect(addresses.usdc).toBe(REAL_BASE_FORK_DEPENDENCIES.usdc);
  expect(addresses.aavePool).toBe(REAL_BASE_FORK_DEPENDENCIES.aavePool);
  expect(addresses.aToken).toBe(REAL_BASE_FORK_DEPENDENCIES.aaveAToken);
  expect(addresses.steakhouseUSDCPrimeVault).toBe(REAL_BASE_FORK_DEPENDENCIES.morphoVault);
  const morphoAsset = await publicClient.readContract({
    address: addresses.steakhouseUSDCPrimeVault,
    abi: morphoVaultAbi,
    functionName: 'asset',
  });
  expect(morphoAsset).toBe(REAL_BASE_FORK_DEPENDENCIES.usdc);
}

async function readVenueHoldings(params: {
  publicClient: PublicClient;
  addresses: ContractAddresses;
}): Promise<VenueHoldings> {
  const { publicClient, addresses } = params;
  const [routerUsdc, routerAaveAToken, routerMorphoShares] = await Promise.all([
    publicClient.readContract({
      address: addresses.usdc,
      abi: usdcAbi,
      functionName: 'balanceOf',
      args: [addresses.router],
    }),
    publicClient.readContract({
      address: addresses.aToken,
      abi: usdcAbi,
      functionName: 'balanceOf',
      args: [addresses.router],
    }),
    publicClient.readContract({
      address: addresses.steakhouseUSDCPrimeVault,
      abi: morphoVaultAbi,
      functionName: 'balanceOf',
      args: [addresses.router],
    }),
  ]);
  const routerMorphoAssets = await publicClient.readContract({
    address: addresses.steakhouseUSDCPrimeVault,
    abi: morphoVaultAbi,
    functionName: 'convertToAssets',
    args: [routerMorphoShares],
  });
  return {
    routerUsdc,
    routerAaveAToken,
    routerMorphoShares,
    routerMorphoAssets,
  };
}

function expectSelectedVenueReceivedDeposit(params: {
  before: VenueHoldings;
  after: VenueHoldings;
  amount: bigint;
  selectedVenue: VaultType;
}): void {
  const aaveDelta = params.after.routerAaveAToken - params.before.routerAaveAToken;
  const morphoAssetDelta = params.after.routerMorphoAssets - params.before.routerMorphoAssets;
  const morphoShareDelta = params.after.routerMorphoShares - params.before.routerMorphoShares;

  if (params.selectedVenue === 'AAVE') {
    expect(aaveDelta).toBeGreaterThanOrEqual(params.amount - ROUTE_ASSERTION_TOLERANCE);
    expect(morphoAssetDelta).toBeLessThanOrEqual(ROUTE_ASSERTION_TOLERANCE);
    expect(morphoShareDelta).toBe(0n);
  } else {
    expect(aaveDelta).toBeLessThanOrEqual(ROUTE_ASSERTION_TOLERANCE);
    expect(morphoShareDelta).toBeGreaterThan(0n);
    expect(morphoAssetDelta).toBeGreaterThanOrEqual(params.amount - ROUTE_ASSERTION_TOLERANCE);
  }
  expect(params.after.routerUsdc).toBe(0n);
}

function expectExitRedirectedEvent(
  receipt: TransactionReceipt,
  expected: { wallet: EvmAddress },
): void {
  const [event] = parseEventLogs({
    abi: routerAbi,
    logs: receipt.logs,
    eventName: 'ExitRedirected',
  });
  expect(event).toBeDefined();
  expect(event?.args.wallet).toBe(expected.wallet);
  expect(event?.args.targetAave).toBeGreaterThan(0n);
  expect(event?.args.targetMorpho).toBeGreaterThan(0n);
  expect(event?.args.actualAave).toBe(0n);
  expect(event?.args.actualMorpho).toBeGreaterThan(event?.args.targetMorpho ?? 0n);
  expect(event?.args.shortLeg).toBe(false);
}

async function drainAaveCash(params: {
  publicClient: PublicClient;
  rpcUrl: string;
  addresses: ContractAddresses;
}): Promise<bigint> {
  const cash = await params.publicClient.readContract({
    address: params.addresses.usdc,
    abi: usdcAbi,
    functionName: 'balanceOf',
    args: [params.addresses.aToken],
  });
  if (cash === 0n) return 0n;

  await rpcRequest(params.rpcUrl, 'anvil_setBalance', [
    params.addresses.aToken,
    X402_TEST_ETH_BALANCE,
  ]);
  await rpcRequest(params.rpcUrl, 'anvil_impersonateAccount', [params.addresses.aToken]);
  try {
    const aTokenClient = createWalletClient({
      account: params.addresses.aToken as Address,
      chain: base,
      transport: http(params.rpcUrl),
    });
    const hash = await aTokenClient.writeContract({
      address: params.addresses.usdc,
      abi: usdcAbi,
      functionName: 'transfer',
      args: [AAVE_CASH_SINK, cash],
    });
    await sendAndExpectSuccess(params.publicClient, hash);
  } finally {
    await rpcRequest(params.rpcUrl, 'anvil_stopImpersonatingAccount', [params.addresses.aToken]);
  }
  return cash;
}

async function readRoutingFacts(params: {
  sdk: Pick<Divigent, 'getOptimalVault' | 'getRecommendedRoute'>;
  amount: bigint;
}): Promise<RoutingFacts> {
  const [optimalVault, route] = await Promise.all([
    params.sdk.getOptimalVault(),
    params.sdk.getRecommendedRoute(params.amount),
  ]);
  return {
    optimalVault,
    route,
  };
}

function expectOptimalVaultMatchesPolicy(params: {
  facts: RoutingFacts;
  rates: VaultRate[];
  addresses: ContractAddresses;
}): VaultType {
  const expectedOptimal = expectedOptimalVaultType(params.rates);
  expect(params.facts.optimalVault.vaultType).toBe(expectedOptimal);
  expect(params.facts.optimalVault.vault).toBe(expectedVaultAddress(params.addresses, expectedOptimal));
  expect(params.facts.optimalVault.twarRate).toBe(rateFor(params.rates, expectedOptimal).twarRate);
  return expectedOptimal;
}

function expectRoute(
  facts: RoutingFacts,
  expectedRoute?: VaultType | undefined,
): VaultType {
  if (expectedRoute !== undefined) {
    expect(facts.route).toBe(expectedRoute);
  }
  return facts.route;
}
// Exercises: x402 agent deposits into the real Base venue selected by TWAR and fully exits it.
test.sequential(
  'x402 agent deposits into the real Base venue selected by TWAR and fully exits it',
  async ({ divigent, publicClient, rpcUrl }) => {
    await withForkSnapshot(rpcUrl, async () => {
      const agent = createX402AgentForPrivateKey({
        privateKey: X402_AGENT_DEPOSIT_PRIVATE_KEY,
        rpcUrl,
        publicClient,
        addresses: divigent.addresses,
      });
      const amount = parseUsdc('10');

      await prepareX402Agent({ agent, rpcUrl, publicClient, initialize: true });
      await expectRealBaseVenueWiring({ publicClient, addresses: divigent.addresses });
      const [rates, allocationBefore] = await Promise.all([
        agent.sdk.getAllRates(),
        agent.sdk.getCurrentAllocation(),
      ]);
      const venueHoldingsBefore = await readVenueHoldings({
        publicClient,
        addresses: divigent.addresses,
      });
      const routing = await readRoutingFacts({
        sdk: agent.sdk,
        amount,
      });
      expectOptimalVaultMatchesPolicy({ facts: routing, rates, addresses: divigent.addresses });
      const route = expectRoute(routing);
      const selectedVenue: VaultType = route;

      const deposit = await approveAndDepositAndAssert(agent, publicClient, amount, {
        vaultType: route,
      });

      const [allocationAfterDeposit, venueHoldingsAfterDeposit] = await Promise.all([
        agent.sdk.getCurrentAllocation(),
        readVenueHoldings({ publicClient, addresses: divigent.addresses }),
      ]);
      expect(allocationDelta(allocationBefore, allocationAfterDeposit, selectedVenue))
        .toBeGreaterThanOrEqual(amount - ROUTE_ASSERTION_TOLERANCE);
      expectSelectedVenueReceivedDeposit({
        before: venueHoldingsBefore,
        after: venueHoldingsAfterDeposit,
        amount,
        selectedVenue,
      });

      await withdrawAndAssert(agent, publicClient, deposit.sharesMinted);

      const [allocationAfterExit, venueHoldingsAfterExit] = await Promise.all([
        agent.sdk.getCurrentAllocation(),
        readVenueHoldings({ publicClient, addresses: divigent.addresses }),
      ]);
      expect(allocationAfterExit.aaveAssets + allocationAfterExit.morphoAssets)
        .toBeLessThanOrEqual(ROUTE_ASSERTION_TOLERANCE);
      expect(venueHoldingsAfterExit.routerAaveAToken + venueHoldingsAfterExit.routerMorphoAssets)
        .toBeLessThanOrEqual(ROUTE_ASSERTION_TOLERANCE);
      expect(venueHoldingsAfterExit.routerUsdc).toBe(0n);
      await expectFullExit(agent);
    });
  },
);
// Exercises: x402 agent deposits into real Base Morpho when Aave capacity is unavailable.
test.sequential(
  'x402 agent deposits into real Base Morpho when Aave capacity is unavailable',
  async ({ divigent, publicClient, rpcUrl }) => {
    await withForkSnapshot(rpcUrl, async () => {
      const agent = createX402AgentForPrivateKey({
        privateKey: X402_AGENT_WITHDRAW_PRIVATE_KEY,
        rpcUrl,
        publicClient,
        addresses: divigent.addresses,
      });
      const amount = parseUsdc('10');

      await prepareX402Agent({ agent, rpcUrl, publicClient, initialize: true });
      await expectRealBaseVenueWiring({ publicClient, addresses: divigent.addresses });
      const drained = await drainAaveCash({
        publicClient,
        rpcUrl,
        addresses: divigent.addresses,
      });
      expect(drained).toBeGreaterThanOrEqual(amount);

      const [rates, allocationBefore] = await Promise.all([
        agent.sdk.getAllRates(),
        agent.sdk.getCurrentAllocation(),
      ]);
      const routing = await readRoutingFacts({
        sdk: agent.sdk,
        amount,
      });
      expectOptimalVaultMatchesPolicy({ facts: routing, rates, addresses: divigent.addresses });
      const route = expectRoute(routing, 'MORPHO');
      expect(route).toBe('MORPHO');
      expect(allocationBefore.aaveAssets + allocationBefore.morphoAssets).toBe(0n);
      const venueHoldingsBefore = await readVenueHoldings({
        publicClient,
        addresses: divigent.addresses,
      });
      expect(venueHoldingsBefore.routerAaveAToken).toBe(0n);
      expect(venueHoldingsBefore.routerMorphoShares).toBe(0n);

      const deposit = await approveAndDepositAndAssert(agent, publicClient, amount, {
        vaultType: 'MORPHO',
      });

      const [allocationAfterDeposit, venueHoldingsAfterDeposit] = await Promise.all([
        agent.sdk.getCurrentAllocation(),
        readVenueHoldings({ publicClient, addresses: divigent.addresses }),
      ]);
      expect(allocationAfterDeposit.aaveAssets).toBe(0n);
      expect(allocationAfterDeposit.morphoAssets)
        .toBeGreaterThanOrEqual(amount - ROUTE_ASSERTION_TOLERANCE);
      expectSelectedVenueReceivedDeposit({
        before: venueHoldingsBefore,
        after: venueHoldingsAfterDeposit,
        amount,
        selectedVenue: 'MORPHO',
      });

      const withdraw = await withdrawAndAssert(agent, publicClient, deposit.sharesMinted);
      expect(withdraw.usdcReturned).toBeGreaterThan(0n);
      const venueHoldingsAfterExit = await readVenueHoldings({
        publicClient,
        addresses: divigent.addresses,
      });
      expect(venueHoldingsAfterExit.routerAaveAToken).toBe(0n);
      expect(venueHoldingsAfterExit.routerMorphoAssets).toBeLessThanOrEqual(
        ROUTE_ASSERTION_TOLERANCE,
      );
      expect(venueHoldingsAfterExit.routerUsdc).toBe(0n);
      await expectFullExit(agent);
    });
  },
);
// Exercises: x402 agent withdraw emits ExitRedirected when Aave liquidity is constrained.
test.sequential(
  'x402 agent withdraw emits ExitRedirected when Aave liquidity is constrained',
  async ({ divigent, publicClient, rpcUrl }) => {
    await withForkSnapshot(rpcUrl, async () => {
      const agent = createX402AgentForPrivateKey({
        privateKey: X402_AGENT_RECALL_PRIVATE_KEY,
        rpcUrl,
        publicClient,
        addresses: divigent.addresses,
      });
      const firstAmount = parseUsdc('10');
      const secondAmount = parseUsdc('20');

      await prepareX402Agent({
        agent,
        rpcUrl,
        publicClient,
        fundingAmount: parseUsdc('50'),
        initialize: true,
      });
      await expectRealBaseVenueWiring({ publicClient, addresses: divigent.addresses });
      const initialRates = await agent.sdk.getAllRates();
      const initialRouting = await readRoutingFacts({
        sdk: agent.sdk,
        amount: firstAmount,
      });
      expectOptimalVaultMatchesPolicy({
        facts: initialRouting,
        rates: initialRates,
        addresses: divigent.addresses,
      });
      const initialRoute = expectRoute(initialRouting);
      expect(initialRoute).toBe('AAVE');

      await approveUsdcAndWait(agent, publicClient, firstAmount + secondAmount);
      await depositAndAssert(agent, publicClient, firstAmount, {
        vaultType: 'AAVE',
      });

      const drained = await drainAaveCash({
        publicClient,
        rpcUrl,
        addresses: divigent.addresses,
      });
      expect(drained).toBeGreaterThanOrEqual(firstAmount);

      const ratesAfterDrain = await agent.sdk.getAllRates();
      const routingAfterDrain = await readRoutingFacts({
        sdk: agent.sdk,
        amount: secondAmount,
      });
      expectOptimalVaultMatchesPolicy({
        facts: routingAfterDrain,
        rates: ratesAfterDrain,
        addresses: divigent.addresses,
      });
      const routeAfterDrain = expectRoute(routingAfterDrain, 'MORPHO');
      expect(routeAfterDrain).toBe('MORPHO');
      await depositAndAssert(agent, publicClient, secondAmount, {
        vaultType: 'MORPHO',
      });

      const totalShares = await agent.sdk.dvUsdcBalance(agent.wallet);
      const sharesToWithdraw = totalShares / 2n;
      const withdraw = await withdrawAndAssert(agent, publicClient, sharesToWithdraw);
      expectExitRedirectedEvent(withdraw.receipt, { wallet: agent.wallet });
    });
  },
);
