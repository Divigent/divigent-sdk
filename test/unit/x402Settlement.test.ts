import { describe, expect, it, vi } from 'vitest';
import { ReserveFloor } from '../../src/x402/attach';
import {
  attachDivigentIncome,
  depositIdleAboveFloor,
  handleDivigentSettlement,
  wrapFetchWithDivigentYield,
} from '../../src/x402/settlement';
import type { TxHash } from '../../src/types';
import {
  HASH_1,
  OWNER,
  createX402Divigent as createIncomeDivigent,
  settledResponse,
  settlementHttp,
  usdc,
} from '../helpers';

describe('depositIdleAboveFloor', () => {
  // Exercises: returns undefined when no wallet is available.
  it('returns undefined when no wallet is available', async () => {
    const divigent = createIncomeDivigent({ wallet: '' });
    const floor = new ReserveFloor({ minIdleThreshold: usdc('0.000100') });

    await expect(depositIdleAboveFloor(divigent, floor)).resolves.toBeUndefined();
    expect(divigent.depositWithPermit).not.toHaveBeenCalled();
  });

  // Exercises: does nothing when balance is below reserve floor or idle is below minDeposit.
  it('does nothing when balance is below reserve floor or idle is below minDeposit', async () => {
    const below = createIncomeDivigent({ balances: [usdc('0.000100')] });
    await expect(
      depositIdleAboveFloor(below, new ReserveFloor({ minIdleThreshold: usdc('0.000100') })),
    ).resolves.toBeUndefined();
    expect(below.depositWithPermit).not.toHaveBeenCalled();

    const tooSmall = createIncomeDivigent({ balances: [usdc('0.000105')] });
    await expect(
      depositIdleAboveFloor(tooSmall, new ReserveFloor({ minIdleThreshold: usdc('0.000100') }), {
        minDeposit: usdc('0.000010'),
      }),
    ).resolves.toBeUndefined();
    expect(tooSmall.depositWithPermit).not.toHaveBeenCalled();
  });

  // Exercises: deposits exactly idle balance above reserve floor and records dedupe key.
  it('deposits exactly idle balance above reserve floor and records dedupe key', async () => {
    const divigent = createIncomeDivigent({ balances: [usdc('0.000250')] });
    const seenTxHashes = new Set<string>();

    await expect(
      depositIdleAboveFloor(divigent, new ReserveFloor({ minIdleThreshold: usdc('0.000100') }), {
        dedupeKey: 'settlement-1',
        seenTxHashes,
      }),
    ).resolves.toBe(HASH_1);

    expect(divigent.depositWithPermit).toHaveBeenCalledWith({
      amount: usdc('0.000150'),
      wallet: OWNER,
    });
    expect(seenTxHashes.has('settlement-1')).toBe(true);
  });

  // Exercises: ignores duplicate settlement keys.
  it('ignores duplicate settlement keys', async () => {
    const divigent = createIncomeDivigent({ balances: [usdc('0.000250')] });
    const seenTxHashes = new Set(['settlement-1']);

    await expect(
      depositIdleAboveFloor(divigent, new ReserveFloor({ minIdleThreshold: usdc('0.000100') }), {
        dedupeKey: 'settlement-1',
        seenTxHashes,
      }),
    ).resolves.toBeUndefined();
    expect(divigent.usdcBalance).not.toHaveBeenCalled();
  });

  // Exercises: serializes concurrent sweeps per wallet and rechecks the dedupe key inside the lock.
  it('serializes concurrent sweeps per wallet and rechecks the dedupe key inside the lock', async () => {
    const divigent = createIncomeDivigent({ balances: [usdc('0.000250'), usdc('0.000250')] });
    const floor = new ReserveFloor({ minIdleThreshold: usdc('0.000100') });
    const seenTxHashes = new Set<string>();

    const [first, second] = await Promise.all([
      depositIdleAboveFloor(divigent, floor, {
        dedupeKey: 'settlement-1',
        seenTxHashes,
      }),
      depositIdleAboveFloor(divigent, floor, {
        dedupeKey: 'settlement-1',
        seenTxHashes,
      }),
    ]);

    expect([first, second].filter(Boolean)).toEqual([HASH_1]);
    expect(divigent.depositWithPermit).toHaveBeenCalledTimes(1);
    expect(seenTxHashes.has('settlement-1')).toBe(true);
  });
});

