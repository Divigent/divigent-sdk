import type {
  AfterPaymentCreationHook,
  BeforePaymentCreationHook,
  OnPaymentCreationFailureHook,
  PaymentCreatedContext as X402PaymentCreatedContext,
  PaymentCreationContext,
  x402Client,
} from '@x402/core/client';
import { CHAINS } from '../core/chains';
import type { Divigent } from '../divigent';
import {
  AlreadyAttachedError,
  DivigentError,
  isDivigentError,
  PaymentCapExceededError,
  toDivigentError,
} from '../errors';
import type { EvmAddress, TxHash } from '../types';
import { bigintMax, bigintMin } from '../core/utils';
import { withOwnerLock } from './locks';
import type {
  FailureContext,
  IntegrationErrorContext,
  PaymentContext,
  PaymentCreatedContext,
  X402PolicyContext,
  X402ResourceCap,
  X402ResourcePattern,
  X402WrapConfig,
} from './types';

export const DEFAULT_MAX_PAYMENT_AMOUNT = 100n * 10n ** 6n; // 100 USDC
const RECALL_BALANCE_TIMEOUT_MS = 60_000;
const RECALL_BALANCE_POLL_MS = 2_000;

type PaymentCtx = PaymentCreationContext | X402PaymentCreatedContext;
type NonFatalInput = Omit<IntegrationErrorContext, 'error'> & { error: unknown };
type HookFn = BeforePaymentCreationHook | AfterPaymentCreationHook | OnPaymentCreationFailureHook;

type RemovableX402Client = {
  offBeforePaymentCreation?: (hook: BeforePaymentCreationHook) => unknown;
  offAfterPaymentCreation?: (hook: AfterPaymentCreationHook) => unknown;
  offPaymentCreationFailure?: (hook: OnPaymentCreationFailureHook) => unknown;
  off?: (event: string, hook: HookFn) => unknown;
  removeListener?: (event: string, hook: HookFn) => unknown;
  removeEventListener?: (event: string, hook: HookFn) => unknown;
  beforePaymentCreationHooks?: BeforePaymentCreationHook[];
  afterPaymentCreationHooks?: AfterPaymentCreationHook[];
  onPaymentCreationFailureHooks?: OnPaymentCreationFailureHook[];
};

// Track attached clients to prevent double hook registration.
const attachedClients = new WeakSet<x402Client>();

/**
 * @notice EMA-based reserve sizer used to keep payment liquidity in the wallet.
 */
export class ReserveFloor {
  private emaScaled: bigint = 0n;
  private readonly minIdleThreshold: bigint;
  private readonly ratioScaled: bigint;
  private readonly alphaScaled: bigint = 20n;

  constructor(opts: {
    minIdleThreshold?: bigint | undefined;
    reserveRatio?: number | undefined;
    reserveMultiplier?: number | undefined;
  } = {}) {
    this.minIdleThreshold = opts.minIdleThreshold ?? 1_000n * 10n ** 6n;
    const ratio = opts.reserveRatio ?? 0.1;
    const multiplier = opts.reserveMultiplier ?? 3;
    this.ratioScaled = BigInt(Math.round(ratio * multiplier * 100));
  }

  /**
   * @notice Record a payment amount into the reserve EMA.
   * @param amount Payment amount in USDC atomic units.
   * @param maxAmount Optional clamp to prevent reserve poisoning.
   */
  recordPayment(amount: bigint, maxAmount?: bigint): void {
    if (amount <= 0n) return;
    const safe = maxAmount !== undefined && amount > maxAmount ? maxAmount : amount;
    this.emaScaled =
      (this.alphaScaled * safe + (100n - this.alphaScaled) * this.emaScaled) / 100n;
  }

  /**
   * @notice Return the USDC amount the wallet should keep liquid.
   * @returns Required wallet reserve in USDC atomic units.
   */
  required(): bigint {
    const emaBased = (this.emaScaled * this.ratioScaled) / 100n;
    return bigintMax(emaBased, this.minIdleThreshold);
  }

