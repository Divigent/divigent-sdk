import type { Hex, PublicClient, WalletClient } from 'viem';
import { sendCalls, waitForCallsStatus } from 'viem/actions';
import type { ContractAddresses, DivigentChain } from './core/chains';
import { DivigentError } from './errors';
import { txHash, type EvmAddress, type TxHash, type WaitOptions } from './types';

/** @notice Raw contract call executed by a Divigent transaction executor. */
export type DivigentCall = {
  /** @notice Target contract address. */
  to: EvmAddress;
  /** @notice ABI-encoded calldata. */
  data: Hex;
  /** @notice Native value sent with the call. Defaults to 0. */
  value?: bigint;
};

/** @notice Metadata available to custom executors when broadcasting calls. */
export type DivigentExecutionContext = {
  /** @notice Divigent public client. */
  publicClient: PublicClient;
  /** @notice Divigent deployment chain. */
  chain: DivigentChain;
  /** @notice Numeric EVM chain id. */
  chainId: number;
  /** @notice Configured Divigent contract addresses. */
  addresses: ContractAddresses;
  /** @notice Original SDK plans that produced the calls. */
  plans: readonly unknown[];
  /** @notice Optional wait settings supplied to `sendPlans`. */
  waitOptions?: WaitOptions;
};

/** @notice Handle returned by a custom Divigent executor. */
export type DivigentExecutionHandle = {
  /** @notice Mined transaction hash when available immediately. */
  txHash?: TxHash;
  /** @notice ERC-4337 UserOperation hash when the executor submits a user op. */
  userOpHash?: Hex;
  /** @notice EIP-5792 wallet call bundle id when the executor submits a call bundle. */
  callBundleId?: string;
  /** @notice Optional executor-specific raw response for observability. */
  raw?: unknown;
};

/** @notice Finalized execution result with a mined transaction hash. */
export type DivigentExecutionReceipt = {
  /** @notice Transaction hash containing the Divigent call logs. */
  txHash: TxHash;
  /** @notice Optional executor-specific receipt/status payload. */
  raw?: unknown;
};

/** @notice Pluggable execution surface for smart accounts and batched wallets. */
export type DivigentCallExecutor = {
  /** @notice On-chain account that sends calls and owns USDC/dvUSDC. */
  account: EvmAddress;
  /** @notice Executor flavor for telemetry and debugging. */
  kind?: 'eoa' | 'eip5792' | 'eip7702' | 'erc4337' | 'safe' | 'custom' | (string & {});
  /** @notice Optional chain id guard. */
  chainId?: number;
  /** @notice Broadcast one or more calls. */
  executeCalls(
    calls: readonly DivigentCall[],
    context: DivigentExecutionContext,
  ): Promise<DivigentExecutionHandle>;
  /**
   * @notice Resolve executor-specific handles to a mined transaction hash.
   * @remarks ERC-4337 and EIP-5792 executors usually need this to map a user op
   * or call-bundle id to the transaction receipt that contains protocol events.
   */
  waitForResult?(
    handle: DivigentExecutionHandle,
    context: DivigentExecutionContext,
  ): Promise<DivigentExecutionReceipt>;
};

/** @notice Result returned by `divigent.sendPlans(...)`. */
export type DivigentSendPlansResult = {
  /** @notice Sequential EOA writes or one batched executor operation. */
  mode: 'sequential' | 'batched';
  /** @notice Transaction hashes produced by execution. Batched modes normally contain one hash. */
  txHashes: readonly TxHash[];
  /** @notice Executor-specific handle when a custom executor was used. */
  handle?: DivigentExecutionHandle;
};

/** @notice Config for the built-in EIP-5792 call-bundle executor. */
export type Eip5792ExecutorConfig = {
  /** @notice viem wallet client that supports wallet_sendCalls, or viem's fallback. */
  walletClient: WalletClient;
  /** @notice Account that owns USDC and executes the call bundle. Defaults to walletClient.account. */
  account?: EvmAddress;
  /** @notice Optional chain id guard. Defaults to walletClient.chain.id when available. */
  chainId?: number;
  /** @notice Allow viem to fall back to sequential eth_sendTransaction when wallet_sendCalls is unsupported. */
  experimentalFallback?: boolean;
  /** @notice Polling interval for waitForCallsStatus. */
  pollingInterval?: number;
  /** @notice Timeout for waitForCallsStatus. */
  timeout?: number;
};

/**
 * @notice Create a viem-native EIP-5792 executor for wallets that support call bundles.
 * @remarks This covers smart-wallet batching surfaces and EIP-7702-compatible
 * wallets exposed through `wallet_sendCalls`. It adds no dependency beyond viem.
 */
export function createEip5792Executor(config: Eip5792ExecutorConfig): DivigentCallExecutor {
  const account = config.account ?? (config.walletClient.account?.address as EvmAddress | undefined);
  if (!account) {
    throw new DivigentError(
      '[@divigent/sdk] createEip5792Executor requires an account or walletClient.account',
      {
        code: 'DIVIGENT_EXECUTOR_ACCOUNT_REQUIRED',
        category: 'wallet',
      },
    );
  }

  const executor: DivigentCallExecutor = {
    account,
    kind: 'eip5792',
    async executeCalls(calls, context) {
      const result = await sendCalls(config.walletClient as never, {
        account,
        chain: config.walletClient.chain,
        calls: calls.map((call) => ({
          to: call.to,
          data: call.data,
          ...(call.value !== undefined && { value: call.value }),
        })),
        ...(config.experimentalFallback !== undefined && {
          experimental_fallback: config.experimentalFallback,
        }),
      } as never);

      return {
        callBundleId: result.id,
        raw: result,
      };
    },
    async waitForResult(handle, context) {
      if (handle.txHash) return { txHash: handle.txHash, raw: handle.raw };
      if (!handle.callBundleId) {
        throw new DivigentError(
          '[@divigent/sdk] EIP-5792 executor did not return a call bundle id',
          {
            code: 'DIVIGENT_EXECUTOR_RESULT_UNRESOLVED',
            category: 'wallet',
            context: { handle },
          },
        );
      }

      const status = await waitForCallsStatus(config.walletClient as never, {
        id: handle.callBundleId,
        throwOnFailure: true,
        pollingInterval: config.pollingInterval ?? context.waitOptions?.pollingInterval,
        timeout: config.timeout ?? context.waitOptions?.timeout,
      });
      const receipt = status.receipts?.at(-1);
      if (!receipt?.transactionHash) {
        throw new DivigentError(
          '[@divigent/sdk] EIP-5792 call bundle completed without a transaction receipt',
          {
            code: 'DIVIGENT_EXECUTOR_RECEIPT_MISSING',
            category: 'wallet',
            retryable: true,
            context: { id: handle.callBundleId, status },
          },
        );
      }

      return {
        txHash: txHash(receipt.transactionHash),
        raw: status,
      };
    },
  };
  const chainId = config.chainId ?? config.walletClient.chain?.id;
  if (chainId !== undefined) executor.chainId = chainId;
  return executor;
}
