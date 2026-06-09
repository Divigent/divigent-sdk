import { describe, expect, it, vi } from 'vitest';
import type { Hex, PublicClient } from 'viem';
import {
  analyzeMissedYieldWithClient,
  analyzeWalletBehaviorWithClient,
  getProtocolMetricsWithClient,
} from '../../src/analysis';
import { parseUsdc } from '../../src/core/utils';
import { evmAddress, type EvmAddress } from '../../src/types';

const WALLET = evmAddress('0x1111111111111111111111111111111111111111');
const USDC = evmAddress('0x2222222222222222222222222222222222222222');
const MERCHANT_A = evmAddress('0x3333333333333333333333333333333333333333');
const MERCHANT_B = evmAddress('0x4444444444444444444444444444444444444444');
const MERCHANT_C = evmAddress('0x5555555555555555555555555555555555555555');
const MERCHANT_D = evmAddress('0x6666666666666666666666666666666666666666');
const FUNDER = evmAddress('0x7777777777777777777777777777777777777777');
const ROUTER = evmAddress('0x8888888888888888888888888888888888888888');
const DV_USDC = evmAddress('0x9999999999999999999999999999999999999999');
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

type FakeLog = {
  blockNumber: bigint;
  data: Hex;
  topics: readonly [typeof TRANSFER_TOPIC, Hex, Hex];
  transactionHash: Hex;
  logIndex: number;
};

