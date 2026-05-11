import { describe, expect, it } from 'vitest';
import {
  applyBps,
  applyFee,
  applySlippageDown,
  convertToAssets,
  convertToShares,
  rescaleDecimals,
} from '../../src/core/utils';
import { ReserveFloor } from '../../src/x402/attach';
import { attachDivigentYield } from '../../src/x402/attach';
import { depositIdleAboveFloor } from '../../src/x402/settlement';
import {
  HASH_1,
  OWNER,
  createX402Client,
  createX402Divigent,
  usdc,
  x402PaymentContext,
} from '../helpers';

function pseudoRandom(seed: bigint): () => bigint {
  let state = seed;
  return () => {
    state = (state * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) %
      (2n ** 64n);
    return state;
  };
}

describe('capital safety invariants', () => {
  it('never derives a slippage or fee output above the input amount', () => {
    const next = pseudoRandom(7n);

    for (let i = 0; i < 500; i++) {
      const amount = next() % 10n ** 24n;
      const bps = Number(next() % 10_001n);

      const slipped = applySlippageDown(amount, bps);
      const fee = applyFee(amount, BigInt(bps));
      const bpsAmount = applyBps(amount, bps);

      expect(slipped).toBeGreaterThanOrEqual(0n);
      expect(slipped).toBeLessThanOrEqual(amount);
      expect(fee).toBeGreaterThanOrEqual(0n);
      expect(fee).toBeLessThanOrEqual(amount);
      expect(bpsAmount).toBeGreaterThanOrEqual(0n);
      expect(bpsAmount).toBeLessThanOrEqual(amount);

      if (bps === 0) expect(slipped).toBe(amount);
      if (bps === 10_000) expect(slipped).toBe(0n);
    }
  });

  it('keeps virtual share conversion round trips conservative under floor rounding', () => {
    const next = pseudoRandom(11n);

    for (let i = 0; i < 500; i++) {
      const assets = (next() % 10n ** 18n) + 1n;
      const shares = (next() % 10n ** 18n) + 1n;
      const totalSupply = next() % 10n ** 20n;
      const totalAssets = next() % 10n ** 20n;

      const mintedShares = convertToShares(assets, totalSupply, totalAssets);
      const assetsBack = convertToAssets(mintedShares, totalSupply, totalAssets);
      expect(assetsBack).toBeLessThanOrEqual(assets);

      const redeemedAssets = convertToAssets(shares, totalSupply, totalAssets);
      const sharesBack = convertToShares(redeemedAssets, totalSupply, totalAssets);
      expect(sharesBack).toBeLessThanOrEqual(shares);
    }
  });

  it('keeps decimal downscaling between floor and ceil bounds', () => {
    const next = pseudoRandom(19n);

    for (let i = 0; i < 300; i++) {
      const amount = next() % 10n ** 24n;
      const fromDecimals = 6 + Number(next() % 13n);
      const toDecimals = Number(next() % 7n);
      if (fromDecimals <= toDecimals) continue;

      const floor = rescaleDecimals(amount, fromDecimals, toDecimals, 'floor');
      const ceil = rescaleDecimals(amount, fromDecimals, toDecimals, 'ceil');

      expect(ceil).toBeGreaterThanOrEqual(floor);
      expect(ceil - floor).toBeLessThanOrEqual(1n);

      const floorBack = rescaleDecimals(floor, toDecimals, fromDecimals, 'floor');
      const ceilBack = rescaleDecimals(ceil, toDecimals, fromDecimals, 'floor');
      expect(floorBack).toBeLessThanOrEqual(amount);
      expect(ceilBack).toBeGreaterThanOrEqual(amount);
    }
  });

  it('keeps reserve EMA between previous EMA and the capped payment sample', () => {
    const next = pseudoRandom(23n);
    const floor = new ReserveFloor({
      minIdleThreshold: usdc('0.000123'),
      reserveRatio: 0.1,
      reserveMultiplier: 3,
    });

    for (let i = 0; i < 300; i++) {
      const previous = floor.ema;
      const amount = next() % usdc('1000000');
      const cap = next() % usdc('10000');
      const sample = amount > cap ? cap : amount;

      floor.recordPayment(amount, cap);

      const lower = previous < sample ? previous : sample;
      const upper = previous > sample ? previous : sample;
      expect(floor.ema).toBeGreaterThanOrEqual(lower);
      expect(floor.ema).toBeLessThanOrEqual(upper);
      expect(floor.required()).toBeGreaterThanOrEqual(usdc('0.000123'));
    }
  });

  it('x402 recall asks the contract only for the exact liquidity deficit', async () => {
    const cases = [
      { balance: usdc('0'), payment: usdc('1'), floor: usdc('0.1') },
      { balance: usdc('0.000001'), payment: usdc('1'), floor: usdc('0.1') },
      { balance: usdc('1.099999'), payment: usdc('1'), floor: usdc('0.1') },
      { balance: usdc('10'), payment: usdc('7.777'), floor: usdc('0.999') },
      { balance: usdc('5'), payment: usdc('4.999999'), floor: usdc('0.000002') },
    ];

    for (const item of cases) {
      const needed = item.payment + item.floor;
      const deficit = item.balance >= needed ? 0n : needed - item.balance;
      const { client, hooks } = createX402Client();
      const divigent = createX402Divigent({
        balances: [item.balance, needed],
        previewWithdrawNet: (deficit) => deficit + 1n,
      });
      attachDivigentYield(client as never, divigent, {
        minIdleThreshold: item.floor,
        maxPaymentAmount: needed + 1n,
      });

      await hooks.before?.(x402PaymentContext({ amount: item.payment }));

      if (deficit === 0n) {
        expect(divigent.previewWithdrawNet).not.toHaveBeenCalled();
        expect(divigent.withdrawAndWait).not.toHaveBeenCalled();
      } else {
        expect(divigent.previewWithdrawNet).toHaveBeenCalledWith(deficit, OWNER);
        expect(divigent.withdrawAndWait).toHaveBeenCalledWith(expect.objectContaining({
          shares: deficit + 1n,
          wallet: OWNER,
        }));
      }
    }
  });

  it('x402 recall never acts on payments above the cap', async () => {
    const { client, hooks } = createX402Client();
    const divigent = createX402Divigent({
      balances: [0n],
      previewWithdrawNet: (deficit) => deficit,
    });
    attachDivigentYield(client as never, divigent, {
      maxPaymentAmount: usdc('0.000099'),
      minIdleThreshold: 0n,
    });

    await expect(
      hooks.before?.(x402PaymentContext({ amount: usdc('0.000100') })),
    ).rejects.toMatchObject({
      code: 'DIVIGENT_X402_PAYMENT_CAP_EXCEEDED',
    });
    expect(divigent.usdcBalance).not.toHaveBeenCalled();
    expect(divigent.previewWithdrawNet).not.toHaveBeenCalled();
    expect(divigent.withdrawAndWait).not.toHaveBeenCalled();
  });

  it('idle redeposit never deposits the reserve floor or sub-threshold dust', async () => {
    const balances = [
      usdc('0'),
      usdc('0.000001'),
      usdc('0.000099'),
      usdc('0.000100'),
      usdc('0.000101'),
      usdc('0.000149'),
      usdc('0.000150'),
      usdc('0.001'),
    ];

    for (const balance of balances) {
      const divigent = createX402Divigent({ balances: [balance] });
      const txHash = await depositIdleAboveFloor(
        divigent,
        new ReserveFloor({ minIdleThreshold: usdc('0.000100') }),
        { minDeposit: usdc('0.000050') },
      );
      const idle = balance > usdc('0.000100') ? balance - usdc('0.000100') : 0n;

      if (idle < usdc('0.000050')) {
        expect(txHash).toBeUndefined();
        expect(divigent.depositWithPermit).not.toHaveBeenCalled();
      } else {
        expect(txHash).toBe(HASH_1);
        expect(divigent.depositWithPermit).toHaveBeenCalledWith({
          amount: idle,
          wallet: OWNER,
        });
      }
    }
  });
});
