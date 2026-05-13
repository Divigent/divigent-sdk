import { afterEach, describe, expect, it, vi } from 'vitest';
import { baseSepolia } from 'viem/chains';
import { AlreadyAttachedError, PaymentCapExceededError } from '../../src/errors';
import { attachDivigentYield } from '../../src/x402/attach';
import { ReserveFloor } from '../../src/x402/attach';
import {
  HASH_1,
  OWNER,
  SELLER,
  addresses,
  createX402Client,
  createX402Divigent,
  usdc,
  x402PaymentContext,
} from './helpers';

afterEach(() => {
  vi.useRealTimers();
});

describe('ReserveFloor', () => {
  // Exercises: uses the configured minimum floor until EMA reserve exceeds it.
  it('uses the configured minimum floor until EMA reserve exceeds it', () => {
    const floor = new ReserveFloor();
    expect(floor.required()).toBe(usdc('1000'));
  });

  // Exercises: updates EMA and clamps payment samples by payment cap.
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

  // Exercises: handles reserve boundary configuration without inventing extra liquidity.
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

  // Exercises: ignores zero and negative payment samples.
  it('ignores zero and negative payment samples', () => {
    const floor = new ReserveFloor({ minIdleThreshold: 0n });
    floor.recordPayment(0n);
    floor.recordPayment(-1n);
    expect(floor.ema).toBe(0n);
    expect(floor.required()).toBe(0n);
  });
});

