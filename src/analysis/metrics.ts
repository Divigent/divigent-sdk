import type { Hex, PublicClient } from 'viem';
import { parseAbiItem } from 'viem';
import { routerAbi, dvUsdcAbi } from '../abis';
import { chainConfigForAnalysis } from './shared';
import { formatUsdc } from '../core/utils';
import type { DivigentProtocolMetrics, ProtocolMetricsClientInput } from './types';
import { evmAddress, type EvmAddress } from '../types';

const WALLET_AUTHORISED_EVENT = parseAbiItem('event WalletAuthorised(address indexed wallet)');
const DEPOSITED_EVENT = parseAbiItem('event Deposited(address indexed wallet, uint256 usdcAmount, uint256 dvUsdcMinted, uint8 indexed vaultType)');
const WITHDRAWN_EVENT = parseAbiItem('event Withdrawn(address indexed wallet, uint256 dvUsdcBurned, uint256 usdcReturned, uint256 yieldEarned, uint256 feePaid)');
const METRICS_LOG_CHUNK_SIZE = 50_000n;
const MIN_LOG_CHUNK_SIZE = 1_000n;
const POSITION_READ_BATCH_SIZE = 25;

type ProtocolEventLog<TArgs extends Record<string, unknown>> = {
  args: TArgs;
  transactionHash?: Hex | null;
  logIndex?: number | null;
};

type AuthorizedArgs = { wallet: EvmAddress };
type DepositedArgs = { wallet: EvmAddress; usdcAmount: bigint; dvUsdcMinted: bigint };
type WithdrawnArgs = { wallet: EvmAddress; dvUsdcBurned: bigint; usdcReturned: bigint };

