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
import { bigintMax } from '../core/utils';
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

const DEFAULT_MAX_PAYMENT_AMOUNT = 100n * 10n ** 6n; // 100 USDC
const RECALL_BALANCE_TIMEOUT_MS = 60_000;
const RECALL_BALANCE_POLL_MS = 2_000;

type PaymentCtx = PaymentCreationContext | X402PaymentCreatedContext;
type NonFatalInput = Omit<IntegrationErrorContext, 'error'> & { error: unknown };

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

  let lock: Promise<void> = Promise.resolve();
  let detached = false;
  const redact = config.redact ?? false;

  const redactAddr = (a: EvmAddress): EvmAddress | string =>
    redact ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
  const redactHash = (h: TxHash | undefined): TxHash | undefined =>
    redact ? undefined : h;

  const runExclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = lock.then(fn, fn);
    lock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  type RecallState = {
    owner: EvmAddress;
    recallShares: bigint;
    balanceBefore: bigint;
  };
  const recallByRequired = new WeakMap<object, RecallState>();
  const handledByRequired = new WeakSet<object>();

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
    if (!(await shouldHandlePaymentByPolicy(config, policy))) return;

    const paymentCap = effectivePaymentCap(
      config,
      DEFAULT_MAX_PAYMENT_AMOUNT,
      policy.resource,
    );
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
    const key = raw.paymentRequired as object;
    handledByRequired.add(key);

    try {
      await runExclusive(async () => {
        const floor = reserveFloor.required();
        const balance = await divigent.usdcBalance(owner);
        const needed = paymentAmount + floor;
        const deficit = balance >= needed ? 0n : needed - balance;

        let recallShares: bigint | undefined;
        let recallTxHash: TxHash | undefined;
        let recallError: unknown;

        if (deficit > 0n) {
          try {
            const sharesNeeded = await divigent.previewWithdrawNet(deficit, owner);
            if (sharesNeeded > 0n) {
              recallShares = sharesNeeded;
              const recalled = await divigent.withdrawAndWait({
                shares: sharesNeeded,
                wallet: owner,
                slippageBps,
              });
              recallTxHash = recalled.txHash;
              await waitForUsdcBalanceAtLeast(divigent, owner, needed);
              recallByRequired.set(
                raw.paymentRequired as object,
                { owner, recallShares: sharesNeeded, balanceBefore: balance },
              );
            }
          } catch (err) {
            recallError = err;
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
      });
    } catch (err) {
      handledByRequired.delete(key);
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
    if (paymentAmount > paymentCap) return;

    await runExclusive(async () => {
      const owner = wallet();
      reserveFloor.recordPayment(paymentAmount, paymentCap);

      recallByRequired.delete(key);
      handledByRequired.delete(key);

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
    const state = recallByRequired.get(key);
    const wasHandled = state !== undefined || handledByRequired.has(key);
    recallByRequired.delete(key);
    handledByRequired.delete(key);
    if (!wasHandled) return;

    let redepositAmount: bigint | undefined;
    let redepositTxHash: TxHash | undefined;
    const recalledUsdc = state !== undefined;

    if (state) {
      try {
        await runExclusive(async () => {
          const balance = await divigent.usdcBalance(state.owner);
          const excess = balance > state.balanceBefore ? balance - state.balanceBefore : 0n;
          if (excess > 0n) {
            try {
              redepositAmount = excess;
              redepositTxHash = await divigent.depositWithPermit({
                amount: excess,
                wallet: state.owner,
              });
            } catch (_err) {
              // Redeposit failed; USDC remains liquid in the wallet.
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
      const paymentAmount = ctxAmount(raw);
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
      detached = true;
      attachedClients.delete(client);
    },
  };
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
  if (pattern instanceof RegExp) return pattern.test(value);
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
  allowedPayTo: readonly string[] | undefined,
  payTo: string | undefined,
): boolean {
  if (!allowedPayTo || allowedPayTo.length === 0) return true;
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

function effectivePaymentCap(
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
  if (!matchesAllowedPayTo(config.allowedPayTo, ctx.payTo)) return false;
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
