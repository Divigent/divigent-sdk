import type { DivigentError } from '../errors';
import type { EvmAddress, Prettify, TxHash } from '../types';
import type { x402HTTPClient } from '@x402/core/client';

/** @notice Observer payload for Divigent's pre-payment x402 recall hook. */
export type PaymentContext = {
  /**
   * @notice Wallet identifier in the observer payload.
   *
   * When `redact: false` (default), this is the full `EvmAddress`. When
   * `redact: true` is set on the wrap config, telemetry-pipe consumers
   * receive a truncated display string like `"0x90F79b…b906"` instead.
   */
  wallet: EvmAddress | string;
  paymentAmount: bigint;
  walletBalance: bigint;
  reserveFloor: bigint;
  deficit: bigint;
  recallShares?: bigint;
  recallTxHash?: TxHash;
  /**
   * @notice Set when an attempted recall withdraw failed. If the wallet still
   * has enough liquid USDC for the payment, the SDK lets x402 proceed and
   * reports the degraded reserve here. If not, the hook aborts before signing.
   */
  recallError?: unknown;
};

/**
 * @notice Observer payload for the moment x402 finishes signing a payment payload.
 *
 * This fires before the server pulls USDC. Use it for telemetry only, not
 * redeposit decisions.
 */
export type PaymentCreatedContext = Prettify<PaymentContext>;

/** @notice Observer payload for x402 payment-payload creation failures. */
export type FailureContext = Prettify<{
  /** @notice Wallet identifier, full or redacted depending on config. */
  wallet: EvmAddress | string;
  paymentAmount: bigint;
  /** @notice The error thrown by x402's scheme signing / submission step. */
  error: unknown;
  /** @notice True when Divigent recalled USDC before the failure. */
  recalledUsdc: boolean;
  /** @notice Hash of the redeposit tx our failure hook broadcast, if any. */
  redepositTxHash?: TxHash;
  /** @notice Amount that the failure hook moved back into the vault. */
  redepositAmount?: bigint;
}>;

/** @notice Observer payload for successful post-settlement idle USDC deposits. */
export type IdleDepositContext = Prettify<{
  /** @notice Wallet address whose idle USDC was deposited. */
  wallet: EvmAddress | string;
  /** @notice Wallet USDC balance before the idle deposit. */
  walletBalance: bigint;
  /** @notice Reserve floor intentionally left liquid in the wallet. */
  reserveFloor: bigint;
  /** @notice Extra USDC kept liquid while the x402 settlement debit propagates. */
  settlementReserve?: bigint;
  /** @notice USDC amount deposited into Divigent. */
  idleAmount: bigint;
  /** @notice Hash of the Divigent deposit transaction. */
  txHash: TxHash;
  /** @notice Settlement transaction or caller-provided dedupe key, when present. */
  dedupeKey?: string;
}>;

/** @notice Non-fatal integration error surfaced by Divigent hooks/wrappers. */
export type IntegrationErrorContext = Prettify<{
  /** @notice Lifecycle phase where the error was caught. */
  phase:
    | 'observer'
    | 'x402-before-hook'
    | 'x402-failure-hook'
    | 'settlement'
    | 'deposit-idle';
  /** @notice Typed SDK error converted from the original thrown value. */
  error: DivigentError;
  /** @notice Optional callback/helper label for diagnostics. */
  label?: string;
  /** @notice True when the SDK swallowed the error and continued the flow. */
  recoverable: boolean;
}>;

/** @notice Resource matcher used by x402 allowlists and per-resource caps. */
export type X402ResourcePattern = string | RegExp;

/** @notice Per-resource payment cap definition for x402 integrations. */
export type X402ResourceCap =
  | Prettify<{ resource: X402ResourcePattern; maxPaymentAmount: bigint }>
  | readonly [resource: X402ResourcePattern, maxPaymentAmount: bigint];

/** @notice Normalized policy context passed to `shouldHandlePayment`. */
export type X402PolicyContext = Prettify<{
  wallet: EvmAddress;
  paymentAmount: bigint;
  payTo?: string;
  resource?: string;
  origin?: string;
  network?: string;
  scheme?: string;
  asset?: string;
  raw: unknown;
}>;

/** @notice Configuration for attaching Divigent liquidity hooks to an x402 client. */
export type X402WrapConfig = {
  /** @notice Minimum USDC to keep liquid in the wallet before/after payments. */
  minIdleThreshold?: bigint;
  /** @notice EMA reserve ratio used to size the liquid payment buffer. */
  reserveRatio?: number;
  /** @notice Multiplier applied to the EMA-based reserve estimate. */
  reserveMultiplier?: number;
  /** @notice Slippage guard for vault withdrawals used by the x402 recall path. */
  slippageBps?: number;
  /** @notice Hard cap on per-payment amount the hook will act on. */
  maxPaymentAmount?: bigint;
  /** @notice Optional cumulative cap for this attached client session. */
  maxSessionPaymentAmount?: bigint;
  /** @notice Require `allowedPayTo` to be configured before handling payments. */
  requireAllowedPayTo?: boolean;
  /** @notice Optional payee allowlist for Divigent's recall hook. */
  allowedPayTo?: readonly string[];
  /** @notice Optional URL origin allowlist, e.g. ["https://api.example.com"]. */
  allowedOrigins?: readonly string[];
  /** @deprecated Use `allowedOrigins`. Kept for backwards compatibility. */
  allowedOrigin?: readonly string[] | string;
  /** @notice Optional resource allowlist. String patterns support "*" wildcards. */
  allowedResources?: readonly X402ResourcePattern[];
  /** @deprecated Use `allowedResources`. Kept for backwards compatibility. */
  allowedResource?: readonly X402ResourcePattern[] | X402ResourcePattern;
  /** @notice Optional per-resource payment caps. */
  maxPaymentAmountByResource?: Record<string, bigint> | readonly X402ResourceCap[];
  /** @notice Last-mile predicate for advanced agent policy. */
  shouldHandlePayment?: (ctx: X402PolicyContext) => boolean | Promise<boolean>;
  /** @notice Redact wallet addresses and tx hashes in observer callbacks. */
  redact?: boolean;
  /** @notice Receives non-fatal integration errors that must not break payment flow. */
  onNonFatalError?: (ctx: IntegrationErrorContext) => void | Promise<void>;
  /** @notice Fires after the pre-payment recall hook finishes. */
  onBeforePayment?: (ctx: PaymentContext) => void | Promise<void>;
  /** @notice Fires after x402 signs the payment payload, before settlement. */
  onAfterPaymentCreation?: (ctx: PaymentCreatedContext) => void | Promise<void>;
  /** @notice Fires when x402 payment-payload creation fails. */
  onPaymentFailure?: (ctx: FailureContext) => void | Promise<void>;
};

