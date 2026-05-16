import type { Hex } from 'viem';
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  UserRejectedRequestError,
} from 'viem';
import {
  dvUsdcAbi,
  feeCollectorAbi,
  oracleAbi,
  routerAbi,
} from './abis';
import type { EvmAddress } from './types';

/**
 * @notice Coarse category for retry policy, logs, and agent control flow.
 */
export type DivigentErrorCategory =
  | 'wallet'
  | 'chain'
  | 'contract'
  | 'x402'
  | 'policy'
  | 'receipt'
  | 'config'
  | 'validation';

/**
 * @notice Options accepted by every Divigent error.
 * @param cause Original viem/native error.
 * @param code Stable machine-readable error code.
 * @param category Coarse routing category.
 * @param retryable Whether an agent may retry without changing inputs.
 * @param context Structured metadata for logs and agent decisions.
 */
export type DivigentErrorOptions = {
  cause?: unknown;
  code?: string;
  category?: DivigentErrorCategory;
  retryable?: boolean;
  context?: Record<string, unknown>;
};

type ErrorDefaults = {
  code: string;
  category: DivigentErrorCategory;
  retryable?: boolean;
  context?: Record<string, unknown>;
};

function withDefaults(
  defaults: ErrorDefaults,
  options?: DivigentErrorOptions,
): DivigentErrorOptions {
  const next: DivigentErrorOptions = {
    code: options?.code ?? defaults.code,
    category: options?.category ?? defaults.category,
    retryable: options?.retryable ?? defaults.retryable ?? false,
  };

  if (options?.cause !== undefined) {
    next.cause = options.cause;
  }

  const context = {
    ...(defaults.context ?? {}),
    ...(options?.context ?? {}),
  };
  if (Object.keys(context).length > 0) {
    next.context = context;
  }

  return next;
}

function formatUsdcForError(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  const whole = abs / 1_000_000n;
  const fraction = (abs % 1_000_000n).toString().padStart(6, '0');
  const trimmed = fraction.replace(/0+$/, '');
  return `${sign}${whole}${trimmed ? `.${trimmed}` : ''} USDC`;
}

/**
 * @notice Base class for every typed error thrown by the Divigent SDK.
 */
export class DivigentError extends Error {
  readonly code: string | undefined;
  readonly category: DivigentErrorCategory | undefined;
  readonly retryable: boolean;
  readonly context: Record<string, unknown> | undefined;

  constructor(message: string, options?: DivigentErrorOptions) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = 'DivigentError';
    this.code = options?.code;
    this.category = options?.category;
    this.retryable = options?.retryable ?? false;
    this.context = options?.context;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * @notice Options for converting arbitrary thrown values into DivigentError.
 * @param abi Optional ABI used to decode scoped contract custom errors.
 * @param message Optional fallback message for unknown errors.
 */
export type ToDivigentErrorOptions = DivigentErrorOptions & {
  abi?: readonly unknown[];
  message?: string;
};

/**
 * @notice Narrow an unknown thrown value to a Divigent SDK error.
 * @param error Thrown value.
 * @returns True when `error` is a DivigentError.
 */
export function isDivigentError(error: unknown): error is DivigentError {
  return error instanceof DivigentError;
}

/**
 * @notice viem client chain does not match the configured Divigent deployment.
 */
export class ChainMismatchError extends DivigentError {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
    public readonly source: string,
    options?: DivigentErrorOptions,
  ) {
    super(
      `Chain mismatch in ${source}: expected ${expected}, got ${actual}`,
      withDefaults(
        {
          code: 'DIVIGENT_CHAIN_MISMATCH',
          category: 'config',
          context: { expected, actual, source },
        },
        options,
      ),
    );
    this.name = 'ChainMismatchError';
  }
}

/**
 * @notice On-chain self-identification does not match configured addresses.
 */
