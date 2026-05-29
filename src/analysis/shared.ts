import type { Hex, PublicClient } from 'viem';
import { createPublicClient, getAddress, http, isHex, parseAbiItem } from 'viem';
import { CHAINS, chainFromId, type ChainConfig } from '../core/chains';
import { formatUsdc, parseUsdc } from '../core/utils';
import { DivigentError } from '../errors';
import { evmAddress, type EvmAddress } from '../types';
import type {
  UsdcTransferEvent,
  WalletAnalysisClientInput,
  WalletBehaviorReport,
  WalletBehaviorSeries,
} from './types';
import { usdcAbi } from '../abis';

export const DEFAULT_ANALYSIS_CHAIN_ID: number = CHAINS.base.id;
export const DEFAULT_LOOKBACK_DAYS = 30;
export const MAX_LOOKBACK_DAYS = 90;
export const BASE_BLOCKS_PER_DAY = 43_200n;
export const LOG_BLOCK_CHUNK_SIZE = 25_000n;
const MIN_LOG_BLOCK_CHUNK_SIZE = 1_000n;
export const SECONDS_PER_DAY = 86_400;
export const USDC_ATOMIC = 1_000_000n;

const DEFAULT_RPC_BY_CHAIN: Record<number, string> = {
  [CHAINS.base.id]: 'https://mainnet.base.org',
  [CHAINS['base-sepolia'].id]: 'https://sepolia.base.org',
};

const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;
const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

type RawTransferLog = {
  address?: string;
  blockNumber?: bigint | null;
  data?: Hex;
  topics?: readonly Hex[];
  transactionHash?: Hex | null;
  logIndex?: number | null;
};

type LogsClient = PublicClient & {
  getLogs(args: {
    address: EvmAddress;
    fromBlock: bigint;
    toBlock: bigint;
    event: typeof TRANSFER_EVENT;
    args: { from?: EvmAddress; to?: EvmAddress };
  }): Promise<readonly RawTransferLog[]>;
  getBlockNumber(): Promise<bigint>;
  getTransactionCount(args: { address: EvmAddress }): Promise<number>;
};

export function chainConfigForAnalysis(chainId: number = DEFAULT_ANALYSIS_CHAIN_ID): ChainConfig {
  const chain = chainFromId(chainId);
  if (chain === undefined) {
    throw new DivigentError(`[@divigent/sdk] unsupported analysis chain id: ${chainId}`, {
      code: 'DIVIGENT_UNSUPPORTED_ANALYSIS_CHAIN',
      category: 'config',
      context: { chainId },
    });
  }
  return CHAINS[chain];
}

export function createAnalysisPublicClient(
  chainId: number = DEFAULT_ANALYSIS_CHAIN_ID,
  rpcUrl?: string,
): PublicClient {
  const config = chainConfigForAnalysis(chainId);
  return createPublicClient({
    chain: config.viemChain,
    transport: http(rpcUrl ?? DEFAULT_RPC_BY_CHAIN[config.id]),
  }) as PublicClient;
}

export function normalizeLookbackDays(value: number | undefined): number {
  const days = value ?? DEFAULT_LOOKBACK_DAYS;
  if (!Number.isInteger(days) || days <= 0) {
    throw new DivigentError('[@divigent/sdk] lookbackDays must be a positive integer', {
      code: 'DIVIGENT_INVALID_ANALYSIS_WINDOW',
      category: 'validation',
      context: { lookbackDays: value },
    });
  }
  return Math.min(days, MAX_LOOKBACK_DAYS);
}

export function parseOptionalUsdc(value: string | undefined, field: string): bigint {
  if (value === undefined) return 0n;
  try {
    return parseUsdc(value);
  } catch (err) {
    throw new DivigentError(`[@divigent/sdk] invalid ${field}: ${value}`, {
      code: 'DIVIGENT_INVALID_USDC_AMOUNT',
      category: 'validation',
      context: { field, value, cause: err instanceof Error ? err.message : String(err) },
    });
  }
}

export function ratioPct(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return 0;
  return Number((numerator * 1_000_000n) / denominator) / 10_000;
}

