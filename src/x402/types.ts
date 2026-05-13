import type { DivigentError } from '../errors';
import type { EvmAddress, Prettify, TxHash } from '../types';

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
   * @notice Set when an attempted recall withdraw failed. The SDK falls
   * through and lets x402 pay from whatever USDC is currently liquid.
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
  /** @notice Optional payee allowlist for Divigent's recall hook. */
  allowedPayTo?: readonly string[];
  /** @notice Optional URL origin allowlist, e.g. ["https://api.example.com"]. */
  allowedOrigins?: readonly string[];
  allowedOrigin?: readonly string[] | string;
  /** @notice Optional resource allowlist. String patterns support "*" wildcards. */
  allowedResources?: readonly X402ResourcePattern[];
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