  /** @notice Current raw EMA amount in USDC atomic units. */
  get ema(): bigint {
    return this.emaScaled;
  }
}

/**
 * @notice Register Divigent yield-recall hooks on an x402 client.
 * @remarks Call `detach()` before re-attaching to the same client.
 * @param client Existing x402 client.
 * @param divigent Divigent facade used for recall withdrawals.
 * @param config x402 policy, reserve, and observer config.
 * @returns Detach handle.
 * @throws AlreadyAttachedError if the client already has active Divigent hooks.
 */
export function attachDivigentYield(
  client: x402Client,
  divigent: Divigent,
  config: X402WrapConfig = {},
): { detach: () => void } {
  const reserveFloor = new ReserveFloor({
    minIdleThreshold: config.minIdleThreshold,
    reserveRatio: config.reserveRatio,
    reserveMultiplier: config.reserveMultiplier,
  });
  return attachX402HooksWithReserveFloor(client, divigent, config, reserveFloor);
}

/**
 * @notice Attach x402 recall hooks using a caller-owned reserve floor.
 * @remarks Package-internal helper shared by attach and settlement composition.
 * @param client Existing x402 client.
 * @param divigent Divigent facade used for recall withdrawals.
 * @param config x402 policy, reserve, and observer config.
 * @param reserveFloor Shared reserve floor instance.
 * @returns Detach handle.
 */