describe('handleDivigentSettlement', () => {
  // Exercises: ignores missing, malformed, unsuccessful, or policy-blocked settlements.
  it('ignores missing, malformed, unsuccessful, or policy-blocked settlements', async () => {
    const divigent = createIncomeDivigent({ balances: [usdc('0.000250')] });
    const floor = new ReserveFloor({ minIdleThreshold: usdc('0.000100') });

    await expect(
      handleDivigentSettlement(settledResponse(), settlementHttp(undefined, true) as never, divigent, floor),
    ).resolves.toBeUndefined();
    await expect(
      handleDivigentSettlement(
        settledResponse(),
        settlementHttp({ success: true }) as never,
        divigent,
        floor,
      ),
    ).resolves.toBeUndefined();
    await expect(
      handleDivigentSettlement(
        settledResponse(),
        settlementHttp({ success: false, transaction: '0x1' }) as never,
        divigent,
        floor,
      ),
    ).resolves.toBeUndefined();
    await expect(
      handleDivigentSettlement(
        settledResponse('https://blocked.example.com/paid'),
        settlementHttp({ success: true, transaction: '0x2' }) as never,
        divigent,
        floor,
        { config: { allowedOrigin: 'https://api.example.com' }, resource: 'https://blocked.example.com/paid' },
      ),
    ).resolves.toBeUndefined();

    expect(divigent.depositWithPermit).not.toHaveBeenCalled();
  });

  // Exercises: deposits idle funds once for successful settlements.
  it('deposits idle funds once for successful settlements', async () => {
    const divigent = createIncomeDivigent({ balances: [usdc('0.000250')] });
    const floor = new ReserveFloor({ minIdleThreshold: usdc('0.000100') });
    const seenTxHashes = new Set<string>();

    await expect(
      handleDivigentSettlement(
        settledResponse(),
        settlementHttp({ success: true, transaction: 'tx-1' }) as never,
        divigent,
        floor,
        { seenTxHashes, resource: 'https://api.example.com/paid' },
      ),
    ).resolves.toBe(HASH_1);

    await expect(
      handleDivigentSettlement(
        settledResponse(),
        settlementHttp({ success: true, transaction: 'tx-1' }) as never,
        divigent,
        floor,
        { seenTxHashes, resource: 'https://api.example.com/paid' },
      ),
    ).resolves.toBeUndefined();

    expect(divigent.depositWithPermit).toHaveBeenCalledTimes(1);
  });
});

