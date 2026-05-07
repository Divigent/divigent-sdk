import type { PublicClient, WalletClient } from 'viem';
import { getAddress, isAddress } from 'viem';
import {
  CHAINS,
  assertProtocolDeployed,
  type ContractAddresses,
  type DivigentChain,
  getAddresses,
  isZeroAddress,
} from './core/chains';
import {
  AddressMismatchError,
  ChainMismatchError,
  DivigentError,
  OperatorAckRequiredError,
  PermitUnsupportedFor7702AccountError,
  runRead,
  ZeroAddressError,
} from './errors';
import type {
  EvmAddress,
  DepositResult,
  OptimalVault,
  OracleStatus,
  PermitSig,
  Position,
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
import { applySlippageDown } from './core/utils';
import { attachDivigentYield } from './x402/attach';
import type { FeeOverrides } from './types';
import type { X402WrapConfig } from './x402/types';
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
  readRouterNonce,
  readRouterOracle,
  readRouterPosition,
  readRouterPreviewDeposit,
  readRouterPreviewRedeem,
  readRouterPreviewWithdrawNet,
  readRouterPricePerShare,
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
  /** @notice Supported deployment chain. Defaults to `base-sepolia` for the beta. */
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
  /** @notice Wallet credited with dvUSDC shares. Defaults to the connected wallet. */
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
  /** @notice If true, 7702 accounts fall back to `approveUsdc + deposit`. Defaults to true. */
  fallbackOn7702?: boolean;
};

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

// Stablecoin vault PPS drift is normally tiny; 10 bps is a tight default for
// user-initiated exits. The x402 recall path uses a wider payment-safe margin.
const DEFAULT_SLIPPAGE_BPS = 10;

/** @notice Main viem-native facade for Divigent reads, writes, signing, and x402 hooks. */
export class Divigent {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient | undefined;
  readonly chain: DivigentChain;
  readonly addresses: ContractAddresses;

  /** Serializes permit signing per owner so concurrent permits cannot share a nonce. */
  private readonly permitQueues = new Map<string, Promise<unknown>>();

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
    const chain = config.chain ?? 'base-sepolia';
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
    // Keep the stored chain usable after a failed permit attempt.
    this.permitQueues.set(key, next.then(() => undefined, () => undefined));
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
   * @notice Read the current Aave/Morpho asset allocation.
   * @returns Current allocation by venue.
   */
  getCurrentAllocation(): Promise<VaultAllocation> {
    return readRouterCurrentAllocation(this.publicClient, this.addresses.router);
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

  /**
   * @notice Approve the Divigent router to spend an exact USDC amount.
   * @param amount USDC amount in atomic units.
   * @param fees Optional EIP-1559 fee overrides.
   * @returns Transaction hash.
   */
  approveUsdc(amount: bigint, fees?: FeeOverrides): Promise<TxHash> {
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
   * @notice Deposit USDC after allowance is already in place.
   * @remarks If `minSharesOut` is omitted, the SDK derives it from
   * `previewDeposit` and `slippageBps` to protect callers from adverse
   * vault-state shifts between preview and execute.
   * @param params Deposit amount, optional wallet/minimum shares/slippage, and optional fees.
   * @returns Transaction hash.
   */
  async deposit(params: DepositParams): Promise<TxHash> {
    const wallet = params.wallet ?? this.defaultWallet();
    const minSharesOut = await this.resolveMinSharesOut(params);
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
   * collisions. 7702 accounts can fall back to `approveUsdc + deposit`.
   * @param params Deposit amount, optional wallet/deadline, 7702 fallback flag, and optional fees.
   * @returns Transaction hash.
   */
  async depositWithPermit(params: DepositWithPermitParams): Promise<TxHash> {
    const wallet = params.wallet ?? this.defaultWallet();
    const fallback = params.fallbackOn7702 ?? true;
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
        if (fallback && err instanceof PermitUnsupportedFor7702AccountError) {
          const approveHash = await this.approveUsdc(params.amount, params.fees);
          await this.waitForReceipt(approveHash);
          return this.deposit({
            amount: params.amount,
            wallet,
            minSharesOut,
            ...(params.fees && { fees: params.fees }),
          });
        }
        throw err;
      }

      return depositWithPermitWrite({
        walletClient: this.requireWallet(),
        publicClient: this.publicClient,
        router: this.addresses.router,
        amount: params.amount,
        wallet,
        permit,
        minSharesOut,
        ...(params.fees && { fees: params.fees }),
      });
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
   * @returns Detach handle.
   */
  attachTo(client: x402Client, config: X402WrapConfig = {}): { detach: () => void } {
    return attachDivigentYield(client, this, config);
  }
}