export function attachX402HooksWithReserveFloor(
  client: x402Client,
  divigent: Divigent,
  config: X402WrapConfig,
  reserveFloor: ReserveFloor,
): { detach: () => void } {
  if (attachedClients.has(client)) {
    throw new AlreadyAttachedError();
  }
  attachedClients.add(client);

  const slippageBps = config.slippageBps ?? 50;
  const expectedNetwork = `eip155:${CHAINS[divigent.chain].id}`;
  const expectedAsset = divigent.addresses.usdc.toLowerCase();

  let detached = false;
  let sessionPaymentTotal = 0n;
  const redact = config.redact ?? false;

  const redactAddr = (a: EvmAddress): EvmAddress | string =>
    redact ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
  const redactHash = (h: TxHash | undefined): TxHash | undefined =>
    redact ? undefined : h;

  type RecallState = {
    owner: EvmAddress;
    recallShares: bigint;
    balanceBefore: bigint;
    recalledUsdc: bigint;
  };
  const recallByRequired = new WeakMap<object, RecallState>();
  const handledByRequired = new WeakSet<object>();
  const sessionReservedByRequired = new WeakSet<object>();

  const releaseSessionReservation = (key: object, paymentAmount: bigint): void => {
    if (!sessionReservedByRequired.has(key)) return;
    sessionReservedByRequired.delete(key);
    sessionPaymentTotal = sessionPaymentTotal > paymentAmount
      ? sessionPaymentTotal - paymentAmount
      : 0n;
  };

  const wallet = (): EvmAddress => {
    const wc = divigent.walletClient;
    if (!wc?.account) {
      throw new DivigentError('[@divigent/sdk] x402 plugin requires walletClient with bound account', {
        code: 'DIVIGENT_X402_WALLET_REQUIRED',
        category: 'wallet',
      });
    }
    return wc.account.address as EvmAddress;
  };

  const beforeHook: BeforePaymentCreationHook = async (raw) => {
    if (detached) return;
    if (!ctxMatches(raw, expectedNetwork, expectedAsset)) return;

    const paymentAmount = ctxAmount(raw);
    if (paymentAmount <= 0n) return;
    const owner = wallet();
    const policy = policyContext(raw, owner, paymentAmount);
    if (config.requireAllowedPayTo === true && (!config.allowedPayTo || config.allowedPayTo.length === 0)) {
      throw new DivigentError('[@divigent/sdk] x402 payTo allowlist is required by policy', {
        code: 'DIVIGENT_X402_PAYTO_ALLOWLIST_REQUIRED',
        category: 'policy',
        context: { paymentAmount, resource: policy.resource },
      });
    }
    if (!(await shouldHandlePaymentByPolicy(config, policy))) return;

    const paymentCap = effectivePaymentCap(
      config,
      DEFAULT_MAX_PAYMENT_AMOUNT,
      policy.resource,
    );
    const key = raw.paymentRequired as object;
    if (paymentAmount > paymentCap) {
      await safeObserver(
        config.onBeforePayment,
        {
          wallet: redactAddr(owner),
          paymentAmount,
          walletBalance: 0n,
          reserveFloor: 0n,
          deficit: 0n,
        },
        'onBeforePayment',
        config.onNonFatalError,
      );
      throw new PaymentCapExceededError(paymentAmount, paymentCap, {
        code: 'DIVIGENT_X402_PAYMENT_CAP_EXCEEDED',
        category: 'policy',
        context: {
          paymentAmount,
          paymentCap,
          resource: policy.resource,
          payTo: policy.payTo,
        },
      });
    }
    if (
      config.maxSessionPaymentAmount !== undefined &&
      sessionPaymentTotal + paymentAmount > config.maxSessionPaymentAmount
    ) {
      const remaining = config.maxSessionPaymentAmount > sessionPaymentTotal
        ? config.maxSessionPaymentAmount - sessionPaymentTotal
        : 0n;
      throw new PaymentCapExceededError(paymentAmount, remaining, {
        code: 'DIVIGENT_X402_SESSION_CAP_EXCEEDED',
        category: 'policy',
        context: {
          paymentAmount,
          sessionPaymentTotal,
          sessionPaymentCap: config.maxSessionPaymentAmount,
          resource: policy.resource,
          payTo: policy.payTo,
        },
      });
    }
    if (config.maxSessionPaymentAmount !== undefined) {
      sessionPaymentTotal += paymentAmount;
      sessionReservedByRequired.add(key);
    }
    handledByRequired.add(key);

    try {
      await withOwnerLock(owner, async () => {
        const floor = reserveFloor.required();
        let balance: bigint;
        try {
          balance = await divigent.usdcBalance(owner);
        } catch (err) {
          throw new DivigentError(
            '[@divigent/sdk] x402 could not read wallet USDC balance before recall',
            {
              cause: err,
              code: 'DIVIGENT_X402_BALANCE_READ_FAILED',
              category: 'x402',
              retryable: true,
              context: {
                wallet: owner,
                paymentAmount,
                reserveFloor: floor,
              },
            },
          );
        }
        const needed = paymentAmount + floor;
        const deficit = balance >= needed ? 0n : needed - balance;
        let liquidBalance = balance;

        let recallShares: bigint | undefined;
        let recallTxHash: TxHash | undefined;
        let recallError: unknown;

        if (deficit > 0n) {
          try {
            const sharesNeeded = await divigent.previewWithdrawNet(deficit, owner);
            if (sharesNeeded > 0n) {
              const recalled = await divigent.withdrawAndWait({
                shares: sharesNeeded,
                wallet: owner,
                slippageBps,
              });
              recallShares = sharesNeeded;
              recallTxHash = recalled.txHash;
              await waitForUsdcBalanceAtLeast(divigent, owner, needed);
              liquidBalance = needed;
              recallByRequired.set(
                raw.paymentRequired as object,
                {
                  owner,
                  recallShares: sharesNeeded,
                  balanceBefore: balance,
                  recalledUsdc: recalled.usdcReturned,
                },
              );
            }
          } catch (err) {
            recallError = err;
            try {
              liquidBalance = await divigent.usdcBalance(owner);
            } catch {
              liquidBalance = balance;
            }
          }
        }

        const redactedRecallHash = redactHash(recallTxHash);
        const ctx: PaymentContext = {
          wallet: redactAddr(owner),
          paymentAmount,
          walletBalance: balance,
          reserveFloor: floor,
          deficit,
          ...(recallShares !== undefined && { recallShares }),
          ...(redactedRecallHash !== undefined && { recallTxHash: redactedRecallHash }),
          ...(recallError !== undefined && { recallError }),
        };
        await safeObserver(config.onBeforePayment, ctx, 'onBeforePayment', config.onNonFatalError);

        if (deficit > 0n && liquidBalance < paymentAmount) {
          throw new DivigentError(
            '[@divigent/sdk] x402 recall could not make enough USDC liquid for payment',
            {
              cause: recallError,
              code: 'DIVIGENT_X402_RECALL_INSUFFICIENT_LIQUIDITY',
              category: 'x402',
              retryable: true,
              context: {
                wallet: owner,
                paymentAmount,
                walletBalance: liquidBalance,
                initialWalletBalance: balance,
                reserveFloor: floor,
                deficit,
              },
            },
          );
        }
      });
    } catch (err) {
      handledByRequired.delete(key);
      releaseSessionReservation(key, paymentAmount);
      if (
        isDivigentError(err) &&
        (
          err.code === 'DIVIGENT_X402_RECALL_INSUFFICIENT_LIQUIDITY' ||
          err.code === 'DIVIGENT_X402_BALANCE_READ_FAILED'
        )
      ) {
        throw err;
      }
      await reportNonFatal(config.onNonFatalError, {
        phase: 'x402-before-hook',
        error: err,
        recoverable: true,
      });
    }
  };

  const afterHook: AfterPaymentCreationHook = async (raw) => {
    if (detached) return;
    if (!ctxMatches(raw, expectedNetwork, expectedAsset)) return;

    const paymentAmount = ctxAmount(raw);
    const key = raw.paymentRequired as object;
    if (paymentAmount <= 0n || !handledByRequired.has(key)) return;

    const paymentCap = effectivePaymentCap(
      config,
      DEFAULT_MAX_PAYMENT_AMOUNT,
      policyContext(raw, wallet(), paymentAmount).resource,
    );
    if (paymentAmount > paymentCap) {
      recallByRequired.delete(key);
      handledByRequired.delete(key);
      releaseSessionReservation(key, paymentAmount);
      return;
    }

    const owner = wallet();
    await withOwnerLock(owner, async () => {
      reserveFloor.recordPayment(paymentAmount, paymentCap);

      recallByRequired.delete(key);
      handledByRequired.delete(key);
      sessionReservedByRequired.delete(key);

      if (config.onAfterPaymentCreation) {
        let walletBalance = 0n;
        try {
          walletBalance = await divigent.usdcBalance(owner);
        } catch {
          // Telemetry-only; never fail payment creation after recall state clears.
        }
        const ctx: PaymentCreatedContext = {
          wallet: redactAddr(owner),
          paymentAmount,
          walletBalance,
          reserveFloor: reserveFloor.required(),
          deficit: 0n,
        };
        await safeObserver(
          config.onAfterPaymentCreation,
          ctx,
          'onAfterPaymentCreation',
          config.onNonFatalError,
        );
      }
    });
  };

  const failureHook: OnPaymentCreationFailureHook = async (raw) => {
    if (detached) return;
    const key = raw.paymentRequired as object;
    const paymentAmount = ctxAmount(raw);
    const state = recallByRequired.get(key);
    const wasHandled = state !== undefined || handledByRequired.has(key);
    recallByRequired.delete(key);
    handledByRequired.delete(key);
    releaseSessionReservation(key, paymentAmount);
    if (!wasHandled) return;

    let redepositAmount: bigint | undefined;
    let redepositTxHash: TxHash | undefined;
    const recalledUsdc = state !== undefined;

    if (state) {
      try {
        await withOwnerLock(state.owner, async () => {
          const balance = await divigent.usdcBalance(state.owner);
          const excess = balance > state.balanceBefore ? balance - state.balanceBefore : 0n;
          const undoAmount = bigintMin(excess, state.recalledUsdc);
          if (undoAmount > 0n) {
            try {
              redepositAmount = undoAmount;
              const redeposit = await divigent.depositWithPermitAndWait({
                amount: undoAmount,
                wallet: state.owner,
                ...(config.depositSlippageBps !== undefined && { slippageBps: config.depositSlippageBps }),
              });
              redepositTxHash = redeposit.txHash;
            } catch (_err) {
              // Redeposit failed; USDC remains liquid in the wallet.
              await reportNonFatal(config.onNonFatalError, {
                phase: 'x402-failure-hook',
                error: _err,
                recoverable: true,
              });
            }
          }
        });
      } catch (err) {
        await reportNonFatal(config.onNonFatalError, {
          phase: 'x402-failure-hook',
          error: err,
          recoverable: true,
        });
      }
    }

    if (config.onPaymentFailure) {
      const owner = state?.owner ?? wallet();
      const redactedHash = redactHash(redepositTxHash);
      const ctx: FailureContext = {
        wallet: redactAddr(owner),
        paymentAmount,
        error: raw.error,
        recalledUsdc,
        ...(redepositAmount !== undefined && { redepositAmount }),
        ...(redactedHash !== undefined && { redepositTxHash: redactedHash }),
      };
      await safeObserver(config.onPaymentFailure, ctx, 'onPaymentFailure', config.onNonFatalError);
    }
  };

  client
    .onBeforePaymentCreation(beforeHook)
    .onAfterPaymentCreation(afterHook)
    .onPaymentCreationFailure(failureHook);

  return {
    detach(): void {
      if (detached) return;
      detached = true;
      unregisterX402Hooks(client, beforeHook, afterHook, failureHook);
      attachedClients.delete(client);
    },
  };
}