describe('settlement wrappers', () => {
  // Exercises: evicts old settlement dedupe keys at capacity so new income is not blocked forever.
  it('evicts old settlement dedupe keys at capacity so new income is not blocked forever', async () => {
    const divigent = createIncomeDivigent({
      balances: [usdc('0.000250'), usdc('0.000260'), usdc('0.000270')],
    });
    const floor = new ReserveFloor({ minIdleThreshold: usdc('0.000100') });
    const inner = vi.fn(async () => settledResponse());
    const http = {
      getPaymentSettleResponse: vi
        .fn()
        .mockReturnValueOnce({ success: true, transaction: 'tx-1' })
        .mockReturnValueOnce({ success: true, transaction: 'tx-2' })
        .mockReturnValueOnce({ success: true, transaction: 'tx-1' }),
    };
    const fetchWithYield = wrapFetchWithDivigentYield(
      inner as unknown as typeof fetch,
      http as never,
      divigent,
      floor,
      { dedupeCapacity: 1 },
    );

    await fetchWithYield('https://api.example.com/paid');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fetchWithYield('https://api.example.com/paid');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fetchWithYield('https://api.example.com/paid');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(divigent.depositWithPermit).toHaveBeenCalledTimes(3);
    expect(divigent.depositWithPermit).toHaveBeenNthCalledWith(1, {
      amount: usdc('0.000150'),
      wallet: OWNER,
    });
    expect(divigent.depositWithPermit).toHaveBeenNthCalledWith(3, {
      amount: usdc('0.000170'),
      wallet: OWNER,
    });
  });

  // Exercises: derives settlement resources from string, URL, and Request fetch inputs.
  it('derives settlement resources from string, URL, and Request fetch inputs', async () => {
    const inputs: Array<Parameters<typeof fetch>[0]> = [
      'https://api.example.com/paid',
      new URL('https://api.example.com/paid'),
      new Request('https://api.example.com/paid'),
    ];

    for (const [index, input] of inputs.entries()) {
      const divigent = createIncomeDivigent({ balances: [usdc('0.000250')] });
      const inner = vi.fn(async () => settledResponse());
      const fetchWithYield = wrapFetchWithDivigentYield(
        inner as unknown as typeof fetch,
        settlementHttp({ success: true, transaction: `tx-${index}` }) as never,
        divigent,
        new ReserveFloor({ minIdleThreshold: usdc('0.000100') }),
        { config: { allowedOrigin: 'https://api.example.com' } },
      );

      await fetchWithYield(input);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(divigent.depositWithPermit).toHaveBeenCalledWith({
        amount: usdc('0.000150'),
        wallet: OWNER,
      });
    }
  });

  // Exercises: wraps fetch without blocking the paid response when redeposit runs in the background.
  it('wraps fetch without blocking the paid response when redeposit runs in the background', async () => {
    const divigent = createIncomeDivigent({ balances: [usdc('0.000250')] });
    const floor = new ReserveFloor({ minIdleThreshold: usdc('0.000100') });
    const inner = vi.fn(async () => settledResponse());
    const onNonFatalError = vi.fn();
    const fetchWithYield = wrapFetchWithDivigentYield(
      inner as unknown as typeof fetch,
      settlementHttp({ success: true, transaction: 'tx-1' }) as never,
      divigent,
      floor,
      { config: { onNonFatalError } },
    );

    const response = await fetchWithYield('https://api.example.com/paid');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(response).toBeInstanceOf(Response);
    expect(divigent.depositWithPermit).toHaveBeenCalledWith({
      amount: usdc('0.000150'),
      wallet: OWNER,
    });
    expect(onNonFatalError).not.toHaveBeenCalled();
  });

  // Exercises: reports background settlement failures without replacing the paid response.
  it('reports background settlement failures without replacing the paid response', async () => {
    const divigent = createIncomeDivigent({ balances: [usdc('0.000250')], depositRejects: true });
    const floor = new ReserveFloor({ minIdleThreshold: usdc('0.000100') });
    const inner = vi.fn(async () => settledResponse());
    const onNonFatalError = vi.fn();
    const fetchWithYield = wrapFetchWithDivigentYield(
      inner as unknown as typeof fetch,
      settlementHttp({ success: true, transaction: 'tx-1' }) as never,
      divigent,
      floor,
      { config: { onNonFatalError } },
    );

    const response = await fetchWithYield('https://api.example.com/paid');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(response).toBeInstanceOf(Response);
    expect(onNonFatalError).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'settlement',
      recoverable: true,
    }));
  });

  // Exercises: attaches seller income redeposit hooks and swallows non-fatal failures.
  it('attaches seller income redeposit hooks and swallows non-fatal failures', async () => {
    const onAfterSettle = vi.fn();
    const server = { onAfterSettle };
    const divigent = createIncomeDivigent({ balances: [usdc('0.000250')], depositRejects: true });
    const onNonFatalError = vi.fn();

    const handle = attachDivigentIncome(
      server as never,
      divigent,
      new ReserveFloor({ minIdleThreshold: usdc('0.000100') }),
      { onNonFatalError },
    );

    const hook = onAfterSettle.mock.calls[0]?.[0] as (ctx: {
      result: { success: boolean; transaction: TxHash };
    }) => Promise<void>;
    await hook({ result: { success: true, transaction: HASH_1 } });

    expect(onNonFatalError).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'deposit-idle',
      recoverable: true,
    }));

    handle.detach();
    await hook({ result: { success: true, transaction: HASH_1 } });
    expect(divigent.depositWithPermit).toHaveBeenCalledTimes(1);
  });
});