export class AddressMismatchError extends DivigentError {
  constructor(
    public readonly field: string,
    public readonly expected: EvmAddress,
    public readonly actual: EvmAddress,
    options?: DivigentErrorOptions,
  ) {
    super(
      `Address mismatch on ${field}: expected ${expected}, on-chain returned ${actual}. ` +
        'If you passed a custom `addresses` override, it does not belong to the Divigent stack.',
      withDefaults(
        {
          code: 'DIVIGENT_ADDRESS_MISMATCH',
          category: 'config',
          context: { field, expected, actual },
        },
        options,
      ),
    );
    this.name = 'AddressMismatchError';
  }
}

/**
 * @notice Required address input was the zero address.
 */
export class ZeroAddressError extends DivigentError {
  constructor(options?: DivigentErrorOptions) {
    super(
      'Address must be non-zero',
      withDefaults(
        {
          code: 'DIVIGENT_ZERO_ADDRESS',
          category: 'config',
        },
        options,
      ),
    );
    this.name = 'ZeroAddressError';
  }
}

/**
 * @notice x402 payment amount exceeded the configured Divigent policy cap.
 */
export class PaymentCapExceededError extends DivigentError {
  constructor(
    public readonly requested: bigint,
    public readonly cap: bigint,
    options?: DivigentErrorOptions,
  ) {
    super(
      `x402 payment amount ${requested} exceeds configured maxPaymentAmount=${cap}. ` +
        'Raise `maxPaymentAmount` or the matching resource cap if this is legitimate.',
      withDefaults(
        {
          code: 'DIVIGENT_PAYMENT_CAP_EXCEEDED',
          category: 'policy',
          context: { requested, cap },
        },
        options,
      ),
    );
    this.name = 'PaymentCapExceededError';
  }
}

/**
 * @notice Deposit amount is below the router's on-chain minimum.
 */
export class MinDepositNotMetError extends DivigentError {
  constructor(
    public readonly amount: bigint,
    public readonly minDeposit: bigint,
    options?: DivigentErrorOptions,
  ) {
    super(
      `Deposit amount ${formatUsdcForError(amount)} is below router MIN_DEPOSIT=${formatUsdcForError(minDeposit)}`,
      withDefaults(
        {
          code: 'DIVIGENT_MIN_DEPOSIT_NOT_MET',
          category: 'validation',
          context: { amount, minDeposit },
        },
        options,
      ),
    );
    this.name = 'MinDepositNotMetError';
  }
}

/**
 * @notice Divigent hooks were attached twice to one x402 client.
 */
export class AlreadyAttachedError extends DivigentError {
  constructor(options?: DivigentErrorOptions) {
    super(
      'Divigent is already attached to this x402 client. Call the detach() handle before re-attaching.',
      withDefaults(
        {
          code: 'DIVIGENT_ALREADY_ATTACHED',
          category: 'config',
        },
        options,
      ),
    );
    this.name = 'AlreadyAttachedError';
  }
}

/**
 * @notice EIP-2612 permit is unsafe for an EIP-7702/smart-account owner.
 */
export class PermitUnsupportedFor7702AccountError extends DivigentError {
  constructor(
    public readonly owner: EvmAddress,
    options?: DivigentErrorOptions,
  ) {
    super(
      `Account ${owner} has contract code (EIP-7702 delegation or smart account). ` +
        "USDC's SignatureChecker routes signers with code to ERC-1271, not ecrecover. " +
        'Use approveUsdc() + deposit() instead.',
      withDefaults(
        {
          code: 'DIVIGENT_PERMIT_UNSUPPORTED_7702',
          category: 'wallet',
          context: { owner },
        },
        options,
      ),
    );
    this.name = 'PermitUnsupportedFor7702AccountError';
  }
}

/**
 * @notice Token does not expose the permit fields required by the USDC EIP-2612 path.
 */
export class PermitUnsupportedForTokenError extends DivigentError {
  constructor(
    public readonly token: EvmAddress,
    public readonly field: 'name' | 'version' | 'nonces',
    options?: DivigentErrorOptions,
  ) {
    super(
      `Token ${token} does not expose a compatible EIP-2612 permit field: ${field}. ` +
        'Use approveUsdc() + deposit() instead.',
      withDefaults(
        {
          code: 'DIVIGENT_PERMIT_UNSUPPORTED_TOKEN',
          category: 'contract',
          context: { token, field },
        },
        options,
      ),
    );
    this.name = 'PermitUnsupportedForTokenError';
  }
}