/** @notice Options for post-settlement automatic idle deposits. */
export type X402AutoDepositOptions = {
  /** @notice Maximum number of settled transaction keys remembered for dedupe. */
  dedupeCapacity?: number;
  /** @notice Existing dedupe set for shared integrations. */
  seenTxHashes?: Set<string>;
  /**
   * @notice Skip deposits below this amount. Public wrappers default to the
   * router's on-chain `MIN_DEPOSIT` to avoid dust deposit reverts.
   */
  minDeposit?: bigint | (() => bigint | Promise<bigint>);
  /** @notice Wait for the idle deposit before returning the paid response. */
  waitForIdleDeposit?: boolean;
  /** @notice Fires after wallet USDC above the reserve floor is deposited. */
  onIdleDeposit?: (ctx: IdleDepositContext) => void | Promise<void>;
  /** @notice Receives non-fatal idle-deposit observer errors. */
  onNonFatalError?: (ctx: IntegrationErrorContext) => void | Promise<void>;
};

/** @notice Options for depositing idle wallet USDC above a reserve floor. */
export type X402IdleDepositOptions = {
  /** @notice Wallet to sweep. Defaults to the bound wallet client account. */
  wallet?: EvmAddress;
  /** @notice Minimum USDC to keep liquid in the wallet. */
  minIdleThreshold?: bigint;
  /** @notice EMA reserve ratio used to size the liquid payment buffer. */
  reserveRatio?: number;
  /** @notice Multiplier applied to the EMA-based reserve estimate. */
  reserveMultiplier?: number;
  /** @notice Idempotency key for settlement/income sweeps. */
  dedupeKey?: string;
  /** @notice Existing dedupe set for shared integrations. */
  seenTxHashes?: Set<string>;
  /**
   * @notice Skip deposits below this amount. Defaults to the router's on-chain
   * `MIN_DEPOSIT` in public SDK helpers.
   */
  minDeposit?: bigint | (() => bigint | Promise<bigint>);
  /** @notice Fires after wallet USDC above the reserve floor is deposited. */
  onIdleDeposit?: (ctx: IdleDepositContext) => void | Promise<void>;
  /** @notice Receives non-fatal idle-deposit observer errors. */
  onNonFatalError?: (ctx: IntegrationErrorContext) => void | Promise<void>;
};

/** @notice Seller/resource-server options for depositing received x402 income. */
export type X402IncomeConfig = {
  /** @notice Wallet to sweep. Defaults to the bound wallet client account. */
  wallet?: EvmAddress;
  /** @notice Minimum USDC to keep liquid in the seller wallet. */
  minIdleThreshold?: bigint;
  /** @notice EMA reserve ratio used to size the liquid buffer. */
  reserveRatio?: number;
  /** @notice Multiplier applied to the EMA-based reserve estimate. */
  reserveMultiplier?: number;
  /** @notice Maximum number of settled transaction keys remembered for dedupe. */
  dedupeCapacity?: number;
  /**
   * @notice Skip deposits below this amount. Defaults to the router's on-chain
   * `MIN_DEPOSIT` in public SDK helpers.
   */
  minDeposit?: bigint | (() => bigint | Promise<bigint>);
  /** @notice Fires after received x402 income is deposited. */
  onIdleDeposit?: (ctx: IdleDepositContext) => void | Promise<void>;
  /** @notice Receives non-fatal income-deposit errors. */
  onNonFatalError?: (ctx: IntegrationErrorContext) => void | Promise<void>;
};

/** @notice Handle returned by `divigent.attachTo(x402Client, config)`. */
export type X402AttachHandle = {
  /** @notice Detach Divigent's x402 recall hooks from the client. */
  detach: () => void;
  /**
   * @notice Wrap a payment-enabled fetch so successful x402 settlements deposit
   * wallet USDC above the reserve floor back into Divigent.
   */
  wrapFetchWithYield: (
    fetchWithPayment: typeof fetch,
    http: x402HTTPClient,
    options?: X402AutoDepositOptions,
  ) => typeof fetch;
  /**
   * @notice Deposit current wallet USDC above the reserve floor into Divigent.
   *
   * @remarks Useful for callers that decode settlement responses themselves.
   */
  depositIdle: (options?: X402AutoDepositOptions) => Promise<TxHash | undefined>;
};

/** @notice Handle returned by `divigent.attachToResourceServer(resourceServer, config)`. */
export type X402IncomeAttachHandle = {
  /** @notice Disable future seller-side income deposit hooks. */
  detach: () => void;
  /** @notice Deposit current seller wallet USDC above the configured reserve floor. */
  depositIdle: (options?: X402IdleDepositOptions) => Promise<TxHash | undefined>;
};