type MetricsLogsClient = PublicClient & {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: {
    address: EvmAddress;
    event: typeof WALLET_AUTHORISED_EVENT | typeof DEPOSITED_EVENT | typeof WITHDRAWN_EVENT;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly ProtocolEventLog<Record<string, unknown>>[]>;
};

/** Collect protocol-level traction metrics from on-chain Divigent events and live accounting reads. */
export async function getProtocolMetricsWithClient(
  input: ProtocolMetricsClientInput,
): Promise<DivigentProtocolMetrics> {
  chainConfigForAnalysis(input.chainId);
  const client = input.publicClient as MetricsLogsClient;
  const latestBlock = await client.getBlockNumber();
  const [latestBlockData, deploymentTime] = await Promise.all([
    input.publicClient.getBlock({ blockNumber: latestBlock }),
    input.publicClient.readContract({
      address: input.router,
      abi: routerAbi,
      functionName: 'DEPLOYMENT_TIME',
    }),
  ]);
  const fromBlock = await firstBlockAtOrAfter(input.publicClient, deploymentTime, latestBlock);

  const authorizedLogs = await getLogsChunked<AuthorizedArgs>(
    client,
    input.router,
    WALLET_AUTHORISED_EVENT,
    fromBlock,
    latestBlock,
  );
  const depositLogs = await getLogsChunked<DepositedArgs>(
    client,
    input.router,
    DEPOSITED_EVENT,
    fromBlock,
    latestBlock,
  );
  const withdrawLogs = await getLogsChunked<WithdrawnArgs>(
    client,
    input.router,
    WITHDRAWN_EVENT,
    fromBlock,
    latestBlock,
  );
  const [totalVaultAssets, allocation, pricePerShare, dvTotalSupply] =
    await Promise.all([
      input.publicClient.readContract({
        address: input.router,
        abi: routerAbi,
        functionName: 'totalVaultAssets',
      }),
      input.publicClient.readContract({
        address: input.router,
        abi: routerAbi,
        functionName: 'getCurrentAllocation',
      }),
      input.publicClient.readContract({
        address: input.router,
        abi: routerAbi,
        functionName: 'pricePerShare',
      }),
      input.publicClient.readContract({
        address: input.dvUsdc,
        abi: dvUsdcAbi,
        functionName: 'totalSupply',
      }),
    ]);

  const authorizedWallets = walletSet(authorizedLogs);
  const depositorWallets = walletSet(depositLogs);
  const withdrawerWallets = walletSet(withdrawLogs);
  const touchedWallets = new Set([...authorizedWallets, ...depositorWallets, ...withdrawerWallets]);
  const activeWalletsWithPosition = await countActivePositions(
    input.publicClient,
    input.router,
    [...touchedWallets].map((wallet) => evmAddress(wallet)),
  );
  const cumulativeDepositedAtomic = depositLogs.reduce((acc, log) => acc + log.args.usdcAmount, 0n);
  const cumulativeWithdrawnAtomic = withdrawLogs.reduce((acc, log) => acc + log.args.usdcReturned, 0n);

  return {
    chainId: input.chainId,
    router: input.router,
    dvUsdc: input.dvUsdc,
    asOfBlock: latestBlock,
    asOfTimestamp: new Date(Number(latestBlockData.timestamp) * 1000).toISOString(),
    scan: {
      fromBlock,
      toBlock: latestBlock,
      deploymentTime: new Date(Number(deploymentTime) * 1000).toISOString(),
      deploymentTimeUnix: deploymentTime,
    },
    wallets: {
      uniqueWalletsUsingDivigent: touchedWallets.size,
      uniqueAuthorizedWallets: authorizedWallets.size,
      uniqueDepositors: depositorWallets.size,
      uniqueWithdrawers: withdrawerWallets.size,
      activeWalletsWithPosition,
    },
    volume: {
      cumulativeDepositedUsdc: formatUsdc(cumulativeDepositedAtomic),
      cumulativeDepositedAtomic,
      cumulativeWithdrawnUsdc: formatUsdc(cumulativeWithdrawnAtomic),
      cumulativeWithdrawnAtomic,
      netDvUsdcOutstanding: formatUsdc(dvTotalSupply),
      netDvUsdcOutstandingAtomic: dvTotalSupply,
    },
    tvl: {
      currentTvlUsdc: formatUsdc(totalVaultAssets),
      currentTvlAtomic: totalVaultAssets,
      aaveAssetsUsdc: formatUsdc(allocation[0]),
      aaveAssetsAtomic: allocation[0],
      morphoAssetsUsdc: formatUsdc(allocation[1]),
      morphoAssetsAtomic: allocation[1],
      pricePerShare,
    },
    transactions: {
      totalDivigentTransactions: uniqueTxCount([...authorizedLogs, ...depositLogs, ...withdrawLogs]),
      authorizationTransactions: uniqueTxCount(authorizedLogs),
      depositTransactions: uniqueTxCount(depositLogs),
      withdrawTransactions: uniqueTxCount(withdrawLogs),
      recallProxyTransactions: uniqueTxCount(withdrawLogs),
      x402SettledViaDivigent: null,
      x402SettledViaDivigentNote:
        'On-chain router events identify Divigent withdrawals/recalls, but do not prove whether the recalled USDC was later used for x402 settlement. Treat recallProxyTransactions as the on-chain proxy until SDK/backend telemetry records x402 settlement correlation.',
    },
  };
}

function walletSet<TArgs extends { wallet: EvmAddress }>(
  logs: readonly ProtocolEventLog<TArgs>[],
): Set<string> {
  return new Set(logs.map((log) => evmAddress(log.args.wallet).toLowerCase()));
}

function uniqueTxCount(logs: readonly ProtocolEventLog<Record<string, unknown>>[]): number {
  const seen = new Set<string>();
  logs.forEach((log, index) => {
    const hash = log.transactionHash;
    seen.add(hash === undefined || hash === null
      ? `missing:${index}:${log.logIndex ?? -1}`
      : hash.toLowerCase());
  });
  return seen.size;
}

async function firstBlockAtOrAfter(
  client: PublicClient,
  timestamp: bigint,
  latestBlock: bigint,
): Promise<bigint> {
  let lo = 0n;
  let hi = latestBlock;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const block = await client.getBlock({ blockNumber: mid });
    if (block.timestamp < timestamp) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

async function getLogsChunked<TArgs extends Record<string, unknown>>(
  client: MetricsLogsClient,
  router: EvmAddress,
  event: typeof WALLET_AUTHORISED_EVENT | typeof DEPOSITED_EVENT | typeof WITHDRAWN_EVENT,
  fromBlock: bigint,
  toBlock: bigint,
  chunkSize = METRICS_LOG_CHUNK_SIZE,
): Promise<Array<ProtocolEventLog<TArgs>>> {
  const logs: Array<ProtocolEventLog<TArgs>> = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize + 1n) {
    const end = start + chunkSize > toBlock ? toBlock : start + chunkSize;
    logs.push(...await getLogRange<TArgs>(client, router, event, start, end, chunkSize));
  }
  return logs;
}

async function getLogRange<TArgs extends Record<string, unknown>>(
  client: MetricsLogsClient,
  router: EvmAddress,
  event: typeof WALLET_AUTHORISED_EVENT | typeof DEPOSITED_EVENT | typeof WITHDRAWN_EVENT,
  fromBlock: bigint,
  toBlock: bigint,
  chunkSize: bigint,
): Promise<Array<ProtocolEventLog<TArgs>>> {
  try {
    const logs = await client.getLogs({ address: router, event, fromBlock, toBlock });
    return logs as Array<ProtocolEventLog<TArgs>>;
  } catch (err) {
    if (chunkSize <= MIN_LOG_CHUNK_SIZE || fromBlock >= toBlock) throw err;
    const mid = (fromBlock + toBlock) / 2n;
    return [
      ...await getLogRange<TArgs>(client, router, event, fromBlock, mid, chunkSize / 2n),
      ...await getLogRange<TArgs>(client, router, event, mid + 1n, toBlock, chunkSize / 2n),
    ];
  }
}

async function countActivePositions(
  client: PublicClient,
  router: EvmAddress,
  wallets: readonly EvmAddress[],
): Promise<number> {
  let active = 0;
  for (let index = 0; index < wallets.length; index += POSITION_READ_BATCH_SIZE) {
    const batch = wallets.slice(index, index + POSITION_READ_BATCH_SIZE);
    const positions = await Promise.all(batch.map((wallet) =>
      client.readContract({
        address: router,
        abi: routerAbi,
        functionName: 'getPosition',
        args: [wallet],
      })));
    active += positions.filter(([, currentValue]) => currentValue > 0n).length;
  }
  return active;
}