/**
 * @notice Caller must explicitly acknowledge operator withdrawal authority.
 */
export class OperatorAckRequiredError extends DivigentError {
  constructor(options?: DivigentErrorOptions) {
    super(
      'setOperator grants full withdraw authority over your dvUSDC position. ' +
        'Operators can force bad-price exits with minUsdcOut=0. ' +
        'Pass `acknowledgeFullAuthority: true` to confirm you trust this operator.',
      withDefaults(
        {
          code: 'DIVIGENT_OPERATOR_ACK_REQUIRED',
          category: 'policy',
        },
        options,
      ),
    );
    this.name = 'OperatorAckRequiredError';
  }
}

/**
 * @notice Expected router event was missing from a mined receipt.
 */
export class ReceiptParseError extends DivigentError {
  constructor(
    public readonly eventName: string,
    options?: DivigentErrorOptions,
  ) {
    super(
      `Transaction receipt does not contain a Divigent ${eventName} event`,
      withDefaults(
        {
          code: 'DIVIGENT_RECEIPT_EVENT_MISSING',
          category: 'receipt',
          context: { eventName },
        },
        options,
      ),
    );
    this.name = 'ReceiptParseError';
  }
}

/**
 * @notice Wallet user rejected a signing or transaction request.
 */
export class UserRejectedError extends DivigentError {
  constructor(options?: DivigentErrorOptions) {
    super(
      'User rejected the wallet request',
      withDefaults(
        {
          code: 'DIVIGENT_USER_REJECTED',
          category: 'wallet',
        },
        options,
      ),
    );
    this.name = 'UserRejectedError';
  }
}

const PANIC_MESSAGES = new Map<number, string>([
  [0x01, 'assertion failed'],
  [0x11, 'arithmetic overflow or underflow'],
  [0x12, 'division or modulo by zero'],
  [0x21, 'invalid enum conversion'],
  [0x22, 'malformed storage byte array'],
  [0x31, 'pop on empty array'],
  [0x32, 'array access out of bounds'],
  [0x41, 'memory allocation overflow'],
  [0x51, 'call to uninitialized internal function'],
]);

/**
 * @notice Solidity Panic(uint256) revert decoded from viem.
 */
export class PanicError extends DivigentError {
  constructor(
    public readonly panicCode: number,
    options?: DivigentErrorOptions,
  ) {
    const reason = PANIC_MESSAGES.get(panicCode) ?? 'unknown Solidity panic';
    super(
      `Solidity panic 0x${panicCode.toString(16).padStart(2, '0')}: ${reason}`,
      withDefaults(
        {
          code: 'DIVIGENT_SOLIDITY_PANIC',
          category: 'contract',
          context: { panicCode, reason },
        },
        options,
      ),
    );
    this.name = 'PanicError';
  }
}

/**
 * @notice Solidity Error(string) revert with sanitized reason text.
 */
export class RequireError extends DivigentError {
  public readonly reason: string;

  constructor(rawReason: string, options?: DivigentErrorOptions) {
    const reason = rawReason.replace(/[\x00-\x1F\x7F]/g, '?').slice(0, 256);
    super(
      `Contract revert: ${reason}`,
      withDefaults(
        {
          code: 'DIVIGENT_REQUIRE_REVERT',
          category: 'contract',
          context: { reason },
        },
        options,
      ),
    );
    this.name = 'RequireError';
    this.reason = reason;
  }
}

/**
 * @notice Decoded Divigent custom error without one subclass per Solidity selector.
 */
export class ContractRevertError extends DivigentError {
  constructor(
    public readonly errorName: string,
    public readonly args: readonly unknown[] | undefined,
    options?: DivigentErrorOptions,
  ) {
    super(
      `Divigent contract revert: ${errorName}${formatArgs(args)}`,
      withDefaults(
        {
          code: 'DIVIGENT_CONTRACT_REVERT',
          category: 'contract',
          context: { errorName, args: args ?? [] },
        },
        options,
      ),
    );
    this.name = 'ContractRevertError';
  }
}

