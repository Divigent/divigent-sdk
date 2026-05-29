import { formatUsdc } from '../core/utils';
import { DivigentError } from '../errors';
import { evmAddress } from '../types';
import type {
  AnalyzeMissedYieldInput,
  MissedYieldClientInput,
  MissedYieldReport,
  UsdcTransferEvent,
} from './types';
import {
  SECONDS_PER_DAY,
  atomicSecondsToUsdcDays,
  chainConfigForAnalysis,
  collectWalletBehaviorSeries,
  createAnalysisPublicClient,
  decimalFromRatio,
  parseOptionalUsdc,
  quantile,
  ratioPct,
} from './shared';

const DEFAULT_ASSUMED_APY = 0.045;
const APY_SCALE = 1_000_000n;

type IntegrationState = {
  avgRequiredReserve: bigint;
  avgDeployable: bigint;
  deployableSeconds: bigint;
  initialDeployable: bigint;
  peakDeployable: bigint;
  recallsNeededCount: number;
  neverRanShortOfPendingPayments: boolean;
};

/** Estimate historical missed USDC yield from idle wallet capital. */
export async function analyzeMissedYield(
  input: AnalyzeMissedYieldInput,
): Promise<MissedYieldReport> {
  const config = chainConfigForAnalysis(input.chainId);
  return analyzeMissedYieldWithClient({
    publicClient: createAnalysisPublicClient(config.id, input.rpcUrl),
    usdcAddress: config.addresses.usdc,
    internalAddresses: [config.addresses.router],
    wallet: input.wallet,
    chainId: config.id,
    ...(input.lookbackDays !== undefined && { lookbackDays: input.lookbackDays }),
    ...(input.assumedApy !== undefined && { assumedApy: input.assumedApy }),
    ...(input.minOperatingBalance !== undefined && { minOperatingBalance: input.minOperatingBalance }),
    ...(input.behavior !== undefined && { behavior: input.behavior }),
  });
}

export async function analyzeMissedYieldWithClient(
  input: MissedYieldClientInput,
): Promise<MissedYieldReport> {
  const wallet = evmAddress(input.wallet);
  const series = await collectWalletBehaviorSeries(input);
  const behavior = input.behavior ?? series.report;
  const apy = input.assumedApy ?? DEFAULT_ASSUMED_APY;
  if (!Number.isFinite(apy) || apy < 0) {
    throw new DivigentError('[@divigent/sdk] assumedApy must be a non-negative finite number', {
      code: 'DIVIGENT_INVALID_ANALYSIS_APY',
      category: 'validation',
      context: { assumedApy: input.assumedApy },
    });
  }
  const minOperatingBalance = parseOptionalUsdc(input.minOperatingBalance, 'minOperatingBalance');
  const integrated = integrateDeployable({
    activityEvents: series.events,
    balanceEvents: series.balanceEvents,
    startingBalance: series.startingUsdc,
    windowStartUnix: series.windowStartUnix,
    windowEndUnix: series.windowEndUnix,
    minOperatingBalance,
  });
  const apyScaled = BigInt(Math.max(0, Math.round(apy * Number(APY_SCALE))));
  const missedYieldAtomic = integrated.deployableSeconds * apyScaled /
    (APY_SCALE * 365n * BigInt(SECONDS_PER_DAY));
  const annualizedMissedYieldAtomic = integrated.avgDeployable * apyScaled / APY_SCALE;
  const currentUsdc = series.currentUsdc;
  const withDivigentEfficiency = ratioPct(integrated.avgDeployable, series.avgUsdc);
  const currentEfficiency = 0;

  return {
    wallet,
    lookbackDays: behavior.lookbackDays,
    assumedApy: apy,
    idleCapital: {
      avgIdleUsdc: behavior.balance.avgUsdc,
      avgRequiredReserveUsdc: formatUsdc(integrated.avgRequiredReserve),
      avgDeployableUsdc: formatUsdc(integrated.avgDeployable),
      idleUsdcDays: atomicSecondsToUsdcDays(integrated.deployableSeconds),
    },
    missedYield: {
      missedYieldUsdc: formatUsdc(missedYieldAtomic),
      annualizedMissedYieldUsdc: formatUsdc(annualizedMissedYieldAtomic),
      vsCurrentBalancePct: ratioPct(missedYieldAtomic, currentUsdc),
    },
    capitalEfficiency: {
      currentEfficiencyPct: currentEfficiency,
      withDivigentEfficiencyPct: withDivigentEfficiency,
      efficiencyDeltaPct: withDivigentEfficiency - currentEfficiency,
    },
    counterfactual: {
      wouldHaveDeployedAtLaunchUsdc: formatUsdc(integrated.initialDeployable),
      wouldHavePeakDeployedUsdc: formatUsdc(integrated.peakDeployable),
      wouldHaveRecallsNeededCount: integrated.recallsNeededCount,
      neverRanShortOfPendingPayments: integrated.neverRanShortOfPendingPayments,
    },
    headline: buildHeadline({
      avgDeployable: integrated.avgDeployable,
      missedYield: missedYieldAtomic,
      annualizedMissedYield: annualizedMissedYieldAtomic,
      efficiencyPct: withDivigentEfficiency,
      lookbackDays: behavior.lookbackDays,
      apy,
    }),
  };
}

