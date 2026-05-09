import { afterEach, describe, expect, it, vi } from 'vitest';
import { baseSepolia } from 'viem/chains';
import type { Divigent } from '../../src/divigent';
import { AlreadyAttachedError, PaymentCapExceededError } from '../../src/errors';
import { attachDivigentYield } from '../../src/x402/attach';
import { ReserveFloor } from '../../src/x402/attach';
import {
  HASH_1,
  OWNER,
  SELLER,
  addresses,
  createX402Client,
  usdc,
  x402PaymentContext,
} from './helpers';

function createX402Divigent(opts: {
  balances?: readonly bigint[] | undefined;
  previewWithdrawNet?: bigint | undefined;
  withdrawRejects?: boolean | undefined;
  depositRejects?: boolean | undefined;
} = {}) {
  const balances = [...(opts.balances ?? [0n])];
  return {
    chain: 'base-sepolia',
    addresses,
    walletClient: { account: { address: OWNER } },
    usdcBalance: vi.fn(async () => balances.shift() ?? balances.at(-1) ?? 0n),
    previewWithdrawNet: vi.fn(async () => opts.previewWithdrawNet ?? 1n),
    withdrawAndWait: vi.fn(async () => {
      if (opts.withdrawRejects) throw new Error('withdraw failed');
      return { txHash: HASH_1, usdcReturned: opts.previewWithdrawNet ?? 1n };
    }),
    depositWithPermit: vi.fn(async () => {
      if (opts.depositRejects) throw new Error('deposit failed');
      return HASH_1;
    }),
  } as unknown as Divigent & {
    usdcBalance: ReturnType<typeof vi.fn>;
    previewWithdrawNet: ReturnType<typeof vi.fn>;
    withdrawAndWait: ReturnType<typeof vi.fn>;
    depositWithPermit: ReturnType<typeof vi.fn>;
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ReserveFloor', () => {
  // Uses the configured minimum floor until EMA reserve exceeds it.
  it('uses the configured minimum floor until EMA reserve exceeds it', () => {
    const floor = new ReserveFloor();
    expect(floor.required()).toBe(usdc('1000'));
  });

  // Updates EMA and clamps payment samples by payment cap.
  it('updates EMA and clamps payment samples by payment cap', () => {
    const floor = new ReserveFloor({
      minIdleThreshold: 0n,
      reserveRatio: 0.1,
      reserveMultiplier: 3,
    });

    floor.recordPayment(usdc('1'));
    expect(floor.ema).toBe(usdc('0.2'));
    expect(floor.required()).toBe(usdc('0.06'));

    const clamped = new ReserveFloor({
      minIdleThreshold: 0n,
      reserveRatio: 0.1,
      reserveMultiplier: 3,
    });
    clamped.recordPayment(usdc('1'), usdc('0.1'));
    expect(clamped.ema).toBe(usdc('0.02'));
    expect(clamped.required()).toBe(usdc('0.006'));
  });

  // Handles reserve boundary configuration without inventing extra liquidity.
  it('handles reserve boundary configuration without inventing extra liquidity', () => {
    const zeroRatio = new ReserveFloor({
      minIdleThreshold: usdc('0.000123'),
      reserveRatio: 0,
      reserveMultiplier: 3,
    });
    zeroRatio.recordPayment(usdc('100'));
    expect(zeroRatio.required()).toBe(usdc('0.000123'));

    const zeroMultiplier = new ReserveFloor({
      minIdleThreshold: 0n,
      reserveRatio: 0.1,
      reserveMultiplier: 0,
    });
    zeroMultiplier.recordPayment(usdc('100'));
    expect(zeroMultiplier.required()).toBe(0n);

    const fractional = new ReserveFloor({
      minIdleThreshold: 0n,
      reserveRatio: 0.333,
      reserveMultiplier: 2,
    });
    fractional.recordPayment(usdc('1'));
    expect(fractional.ema).toBe(usdc('0.2'));
    expect(fractional.required()).toBe(usdc('0.134'));
  });

  // Ignores zero and negative payment samples.
  it('ignores zero and negative payment samples', () => {
    const floor = new ReserveFloor({ minIdleThreshold: 0n });
    floor.recordPayment(0n);
    floor.recordPayment(-1n);
    expect(floor.ema).toBe(0n);
    expect(floor.required()).toBe(0n);
  });
});