function unregisterX402Hooks(
  client: x402Client,
  beforeHook: BeforePaymentCreationHook,
  afterHook: AfterPaymentCreationHook,
  failureHook: OnPaymentCreationFailureHook,
): void {
  const removable = client as unknown as RemovableX402Client;
  callHookRemover(() => removable.offBeforePaymentCreation?.(beforeHook));
  callHookRemover(() => removable.offAfterPaymentCreation?.(afterHook));
  callHookRemover(() => removable.offPaymentCreationFailure?.(failureHook));

  removeEmitterHook(removable, ['beforePaymentCreation', 'beforePaymentCreationHook'], beforeHook);
  removeEmitterHook(removable, ['afterPaymentCreation', 'afterPaymentCreationHook'], afterHook);
  removeEmitterHook(removable, ['paymentCreationFailure', 'paymentCreationFailureHook'], failureHook);

  removeHookFromArray(removable.beforePaymentCreationHooks, beforeHook);
  removeHookFromArray(removable.afterPaymentCreationHooks, afterHook);
  removeHookFromArray(removable.onPaymentCreationFailureHooks, failureHook);
}

function callHookRemover(remove: () => unknown): void {
  try {
    remove();
  } catch {
    // Best-effort listener cleanup; detached hooks still guard execution.
  }
}

