import type { Hex, PublicClient } from 'viem';
import type { EvmAddress } from '../types';

export type AnalyzeWalletBehaviorInput = {
  wallet: `0x${string}` | EvmAddress;
  chainId?: number;
  lookbackDays?: number;
  rpcUrl?: string;
};

export type AnalyzeMissedYieldInput = {
  wallet: `0x${string}` | EvmAddress;
  chainId?: number;
  lookbackDays?: number;
  assumedApy?: number;
  minOperatingBalance?: string;
  rpcUrl?: string;
  behavior?: WalletBehaviorReport;
};

export type WalletBehaviorReport = {
  wallet: string;
  lookbackDays: number;
  windowStart: string;
  windowEnd: string;
  balance: {
    currentUsdc: string;
    avgUsdc: string;
    minUsdc: string;
    maxUsdc: string;
    highWatermarkUsdc: string;
  };
  activity: {
    outflowCount: number;
    inflowCount: number;
    distinctMerchants: number;
    totalOutflowUsdc: string;
    totalInflowUsdc: string;
    avgPaymentUsdc: string;
    medianPaymentUsdc: string;
    p95PaymentUsdc: string;
    largestPaymentUsdc: string;
    peakHourlyOutflowUsdc: string;
  };
  pattern: {
    inferredRole: 'buyer' | 'seller' | 'both';
    behaviorClass: 'high_frequency_micropayment' | 'burst_payer' | 'merchant_collector' | 'mixed';
    cadence: 'burst' | 'steady' | 'sparse';
    usesEip3009: boolean;
    operatingPattern: '24x7' | 'workday' | 'nightshift' | 'irregular';
  };
};

export type MissedYieldReport = {
  wallet: string;
  lookbackDays: number;
  assumedApy: number;
  idleCapital: {
    avgIdleUsdc: string;
    avgRequiredReserveUsdc: string;
    avgDeployableUsdc: string;
    idleUsdcDays: string;
  };
  missedYield: {
    missedYieldUsdc: string;
    annualizedMissedYieldUsdc: string;
    vsCurrentBalancePct: number;
  };
  capitalEfficiency: {
    currentEfficiencyPct: number;
    withDivigentEfficiencyPct: number;
    efficiencyDeltaPct: number;
  };
  counterfactual: {
    wouldHaveDeployedAtLaunchUsdc: string;
    wouldHavePeakDeployedUsdc: string;
    wouldHaveRecallsNeededCount: number;
    neverRanShortOfPendingPayments: boolean;
  };
  headline: {
    primary: string;
    secondary: string;
    ctaContext: string;
  };
};

export type WalletAnalysisClientInput = {
  publicClient: PublicClient;
  usdcAddress: EvmAddress;
  internalAddresses?: readonly EvmAddress[];
  wallet: `0x${string}` | EvmAddress;
  chainId: number;
  lookbackDays?: number;
};

export type MissedYieldClientInput = WalletAnalysisClientInput & {
  assumedApy?: number;
  minOperatingBalance?: string;
  behavior?: WalletBehaviorReport;
};

export type ProtocolMetricsClientInput = {
  publicClient: PublicClient;
  chainId: number;
  router: EvmAddress;
  dvUsdc: EvmAddress;
};

export type DivigentProtocolMetrics = {
  chainId: number;
  router: string;
  dvUsdc: string;
  asOfBlock: bigint;
  asOfTimestamp: string;
  scan: {
    fromBlock: bigint;
    toBlock: bigint;
    deploymentTime: string;
    deploymentTimeUnix: bigint;
  };
  wallets: {
    uniqueWalletsUsingDivigent: number;
    uniqueAuthorizedWallets: number;
    uniqueDepositors: number;
    uniqueWithdrawers: number;
    activeWalletsWithPosition: number;
  };
  volume: {
    cumulativeDepositedUsdc: string;
    cumulativeDepositedAtomic: bigint;
    cumulativeWithdrawnUsdc: string;
    cumulativeWithdrawnAtomic: bigint;
    netDvUsdcOutstanding: string;
    netDvUsdcOutstandingAtomic: bigint;
  };
  tvl: {
    currentTvlUsdc: string;
    currentTvlAtomic: bigint;
    aaveAssetsUsdc: string;
    aaveAssetsAtomic: bigint;
    morphoAssetsUsdc: string;
    morphoAssetsAtomic: bigint;
    pricePerShare: bigint;
  };
  transactions: {
    totalDivigentTransactions: number;
    totalTreasuryOperations: number;
    authorizationTransactions: number;
    depositTransactions: number;
    withdrawTransactions: number;
    recallProxyTransactions: number;
    x402SettledViaDivigent: null;
    x402SettledViaDivigentNote: string;
  };
};

export type UsdcTransferDirection = 'in' | 'out';

export type UsdcTransferEvent = {
  direction: UsdcTransferDirection;
  from: EvmAddress;
  to: EvmAddress;
  counterparty: EvmAddress;
  amount: bigint;
  blockNumber: bigint;
  timestamp: number;
  transactionHash?: Hex;
  logIndex?: number;
};

export type WalletBehaviorSeries = {
  report: WalletBehaviorReport;
  events: readonly UsdcTransferEvent[];
  balanceEvents: readonly UsdcTransferEvent[];
  currentUsdc: bigint;
  avgUsdc: bigint;
  minUsdc: bigint;
  maxUsdc: bigint;
  startingUsdc: bigint;
  windowStartUnix: number;
  windowEndUnix: number;
};