describe('x402 recall hook policy and liquidity behavior', () => {
  // Ignores non-Divigent x402 contexts.
  it('ignores non-Divigent x402 contexts', async () => {
    const { client, hooks } = createX402Client();
    const divigent = createX402Divigent({ balances: [0n] });
    attachDivigentYield(client as never, divigent);

    await hooks.before?.(x402PaymentContext({
      paymentRequired: { x402Version: 1, resource: { url: 'https://api.example.com/paid' } },
    }));
    await hooks.before?.(x402PaymentContext({
      network: `eip155:${baseSepolia.id + 1}`,
      asset: addresses.usdc,
    }));
    await hooks.before?.(x402PaymentContext({
      network: `eip155:${baseSepolia.id}`,
      asset: '0x9999999999999999999999999999999999999999',
    }));
    await hooks.before?.(x402PaymentContext({
      network: `eip155:${baseSepolia.id}`,
      asset: addresses.usdc,
      scheme: 'permit2',
    }));

    expect(divigent.usdcBalance).not.toHaveBeenCalled();
    expect(divigent.withdrawAndWait).not.toHaveBeenCalled();
  });

  // Prevents duplicate attachment until detached.
  it('prevents duplicate attachment until detached', () => {
    const { client } = createX402Client();
    const divigent = createX402Divigent();

    const handle = attachDivigentYield(client as never, divigent);
    expect(() => attachDivigentYield(client as never, divigent)).toThrow(AlreadyAttachedError);
    handle.detach();
    expect(() => attachDivigentYield(client as never, divigent)).not.toThrow();
  });

  // Enforces payment caps before recall.
  it('enforces payment caps before recall', async () => {
    const { client, hooks } = createX402Client();
    const divigent = createX402Divigent();
    attachDivigentYield(client as never, divigent, { maxPaymentAmount: usdc('0.000100') });

    await expect(
      hooks.before?.(x402PaymentContext({ amount: usdc('0.000101') })),
    ).rejects.toBeInstanceOf(PaymentCapExceededError);
    expect(divigent.usdcBalance).not.toHaveBeenCalled();
  });

  // Uses the tighter resource-specific payment cap before checking balances.
  it('uses the tighter resource-specific payment cap before checking balances', async () => {
    const { client, hooks } = createX402Client();
    const divigent = createX402Divigent({ balances: [usdc('0.001')] });
    attachDivigentYield(client as never, divigent, {
      maxPaymentAmount: usdc('0.001'),
      maxPaymentAmountByResource: {
        'https://api.example.com/expensive': usdc('0.000250'),
      },
    });

    await expect(
      hooks.before?.(x402PaymentContext({
        amount: usdc('0.000251'),
        resource: 'https://api.example.com/expensive',
      })),
    ).rejects.toBeInstanceOf(PaymentCapExceededError);
    expect(divigent.usdcBalance).not.toHaveBeenCalled();
  });

  // Supports array resource caps and falls back to the global cap on pattern miss.
  it('supports array resource caps and falls back to the global cap on pattern miss', async () => {
    const { client, hooks } = createX402Client();
    const divigent = createX402Divigent({ balances: [usdc('0.001')] });
    attachDivigentYield(client as never, divigent, {
      maxPaymentAmount: usdc('0.001'),
      maxPaymentAmountByResource: [
        ['https://api.example.com/premium/*', usdc('0.000250')],
      ],
      minIdleThreshold: 0n,
    });

    await expect(
      hooks.before?.(x402PaymentContext({
        amount: usdc('0.000251'),
        resource: 'https://api.example.com/premium/1',
      })),
    ).rejects.toBeInstanceOf(PaymentCapExceededError);

    await expect(
      hooks.before?.(x402PaymentContext({
        amount: usdc('0.000251'),
        resource: 'https://api.example.com/basic/1',
      })),
    ).resolves.toBeUndefined();

    expect(divigent.usdcBalance).toHaveBeenCalledTimes(1);
  });

  // Supports regex and array resource policies before touching wallet funds.
  it('supports regex and array resource policies before touching wallet funds', async () => {
    const { client, hooks } = createX402Client();
    const divigent = createX402Divigent({ balances: [usdc('0.01')] });
    attachDivigentYield(client as never, divigent, {
      allowedResources: [
        'https://api.example.com/free/*',
        /^https:\/\/api\.example\.com\/paid\/\d+$/,
      ],
      minIdleThreshold: 0n,
    });

    await hooks.before?.(x402PaymentContext({
      resource: 'https://api.example.com/admin/1',
    }));
    await hooks.before?.(x402PaymentContext({
      resource: 'https://api.example.com/paid/42',
    }));

    expect(divigent.usdcBalance).toHaveBeenCalledTimes(1);
  });

  // Blocks missing policy fields before touching wallet funds.
  it('blocks missing policy fields before touching wallet funds', async () => {
    const { client, hooks } = createX402Client();
    const divigent = createX402Divigent({ balances: [usdc('0.01')] });
    attachDivigentYield(client as never, divigent, {
      allowedPayTo: [SELLER],
      allowedResource: 'https://api.example.com/*',
      allowedOrigin: 'https://api.example.com',
      minIdleThreshold: 0n,
    });

    await hooks.before?.(x402PaymentContext({ payTo: '' }));
    await hooks.before?.(x402PaymentContext({ payTo: SELLER, resource: '' }));
    await hooks.before?.(x402PaymentContext({ payTo: SELLER, resource: 'not-a-url' }));

    expect(divigent.usdcBalance).not.toHaveBeenCalled();
  });

  // Applies payTo, resource, origin, and custom policy filters.
  it('applies payTo, resource, origin, and custom policy filters', async () => {
    const { client, hooks } = createX402Client();
    const divigent = createX402Divigent({ balances: [usdc('0.01')] });
    const shouldHandlePayment = vi.fn(() => true);
    attachDivigentYield(client as never, divigent, {
      allowedPayTo: [SELLER],
      allowedResource: 'https://api.example.com/*',
      allowedOrigin: 'https://api.example.com',
      shouldHandlePayment,
      minIdleThreshold: 0n,
    });

    await hooks.before?.(x402PaymentContext({
      payTo: '0x5555555555555555555555555555555555555555',
    }));
    await hooks.before?.(x402PaymentContext({
      payTo: SELLER,
      resource: 'https://evil.example.com/paid',
    }));
    await hooks.before?.(x402PaymentContext({
      payTo: SELLER,
      resource: 'https://api.example.com/paid',
    }));

    expect(shouldHandlePayment).toHaveBeenCalledTimes(1);
    expect(divigent.usdcBalance).toHaveBeenCalledTimes(1);
  });

  // Honors custom policy false returns and propagates policy callback failures.
  it('honors custom policy false returns and propagates policy callback failures', async () => {
    const blocked = createX402Client();
    const blockedDivigent = createX402Divigent({ balances: [usdc('0.01')] });
    attachDivigentYield(blocked.client as never, blockedDivigent, {
      shouldHandlePayment: () => false,
    });

    await blocked.hooks.before?.(x402PaymentContext());
    expect(blockedDivigent.usdcBalance).not.toHaveBeenCalled();

    const failing = createX402Client();
    const failingDivigent = createX402Divigent({ balances: [usdc('0.01')] });
    attachDivigentYield(failing.client as never, failingDivigent, {
      shouldHandlePayment: () => {
        throw new Error('policy unavailable');
      },
    });

    await expect(failing.hooks.before?.(x402PaymentContext())).rejects.toThrow('policy unavailable');
    expect(failingDivigent.usdcBalance).not.toHaveBeenCalled();
  });

  // Does not withdraw when wallet balance covers payment plus reserve.
  it('does not withdraw when wallet balance covers payment plus reserve', async () => {
    const { client, hooks } = createX402Client();
    const onBeforePayment = vi.fn();
    const divigent = createX402Divigent({ balances: [usdc('1.5')] });
    attachDivigentYield(client as never, divigent, {
      minIdleThreshold: usdc('0.5'),
      onBeforePayment,
    });

    await hooks.before?.(x402PaymentContext({ amount: usdc('1') }));

    expect(divigent.previewWithdrawNet).not.toHaveBeenCalled();
    expect(divigent.withdrawAndWait).not.toHaveBeenCalled();
    expect(onBeforePayment).toHaveBeenCalledWith(expect.objectContaining({
      paymentAmount: usdc('1'),
      walletBalance: usdc('1.5'),
      reserveFloor: usdc('0.5'),
      deficit: 0n,
    }));
  });

  // Recalls only the deficit needed for payment plus reserve.
  it('recalls only the deficit needed for payment plus reserve', async () => {
    const { client, hooks } = createX402Client();
    const onBeforePayment = vi.fn();
    const divigent = createX402Divigent({
      balances: [usdc('0.1'), usdc('1.5')],
      previewWithdrawNet: usdc('1.400001'),
    });
    attachDivigentYield(client as never, divigent, {
      minIdleThreshold: usdc('0.5'),
      slippageBps: 75,
      onBeforePayment,
    });

    await hooks.before?.(x402PaymentContext({ amount: usdc('1') }));

    expect(divigent.previewWithdrawNet).toHaveBeenCalledWith(usdc('1.4'), OWNER);
    expect(divigent.withdrawAndWait).toHaveBeenCalledWith({
      shares: usdc('1.400001'),
      wallet: OWNER,
      slippageBps: 75,
    });
    expect(onBeforePayment).toHaveBeenCalledWith(expect.objectContaining({
      paymentAmount: usdc('1'),
      walletBalance: usdc('0.1'),
      reserveFloor: usdc('0.5'),
      deficit: usdc('1.4'),
      recallShares: usdc('1.400001'),
      recallTxHash: HASH_1,
    }));
  });

  // Handles exact-balance and one-atomic-unit deficit boundaries.
  it('handles exact-balance and one-atomic-unit deficit boundaries', async () => {
    const exact = createX402Client();
    const exactDivigent = createX402Divigent({ balances: [usdc('1.5')] });
    attachDivigentYield(exact.client as never, exactDivigent, {
      minIdleThreshold: usdc('0.5'),
    });

    await exact.hooks.before?.(x402PaymentContext({ amount: usdc('1') }));
    expect(exactDivigent.previewWithdrawNet).not.toHaveBeenCalled();
    expect(exactDivigent.withdrawAndWait).not.toHaveBeenCalled();

    const oneUnitShort = createX402Client();
    const shortDivigent = createX402Divigent({
      balances: [usdc('1.499999'), usdc('1.5')],
      previewWithdrawNet: 1n,
    });
    attachDivigentYield(oneUnitShort.client as never, shortDivigent, {
      minIdleThreshold: usdc('0.5'),
    });

    await oneUnitShort.hooks.before?.(x402PaymentContext({ amount: usdc('1') }));
    expect(shortDivigent.previewWithdrawNet).toHaveBeenCalledWith(1n, OWNER);
    expect(shortDivigent.withdrawAndWait).toHaveBeenCalledWith(expect.objectContaining({
      shares: 1n,
      wallet: OWNER,
    }));
  });

  // Does not withdraw when the contract preview says a deficit rounds to zero shares.
  it('does not withdraw when the contract preview says a deficit rounds to zero shares', async () => {
    const { client, hooks } = createX402Client();
    const onBeforePayment = vi.fn();
    const divigent = createX402Divigent({
      balances: [usdc('0.1')],
      previewWithdrawNet: 0n,
    });
    attachDivigentYield(client as never, divigent, {
      minIdleThreshold: usdc('0.5'),
      onBeforePayment,
    });

    await hooks.before?.(x402PaymentContext({ amount: usdc('1') }));

    expect(divigent.previewWithdrawNet).toHaveBeenCalledWith(usdc('1.4'), OWNER);
    expect(divigent.withdrawAndWait).not.toHaveBeenCalled();
    expect(onBeforePayment).toHaveBeenCalledWith(expect.objectContaining({
      deficit: usdc('1.4'),
    }));
    expect(onBeforePayment.mock.calls[0]?.[0]).not.toHaveProperty('recallShares');
  });

  // Does not treat a mined recall as safe until wallet balance reaches the required floor.
  it('does not treat a mined recall as safe until wallet balance reaches the required floor', async () => {
    vi.useFakeTimers();
    const { client, hooks } = createX402Client();
    const onBeforePayment = vi.fn();
    const divigent = createX402Divigent({
      balances: [usdc('0.1'), usdc('0.1'), usdc('0.1')],
      previewWithdrawNet: usdc('1.400001'),
    });
    attachDivigentYield(client as never, divigent, {
      minIdleThreshold: usdc('0.5'),
      onBeforePayment,
    });

    const pending = hooks.before?.(x402PaymentContext({ amount: usdc('1') }));
    await vi.advanceTimersByTimeAsync(60_001);
    await pending;

    expect(divigent.withdrawAndWait).toHaveBeenCalledWith(expect.objectContaining({
      shares: usdc('1.400001'),
      wallet: OWNER,
    }));
    expect(onBeforePayment).toHaveBeenCalledWith(expect.objectContaining({
      paymentAmount: usdc('1'),
      deficit: usdc('1.4'),
      recallError: expect.objectContaining({
        code: 'DIVIGENT_X402_RECALL_BALANCE_TIMEOUT',
        category: 'x402',
      }),
    }));
  });

  // Ignores after/failure hooks that were not preceded by a handled payment.
  it('ignores after/failure hooks that were not preceded by a handled payment', async () => {
    const { client, hooks } = createX402Client();
    const onAfterPaymentCreation = vi.fn();
    const onPaymentFailure = vi.fn();
    const divigent = createX402Divigent({ balances: [usdc('1')] });
    attachDivigentYield(client as never, divigent, {
      onAfterPaymentCreation,
      onPaymentFailure,
    });
    const ctx = x402PaymentContext({ amount: usdc('1') });

    await hooks.after?.(ctx);
    await hooks.failure?.(ctx);

    expect(divigent.usdcBalance).not.toHaveBeenCalled();
    expect(onAfterPaymentCreation).not.toHaveBeenCalled();
    expect(onPaymentFailure).not.toHaveBeenCalled();
  });

  // Does not run hooks after detach.
  it('does not run hooks after detach', async () => {
    const { client, hooks } = createX402Client();
    const divigent = createX402Divigent({ balances: [usdc('1')] });
    const handle = attachDivigentYield(client as never, divigent);
    handle.detach();

    const ctx = x402PaymentContext({ amount: usdc('1') });
    await hooks.before?.(ctx);
    await hooks.after?.(ctx);
    await hooks.failure?.(ctx);

    expect(divigent.usdcBalance).not.toHaveBeenCalled();
    expect(divigent.withdrawAndWait).not.toHaveBeenCalled();
    expect(divigent.depositWithPermit).not.toHaveBeenCalled();
  });

  // Serializes concurrent recall checks per attached client.
  it('serializes concurrent recall checks per attached client', async () => {
    const { client, hooks } = createX402Client();
    let inFlight = 0;
    let maxInFlight = 0;
    const divigent = {
      chain: 'base-sepolia',
      addresses,
      walletClient: { account: { address: OWNER } },
      usdcBalance: vi.fn(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return usdc('2');
      }),
      previewWithdrawNet: vi.fn(),
      withdrawAndWait: vi.fn(),
      depositWithPermit: vi.fn(),
    } as unknown as Divigent & {
      usdcBalance: ReturnType<typeof vi.fn>;
      previewWithdrawNet: ReturnType<typeof vi.fn>;
      withdrawAndWait: ReturnType<typeof vi.fn>;
      depositWithPermit: ReturnType<typeof vi.fn>;
    };
    attachDivigentYield(client as never, divigent, { minIdleThreshold: 0n });

    await Promise.all([
      hooks.before?.(x402PaymentContext({ amount: usdc('1') })),
      hooks.before?.(x402PaymentContext({ amount: usdc('1') })),
    ]);

    expect(maxInFlight).toBe(1);
    expect(divigent.usdcBalance).toHaveBeenCalledTimes(2);
    expect(divigent.withdrawAndWait).not.toHaveBeenCalled();
  });

  // Records successful payments into the reserve EMA after x402 creates payment payload.
  it('records successful payments into the reserve EMA after x402 creates payment payload', async () => {
    const { client, hooks } = createX402Client();
    const onAfterPaymentCreation = vi.fn();
    const divigent = createX402Divigent({ balances: [usdc('1'), usdc('0.8')] });
    attachDivigentYield(client as never, divigent, {
      minIdleThreshold: 0n,
      reserveRatio: 0.1,
      reserveMultiplier: 3,
      onAfterPaymentCreation,
    });
    const ctx = x402PaymentContext({ amount: usdc('1') });

    await hooks.before?.(ctx);
    await hooks.after?.(ctx);

    expect(onAfterPaymentCreation).toHaveBeenCalledWith(expect.objectContaining({
      paymentAmount: usdc('1'),
      walletBalance: usdc('0.8'),
      reserveFloor: usdc('0.06'),
      deficit: 0n,
    }));
  });

  // Redeposits recalled USDC when x402 payment creation fails after recall.
  it('redeposits recalled USDC when x402 payment creation fails after recall', async () => {
    const { client, hooks } = createX402Client();
    const onPaymentFailure = vi.fn();
    const divigent = createX402Divigent({
      balances: [usdc('0.1'), usdc('1.5'), usdc('1.5')],
      previewWithdrawNet: usdc('1.400001'),
    });
    attachDivigentYield(client as never, divigent, {
      minIdleThreshold: usdc('0.5'),
      onPaymentFailure,
    });
    const ctx = x402PaymentContext({ amount: usdc('1') });

    await hooks.before?.(ctx);
    await hooks.failure?.(ctx);

    expect(divigent.depositWithPermit).toHaveBeenCalledWith({
      amount: usdc('1.4'),
      wallet: OWNER,
    });
    expect(onPaymentFailure).toHaveBeenCalledWith(expect.objectContaining({
      paymentAmount: usdc('1'),
      recalledUsdc: true,
      redepositAmount: usdc('1.4'),
      redepositTxHash: HASH_1,
    }));
  });

  // Keeps recalled USDC liquid when redeposit after payment failure reverts.
  it('keeps recalled USDC liquid when redeposit after payment failure reverts', async () => {
    const { client, hooks } = createX402Client();
    const onPaymentFailure = vi.fn();
    const divigent = createX402Divigent({
      balances: [usdc('0.1'), usdc('1.5'), usdc('1.5')],
      previewWithdrawNet: usdc('1.400001'),
      depositRejects: true,
    });
    attachDivigentYield(client as never, divigent, {
      minIdleThreshold: usdc('0.5'),
      onPaymentFailure,
    });
    const ctx = x402PaymentContext({ amount: usdc('1') });

    await hooks.before?.(ctx);
    await hooks.failure?.(ctx);

    expect(divigent.depositWithPermit).toHaveBeenCalledWith({
      amount: usdc('1.4'),
      wallet: OWNER,
    });
    expect(onPaymentFailure).toHaveBeenCalledWith(expect.objectContaining({
      paymentAmount: usdc('1'),
      recalledUsdc: true,
      redepositAmount: usdc('1.4'),
    }));
    expect(onPaymentFailure.mock.calls[0]?.[0]).not.toHaveProperty('redepositTxHash');
  });

  // Does not redeposit on payment failure when no excess USDC remains.
  it('does not redeposit on payment failure when no excess USDC remains', async () => {
    const { client, hooks } = createX402Client();
    const onPaymentFailure = vi.fn();
    const divigent = createX402Divigent({
      balances: [usdc('0.1'), usdc('1.5'), usdc('0.1')],
      previewWithdrawNet: usdc('1.400001'),
    });
    attachDivigentYield(client as never, divigent, {
      minIdleThreshold: usdc('0.5'),
      onPaymentFailure,
    });
    const ctx = x402PaymentContext({ amount: usdc('1') });

    await hooks.before?.(ctx);
    await hooks.failure?.(ctx);

    expect(divigent.depositWithPermit).not.toHaveBeenCalled();
    expect(onPaymentFailure).toHaveBeenCalledWith(expect.objectContaining({
      recalledUsdc: true,
    }));
    expect(onPaymentFailure.mock.calls[0]?.[0]).not.toHaveProperty('redepositAmount');
  });

  // Keeps observer failures non-fatal and normalized through onNonFatalError.
  it('keeps observer failures non-fatal and normalized through onNonFatalError', async () => {
    const { client, hooks } = createX402Client();
    const onNonFatalError = vi.fn();
    const divigent = createX402Divigent({ balances: [usdc('1.5')] });
    attachDivigentYield(client as never, divigent, {
      minIdleThreshold: usdc('0.5'),
      onBeforePayment: () => {
        throw new Error('observer down');
      },
      onNonFatalError,
    });

    await expect(
      hooks.before?.(x402PaymentContext({ amount: usdc('1') })),
    ).resolves.toBeUndefined();
    expect(onNonFatalError).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'observer',
      label: 'onBeforePayment',
      recoverable: true,
      error: expect.objectContaining({
        code: 'DIVIGENT_X402_NON_FATAL',
        category: 'x402',
      }),
    }));
  });

  // Surfaces recall failures as observer context without blocking x402 payment creation.
  it('surfaces recall failures as observer context without blocking x402 payment creation', async () => {
    const { client, hooks } = createX402Client();
    const onBeforePayment = vi.fn();
    const divigent = createX402Divigent({
      balances: [usdc('0.1')],
      withdrawRejects: true,
    });
    attachDivigentYield(client as never, divigent, {
      minIdleThreshold: usdc('0.5'),
      onBeforePayment,
    });

    await expect(
      hooks.before?.(x402PaymentContext({ amount: usdc('1') })),
    ).resolves.toBeUndefined();
    expect(onBeforePayment).toHaveBeenCalledWith(expect.objectContaining({
      deficit: usdc('1.4'),
      recallError: expect.any(Error),
    }));
  });

  // Redacts wallet and tx hash in observer callbacks when requested.
  it('redacts wallet and tx hash in observer callbacks when requested', async () => {
    const { client, hooks } = createX402Client();
    const onBeforePayment = vi.fn();
    const divigent = createX402Divigent({
      balances: [usdc('0.1'), usdc('1.5')],
      previewWithdrawNet: usdc('1.400001'),
    });
    attachDivigentYield(client as never, divigent, {
      minIdleThreshold: usdc('0.5'),
      redact: true,
      onBeforePayment,
    });

    await hooks.before?.(x402PaymentContext({ amount: usdc('1') }));

    const payload = onBeforePayment.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.wallet).toBe('0x1111…1111');
    expect(payload.recallTxHash).toBeUndefined();
  });
});
