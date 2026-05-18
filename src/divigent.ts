import type { PublicClient, WalletClient, WriteContractParameters } from 'viem';
import { getAddress, isAddress } from 'viem';
import { routerAbi, usdcAbi } from './abis';
import {
  CHAINS,
  assertProtocolDeployed,
  chainFromId,
  type ContractAddresses,
  type DivigentChain,
  getAddresses,
  isZeroAddress,
} from './core/chains';
import {
  AddressMismatchError,
  ChainMismatchError,
  DivigentError,
  MinDepositNotMetError,
  OperatorAckRequiredError,
  PermitUnsupportedFor7702AccountError,
  PermitUnsupportedForTokenError,
  runRead,
  runWrite,
  ZeroAddressError,
} from './errors';
import { txHash } from './types';
import type {
  EvmAddress,
  DepositResult,
  OptimalVault,
  OracleStatus,
  PermitSig,
  Position,
  Prettify,
  TreasuryStatus,
  TxHash,
  VaultAllocation,
  VaultCapacity,
  VaultRate,
  VaultType,
  WaitOptions,
  WithdrawResult,
} from './types';
import type { x402Client } from '@x402/core/client';
import type { x402ResourceServer } from '@x402/core/server';
import { applySlippageDown } from './core/utils';
import {
  createX402AttachHandle,
  createX402IncomeAttachHandle,
  depositIdleWithReserveFloor,
} from './x402/handle';
import type { FeeOverrides } from './types';
import type {
  X402AttachHandle,
  X402IdleDepositOptions,
  X402IncomeAttachHandle,
  X402IncomeConfig,
  X402WrapConfig,
} from './x402/types';
import { parseDepositReceipt, parseWithdrawReceipt } from './core/receipts';
import {
  approveUsdc,
  readUsdcAllowance,
  readUsdcBalance,
  signUsdcPermit,
} from './contracts/usdc';
import {
  readDvUsdcBalance,
  readDvUsdcRouter,
  readDvUsdcTotalSupply,
} from './contracts/dvUsdc';
import {
  readFeeCollectorCalculateFee,
  readFeeCollectorTreasuryStatus,
  readFeeCollectorUsdc,
  readFeeCollectorVaultRouter,
} from './contracts/feeCollector';
import {
  readOracleAllRates,
  readOracleIsFresh,
  readOracleIsVaultSafe,
  readOracleLastGoodObservationAge,
  readOracleOptimalVault,
  readOracleStatus,
  recordObservation,
} from './contracts/yieldOracle';
import {
  cancelTreasuryRotation,
  deposit as depositWrite,
  depositWithPermit as depositWithPermitWrite,
  executeTreasuryRotation,
  initialize as initializeWrite,
  initializeFor as initializeForWrite,
  pauseDeposits,
  proposeTreasuryRotation,
  readRouterConvertToAssets,
  readRouterConvertToShares,
  readRouterCostBasis,
  readRouterCurrentAllocation,
  readRouterCurrentTVLCap,
  readRouterDepositsPaused,
  readRouterDvUsdc,
  readRouterFeeCollector,
  readRouterIsAuthorized,
  readRouterIsOperator,
  readRouterMinDeposit,
  readRouterNonce,
  readRouterOracle,
  readRouterPosition,
  readRouterPreviewDeposit,
  readRouterPreviewRedeem,
  readRouterPreviewWithdrawNet,
  readRouterPricePerShare,
  readRouterRecommendedRoute,
  readRouterTotalVaultAssets,
  readRouterUsdc,
  readRouterWithdrawCapacity,
  setOperator as setOperatorWrite,
  signInitializeFor,
  unpauseDeposits,
  withdraw as withdrawWrite,
} from './contracts/divigentVaultRouter';

// Construction-time address validation.
const ADDRESS_FIELDS: ReadonlyArray<keyof ContractAddresses> = [
  'router',
  'oracle',
  'feeCollector',
  'dvUsdc',
  'usdc',
  'aavePool',
  'aToken',
  'steakhouseUSDCPrimeVault',
];

function validateOverrideAddresses(input: ContractAddresses): ContractAddresses {
  const out = {} as Record<keyof ContractAddresses, EvmAddress>;
  for (const field of ADDRESS_FIELDS) {
    const raw = input[field] as string;
    if (typeof raw !== 'string' || !isAddress(raw)) {
      throw new DivigentError(
        `[@divigent/sdk] DivigentConfig.addresses.${field} is not a valid EVM address: ${JSON.stringify(raw)}`,
        {
          code: 'DIVIGENT_INVALID_ADDRESS',
          category: 'validation',
          context: { field: `DivigentConfig.addresses.${field}`, value: raw },
        },
      );
    }
    if (isZeroAddress(raw as EvmAddress)) {
      throw new ZeroAddressError({
        context: { field: `DivigentConfig.addresses.${field}` },
      });
    }
    out[field] = getAddress(raw) as EvmAddress;
  }
  return out;
}

/** @notice Configuration for creating a Divigent SDK facade. */
export type DivigentConfig = {
  /** @notice viem public client bound to the same chain as the Divigent deployment. */
  publicClient: PublicClient;
  /** @notice viem wallet client required for writes, signing, and x402 recall hooks. */
  walletClient?: WalletClient | undefined;
  /**
   * @notice Supported deployment chain.
   * @remarks If omitted, the SDK infers from bound viem client chains when possible,
   * then falls back to `base-sepolia` for backwards compatibility.
   */
  chain?: DivigentChain | undefined;
  /** @notice Optional custom deployment addresses for private/test deployments. */
  addresses?: ContractAddresses | undefined;
};

/** @notice Parameters for granting or revoking operator authority. */
export type SetOperatorParams = {
  /** @notice Operator address. */
  operator: EvmAddress;
  /** @notice Whether to grant or revoke authority. */
  approved: boolean;
  /** @notice Required acknowledgement when granting authority. */
  acknowledgeFullAuthority?: true;
};

/** @notice Parameters for an allowance-based USDC deposit. */
export type DepositParams = {
  /** @notice Deposit amount in USDC atomic units. */
  amount: bigint;
  /**
   * @notice Wallet that supplies USDC and receives dvUSDC shares.
   * Defaults to the connected wallet.
   */
  wallet?: EvmAddress;
  /** @notice Minimum dvUSDC shares accepted. If omitted, the SDK derives it from preview and slippage. */
  minSharesOut?: bigint;
  /** @notice Slippage tolerance in basis points when `minSharesOut` is omitted. */
  slippageBps?: number;
  /** @notice Optional EIP-1559 fee overrides. */
  fees?: FeeOverrides;
};