const ALL_ERROR_ABIS = [
  ...routerAbi,
  ...oracleAbi,
  ...feeCollectorAbi,
  ...dvUsdcAbi,
].filter((item): item is { type: 'error' } & typeof item => item.type === 'error');

/**
 * @notice Decode raw revert bytes into a Divigent SDK error when possible.
 * @param data Raw EVM revert bytes.
 * @param cause Optional original error to preserve.
 * @returns Decoded error or null when the selector is unknown.
 */
export function decodeDivigentError(
  data: Hex,
  cause?: unknown,
): DivigentError | null {
  return decodeDivigentErrorWithAbi(data, ALL_ERROR_ABIS, cause);
}

function decodeDivigentErrorWithAbi(
  data: Hex,
  errorAbi: readonly unknown[],
  cause?: unknown,
): DivigentError | null {
  if (!data || data.length < 10) return null;
  try {
    const decoded = decodeErrorResult({
      abi: errorAbi as Parameters<typeof decodeErrorResult>[0]['abi'],
      data,
    });
    return new ContractRevertError(decoded.errorName, decoded.args, {
      cause,
    });
  } catch {
    return null;
  }
}

function formatArgs(args: readonly unknown[] | undefined): string {
  if (!args || args.length === 0) return '()';
  return `(${args.map(String).join(', ')})`;
}