function removeEmitterHook(
  client: RemovableX402Client,
  events: readonly string[],
  hook: HookFn,
): void {
  for (const event of events) {
    callHookRemover(() => client.off?.(event, hook));
    callHookRemover(() => client.removeListener?.(event, hook));
    callHookRemover(() => client.removeEventListener?.(event, hook));
  }
}

function removeHookFromArray<T extends HookFn>(hooks: T[] | undefined, hook: T): void {
  if (!hooks) return;
  for (let i = hooks.length - 1; i >= 0; i--) {
    if (hooks[i] === hook) hooks.splice(i, 1);
  }
}

function ctxAmount(ctx: PaymentCtx): bigint {
  const req = ctx.selectedRequirements as {
    amount?: string;
    maxAmountRequired?: string;
  };
  const raw = req.amount ?? req.maxAmountRequired;
  if (!raw) return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}

function ctxMatches(
  ctx: PaymentCtx,
  expectedNetwork: string,
  expectedAsset: string,
): boolean {
  if (ctx.paymentRequired?.x402Version !== 2) return false;

  const req = ctx.selectedRequirements as {
    network?: string;
    asset?: string;
    scheme?: string;
  };
  if (req.scheme && req.scheme.toLowerCase() !== 'exact') return false;
  if (!req.network || req.network.toLowerCase() !== expectedNetwork) return false;
  if (!req.asset || req.asset.toLowerCase() !== expectedAsset) return false;
  return true;
}

function maybeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function policyContext(
  ctx: PaymentCtx,
  wallet: EvmAddress,
  paymentAmount: bigint,
): X402PolicyContext {
  const req = ctx.selectedRequirements as {
    network?: unknown;
    asset?: unknown;
    scheme?: unknown;
    payTo?: unknown;
    resource?: unknown;
  };
  const paymentRequired = ctx.paymentRequired as {
    resource?: unknown;
  };

  const resource =
    maybeString(req.resource) ?? resourceFromPaymentRequired(paymentRequired.resource);
  const out: X402PolicyContext = {
    wallet,
    paymentAmount,
    raw: ctx,
  };
  const payTo = maybeString(req.payTo);
  const origin = originFromResource(resource);
  const network = maybeString(req.network);
  const scheme = maybeString(req.scheme);
  const asset = maybeString(req.asset);
  if (payTo !== undefined) out.payTo = payTo;
  if (resource !== undefined) out.resource = resource;
  if (origin !== undefined) out.origin = origin;
  if (network !== undefined) out.network = network;
  if (scheme !== undefined) out.scheme = scheme;
  if (asset !== undefined) out.asset = asset;
  return out;
}

function asArray<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

function resourceFromPaymentRequired(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value === null || typeof value !== 'object') return undefined;
  return maybeString((value as { url?: unknown }).url);
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function resourceMatches(pattern: X402ResourcePattern, value: string): boolean {
  if (pattern instanceof RegExp) {
    const previousLastIndex = pattern.lastIndex;
    pattern.lastIndex = 0;
    const matched = pattern.test(value);
    pattern.lastIndex = previousLastIndex;
    return matched;
  }
  if (pattern.includes('*')) {
    const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`);
    return regex.test(value);
  }
  return pattern === value;
}

function matchesAny(patterns: readonly X402ResourcePattern[], value: string | undefined): boolean {
  if (patterns.length === 0) return true;
  if (!value) return false;
  return patterns.some((pattern) => resourceMatches(pattern, value));
}

function matchesAllowedPayTo(
  config: X402WrapConfig,
  payTo: string | undefined,
): boolean {
  const allowedPayTo = config.allowedPayTo;
  if (!allowedPayTo || allowedPayTo.length === 0) return config.allowAllPayTo === true;
  if (!payTo) return false;
  const normalized = payTo.toLowerCase();
  return allowedPayTo.some((addr) => addr.toLowerCase() === normalized);
}

function resourcePatterns(config: X402WrapConfig): readonly X402ResourcePattern[] {
  return [
    ...asArray(config.allowedResources),
    ...asArray(config.allowedResource),
  ];
}

function originPatterns(config: X402WrapConfig): readonly string[] {
  return [
    ...asArray(config.allowedOrigins),
    ...asArray(config.allowedOrigin),
  ];
}

function normalizeCap(cap: X402ResourceCap): {
  resource: X402ResourcePattern;
  maxPaymentAmount: bigint;
} {
  if (Array.isArray(cap)) {
    return { resource: cap[0], maxPaymentAmount: cap[1] };
  }
  return cap as { resource: X402ResourcePattern; maxPaymentAmount: bigint };
}

function capForResource(
  config: X402WrapConfig,
  resource: string | undefined,
): bigint | undefined {
  const caps = config.maxPaymentAmountByResource;
  if (!caps || !resource) return undefined;

  if (Array.isArray(caps)) {
    for (const cap of caps) {
      const normalized = normalizeCap(cap);
      if (resourceMatches(normalized.resource, resource)) {
        return normalized.maxPaymentAmount;
      }
    }
    return undefined;
  }

  for (const [pattern, maxPaymentAmount] of Object.entries(caps)) {
    if (resourceMatches(pattern, resource)) return maxPaymentAmount;
  }
  return undefined;
}

export function effectivePaymentCap(
  config: X402WrapConfig,
  defaultCap: bigint,
  resource: string | undefined,
): bigint {
  const global = config.maxPaymentAmount ?? defaultCap;
  const resourceCap = capForResource(config, resource);
  return resourceCap !== undefined && resourceCap < global ? resourceCap : global;
}

async function shouldHandlePaymentByPolicy(
  config: X402WrapConfig,
  ctx: X402PolicyContext,
): Promise<boolean> {
  if (!matchesAllowedPayTo(config, ctx.payTo)) return false;
  if (!matchesAny(resourcePatterns(config), ctx.resource)) return false;

  const origins = originPatterns(config);
  if (origins.length > 0) {
    if (!ctx.origin) return false;
    if (!origins.some((origin) => origin === ctx.origin)) return false;
  }

  if (config.shouldHandlePayment) {
    return await config.shouldHandlePayment(ctx);
  }
  return true;
}

export function shouldHandleResourceByPolicy(
  config: X402WrapConfig | undefined,
  resource: string | undefined,
): boolean {
  if (!config) return true;
  if (!matchesAny(resourcePatterns(config), resource)) return false;

  const origins = originPatterns(config);
  if (origins.length > 0) {
    const origin = originFromResource(resource);
    if (!origin) return false;
    if (!origins.some((allowed) => allowed === origin)) return false;
  }

  return true;
}

function originFromResource(resource: string | undefined): string | undefined {
  if (!resource) return undefined;
  try {
    return new URL(resource).origin;
  } catch {
    return undefined;
  }
}

async function safeObserver<T>(
  fn: ((ctx: T) => void | Promise<void>) | undefined,
  ctx: T,
  label: string,
  onNonFatalError: X402WrapConfig['onNonFatalError'],
): Promise<void> {
  if (!fn) return;
  try {
    await fn(ctx);
  } catch (err) {
    await reportNonFatal(onNonFatalError, {
      phase: 'observer',
      label,
      error: err,
      recoverable: true,
    });
  }
}

export async function reportNonFatal(
  onNonFatalError: X402WrapConfig['onNonFatalError'],
  ctx: NonFatalInput,
): Promise<void> {
  if (!onNonFatalError) return;
  const error = isDivigentError(ctx.error)
    ? toDivigentError(ctx.error, {
        context: {
          phase: ctx.phase,
          ...(ctx.label !== undefined && { label: ctx.label }),
          recoverable: ctx.recoverable,
        },
      })
    : toDivigentError(ctx.error, {
        code: 'DIVIGENT_X402_NON_FATAL',
        category: 'x402',
        context: {
          phase: ctx.phase,
          ...(ctx.label !== undefined && { label: ctx.label }),
          recoverable: ctx.recoverable,
        },
      });
  try {
    await onNonFatalError({ ...ctx, error });
  } catch {
    // Caller telemetry must never break payment or redeposit flow.
  }
}

async function waitForUsdcBalanceAtLeast(
  divigent: Divigent,
  owner: EvmAddress,
  minimum: bigint,
): Promise<void> {
  const deadline = Date.now() + RECALL_BALANCE_TIMEOUT_MS;
  let lastBalance = await divigent.usdcBalance(owner);
  while (lastBalance < minimum && Date.now() < deadline) {
    await sleep(RECALL_BALANCE_POLL_MS);
    lastBalance = await divigent.usdcBalance(owner);
  }
  if (lastBalance >= minimum) return;

  throw new DivigentError(
    '[@divigent/sdk] x402 recall withdrawal mined but wallet USDC balance did not update before timeout',
    {
      code: 'DIVIGENT_X402_RECALL_BALANCE_TIMEOUT',
      category: 'x402',
      context: { wallet: owner, minimum, lastBalance },
    },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