/** @notice Parameters for a permit-based USDC deposit. */
export type DepositWithPermitParams = DepositParams & {
  /** @notice Permit deadline. Defaults to current chain time plus one hour. */
  deadline?: bigint;
  /** @notice If true, unsupported permit paths fall back to `approveUsdc + deposit`. Defaults to true. */
  fallbackOnPermitUnsupported?: boolean;
  /** @deprecated Use `fallbackOnPermitUnsupported`. Kept for backwards compatibility. */
  fallbackOn7702?: boolean;
};

/** @notice viem write request returned by Divigent transaction planning methods. */
export type DivigentWriteRequest = WriteContractParameters;

/** @notice Shared shape for transactions planned but not broadcast by the SDK. */
export type DivigentTransactionPlan<TKind extends string = string> = Prettify<{
  kind: TKind;
  request: DivigentWriteRequest;
}>;

/** @notice Planned USDC approval transaction. */
export type ApproveUsdcPlan = Prettify<DivigentTransactionPlan<'approveUsdc'> & {
  owner: EvmAddress;
  token: EvmAddress;
  spender: EvmAddress;
  /** @notice Caller-requested minimum deposit amount. */
  amount: bigint;
  /** @notice Actual USDC allowance written by the approval transaction. */
  approvalAmount: bigint;
  simulationResult: boolean;
}>;

/** @notice Planned Divigent deposit transaction and the values used to build it. */
export type DepositPlan = Prettify<DivigentTransactionPlan<'deposit'> & {
  owner: EvmAddress;
  wallet: EvmAddress;
  amount: bigint;
  previewShares: bigint;
  minSharesOut: bigint;
  slippageBps: number;
  allowance: bigint;
  approvalRequired: bigint;
  simulated: boolean;
  simulatedSharesOut?: bigint;
}>;

/** @notice Planned Divigent withdrawal transaction and the values used to build it. */
export type WithdrawPlan = Prettify<DivigentTransactionPlan<'withdraw'> & {
  owner: EvmAddress;
  wallet: EvmAddress;
  shares: bigint;
  previewUsdcOut: bigint;
  minUsdcOut: bigint;
  slippageBps: number;
  simulatedUsdcOut: bigint;
}>;

/** @notice Parameters for burning dvUSDC shares and receiving USDC. */
export type WithdrawParams = {
  /** @notice dvUSDC shares to burn. */
  shares: bigint;
  /** @notice Wallet whose position is redeemed. Defaults to the connected wallet. */
  wallet?: EvmAddress;
  /** @notice Minimum USDC output. If omitted, the SDK derives it from preview and slippage. */
  minUsdcOut?: bigint;
  /** @notice Slippage tolerance in basis points when `minUsdcOut` is omitted. */
  slippageBps?: number;
  /** @notice Optional EIP-1559 fee overrides. */
  fees?: FeeOverrides;
};

/** @notice Parameters for creating a USDC permit signature. */
export type SignPermitParams = {
  /** @notice Permit amount in USDC atomic units. */
  amount: bigint;
  /** @notice Permit deadline. */
  deadline: bigint;
  /** @notice Token owner. Defaults to the connected wallet. */
  owner?: EvmAddress;
};

/** @notice Parameters for signing router initialization for another wallet. */
export type SignInitializeForParams = {
  /** @notice Wallet to initialize. */
  wallet: EvmAddress;
  /** @notice Signature deadline. */
  deadline: bigint;
};

/** @notice Parameters for initializing the connected Divigent wallet if needed. */
export type EnsureInitializedParams = WaitOptions & {
  /** @notice Wallet to check. Defaults to the bound wallet client account. */
  wallet?: EvmAddress;
};

// Stablecoin vault PPS drift is normally tiny; 10 bps is a tight default for
// user-initiated exits. The x402 recall path uses a wider payment-safe margin.
const DEFAULT_SLIPPAGE_BPS = 10;
const APPROVAL_VISIBILITY_TIMEOUT_MS = 60_000;
const APPROVAL_VISIBILITY_POLL_MS = 2_000;
const MAX_UINT256 = (1n << 256n) - 1n;

function withFeeOverrides(
  request: unknown,
  fees: FeeOverrides | undefined,
): DivigentWriteRequest {
  return (fees ? { ...(request as object), ...fees } : request) as DivigentWriteRequest;
}

function sameAddress(a: EvmAddress, b: EvmAddress): boolean {
  return getAddress(a) === getAddress(b);
}

function approvalAmountWithDustBuffer(amount: bigint): bigint {
  // Keep SDK-managed approvals deposit-safe even if an RPC or token implementation
  // treats an exact allowance edge inconsistently. One atomic USDC unit is the
  // smallest possible buffer and avoids the unlimited-approval footgun. Preserve
  // zero for explicit allowance revokes and max uint256 to avoid overflow.
  if (amount === 0n || amount === MAX_UINT256) return amount;
  return amount + 1n;
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = error;
  let depth = 0;
  while (cur && depth < 16 && !seen.has(cur)) {
    seen.add(cur);
    if (cur instanceof Error) {
      parts.push(cur.message);
      const shortMessage = (cur as { shortMessage?: unknown }).shortMessage;
      if (typeof shortMessage === 'string') parts.push(shortMessage);
    } else if (typeof cur === 'string') {
      parts.push(cur);
    }
    cur = (cur as { cause?: unknown }).cause;
    depth++;
  }
  return parts.join('\n').toLowerCase();
}