export function decimalFromRatio(numerator: bigint, denominator: bigint, decimals = 6): string {
  if (denominator <= 0n || numerator <= 0n) return '0';
  const scale = 10n ** BigInt(decimals);
  const scaled = (numerator * scale) / denominator;
  const whole = scaled / scale;
  const fraction = scaled % scale;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

export function atomicSecondsToUsdcDays(atomicSeconds: bigint): string {
  return decimalFromRatio(atomicSeconds, USDC_ATOMIC * BigInt(SECONDS_PER_DAY));
}

export function topicForAddress(address: EvmAddress): Hex {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}` as Hex;
}

function addressFromTopic(topic: Hex | undefined): EvmAddress {
  if (topic === undefined || !isHex(topic) || topic.length !== 66) {
    throw new DivigentError('[@divigent/sdk] malformed ERC20 Transfer topic', {
      code: 'DIVIGENT_INVALID_ANALYSIS_LOG',
      category: 'chain',
      context: { topic },
    });
  }
  return evmAddress(getAddress(`0x${topic.slice(26)}`));
}

function decodeTransferLog(log: RawTransferLog, wallet: EvmAddress): UsdcTransferEvent | undefined {
  const topics = log.topics;
  const blockNumber = log.blockNumber;
  const data = log.data;
  if (
    topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC ||
    blockNumber === undefined ||
    blockNumber === null ||
    data === undefined
  ) {
    return undefined;
  }

  const from = addressFromTopic(topics[1]);
  const to = addressFromTopic(topics[2]);
  const amount = BigInt(data);
  const walletLower = wallet.toLowerCase();
  const fromWallet = from.toLowerCase() === walletLower;
  const toWallet = to.toLowerCase() === walletLower;
  if (!fromWallet && !toWallet) return undefined;
  const direction = fromWallet ? 'out' : 'in';
  return {
    direction,
    from,
    to,
    counterparty: direction === 'out' ? to : from,
    amount,
    blockNumber,
    timestamp: 0,
    ...(log.transactionHash !== undefined && log.transactionHash !== null && {
      transactionHash: log.transactionHash,
    }),
    ...(log.logIndex !== undefined && log.logIndex !== null && { logIndex: log.logIndex }),
  };
}

async function fetchTransferLogs(
  client: LogsClient,
  usdcAddress: EvmAddress,
  wallet: EvmAddress,
  direction: 'in' | 'out',
  fromBlock: bigint,
  latestBlock: bigint,
): Promise<readonly RawTransferLog[]> {
  const logs: RawTransferLog[] = [];
  for (let start = fromBlock; start <= latestBlock; start += LOG_BLOCK_CHUNK_SIZE + 1n) {
    const end = start + LOG_BLOCK_CHUNK_SIZE > latestBlock
      ? latestBlock
      : start + LOG_BLOCK_CHUNK_SIZE;
    logs.push(...await fetchTransferLogRange(
      client,
      usdcAddress,
      wallet,
      direction,
      start,
      end,
      LOG_BLOCK_CHUNK_SIZE,
    ));
  }
  return logs;
}

async function fetchTransferLogRange(
  client: LogsClient,
  usdcAddress: EvmAddress,
  wallet: EvmAddress,
  direction: 'in' | 'out',
  fromBlock: bigint,
  toBlock: bigint,
  chunkSize: bigint,
): Promise<readonly RawTransferLog[]> {
  try {
    return await client.getLogs({
      address: usdcAddress,
      fromBlock,
      toBlock,
      event: TRANSFER_EVENT,
      args: direction === 'out' ? { from: wallet } : { to: wallet },
    });
  } catch (err) {
    if (chunkSize <= MIN_LOG_BLOCK_CHUNK_SIZE || fromBlock >= toBlock) throw err;
    const mid = (fromBlock + toBlock) / 2n;
    return [
      ...await fetchTransferLogRange(client, usdcAddress, wallet, direction, fromBlock, mid, chunkSize / 2n),
      ...await fetchTransferLogRange(client, usdcAddress, wallet, direction, mid + 1n, toBlock, chunkSize / 2n),
    ];
  }
}

function estimateTimestamp(latestBlock: bigint, latestTimestamp: number, blockNumber: bigint): number {
  if (blockNumber >= latestBlock) return latestTimestamp;
  return latestTimestamp - Number(latestBlock - blockNumber) * 2;
}

function dedupeTransfers(events: readonly UsdcTransferEvent[]): UsdcTransferEvent[] {
  const seen = new Set<string>();
  const out: UsdcTransferEvent[] = [];
  for (const event of events) {
    const key = event.transactionHash === undefined
      ? `${event.blockNumber}:${event.logIndex ?? -1}:${event.from}:${event.to}:${event.amount}`
      : `${event.transactionHash}:${event.logIndex ?? -1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out;
}

function median(values: readonly bigint[]): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0n;
  return ((sorted[mid - 1] ?? 0n) + (sorted[mid] ?? 0n)) / 2n;
}

export function quantile(values: readonly bigint[], q: number): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] ?? 0n;
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((acc, value) => acc + value, 0n);
}

function eventHour(timestamp: number): number {
  return Math.floor(timestamp / 3600) * 3600;
}

function inferRole(outflowCount: number, inflowCount: number): WalletBehaviorReport['pattern']['inferredRole'] {
  if (outflowCount > 0 && outflowCount > inflowCount * 3) return 'buyer';
  if (inflowCount > 0 && inflowCount > outflowCount * 3) return 'seller';
  return 'both';
}