function mergeContext(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const merged = {
    ...(left ?? {}),
    ...(right ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function optionsForSpecificError(
  cause: unknown,
  options?: ToDivigentErrorOptions,
): DivigentErrorOptions {
  const out: DivigentErrorOptions = { cause };
  if (options?.context !== undefined) out.context = options.context;
  return out;
}

function messageOf(error: unknown): string {
  if (error instanceof BaseError) {
    return error.shortMessage || error.message || 'viem request failed';
  }
  if (error instanceof Error) {
    return error.message || error.name || 'SDK error';
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function isLikelyRetryable(error: unknown): boolean {
  const text = messageOf(error).toLowerCase();
  return [
    'timeout',
    'timed out',
    'network',
    'fetch failed',
    'failed to fetch',
    'connection',
    'rate limit',
    '429',
    '500',
    '502',
    '503',
    '504',
    'temporarily unavailable',
  ].some((needle) => text.includes(needle));
}

function safeWalk(
  error: unknown,
  predicate: (e: unknown) => boolean,
  maxDepth = 32,
): unknown {
  const visited = new Set<unknown>();
  let cur: unknown = error;
  let depth = 0;
  while (cur && depth < maxDepth && !visited.has(cur)) {
    visited.add(cur);
    if (predicate(cur)) return cur;
    cur = (cur as { cause?: unknown }).cause;
    depth++;
  }
  return null;
}

/**
 * @notice Extract raw revert bytes from a viem error if present.
 * @param error Error thrown by viem.
 * @returns Raw revert bytes or null.
 */
export function extractRevertData(error: unknown): Hex | null {
  if (!(error instanceof BaseError)) return null;
  const revert = safeWalk(error, (e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return null;
  return (revert.raw ?? null) as Hex | null;
}

/**
 * @notice Convert viem/native errors into Divigent typed errors.
 * @param error Error thrown by viem or another SDK layer.
 * @param abi Optional invoked contract ABI to avoid selector collisions.
 * @returns Typed Divigent error.
 */
export function wrapViemError(error: unknown, abi?: readonly unknown[]): Error {
  const options: ToDivigentErrorOptions = {};
  if (abi !== undefined) options.abi = abi;
  return toDivigentError(error, options);
}

function decodeViemError(
  error: BaseError,
  abi?: readonly unknown[],
  options?: ToDivigentErrorOptions,
): DivigentError | null {
  if (safeWalk(error, (e) => e instanceof UserRejectedRequestError)) {
    return new UserRejectedError(optionsForSpecificError(error, options));
  }

  const revert = safeWalk(error, (e) => e instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError) {
    const decoded = revert.data;
    if (decoded) {
      if (decoded.errorName === 'Panic') {
        const code = decoded.args?.[0];
        if (typeof code === 'bigint') {
          return new PanicError(Number(code), optionsForSpecificError(error, options));
        }
        if (typeof code === 'number') {
          return new PanicError(code, optionsForSpecificError(error, options));
        }
      }
      if (decoded.errorName === 'Error') {
        const reason = decoded.args?.[0];
        if (typeof reason === 'string') {
          return new RequireError(reason, optionsForSpecificError(error, options));
        }
      }
    }

    if (revert.raw) {
      if (abi) {
        const errorsOnly = (abi as Array<{ type?: string }>).filter(
          (item) => item.type === 'error',
        );
        if (errorsOnly.length > 0) {
          const scoped = decodeDivigentErrorWithAbi(revert.raw as Hex, errorsOnly, error);
          if (scoped) return scoped;
        }
      }

      const typed = decodeDivigentError(revert.raw as Hex, error);
      if (typed) return typed;
    }
  }

  return null;
}

/**
 * @notice Convert any thrown value into a DivigentError.
 * @param error Thrown value from viem, x402, user callbacks, or SDK guards.
 * @param options Optional fallback taxonomy and context.
 * @returns DivigentError preserving the original value as `cause` when possible.
 */
export function toDivigentError(
  error: unknown,
  options: ToDivigentErrorOptions = {},
): DivigentError {
  if (error instanceof DivigentError) {
    const context = mergeContext(error.context, options.context);
    const hasOverrides =
      options.cause !== undefined ||
      options.message !== undefined ||
      context !== error.context;

    if (!hasOverrides) return error;

    const next: DivigentErrorOptions = {
      cause: options.cause ?? error,
      retryable: error.retryable,
    };
    if (error.code !== undefined) next.code = error.code;
    if (error.category !== undefined) next.category = error.category;
    if (context !== undefined) next.context = context;

    return new DivigentError(options.message ?? error.message, next);
  }

  if (error instanceof BaseError) {
    const decoded = decodeViemError(error, options.abi, options);
    if (decoded) return decoded;
  }

  const context = options.context;
  const fallback: DivigentErrorOptions = {
    cause: options.cause ?? error,
    code: options.code ?? (error instanceof BaseError ? 'DIVIGENT_VIEM_ERROR' : 'DIVIGENT_UNKNOWN_ERROR'),
    category: options.category ?? (error instanceof BaseError ? 'chain' : 'config'),
    retryable: options.retryable ?? (error instanceof BaseError ? isLikelyRetryable(error) : false),
  };
  if (context !== undefined) fallback.context = context;

  return new DivigentError(options.message ?? messageOf(error), fallback);
}

/**
 * @notice Run a viem write path and map reverts/user rejection to typed errors.
 * @param fn Function that performs the viem write.
 * @param abi Optional invoked contract ABI for scoped revert decoding.
 * @returns Result from fn.
 */
export async function runWrite<T>(
  fn: () => Promise<T>,
  abi?: readonly unknown[],
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const options: ToDivigentErrorOptions = {
      code: 'DIVIGENT_WRITE_FAILED',
      category: 'chain',
    };
    if (abi !== undefined) options.abi = abi;
    throw toDivigentError(e, options);
  }
}

/**
 * @notice Run a viem read path and map reverts to typed errors.
 * @param fn Function that performs the viem read.
 * @param abi Optional invoked contract ABI for scoped revert decoding.
 * @returns Result from fn.
 */
export async function runRead<T>(
  fn: () => Promise<T>,
  abi?: readonly unknown[],
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const options: ToDivigentErrorOptions = {
      code: 'DIVIGENT_READ_FAILED',
      category: 'chain',
      retryable: isLikelyRetryable(e),
    };
    if (abi !== undefined) options.abi = abi;
    throw toDivigentError(e, options);
  }
}

/**
 * @notice Run a signing path and map wallet rejection to typed errors.
 * @param fn Function that performs the wallet signing request.
 * @returns Result from fn.
 */
export async function runSign<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toDivigentError(e, {
      code: 'DIVIGENT_SIGN_FAILED',
      category: 'wallet',
    });
  }
}