describe('x402 recall hook policy and liquidity behavior', () => {
  // Exercises: ignores malformed or non-Divigent x402 payment contexts.
  it.each([
    [
      'unsupported x402 version',
      { paymentRequired: { x402Version: 1, resource: { url: 'https://api.example.com/paid' } } },
    ],
    ['wrong network', { network: `eip155:${baseSepolia.id + 1}`, asset: addresses.usdc }],
    [
      'wrong asset',
      { network: `eip155:${baseSepolia.id}`, asset: '0x9999999999999999999999999999999999999999' },
    ],
    ['wrong scheme', { network: `eip155:${baseSepolia.id}`, asset: addresses.usdc, scheme: 'permit2' }],
  ] as const)('ignores non-Divigent x402 context: %s', async (_label, context) => {
    const { client, hooks } = createX402Client();
    const divigent = createX402Divigent({ balances: [0n] });
    attachDivigentYield(client as never, divigent);

    await hooks.before?.(x402PaymentContext(context));

    expect(divigent.usdcBalance).not.toHaveBeenCalled();
    expect(divigent.withdrawAndWait).not.toHaveBeenCalled();
  });

  // Exercises: prevents duplicate attachment until detached.
  it('prevents duplicate attachment until detached', () => {
    const { client } = createX402Client();
    const divigent = createX402Divigent();

    const handle = attachDivigentYield(client as never, divigent);
    expect(() => attachDivigentYield(client as never, divigent)).toThrow(AlreadyAttachedError);
    handle.detach();
    expect(() => attachDivigentYield(client as never, divigent)).not.toThrow();
  });

  // Exercises: enforces payment caps before recall.
  it('enforces payment caps before recall', async () => {
    const { client, hooks } = createX402Client();
    const divigent = createX402Divigent();
    attachDivigentYield(client as never, divigent, { maxPaymentAmount: usdc('0.000100') });

    await expect(
      hooks.before?.(x402PaymentContext({ amount: usdc('0.000101') })),
    ).rejects.toBeInstanceOf(PaymentCapExceededError);
    expect(divigent.usdcBalance).not.toHaveBeenCalled();
  });

  // Exercises: uses the tighter resource-specific payment cap before checking balances.
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

  // Exercises: applies ordered resource-specific payment caps.
  it.each([
    [
      'matching resource cap',
      'https://api.example.com/premium/1',
      true,
    ],
    [
      'global cap on pattern miss',
      'https://api.example.com/basic/1',
      false,
    ],
  ] as const)('applies array resource cap policy: %s', async (_label, resource, shouldReject) => {
    const { client, hooks } = createX402Client();
    const divigent = createX402Divigent({ balances: [usdc('0.001')] });
    attachDivigentYield(client as never, divigent, {
      maxPaymentAmount: usdc('0.001'),
      maxPaymentAmountByResource: [
        ['https://api.example.com/premium/*', usdc('0.000250')],
      ],
      minIdleThreshold: 0n,
    });

    const payment = hooks.before?.(x402PaymentContext({
      amount: usdc('0.000251'),
      resource,
    }));
    if (shouldReject) {
      await expect(payment).rejects.toBeInstanceOf(PaymentCapExceededError);
      expect(divigent.usdcBalance).not.toHaveBeenCalled();
    } else {
      await expect(payment).resolves.toBeUndefined();
      expect(divigent.usdcBalance).toHaveBeenCalledTimes(1);
    }
  });

  // Exercises: applies ordered resource allowlist rules before recall.
  it.each([
    ['blocked resource', 'https://api.example.com/admin/1', false],
    ['regex-allowed resource', 'https://api.example.com/paid/42', true],
  ] as const)('applies array resource allow policy: %s', async (_label, resource, shouldHandle) => {
    const { client, hooks } = createX402Client();
    const divigent = createX402Divigent({ balances: [usdc('0.01')] });
    attachDivigentYield(client as never, divigent, {
      allowedResources: [
        'https://api.example.com/free/*',
        /^https:\/\/api\.example\.com\/paid\/\d+$/,
      ],
      minIdleThreshold: 0n,
    });

    await hooks.before?.(x402PaymentContext({ resource }));

    expect(divigent.usdcBalance).toHaveBeenCalledTimes(shouldHandle ? 1 : 0);
  });

  // Exercises: blocks incomplete or malformed payment policy inputs before wallet reads.
  it.each([
    ['missing payTo', { payTo: '' }],
    ['missing resource', { payTo: SELLER, resource: '' }],
    ['malformed resource', { payTo: SELLER, resource: 'not-a-url' }],
  ] as const)('blocks %s before touching wallet funds', async (_label, context) => {
    const { client, hooks } = createX402Client();
    const divigent = createX402Divigent({ balances: [usdc('0.01')] });
    attachDivigentYield(client as never, divigent, {
      allowedPayTo: [SELLER],
      allowedResource: 'https://api.example.com/*',
      allowedOrigin: 'https://api.example.com',
      minIdleThreshold: 0n,
    });

    await hooks.before?.(x402PaymentContext(context));

    expect(divigent.usdcBalance).not.toHaveBeenCalled();
  });

  // Exercises: applies payTo, resource, and origin policy filters.
  it.each([
    ['payTo allowlist', { payTo: '0x5555555555555555555555555555555555555555' }, false],
    ['resource origin allowlist', { payTo: SELLER, resource: 'https://evil.example.com/paid' }, false],
    ['allowed payment', { payTo: SELLER, resource: 'https://api.example.com/paid' }, true],
  ] as const)('applies %s policy filter', async (_label, context, shouldHandle) => {
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

    await hooks.before?.(x402PaymentContext(context));

    expect(shouldHandlePayment).toHaveBeenCalledTimes(shouldHandle ? 1 : 0);
    expect(divigent.usdcBalance).toHaveBeenCalledTimes(shouldHandle ? 1 : 0);
  });

  // Exercises: honors custom policy false returns.
  it('honors custom policy false returns', async () => {
    const { client, hooks } = createX402Client();
    const divigent = createX402Divigent({ balances: [usdc('0.01')] });
    attachDivigentYield(client as never, divigent, {
      shouldHandlePayment: () => false,
    });

    await hooks.before?.(x402PaymentContext());
    expect(divigent.usdcBalance).not.toHaveBeenCalled();
  });

  // Exercises: propagates custom policy callback failures.
  it('propagates custom policy callback failures', async () => {
    const { client, hooks } = createX402Client();
    const divigent = createX402Divigent({ balances: [usdc('0.01')] });
    attachDivigentYield(client as never, divigent, {
      shouldHandlePayment: () => {
        throw new Error('policy unavailable');
      },
    });

    await expect(hooks.before?.(x402PaymentContext())).rejects.toThrow('policy unavailable');
    expect(divigent.usdcBalance).not.toHaveBeenCalled();
  });

  // Exercises: does not withdraw when wallet balance covers payment plus reserve.
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

  // Exercises: recalls only the deficit needed for payment plus reserve.
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

  // Exercises: handles exact-balance and one-atomic-unit deficit boundaries.
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

  // Exercises: does not withdraw when the contract preview says a deficit rounds to zero shares.
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

  // Exercises: does not treat a mined recall as safe until wallet balance reaches the required floor.
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

  // Exercises: ignores after/failure hooks that were not preceded by a handled payment.
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

  // Exercises: does not run hooks after detach.
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

  // Exercises: serializes concurrent recall checks per attached client.
  it('serializes concurrent recall checks per attached client', async () => {
    const { client, hooks } = createX402Client();
    let inFlight = 0;
    let maxInFlight = 0;
    const divigent = createX402Divigent({
      usdcBalance: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return usdc('2');
      },
    });
    attachDivigentYield(client as never, divigent, { minIdleThreshold: 0n });

    await Promise.all([
      hooks.before?.(x402PaymentContext({ amount: usdc('1') })),
      hooks.before?.(x402PaymentContext({ amount: usdc('1') })),
    ]);

    expect(maxInFlight).toBe(1);
    expect(divigent.usdcBalance).toHaveBeenCalledTimes(2);
    expect(divigent.withdrawAndWait).not.toHaveBeenCalled();
  });

  // Exercises: records successful payments into the reserve EMA after x402 creates payment payload.
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

  // Exercises: redeposits recalled USDC when x402 payment creation fails after recall.
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

  // Exercises: keeps recalled USDC liquid when redeposit after payment failure reverts.
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

  // Exercises: does not redeposit on payment failure when no excess USDC remains.
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

  // Exercises: keeps observer failures non-fatal and normalized through onNonFatalError.
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

  // Exercises: surfaces recall failures as observer context without blocking x402 payment creation.
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

  // Exercises: redacts wallet and tx hash in observer callbacks when requested.
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