function topic(address: EvmAddress): Hex {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}` as Hex;
}

function data(amountUsdc: string): Hex {
  return `0x${parseUsdc(amountUsdc).toString(16).padStart(64, '0')}` as Hex;
}

function transfer(
  blockNumber: bigint,
  logIndex: number,
  from: EvmAddress,
  to: EvmAddress,
  amountUsdc: string,
): FakeLog {
  return {
    blockNumber,
    data: data(amountUsdc),
    topics: [TRANSFER_TOPIC, topic(from), topic(to)],
    transactionHash: `0x${blockNumber.toString(16).padStart(62, '0')}${logIndex.toString(16).padStart(2, '0')}` as Hex,
    logIndex,
  };
}

function fakePublicClient(opts: {
  currentUsdc: string;
  nonce?: number;
  logs?: readonly FakeLog[];
}): PublicClient {
  const latestBlock = 1_000_000n;
  const latestTimestamp = 1_700_000_000n;
  const logs = [...(opts.logs ?? [])];
  const getLogs = vi.fn(async (args: {
    fromBlock: bigint;
    toBlock: bigint;
    args: { from?: EvmAddress; to?: EvmAddress };
  }) => logs.filter((log) => {
    if (log.blockNumber < args.fromBlock || log.blockNumber > args.toBlock) return false;
    if (args.args.from !== undefined && log.topics[1].toLowerCase() !== topic(args.args.from).toLowerCase()) return false;
    if (args.args.to !== undefined && log.topics[2].toLowerCase() !== topic(args.args.to).toLowerCase()) return false;
    return true;
  }));

  return {
    getBlockNumber: vi.fn(async () => latestBlock),
    getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
      timestamp: latestTimestamp - (latestBlock - blockNumber) * 2n,
    })),
    getBalance: vi.fn(async () => 1_000_000_000_000_000n),
    getTransactionCount: vi.fn(async () => opts.nonce ?? 1),
    getCode: vi.fn(async () => '0x' as Hex),
    getLogs,
    readContract: vi.fn(async () => parseUsdc(opts.currentUsdc)),
  } as unknown as PublicClient;
}

describe('wallet analysis', () => {
  it('summarizes USDC behavior from Transfer logs', async () => {
    const publicClient = fakePublicClient({
      currentUsdc: '100',
      nonce: 0,
      logs: [
        transfer(999_000n, 0, WALLET, MERCHANT_A, '1'),
        transfer(999_100n, 1, WALLET, MERCHANT_B, '2'),
        transfer(999_200n, 2, WALLET, MERCHANT_C, '3'),
        transfer(999_300n, 3, WALLET, MERCHANT_D, '4'),
        transfer(999_400n, 4, FUNDER, WALLET, '10'),
      ],
    });

    const report = await analyzeWalletBehaviorWithClient({
      publicClient,
      usdcAddress: USDC,
      wallet: WALLET,
      chainId: 8453,
      lookbackDays: 1,
    });

    expect(report.activity.outflowCount).toBe(4);
    expect(report.activity.inflowCount).toBe(1);
    expect(report.activity.distinctMerchants).toBe(4);
    expect(report.activity.totalOutflowUsdc).toBe('10');
    expect(report.activity.totalInflowUsdc).toBe('10');
    expect(report.activity.avgPaymentUsdc).toBe('2.5');
    expect(report.activity.medianPaymentUsdc).toBe('2.5');
    expect(report.activity.p95PaymentUsdc).toBe('4');
    expect(report.activity.largestPaymentUsdc).toBe('4');
    expect(report.pattern.inferredRole).toBe('buyer');
    expect(report.pattern.usesEip3009).toBe(true);
  });

  it('excludes Divigent internal transfers from wallet behavior activity', async () => {
    const publicClient = fakePublicClient({
      currentUsdc: '95',
      logs: [
        transfer(999_000n, 0, WALLET, ROUTER, '10'),
        transfer(999_100n, 1, ROUTER, WALLET, '5'),
        transfer(999_200n, 2, WALLET, MERCHANT_A, '1'),
        transfer(999_300n, 3, FUNDER, WALLET, '2'),
      ],
    });

    const report = await analyzeWalletBehaviorWithClient({
      publicClient,
      usdcAddress: USDC,
      internalAddresses: [ROUTER],
      wallet: WALLET,
      chainId: 8453,
      lookbackDays: 1,
    });

    expect(report.activity.outflowCount).toBe(1);
    expect(report.activity.inflowCount).toBe(1);
    expect(report.activity.totalOutflowUsdc).toBe('1');
    expect(report.activity.totalInflowUsdc).toBe('2');
    expect(report.activity.p95PaymentUsdc).toBe('1');
  });

  it('estimates missed yield from deployable idle USDC', async () => {
    const report = await analyzeMissedYieldWithClient({
      publicClient: fakePublicClient({ currentUsdc: '100', logs: [] }),
      usdcAddress: USDC,
      wallet: WALLET,
      chainId: 8453,
      lookbackDays: 1,
      minOperatingBalance: '10',
      assumedApy: 0.365,
    });

    expect(report.idleCapital.avgIdleUsdc).toBe('100');
    expect(report.idleCapital.avgRequiredReserveUsdc).toBe('10');
    expect(report.idleCapital.avgDeployableUsdc).toBe('90');
    expect(report.idleCapital.idleUsdcDays).toBe('90');
    expect(report.missedYield.missedYieldUsdc).toBe('0.09');
    expect(report.missedYield.annualizedMissedYieldUsdc).toBe('32.85');
    expect(report.capitalEfficiency.withDivigentEfficiencyPct).toBe(90);
    expect(report.counterfactual.wouldHaveDeployedAtLaunchUsdc).toBe('90');
  });

  it('collects protocol traction metrics from router events and live accounting', async () => {
    const wallets = {
      a: WALLET,
      b: MERCHANT_A,
      c: MERCHANT_B,
    };
    const protocolLog = (
      blockNumber: bigint,
      logIndex: number,
      args: Record<string, unknown>,
    ) => ({
      blockNumber,
      transactionHash: `0x${blockNumber.toString(16).padStart(62, '0')}${logIndex.toString(16).padStart(2, '0')}` as Hex,
      logIndex,
      args,
    });
    const eventLogs: Record<string, Array<ReturnType<typeof protocolLog>>> = {
      WalletAuthorised: [
        protocolLog(910n, 0, { wallet: wallets.a }),
        protocolLog(911n, 0, { wallet: wallets.c }),
      ],
      Deposited: [
        protocolLog(920n, 0, { wallet: wallets.a, usdcAmount: parseUsdc('10'), dvUsdcMinted: parseUsdc('9.9') }),
        protocolLog(930n, 0, { wallet: wallets.b, usdcAmount: parseUsdc('5'), dvUsdcMinted: parseUsdc('5') }),
      ],
      Withdrawn: [
        protocolLog(940n, 0, { wallet: wallets.a, dvUsdcBurned: parseUsdc('3'), usdcReturned: parseUsdc('3') }),
      ],
    };
    const publicClient = {
      getBlockNumber: vi.fn(async () => 1_000n),
      getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
        timestamp: blockNumber * 10n,
      })),
      getLogs: vi.fn(async ({ event, fromBlock, toBlock }: {
        event: { name: string };
        fromBlock: bigint;
        toBlock: bigint;
      }) => (eventLogs[event.name] ?? []).filter((log) =>
        log.blockNumber >= fromBlock && log.blockNumber <= toBlock)),
      readContract: vi.fn(async ({ functionName, args }: {
        functionName: string;
        args?: readonly unknown[];
      }) => {
        if (functionName === 'DEPLOYMENT_TIME') return 9_000n;
        if (functionName === 'totalVaultAssets') return parseUsdc('12.5');
        if (functionName === 'getCurrentAllocation') return [parseUsdc('4'), parseUsdc('8.5')] as const;
        if (functionName === 'pricePerShare') return 1_000_000_000_000_000_000n;
        if (functionName === 'totalSupply') return parseUsdc('12');
        if (functionName === 'getPosition') {
          const wallet = String(args?.[0]).toLowerCase();
          if (wallet === wallets.a.toLowerCase()) return [parseUsdc('7'), parseUsdc('7'), 0n] as const;
          if (wallet === wallets.b.toLowerCase()) return [parseUsdc('5'), parseUsdc('5.5'), parseUsdc('0.5')] as const;
          return [0n, 0n, 0n] as const;
        }
        throw new Error(`unexpected read ${functionName}`);
      }),
    } as unknown as PublicClient;

    const metrics = await getProtocolMetricsWithClient({
      publicClient,
      chainId: 8453,
      router: ROUTER,
      dvUsdc: DV_USDC,
    });

    expect(metrics.wallets.uniqueWalletsUsingDivigent).toBe(3);
    expect(metrics.wallets.uniqueDepositors).toBe(2);
    expect(metrics.wallets.activeWalletsWithPosition).toBe(2);
    expect(metrics.volume.cumulativeDepositedUsdc).toBe('15');
    expect(metrics.volume.cumulativeWithdrawnUsdc).toBe('3');
    expect(metrics.volume.netDvUsdcOutstanding).toBe('12');
    expect(metrics.tvl.currentTvlUsdc).toBe('12.5');
    expect(metrics.tvl.aaveAssetsUsdc).toBe('4');
    expect(metrics.tvl.morphoAssetsUsdc).toBe('8.5');
    expect(metrics.transactions.totalDivigentTransactions).toBe(5);
    expect(metrics.transactions.totalTreasuryOperations).toBe(3);
    expect(metrics.transactions.recallProxyTransactions).toBe(1);
    expect(metrics.transactions.x402SettledViaDivigent).toBeNull();
  });
});