function classifyCadence(
  events: readonly UsdcTransferEvent[],
  hourlyCounts: readonly number[],
): WalletBehaviorReport['pattern']['cadence'] {
  if (events.length === 0) return 'sparse';
  const nonZeroHours = hourlyCounts.filter((count) => count > 0).length;
  if (nonZeroHours <= Math.max(2, Math.floor(hourlyCounts.length * 0.05))) return 'sparse';
  const mean = events.length / Math.max(1, hourlyCounts.length);
  const variance = hourlyCounts.reduce((acc, count) => acc + (count - mean) ** 2, 0) / Math.max(1, hourlyCounts.length);
  if (variance / Math.max(mean, 0.0001) > 8) return 'burst';
  return 'steady';
}

function operatingPattern(events: readonly UsdcTransferEvent[]): WalletBehaviorReport['pattern']['operatingPattern'] {
  if (events.length === 0) return 'irregular';
  const activeUtcHours = new Set<number>();
  let weekday = 0;
  let workdayHours = 0;
  let nightHours = 0;
  for (const event of events) {
    const date = new Date(event.timestamp * 1000);
    const hour = date.getUTCHours();
    const day = date.getUTCDay();
    activeUtcHours.add(hour);
    if (day >= 1 && day <= 5) weekday += 1;
    if (hour >= 8 && hour <= 19) workdayHours += 1;
    if (hour >= 20 || hour <= 5) nightHours += 1;
  }
  const total = events.length;
  if (activeUtcHours.size >= 18 && weekday / total < 0.9) return '24x7';
  if (weekday / total >= 0.8 && workdayHours / total >= 0.65) return 'workday';
  if (nightHours / total >= 0.6) return 'nightshift';
  return 'irregular';
}

function computeBalanceStats(
  events: readonly UsdcTransferEvent[],
  currentUsdc: bigint,
  windowStartUnix: number,
  windowEndUnix: number,
): Pick<WalletBehaviorSeries, 'avgUsdc' | 'minUsdc' | 'maxUsdc' | 'startingUsdc'> {
  const totalInflow = sum(events.filter((event) => event.direction === 'in').map((event) => event.amount));
  const totalOutflow = sum(events.filter((event) => event.direction === 'out').map((event) => event.amount));
  const rawStart = currentUsdc - totalInflow + totalOutflow;
  let balance = rawStart < 0n ? 0n : rawStart;
  let minUsdc = balance;
  let maxUsdc = balance;
  let last = windowStartUnix;
  let balanceSeconds = 0n;

  for (const event of events) {
    const seconds = Math.max(0, event.timestamp - last);
    balanceSeconds += balance * BigInt(seconds);
    balance = event.direction === 'in'
      ? balance + event.amount
      : balance > event.amount ? balance - event.amount : 0n;
    if (balance < minUsdc) minUsdc = balance;
    if (balance > maxUsdc) maxUsdc = balance;
    last = event.timestamp;
  }

  balanceSeconds += balance * BigInt(Math.max(0, windowEndUnix - last));
  const duration = BigInt(Math.max(1, windowEndUnix - windowStartUnix));
  return {
    avgUsdc: balanceSeconds / duration,
    minUsdc,
    maxUsdc,
    startingUsdc: rawStart < 0n ? 0n : rawStart,
  };
}