function integrateDeployable(params: {
  activityEvents: readonly UsdcTransferEvent[];
  balanceEvents: readonly UsdcTransferEvent[];
  startingBalance: bigint;
  windowStartUnix: number;
  windowEndUnix: number;
  minOperatingBalance: bigint;
}): IntegrationState {
  let balance = params.startingBalance;
  let last = params.windowStartUnix;
  let deployableSeconds = 0n;
  let reserveSeconds = 0n;
  let initialDeployable = 0n;
  let peakDeployable = 0n;
  let recallsNeededCount = 0;
  let neverRanShortOfPendingPayments = true;

  const integrateInterval = (timestamp: number, isInitial: boolean): void => {
    const seconds = Math.max(0, timestamp - last);
    const required = requiredReserveAt(params.activityEvents, last, params.minOperatingBalance);
    const deployable = balance > required ? balance - required : 0n;
    if (isInitial) initialDeployable = deployable;
    if (deployable > peakDeployable) peakDeployable = deployable;
    deployableSeconds += deployable * BigInt(seconds);
    reserveSeconds += required * BigInt(seconds);
    if (balance < required) recallsNeededCount += 1;
    if (balance < oneHourOutflowAt(params.activityEvents, last)) {
      neverRanShortOfPendingPayments = false;
    }
  };

  integrateInterval(params.balanceEvents[0]?.timestamp ?? params.windowEndUnix, true);
  for (const event of params.balanceEvents) {
    if (event.timestamp > last) {
      last = event.timestamp;
    }
    balance = event.direction === 'in'
      ? balance + event.amount
      : balance > event.amount ? balance - event.amount : 0n;
    integrateInterval(nextTimestamp(params.balanceEvents, event, params.windowEndUnix), false);
  }

  const duration = BigInt(Math.max(1, params.windowEndUnix - params.windowStartUnix));
  return {
    avgRequiredReserve: reserveSeconds / duration,
    avgDeployable: deployableSeconds / duration,
    deployableSeconds,
    initialDeployable,
    peakDeployable,
    recallsNeededCount,
    neverRanShortOfPendingPayments,
  };
}

function nextTimestamp(
  events: readonly UsdcTransferEvent[],
  event: UsdcTransferEvent,
  windowEndUnix: number,
): number {
  const index = events.indexOf(event);
  return events[index + 1]?.timestamp ?? windowEndUnix;
}

function requiredReserveAt(
  events: readonly UsdcTransferEvent[],
  timestamp: number,
  minOperatingBalance: bigint,
): bigint {
  const p95Payment = quantile(
    events
      .filter((event) =>
        event.direction === 'out' &&
        event.timestamp > timestamp - 7 * SECONDS_PER_DAY &&
        event.timestamp <= timestamp)
      .map((event) => event.amount),
    0.95,
  );
  const oneHourOutflow = oneHourOutflowAt(events, timestamp);
  return [minOperatingBalance, p95Payment, oneHourOutflow]
    .reduce((max, value) => value > max ? value : max, 0n);
}

function oneHourOutflowAt(events: readonly UsdcTransferEvent[], timestamp: number): bigint {
  return events
    .filter((event) =>
      event.direction === 'out' &&
      event.timestamp > timestamp - 3600 &&
      event.timestamp <= timestamp)
    .reduce((acc, event) => acc + event.amount, 0n);
}

function buildHeadline(params: {
  avgDeployable: bigint;
  missedYield: bigint;
  annualizedMissedYield: bigint;
  efficiencyPct: number;
  lookbackDays: number;
  apy: number;
}): MissedYieldReport['headline'] {
  const apyPct = decimalFromRatio(BigInt(Math.round(params.apy * 10_000)), 100n, 2);
  return {
    primary: `This wallet held an average of ${formatUsdc(params.avgDeployable)} deployable USDC over the last ${params.lookbackDays} days.`,
    secondary: `At ${apyPct}% APY, that is about ${formatUsdc(params.missedYield)} USDC missed in-window, or ${formatUsdc(params.annualizedMissedYield)} USDC annualized.`,
    ctaContext: `With Divigent, this wallet could have kept roughly ${params.efficiencyPct.toFixed(2)}% of idle USDC productive while preserving a reserve for payments.`,
  };
}