function shouldFallbackPermitWriteToApproval(error: unknown): boolean {
  if (error instanceof DivigentError) {
    const errorName = error.context?.errorName;
    if (errorName === 'InsufficientPermitAllowance') return true;
    const reason = error.context?.reason;
    if (
      typeof reason === 'string' &&
      reason.toLowerCase().includes('transfer amount exceeds allowance')
    ) {
      return true;
    }
  }

  const text = errorText(error);
  return (
    text.includes('transfer amount exceeds allowance') ||
    text.includes('erc20: insufficient allowance') ||
    text.includes('erc20insufficientallowance') ||
    text.includes('erc20 insufficient allowance') ||
    text.includes('insufficient allowance') ||
    text.includes('insufficientpermitallowance') ||
    text.includes('insufficient permit allowance')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveChain(config: DivigentConfig): DivigentChain {
  if (config.chain !== undefined) return config.chain;

  const publicChainId = config.publicClient.chain?.id;
  const walletChainId = config.walletClient?.chain?.id;
  const publicChain = publicChainId === undefined ? undefined : chainFromId(publicChainId);
  const walletChain = walletChainId === undefined ? undefined : chainFromId(walletChainId);

  if (publicChain !== undefined && walletChain !== undefined && publicChain !== walletChain) {
    throw new ChainMismatchError(CHAINS[publicChain].id, CHAINS[walletChain].id, 'walletClient');
  }

  return publicChain ?? walletChain ?? 'base-sepolia';
}

/** @notice Main viem-native facade for Divigent reads, writes, signing, and x402 hooks. */
export class Divigent {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient | undefined;
  readonly chain: DivigentChain;
  readonly addresses: ContractAddresses;

  /** Serializes permit signing per owner so concurrent permits cannot share a nonce. */
  private readonly permitQueues = new Map<string, Promise<unknown>>();
  private minDepositPromise: Promise<bigint> | undefined;

  private constructor(cfg: {
    publicClient: PublicClient;
    walletClient: WalletClient | undefined;
    chain: DivigentChain;
    addresses: ContractAddresses;
  }) {
    this.publicClient = cfg.publicClient;
    this.walletClient = cfg.walletClient;
    this.chain       = cfg.chain;
    this.addresses   = cfg.addresses;
  }

  /**
   * @notice Create a Divigent facade and validate client chain bindings.
   * @param config viem clients, chain selection, and optional deployment addresses.
   * @returns Divigent SDK facade.
   * @throws If viem clients are bound to the wrong chain.
   * @throws If the selected deployment is missing required contract addresses.
   */
  static create(config: DivigentConfig): Divigent {
    const chain = resolveChain(config);
    const expectedChainId = CHAINS[chain].id;

    if (config.walletClient?.chain && config.walletClient.chain.id !== expectedChainId) {
      throw new ChainMismatchError(expectedChainId, config.walletClient.chain.id, 'walletClient');
    }
    if (config.publicClient.chain && config.publicClient.chain.id !== expectedChainId) {
      throw new ChainMismatchError(expectedChainId, config.publicClient.chain.id, 'publicClient');
    }

    let addresses: ContractAddresses;
    if (config.addresses) {
      addresses = validateOverrideAddresses(config.addresses);
    } else {
      assertProtocolDeployed(chain);
      addresses = getAddresses(chain);
    }

    return new Divigent({
      publicClient: config.publicClient,
      walletClient: config.walletClient,
      chain,
      addresses,
    });
  }

  // Address verification

  /**
   * @notice Verify configured addresses against on-chain self-identifying reads.
   * @remarks Call this before writes when using custom address overrides.
   * @throws AddressMismatchError if any configured address disagrees with the deployed stack.
   */
  async verifyAddresses(): Promise<void> {
    const [
      routerUsdc,
      routerDvUsdc,
      routerFeeCollector,
      routerOracle,
      dvUsdcRouter,
      feeCollectorRouter,
      feeCollectorUsdc,
    ] = await Promise.all([
      readRouterUsdc(this.publicClient, this.addresses.router),
      readRouterDvUsdc(this.publicClient, this.addresses.router),
      readRouterFeeCollector(this.publicClient, this.addresses.router),
      readRouterOracle(this.publicClient, this.addresses.router),
      readDvUsdcRouter(this.publicClient, this.addresses.dvUsdc),
      readFeeCollectorVaultRouter(this.publicClient, this.addresses.feeCollector),
      readFeeCollectorUsdc(this.publicClient, this.addresses.feeCollector),
    ]);

    const ci = (a: EvmAddress, b: EvmAddress) => a.toLowerCase() === b.toLowerCase();

    if (!ci(routerUsdc, this.addresses.usdc)) {
      throw new AddressMismatchError('router.USDC()', this.addresses.usdc, routerUsdc);
    }
    if (!ci(routerDvUsdc, this.addresses.dvUsdc)) {
      throw new AddressMismatchError('router.DV_USDC()', this.addresses.dvUsdc, routerDvUsdc);
    }
    if (!ci(routerFeeCollector, this.addresses.feeCollector)) {
      throw new AddressMismatchError(
        'router.FEE_COLLECTOR()', this.addresses.feeCollector, routerFeeCollector,
      );
    }
    if (!ci(routerOracle, this.addresses.oracle)) {
      throw new AddressMismatchError('router.ORACLE()', this.addresses.oracle, routerOracle);
    }
    if (!ci(dvUsdcRouter, this.addresses.router)) {
      throw new AddressMismatchError('dvUSDC.VAULT_ROUTER()', this.addresses.router, dvUsdcRouter);
    }
    if (!ci(feeCollectorRouter, this.addresses.router)) {
      throw new AddressMismatchError(
        'feeCollector.VAULT_ROUTER()', this.addresses.router, feeCollectorRouter,
      );
    }
    if (!ci(feeCollectorUsdc, this.addresses.usdc)) {
      throw new AddressMismatchError(
        'feeCollector.USDC()', this.addresses.usdc, feeCollectorUsdc,
      );
    }
  }

  // Internal helpers

  private async queuePermit<T>(owner: EvmAddress, fn: () => Promise<T>): Promise<T> {
    const key = owner.toLowerCase();
    const prev = this.permitQueues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const cleanup = next.then(() => undefined, () => undefined);
    this.permitQueues.set(key, cleanup);
    void cleanup.then(() => {
      if (this.permitQueues.get(key) === cleanup) {
        this.permitQueues.delete(key);
      }
    });
    return next as Promise<T>;
  }

  private requireWallet(): WalletClient {
    if (!this.walletClient) {
      throw new DivigentError(
        '[@divigent/sdk] wallet operation requires walletClient — provide one in Divigent.create()',
        {
          code: 'DIVIGENT_WALLET_CLIENT_REQUIRED',
          category: 'wallet',
        },
      );
    }
    return this.walletClient;
  }

  private requireSigner(): {
    walletClient: WalletClient;
    account: NonNullable<WalletClient['account']>;
    chain: NonNullable<WalletClient['chain']>;
  } {
    const walletClient = this.requireWallet();
    if (!walletClient.account) {
      throw new DivigentError('[@divigent/sdk] walletClient has no account', {
        code: 'DIVIGENT_WALLET_ACCOUNT_REQUIRED',
        category: 'wallet',
      });
    }
    if (!walletClient.chain) {
      throw new DivigentError('[@divigent/sdk] walletClient has no chain', {
        code: 'DIVIGENT_WALLET_CHAIN_REQUIRED',
        category: 'wallet',
      });
    }
    return { walletClient, account: walletClient.account, chain: walletClient.chain };
  }

  private defaultWallet(): EvmAddress {
    const wc = this.requireWallet();
    if (!wc.account) {
      throw new DivigentError('[@divigent/sdk] walletClient has no account', {
        code: 'DIVIGENT_WALLET_ACCOUNT_REQUIRED',
        category: 'wallet',
      });
    }
    return wc.account.address as EvmAddress;
  }

  private async waitForReceipt(
    hash: TxHash,
    options: WaitOptions = {},
  ): ReturnType<PublicClient['waitForTransactionReceipt']> {
    const params: Parameters<PublicClient['waitForTransactionReceipt']>[0] = { hash };
    if (options.confirmations !== undefined) params.confirmations = options.confirmations;
    if (options.pollingInterval !== undefined) params.pollingInterval = options.pollingInterval;
    if (options.timeout !== undefined) params.timeout = options.timeout;
    return runRead(() => this.publicClient.waitForTransactionReceipt(params));
  }

  // Router reads

  /**
   * @notice Read a wallet's deposited principal, current value, and accrued yield.
   * @param wallet Wallet address to inspect.
   * @returns Position values in USDC atomic units.
   */
  getPosition(wallet: EvmAddress): Promise<Position> {
    return readRouterPosition(this.publicClient, this.addresses.router, wallet);
  }

  /**
   * @notice Read current withdraw liquidity across Divigent's yield venues.
   * @returns Withdraw capacity and venue reachability.
   */
  withdrawCapacity(): Promise<VaultCapacity> {
    return readRouterWithdrawCapacity(this.publicClient, this.addresses.router);
  }

  /**
   * @notice Read the current venue asset allocation.
   * @returns Current allocation by venue.
   */
  getCurrentAllocation(): Promise<VaultAllocation> {
    return readRouterCurrentAllocation(this.publicClient, this.addresses.router);
  }

  /**
   * @notice Read the router-selected deposit venue for an amount.
   * @param amount Deposit amount in USDC atomic units.
   * @returns Venue selected by current oracle rates and route capacity.
   */
  getRecommendedRoute(amount: bigint): Promise<VaultType> {
    return readRouterRecommendedRoute(this.publicClient, this.addresses.router, amount);
  }

  /**
   * @notice Read current dvUSDC price per share in USDC atomic units.
   * @returns Price per share.
   */
  pricePerShare(): Promise<bigint> {
    return readRouterPricePerShare(this.publicClient, this.addresses.router);
  }

  /**
   * @notice Read total USDC-equivalent assets managed by the router.
   * @returns Total assets in USDC atomic units.
   */
  totalVaultAssets(): Promise<bigint> {
    return readRouterTotalVaultAssets(this.publicClient, this.addresses.router);
  }

  /**
   * @notice Read the active TVL cap in USDC atomic units.
   * @returns TVL cap in USDC atomic units.
   */
  currentTVLCap(): Promise<bigint> {
    return readRouterCurrentTVLCap(this.publicClient, this.addresses.router);
  }

  /**
   * @notice Read the router's minimum accepted USDC deposit.
   * @returns Minimum deposit in USDC atomic units.
   */
  minDeposit(): Promise<bigint> {
    if (this.minDepositPromise === undefined) {
      const pending = readRouterMinDeposit(this.publicClient, this.addresses.router);
      this.minDepositPromise = pending;
      void pending.catch(() => {
        if (this.minDepositPromise === pending) {
          this.minDepositPromise = undefined;
        }
      });
    }
    return this.minDepositPromise;
  }

  /**
   * @notice Read a wallet's principal cost basis in USDC atomic units.
   * @param wallet Wallet address to inspect.
   * @returns Cost basis in USDC atomic units.
   */
  costBasis(wallet: EvmAddress): Promise<bigint> {
    return readRouterCostBasis(this.publicClient, this.addresses.router, wallet);
  }

  /**
   * @notice Preview dvUSDC shares minted for a deposit amount.
   * @param amount Deposit amount in USDC atomic units.
   * @returns Expected dvUSDC shares.
   */
  previewDeposit(amount: bigint): Promise<bigint> {
    return readRouterPreviewDeposit(this.publicClient, this.addresses.router, amount);
  }

  /**
   * @notice Preview gross USDC returned for burning dvUSDC shares.
   * @param shares dvUSDC shares to redeem.
   * @param wallet Wallet whose cost basis/yield split is used.
   * @returns Expected USDC returned before caller-side slippage guard.
   */
  previewRedeem(shares: bigint, wallet: EvmAddress): Promise<bigint> {
    return readRouterPreviewRedeem(this.publicClient, this.addresses.router, shares, wallet);
  }

  /**
   * @notice Preview shares needed to receive at least `desiredUsdc` net USDC.
   * @param desiredUsdc Target net USDC amount in atomic units.
   * @param wallet Wallet whose position will be redeemed.
   * @returns Estimated dvUSDC shares to burn.
   */
  previewWithdrawNet(desiredUsdc: bigint, wallet: EvmAddress): Promise<bigint> {
    return readRouterPreviewWithdrawNet(this.publicClient, this.addresses.router, desiredUsdc, wallet);
  }

  /**
   * @notice Convert USDC assets to dvUSDC shares using on-chain router math.
   * @param assets USDC amount in atomic units.
   * @returns Share amount.
   */
  convertToShares(assets: bigint): Promise<bigint> {
    return readRouterConvertToShares(this.publicClient, this.addresses.router, assets);
  }

  /**
   * @notice Convert dvUSDC shares to USDC assets using on-chain router math.
   * @param shares dvUSDC share amount.
   * @returns Asset amount in USDC atomic units.
   */
  convertToAssets(shares: bigint): Promise<bigint> {
    return readRouterConvertToAssets(this.publicClient, this.addresses.router, shares);
  }

  /**
   * @notice Check whether a wallet has initialized/authorized its Divigent account.
   * @param wallet Wallet address to check.
   * @returns True when the wallet is authorized.
   */
  isAuthorized(wallet: EvmAddress): Promise<boolean> {
    return readRouterIsAuthorized(this.publicClient, this.addresses.router, wallet);
  }

  /**
   * @notice Check whether `operator` may withdraw on behalf of `wallet`.
   * @param wallet Wallet owner address.
   * @param operator Operator address.
   * @returns True when operator authority is active.
   */
  isOperator(wallet: EvmAddress, operator: EvmAddress): Promise<boolean> {
    return readRouterIsOperator(this.publicClient, this.addresses.router, wallet, operator);
  }

  /**
   * @notice Read the router nonce used for wallet authorization signatures.
   * @param wallet Wallet address.
   * @returns Current router nonce.
   */
  nonce(wallet: EvmAddress): Promise<bigint> {
    return readRouterNonce(this.publicClient, this.addresses.router, wallet);
  }

  /**
   * @notice Check whether deposits are paused by protocol governance.
   * @returns True when deposits are paused.
   */
  depositsPaused(): Promise<boolean> {
    return readRouterDepositsPaused(this.publicClient, this.addresses.router);
  }

  // Oracle reads

  /**
   * @notice Read the oracle's currently preferred deposit venue.
   * @returns Optimal vault address, venue type, and TWAR rate.
   */
  getOptimalVault(): Promise<OptimalVault> {
    return readOracleOptimalVault(this.publicClient, this.addresses.oracle);
  }

  /**
   * @notice Read all oracle venue rates and safety flags.
   * @returns Rate data for every supported venue.
   */
  getAllRates(): Promise<VaultRate[]> {
    return readOracleAllRates(this.publicClient, this.addresses.oracle);
  }

  /**
   * @notice Check whether the oracle currently marks a venue safe.
   * @param vaultType Venue to check.
   * @returns True when the venue is currently safe.
   */
  isVaultSafe(vaultType: VaultType): Promise<boolean> {
    return readOracleIsVaultSafe(this.publicClient, this.addresses.oracle, vaultType);
  }

  /**
   * @notice Check whether oracle observations are fresh enough for routing.
   * @returns True when the oracle is fresh.
   */
  isFresh(): Promise<boolean> {
    return readOracleIsFresh(this.publicClient, this.addresses.oracle);
  }

  /**
   * @notice Read the age of the last good oracle observation in seconds.
   * @returns Age in seconds.
   */
  lastGoodObservationAge(): Promise<bigint> {
    return readOracleLastGoodObservationAge(this.publicClient, this.addresses.oracle);
  }

  /**
   * @notice Read oracle freshness and last observation timestamp.
   * @returns Oracle status.
   */
  oracleStatus(): Promise<OracleStatus> {
    return readOracleStatus(this.publicClient, this.addresses.oracle);
  }

  // Fee collector reads

  /**
   * @notice Read fee-collector treasury and pending rotation state.
   * @returns Treasury rotation status.
   */
  treasuryStatus(): Promise<TreasuryStatus> {
    return readFeeCollectorTreasuryStatus(this.publicClient, this.addresses.feeCollector);
  }

  /**
   * @notice Preview protocol fee for a yield amount.
   * @param yieldEarned Yield amount in USDC atomic units.
   * @returns Fee amount in USDC atomic units.
   */
  calculateFee(yieldEarned: bigint): Promise<bigint> {
    return readFeeCollectorCalculateFee(this.publicClient, this.addresses.feeCollector, yieldEarned);
  }

  // Token reads

  /**
   * @notice Read a wallet's dvUSDC share balance.
   * @param wallet Wallet address.
   * @returns Share balance.
   */
  dvUsdcBalance(wallet: EvmAddress): Promise<bigint> {
    return readDvUsdcBalance(this.publicClient, this.addresses.dvUsdc, wallet);
  }

  /**
   * @notice Read total dvUSDC share supply.
   * @returns Total share supply.
   */
  dvUsdcTotalSupply(): Promise<bigint> {
    return readDvUsdcTotalSupply(this.publicClient, this.addresses.dvUsdc);
  }

  /**
   * @notice Read USDC balance for an account.
   * @param account Account address.
   * @returns USDC balance in atomic units.
   */
  usdcBalance(account: EvmAddress): Promise<bigint> {
    return readUsdcBalance(this.publicClient, this.addresses.usdc, account);
  }

  /**
   * @notice Read USDC allowance from `owner` to the Divigent router.
   * @param owner Token owner address.
   * @returns Allowance in USDC atomic units.
   */
  usdcAllowance(owner: EvmAddress): Promise<bigint> {
    return readUsdcAllowance(this.publicClient, this.addresses.usdc, owner, this.addresses.router);
  }

  // Wallet registration writes

  /**
   * @notice Initialize the connected wallet with the router.
   * @returns Transaction hash.
   */
  initialize(): Promise<TxHash> {
    return initializeWrite({
      walletClient: this.requireWallet(),
      publicClient: this.publicClient,
      router: this.addresses.router,
    });
  }

  /**
   * @notice Initialize the connected wallet if it is not already authorized.
   * @param params Optional wallet check and receipt wait options.
   * @returns Initialization transaction hash, or `undefined` when already initialized.
   */
  async ensureInitializedAndWait(params: EnsureInitializedParams = {}): Promise<TxHash | undefined> {
    const wallet = params.wallet ?? this.defaultWallet();
    if (await this.isAuthorized(wallet)) return undefined;

    const signer = this.defaultWallet();
    if (wallet.toLowerCase() !== signer.toLowerCase()) {
      throw new DivigentError(
        '[@divigent/sdk] ensureInitializedAndWait can only initialize the connected signer wallet. ' +
          'Use initializeFor() when initializing a different wallet.',
        {
          code: 'DIVIGENT_WALLET_MISMATCH',
          category: 'wallet',
          context: { wallet, signer },
        },
      );
    }

    const hash = await this.initialize();
    const waitOptions: WaitOptions = {};
    if (params.confirmations !== undefined) waitOptions.confirmations = params.confirmations;
    if (params.pollingInterval !== undefined) waitOptions.pollingInterval = params.pollingInterval;
    if (params.timeout !== undefined) waitOptions.timeout = params.timeout;
    await this.waitForReceipt(hash, waitOptions);
    return hash;
  }

  /**
   * @notice Initialize another wallet using an off-chain `signInitializeFor` signature.
   * @param params Wallet, deadline, and signature.
   * @returns Transaction hash.
   */
  initializeFor(params: { wallet: EvmAddress; deadline: bigint; sig: `0x${string}` }): Promise<TxHash> {
    return initializeForWrite({
      walletClient: this.requireWallet(),
      publicClient: this.publicClient,
      router: this.addresses.router,
      wallet: params.wallet,
      deadline: params.deadline,
      sig: params.sig,
    });
  }

  /**
   * @notice Grant or revoke operator authority over the caller's dvUSDC position.
   *
   * @remarks Operators can trigger withdrawals for the wallet, so granting
   * authority requires `acknowledgeFullAuthority: true`. Withdrawal proceeds
   * still route to the wallet owner.
   * @param params Operator address, approval flag, and required acknowledgement.
   * @returns Transaction hash.
   * @throws OperatorAckRequiredError if approval is granted without acknowledgement.
   */
  async setOperator(params: SetOperatorParams): Promise<TxHash> {
    if (params.approved && params.acknowledgeFullAuthority !== true) {
      throw new OperatorAckRequiredError();
    }
    return setOperatorWrite({
      walletClient: this.requireWallet(),
      publicClient: this.publicClient,
      router: this.addresses.router,
      operator: params.operator,
      approved: params.approved,
    });
  }

  // Core deposit and withdraw writes

  private async assertMinDepositAmount(amount: bigint): Promise<void> {
    const minimum = await this.minDeposit();
    if (amount < minimum) {
      throw new MinDepositNotMetError(amount, minimum);
    }
  }

  private depositWithResolvedMinShares(
    params: DepositParams,
    wallet: EvmAddress,
    minSharesOut: bigint,
  ): Promise<TxHash> {
    return depositWrite({
      walletClient: this.requireWallet(),
      publicClient: this.publicClient,
      router: this.addresses.router,
      amount: params.amount,
      wallet,
      minSharesOut,
      ...(params.fees && { fees: params.fees }),
    });
  }

  private async waitForUsdcApprovalVisible(
    owner: EvmAddress,
    amount: bigint,
  ): Promise<void> {
    const deadline = Date.now() + APPROVAL_VISIBILITY_TIMEOUT_MS;
    let allowance = await this.usdcAllowance(owner);

    while (allowance < amount && Date.now() < deadline) {
      await sleep(APPROVAL_VISIBILITY_POLL_MS);
      allowance = await this.usdcAllowance(owner);
    }

    if (allowance < amount) {
      throw new DivigentError(
        '[@divigent/sdk] USDC allowance for Divigent router was not visible before timeout',
        {
          code: 'DIVIGENT_ALLOWANCE_NOT_READY',
          category: 'chain',
          retryable: true,
          context: {
            owner,
            spender: this.addresses.router,
            allowance,
            amount,
          },
        },
      );
    }
  }

  private async depositViaApproval(
    params: DepositParams,
    wallet: EvmAddress,
    minSharesOut: bigint,
  ): Promise<TxHash> {
    const approvalOwner = this.requireSigner().account.address as EvmAddress;
    if (!sameAddress(approvalOwner, wallet)) {
      throw new DivigentError(
        '[@divigent/sdk] approval fallback requires the deposit wallet to match the signer. ' +
          'Call approveUsdc() + deposit() explicitly when funding a different wallet.',
        {
          code: 'DIVIGENT_PERMIT_FALLBACK_OWNER_MISMATCH',
          category: 'validation',
          context: { signer: approvalOwner, wallet },
        },
      );
    }

    const targetAllowance = approvalAmountWithDustBuffer(params.amount);
    const allowance = await this.usdcAllowance(approvalOwner);
    if (allowance < targetAllowance) {
      const approveHash = await this.approveUsdcAmount(targetAllowance, params.fees);
      await this.waitForReceipt(approveHash);
      await this.waitForUsdcApprovalVisible(approvalOwner, targetAllowance);
    }

    return this.depositWithResolvedMinShares(params, wallet, minSharesOut);
  }

  private approveUsdcAmount(amount: bigint, fees?: FeeOverrides): Promise<TxHash> {
    return approveUsdc({
      walletClient: this.requireWallet(),
      publicClient: this.publicClient,
      usdc: this.addresses.usdc,
      spender: this.addresses.router,
      amount,
      ...(fees && { fees }),
    });
  }

  /**
   * @notice Approve the Divigent router to spend USDC for a deposit.
   * @remarks The SDK approves one extra atomic USDC unit when possible so
   * approve-then-deposit integrations avoid exact-allowance edge cases.
   * @param amount Minimum USDC deposit amount in atomic units.
   * @param fees Optional EIP-1559 fee overrides.
   * @returns Transaction hash.
   */
  approveUsdc(amount: bigint, fees?: FeeOverrides): Promise<TxHash> {
    const approvalAmount = approvalAmountWithDustBuffer(amount);
    return this.approveUsdcAmount(approvalAmount, fees);
  }

  /**
   * @notice Build and simulate a deposit-safe USDC approval transaction without broadcasting it.
   * @remarks The planned approval uses the same one-atomic-unit buffer as
   * `approveUsdc`.
   * @param amount Minimum USDC deposit amount in atomic units.
   * @param fees Optional EIP-1559 fee overrides to include in the planned request.
   * @returns A viem-ready write request and approval metadata.
   */
  async planApproveUsdc(amount: bigint, fees?: FeeOverrides): Promise<ApproveUsdcPlan> {
    const { account, chain } = this.requireSigner();
    const approvalAmount = approvalAmountWithDustBuffer(amount);
    const { request, result } = await runWrite(() => this.publicClient.simulateContract({
      address: this.addresses.usdc,
      abi: usdcAbi,
      functionName: 'approve',
      args: [this.addresses.router, approvalAmount],
      account,
      chain,
    }), usdcAbi);

    return {
      kind: 'approveUsdc',
      owner: account.address as EvmAddress,
      token: this.addresses.usdc,
      spender: this.addresses.router,
      amount,
      approvalAmount,
      request: withFeeOverrides(request, fees),
      simulationResult: result,
    };
  }

  /**
   * @notice Build a Divigent deposit transaction without broadcasting it.
   *
   * @remarks The plan always returns a viem-ready deposit request. If current
   * allowance is insufficient, `simulated` is false because the deposit would
   * revert until an approval transaction is mined.
   * @param params Deposit amount, optional credited wallet, slippage, and fees.
   * @returns Deposit request, preview values, and approval requirement.
   */
  async planDeposit(params: DepositParams): Promise<DepositPlan> {
    const { account, chain } = this.requireSigner();
    const owner = account.address as EvmAddress;
    const wallet = params.wallet ?? owner;
    const previewShares = await this.previewDeposit(params.amount);
    const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    const minSharesOut = params.minSharesOut ?? applySlippageDown(previewShares, slippageBps);
    const allowance = await this.usdcAllowance(wallet);
    const approvalRequired = allowance >= params.amount ? 0n : params.amount - allowance;

    const baseRequest = {
      address: this.addresses.router,
      abi: routerAbi,
      functionName: 'deposit',
      args: [params.amount, wallet, minSharesOut],
      account,
      chain,
    } as const;

    let request = withFeeOverrides(baseRequest, params.fees);
    let simulatedSharesOut: bigint | undefined;
    let simulated = false;

    if (approvalRequired === 0n) {
      const simulatedDeposit = await runWrite(
        () => this.publicClient.simulateContract(baseRequest as never),
        routerAbi,
      );
      request = withFeeOverrides(simulatedDeposit.request, params.fees);
      simulatedSharesOut = simulatedDeposit.result as bigint;
      simulated = true;
    }

    return {
      kind: 'deposit',
      owner,
      wallet,
      amount: params.amount,
      previewShares,
      minSharesOut,
      slippageBps,
      allowance,
      approvalRequired,
      simulated,
      request,
      ...(simulatedSharesOut !== undefined && { simulatedSharesOut }),
    };
  }

  /**
   * @notice Deposit USDC after allowance is already in place.
   * @remarks If `minSharesOut` is omitted, the SDK derives it from
   * `previewDeposit` and `slippageBps` to protect callers from adverse
   * vault-state shifts between preview and execute.
   * @param params Deposit amount, optional wallet/minimum shares/slippage, and optional fees.
   * @returns Transaction hash.
   */
  async deposit(params: DepositParams): Promise<TxHash> {
    const wallet = params.wallet ?? this.defaultWallet();
    await this.assertMinDepositAmount(params.amount);
    const minSharesOut = await this.resolveMinSharesOut(params);
    return this.depositWithResolvedMinShares(params, wallet, minSharesOut);
  }

  private async resolveMinSharesOut(params: DepositParams): Promise<bigint> {
    if (params.minSharesOut !== undefined) return params.minSharesOut;
    const preview = await this.previewDeposit(params.amount);
    const bps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    return applySlippageDown(preview, bps);
  }

  /**
   * @notice Deposit USDC, wait for mining, and parse the minted share amount.
   * @param params Deposit amount, optional wallet override, wait options, and optional fees.
   * @returns Parsed deposit result.
   */
  async depositAndWait(params: DepositParams & WaitOptions): Promise<DepositResult> {
    const hash = await this.deposit(params);
    const receipt = await this.waitForReceipt(hash, params);
    return parseDepositReceipt(receipt);
  }

  /**
   * @notice Sign a USDC permit and deposit in one router transaction.
   * @remarks The SDK serializes permit calls per owner to avoid nonce
   * collisions. Unsupported permit paths can fall back to
   * `approveUsdc + deposit`.
   * @param params Deposit amount, optional wallet/deadline, 7702 fallback flag, and optional fees.
   * @returns Transaction hash.
   */
  async depositWithPermit(params: DepositWithPermitParams): Promise<TxHash> {
    const wallet = params.wallet ?? this.defaultWallet();
    const fallback = params.fallbackOnPermitUnsupported ?? params.fallbackOn7702 ?? true;
    await this.assertMinDepositAmount(params.amount);
    const minSharesOut = await this.resolveMinSharesOut(params);

    return this.queuePermit(wallet, async () => {
      let deadline: bigint;
      if (params.deadline !== undefined) {
        deadline = params.deadline;
      } else {
        // Use chain time so local clock drift cannot make the default stale.
        const { timestamp } = await runRead(() => this.publicClient.getBlock());
        deadline = timestamp + 3600n;
      }

      let permit;
      try {
        permit = await signUsdcPermit({
          walletClient: this.requireWallet(),
          publicClient: this.publicClient,
          usdc: this.addresses.usdc,
          spender: this.addresses.router,
          value: params.amount,
          deadline,
          owner: wallet,
        });
      } catch (err) {
        const permitUnsupported = (
          err instanceof PermitUnsupportedFor7702AccountError ||
          err instanceof PermitUnsupportedForTokenError
        );
        if (fallback && permitUnsupported) {
          return this.depositViaApproval(params, wallet, minSharesOut);
        }
        throw err;
      }

      try {
        return await depositWithPermitWrite({
          walletClient: this.requireWallet(),
          publicClient: this.publicClient,
          router: this.addresses.router,
          amount: params.amount,
          wallet,
          permit,
          minSharesOut,
          ...(params.fees && { fees: params.fees }),
        });
      } catch (err) {
        if (fallback && shouldFallbackPermitWriteToApproval(err)) {
          return this.depositViaApproval(params, wallet, minSharesOut);
        }
        throw err;
      }
    });
  }

  /**
   * @notice Permit-deposit USDC, wait for mining, and parse the minted share amount.
   * @param params Deposit amount, optional wallet/deadline, wait options, and optional fees.
   * @returns Parsed deposit result.
   */
  async depositWithPermitAndWait(params: DepositWithPermitParams & WaitOptions): Promise<DepositResult> {
    const hash = await this.depositWithPermit(params);
    const receipt = await this.waitForReceipt(hash, params);
    return parseDepositReceipt(receipt);
  }

  /**
   * @notice Withdraw USDC by burning dvUSDC shares.
   *
   * @remarks If `minUsdcOut` is omitted, the SDK derives it from
   * `previewRedeem` and `slippageBps` to protect both direct and
   * operator-driven withdrawals.
   * @param params Share amount, optional wallet/minimum output/slippage, and optional fees.
   * @returns Transaction hash.
   */
  async withdraw(params: WithdrawParams): Promise<TxHash> {
    const wallet = params.wallet ?? this.defaultWallet();
    let minUsdcOut = params.minUsdcOut;

    if (minUsdcOut === undefined) {
      const preview = await this.previewRedeem(params.shares, wallet);
      const bps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
      minUsdcOut = applySlippageDown(preview, bps);
    }

    return withdrawWrite({
      walletClient: this.requireWallet(),
      publicClient: this.publicClient,
      router: this.addresses.router,
      shares: params.shares,
      wallet,
      minUsdcOut,
      ...(params.fees && { fees: params.fees }),
    });
  }

  /**
   * @notice Build and simulate a Divigent withdrawal transaction without broadcasting it.
   * @param params Share amount, optional wallet/minimum output/slippage, and optional fees.
   * @returns A viem-ready withdraw request and preview/simulation metadata.
   */
  async planWithdraw(params: WithdrawParams): Promise<WithdrawPlan> {
    const { account, chain } = this.requireSigner();
    const owner = account.address as EvmAddress;
    const wallet = params.wallet ?? owner;
    const previewUsdcOut = await this.previewRedeem(params.shares, wallet);
    const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    const minUsdcOut = params.minUsdcOut ?? applySlippageDown(previewUsdcOut, slippageBps);

    const { request, result } = await runWrite(() => this.publicClient.simulateContract({
      address: this.addresses.router,
      abi: routerAbi,
      functionName: 'withdraw',
      args: [params.shares, wallet, minUsdcOut],
      account,
      chain,
    }), routerAbi);

    return {
      kind: 'withdraw',
      owner,
      wallet,
      shares: params.shares,
      previewUsdcOut,
      minUsdcOut,
      slippageBps,
      request: withFeeOverrides(request, params.fees),
      simulatedUsdcOut: result as bigint,
    };
  }

  /**
   * @notice Broadcast a previously planned Divigent transaction.
   * @param plan Plan returned by `planApproveUsdc`, `planDeposit`, or `planWithdraw`.
   * @returns Transaction hash.
   */
  async sendPlan(plan: DivigentTransactionPlan): Promise<TxHash> {
    const walletClient = this.requireWallet();
    const hash = await runWrite(() => walletClient.writeContract(plan.request as never));
    return txHash(hash);
  }

  /**
   * @notice Withdraw, wait for mining, and parse the USDC returned.
   * @param params Share amount, optional wallet/minimum output/slippage, wait options, and optional fees.
   * @returns Parsed withdraw result.
   */
  async withdrawAndWait(params: WithdrawParams & WaitOptions): Promise<WithdrawResult> {
    const hash = await this.withdraw(params);
    const receipt = await this.waitForReceipt(hash, params);
    return parseWithdrawReceipt(receipt);
  }

  // Governance writes

  /**
   * @notice Propose a fee-collector treasury rotation. Governance-only path.
   * @param newTreasury Proposed treasury address.
   * @returns Transaction hash.
   */
  proposeTreasuryRotation(newTreasury: EvmAddress): Promise<TxHash> {
    return proposeTreasuryRotation({
      walletClient: this.requireWallet(),
      publicClient: this.publicClient,
      router: this.addresses.router,
      newTreasury,
    });
  }

  /**
   * @notice Execute a ready fee-collector treasury rotation. Governance-only path.
   * @returns Transaction hash.
   */
  executeTreasuryRotation(): Promise<TxHash> {
    return executeTreasuryRotation({
      walletClient: this.requireWallet(),
      publicClient: this.publicClient,
      router: this.addresses.router,
    });
  }

  /**
   * @notice Cancel a pending treasury rotation. Governance-only path.
   * @returns Transaction hash.
   */
  cancelTreasuryRotation(): Promise<TxHash> {
    return cancelTreasuryRotation({
      walletClient: this.requireWallet(),
      publicClient: this.publicClient,
      router: this.addresses.router,
    });
  }

  /**
   * @notice Pause new deposits. Governance-only emergency path.
   * @returns Transaction hash.
   */
  pauseDeposits(): Promise<TxHash> {
    return pauseDeposits({
      walletClient: this.requireWallet(),
      publicClient: this.publicClient,
      router: this.addresses.router,
    });
  }

  /**
   * @notice Resume deposits after an emergency pause. Governance-only path.
   * @returns Transaction hash.
   */
  unpauseDeposits(): Promise<TxHash> {
    return unpauseDeposits({
      walletClient: this.requireWallet(),
      publicClient: this.publicClient,
      router: this.addresses.router,
    });
  }

  // Oracle writes

  /**
   * @notice Record a fresh yield oracle observation.
   * @returns Transaction hash.
   */
  recordObservation(): Promise<TxHash> {
    return recordObservation({
      walletClient: this.requireWallet(),
      publicClient: this.publicClient,
      oracle: this.addresses.oracle,
    });
  }

  // Signing helpers

  /**
   * @notice Create a USDC permit signature for a future Divigent deposit.
   * @param params Permit amount, deadline, and optional owner override.
   * @returns Permit signature parts.
   */
  signPermit(params: SignPermitParams): Promise<PermitSig> {
    return signUsdcPermit({
      walletClient: this.requireWallet(),
      publicClient: this.publicClient,
      usdc: this.addresses.usdc,
      spender: this.addresses.router,
      value: params.amount,
      deadline: params.deadline,
      owner: params.owner ?? this.defaultWallet(),
    });
  }

  /**
   * @notice Sign router wallet initialization for another wallet to submit on-chain.
   * @param params Wallet and deadline.
   * @returns EIP-712 signature.
   */
  signInitializeFor(params: SignInitializeForParams): Promise<`0x${string}`> {
    return signInitializeFor({
      walletClient: this.requireWallet(),
      publicClient: this.publicClient,
      router: this.addresses.router,
      wallet: params.wallet,
      deadline: params.deadline,
    });
  }

  // x402 integration

  /**
   * @notice Attach Divigent recall hooks to an existing x402 client.
   * @param client Existing x402 client instance.
   * @param config Divigent x402 policy and observer config.
   * @returns x402 attach handle.
   */
  attachTo(client: x402Client, config: X402WrapConfig = {}): X402AttachHandle {
    return createX402AttachHandle(client, this, config);
  }

  /**
   * @notice Attach Divigent income deposit hooks to an existing x402 resource server.
   * @param server Existing x402 resource server instance.
   * @param config Seller-side reserve and observer config.
   * @returns x402 income attach handle.
   */
  attachToResourceServer(
    server: x402ResourceServer,
    config: X402IncomeConfig = {},
  ): X402IncomeAttachHandle {
    return createX402IncomeAttachHandle(server, this, config);
  }

  /**
   * @notice Deposit wallet USDC above a reserve floor into Divigent.
   * @param options Wallet, reserve, threshold, and observer options.
   * @returns Deposit transaction hash, or `undefined` when no sweep occurs.
   */
  depositIdle(options: X402IdleDepositOptions = {}): Promise<TxHash | undefined> {
    return depositIdleWithReserveFloor(this, options);
  }
}