export async function collectWalletBehaviorSeries(
  input: WalletAnalysisClientInput,
): Promise<WalletBehaviorSeries> {
  const wallet = evmAddress(input.wallet);
  const lookbackDays = normalizeLookbackDays(input.lookbackDays);
  const client = input.publicClient as LogsClient;
  const latestBlock = await client.getBlockNumber();
  const fromBlock = latestBlock > BASE_BLOCKS_PER_DAY * BigInt(lookbackDays)
    ? latestBlock - BASE_BLOCKS_PER_DAY * BigInt(lookbackDays)
    : 0n;
  const latestBlockData = await input.publicClient.getBlock({ blockNumber: latestBlock });
  const windowEndUnix = Number(latestBlockData.timestamp);
  const windowStartUnix = windowEndUnix - lookbackDays * SECONDS_PER_DAY;

  const [currentUsdc, nonce, outLogs, inLogs] = await Promise.all([
    input.publicClient.readContract({
      address: input.usdcAddress,
      abi: usdcAbi,
      functionName: 'balanceOf',
      args: [wallet],
    }),
    client.getTransactionCount({ address: wallet }),
    fetchTransferLogs(client, input.usdcAddress, wallet, 'out', fromBlock, latestBlock),
    fetchTransferLogs(client, input.usdcAddress, wallet, 'in', fromBlock, latestBlock),
  ]);

  const decoded = dedupeTransfers(
    [...outLogs, ...inLogs]
      .map((log) => decodeTransferLog(log, wallet))
      .filter((event): event is UsdcTransferEvent => event !== undefined),
  );
  const events = decoded.map((event) => ({
    ...event,
    timestamp: estimateTimestamp(latestBlock, windowEndUnix, event.blockNumber),
  }))
    .filter((event) => event.timestamp >= windowStartUnix && event.timestamp <= windowEndUnix)
    .sort((a, b) =>
      a.timestamp - b.timestamp ||
      (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0) ||
      (a.logIndex ?? 0) - (b.logIndex ?? 0));

  const internalAddresses = new Set(
    (input.internalAddresses ?? []).map((address) => evmAddress(address).toLowerCase()),
  );
  const activityEvents = events.filter((event) => !internalAddresses.has(event.counterparty.toLowerCase()));
  const outflows = activityEvents.filter((event) => event.direction === 'out');
  const inflows = activityEvents.filter((event) => event.direction === 'in');
  const outflowAmounts = outflows.map((event) => event.amount);
  const totalOutflow = sum(outflowAmounts);
  const totalInflow = sum(inflows.map((event) => event.amount));
  const hours = lookbackDays * 24;
  const hourlyOutflows = new Map<number, bigint>();
  const hourlyCounts = Array.from({ length: hours }, () => 0);
  for (const event of activityEvents) {
    const hour = eventHour(event.timestamp);
    if (event.direction === 'out') {
      hourlyOutflows.set(hour, (hourlyOutflows.get(hour) ?? 0n) + event.amount);
    }
    const index = Math.floor((event.timestamp - windowStartUnix) / 3600);
    if (index >= 0 && index < hourlyCounts.length) hourlyCounts[index] = (hourlyCounts[index] ?? 0) + 1;
  }

  const peakHourlyOutflow = [...hourlyOutflows.values()].reduce((max, value) => value > max ? value : max, 0n);
  const averageHourlyOutflow = totalOutflow / BigInt(Math.max(1, hours));
  const distinctMerchants = new Set(outflows.map((event) => event.counterparty.toLowerCase())).size;
  const distinctInflowCounterparties = new Set(inflows.map((event) => event.counterparty.toLowerCase())).size;
  const role = inferRole(outflows.length, inflows.length);
  const behaviorClass: WalletBehaviorReport['pattern']['behaviorClass'] =
    outflows.length > 500 && median(outflowAmounts) < 5n * USDC_ATOMIC
      ? 'high_frequency_micropayment'
      : averageHourlyOutflow > 0n && peakHourlyOutflow > averageHourlyOutflow * 10n
        ? 'burst_payer'
        : role === 'seller' && distinctInflowCounterparties > 100
          ? 'merchant_collector'
          : 'mixed';
  const balanceStats = computeBalanceStats(events, currentUsdc, windowStartUnix, windowEndUnix);
  const report: WalletBehaviorReport = {
    wallet,
    lookbackDays,
    windowStart: new Date(windowStartUnix * 1000).toISOString(),
    windowEnd: new Date(windowEndUnix * 1000).toISOString(),
    balance: {
      currentUsdc: formatUsdc(currentUsdc),
      avgUsdc: formatUsdc(balanceStats.avgUsdc),
      minUsdc: formatUsdc(balanceStats.minUsdc),
      maxUsdc: formatUsdc(balanceStats.maxUsdc),
      highWatermarkUsdc: formatUsdc(balanceStats.maxUsdc),
    },
    activity: {
      outflowCount: outflows.length,
      inflowCount: inflows.length,
      distinctMerchants,
      totalOutflowUsdc: formatUsdc(totalOutflow),
      totalInflowUsdc: formatUsdc(totalInflow),
      avgPaymentUsdc: formatUsdc(outflows.length === 0 ? 0n : totalOutflow / BigInt(outflows.length)),
      medianPaymentUsdc: formatUsdc(median(outflowAmounts)),
      p95PaymentUsdc: formatUsdc(quantile(outflowAmounts, 0.95)),
      largestPaymentUsdc: formatUsdc(quantile(outflowAmounts, 1)),
      peakHourlyOutflowUsdc: formatUsdc(peakHourlyOutflow),
    },
    pattern: {
      inferredRole: role,
      behaviorClass,
      cadence: classifyCadence(activityEvents, hourlyCounts),
      usesEip3009: nonce === 0 && outflows.length > 0,
      operatingPattern: operatingPattern(activityEvents),
    },
  };

  return {
    report,
    events: activityEvents,
    balanceEvents: events,
    currentUsdc,
    avgUsdc: balanceStats.avgUsdc,
    minUsdc: balanceStats.minUsdc,
    maxUsdc: balanceStats.maxUsdc,
    startingUsdc: balanceStats.startingUsdc,
    windowStartUnix,
    windowEndUnix,
  };
}
