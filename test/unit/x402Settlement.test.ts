import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters } from 'viem';
import { ReserveFloor } from '../../src/x402/attach';
import {
  attachDivigentIncome,
  depositIdleAboveFloor,
  handleDivigentSettlement,
  wrapFetchWithDivigentYield,
} from '../../src/x402/settlement';
import { getAddresses } from '../../src/core/chains';
import { x402UsdcPrice } from '../../src/x402/usdc';
import type { TxHash } from '../../src/types';
import {
  HASH_1,
  HASH_2,
  HASH_3,
  OWNER,
  SELLER,
  addresses,
  createDivigentWithClients,
  createX402Client,
  createX402Divigent as createIncomeDivigent,
  settledResponse,
  settlementHttp,
  usdc,
} from '../helpers';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function topicAddress(address: string): `0x${string}` {
  return `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}` as `0x${string}`;
}

function transferLog(from: string, to: string, value: bigint) {
  return {
    topics: [
      TRANSFER_TOPIC,
      topicAddress(from),
      topicAddress(to),
    ],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  };
}

describe('depositIdleAboveFloor', () => {
  // Exercises: returns undefined when no wallet is available.
  it('returns undefined when no wallet is available', async () => {
    const divigent = createIncomeDivigent({ wallet: '' });
    const floor = new ReserveFloor({ minIdleThreshold: usdc('0.000100') });

    await expect(depositIdleAboveFloor(divigent, floor)).resolves.toBeUndefined();
    expect(divigent.depositWithPermitAndWait).not.toHaveBeenCalled();
  });

  // Exercises: does nothing when balance is below reserve floor or idle is below minDeposit.
  it('does nothing when balance is below reserve floor or idle is below minDeposit', async () => {
    const below = createIncomeDivigent({ balances: [usdc('0.000100')] });
    await expect(
      depositIdleAboveFloor(below, new ReserveFloor({ minIdleThreshold: usdc('0.000100') })),
    ).resolves.toBeUndefined();
    expect(below.depositWithPermitAndWait).not.toHaveBeenCalled();

    const tooSmall = createIncomeDivigent({ balances: [usdc('0.000105')] });
    await expect(
      depositIdleAboveFloor(tooSmall, new ReserveFloor({ minIdleThreshold: usdc('0.000100') }), {
        minDeposit: usdc('0.000010'),
      }),
    ).resolves.toBeUndefined();
    expect(tooSmall.depositWithPermitAndWait).not.toHaveBeenCalled();
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

    expect(divigent.depositWithPermitAndWait).toHaveBeenCalledWith(expect.objectContaining({
      amount: usdc('0.000150'),
      wallet: OWNER,
    }));
    expect(seenTxHashes.has('settlement-1')).toBe(true);
  });

  // Exercises: keeps settlement debit reserve liquid when balance reads are stale.
  it('keeps settlement debit reserve liquid when balance reads are stale', async () => {
    const divigent = createIncomeDivigent({ balances: [usdc('12.350002')] });
    const onIdleDeposit = vi.fn();

    await expect(
      depositIdleAboveFloor(divigent, new ReserveFloor({ minIdleThreshold: usdc('0.25') }), {
        extraReserve: usdc('0.2'),
        minDeposit: usdc('10'),
        onIdleDeposit,
      }),
    ).resolves.toBe(HASH_1);

    expect(divigent.depositWithPermitAndWait).toHaveBeenCalledWith(expect.objectContaining({
      amount: usdc('11.900002'),
      wallet: OWNER,
    }));
    expect(onIdleDeposit).toHaveBeenCalledWith(expect.objectContaining({
      reserveFloor: usdc('0.25'),
      settlementReserve: usdc('0.2'),
      idleAmount: usdc('11.900002'),
    }));
  });

  // Exercises: treats idle-deposit observers as non-fatal after the deposit succeeds.
  it('keeps idle-deposit observer failures non-fatal after broadcast', async () => {
    const divigent = createIncomeDivigent({ balances: [usdc('0.000250')] });
    const onNonFatalError = vi.fn();

    await expect(
      depositIdleAboveFloor(divigent, new ReserveFloor({ minIdleThreshold: usdc('0.000100') }), {
        onIdleDeposit: () => {
          throw new Error('observer failed');
        },
        onNonFatalError,
      }),
    ).resolves.toBe(HASH_1);

    expect(divigent.depositWithPermitAndWait).toHaveBeenCalledWith(expect.objectContaining({
      amount: usdc('0.000150'),
      wallet: OWNER,
    }));
    expect(onNonFatalError).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'observer',
      label: 'onIdleDeposit',
      recoverable: true,
    }));
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
    expect(divigent.depositWithPermitAndWait).toHaveBeenCalledTimes(1);
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

    expect(divigent.depositWithPermitAndWait).not.toHaveBeenCalled();
  });

  // Exercises: deposits idle funds once for successful settlements.
  it('deposits idle funds once for successful settlements', async () => {
    const divigent = createIncomeDivigent({ balances: [usdc('0.000250')] });
    const floor = new ReserveFloor({ minIdleThreshold: usdc('0.000100') });
    const seenTxHashes = new Set<string>();

    await expect(
      handleDivigentSettlement(
        settledResponse(),
        settlementHttp({ success: true, transaction: HASH_1 }) as never,
        divigent,
        floor,
        { seenTxHashes, resource: 'https://api.example.com/paid' },
      ),
    ).resolves.toBe(HASH_1);

    await expect(
      handleDivigentSettlement(
        settledResponse(),
        settlementHttp({ success: true, transaction: HASH_1 }) as never,
        divigent,
        floor,
        { seenTxHashes, resource: 'https://api.example.com/paid' },
      ),
    ).resolves.toBeUndefined();

    expect(divigent.depositWithPermitAndWait).toHaveBeenCalledTimes(1);
  });

  // Exercises: caps untrusted settlement header amounts by the configured payment cap.
  it('caps settlement response amount before reserving wallet liquidity', async () => {
    const divigent = createIncomeDivigent({ balances: [usdc('200')] });
    const onIdleDeposit = vi.fn();

    await expect(
      handleDivigentSettlement(
        settledResponse(),
        settlementHttp({
          success: true,
          transaction: HASH_2,
          payer: OWNER,
          amount: usdc('1000000').toString(),
        }) as never,
        divigent,
        new ReserveFloor({ minIdleThreshold: usdc('0.25') }),
        {
          config: { maxPaymentAmount: usdc('1') },
          minDeposit: usdc('10'),
          onIdleDeposit,
        },
      ),
    ).resolves.toBe(HASH_1);

    expect(onIdleDeposit).toHaveBeenCalledWith(expect.objectContaining({
      settlementReserve: usdc('1'),
      idleAmount: usdc('198.75'),
    }));
  });

  // Exercises: treats receipt lookup failures as non-fatal retry conditions, not as zero reserve.
  it('skips idle deposit when settlement receipt verification fails', async () => {
    const divigent = createIncomeDivigent({ balances: [usdc('12')] });
    Object.assign(divigent, {
      publicClient: {
        getTransactionReceipt: vi.fn(async () => {
          throw new Error('rpc unavailable');
        }),
      },
    });
    const onNonFatalError = vi.fn();

    await expect(
      handleDivigentSettlement(
        settledResponse(),
        settlementHttp({ success: true, transaction: HASH_1 }) as never,
        divigent,
        new ReserveFloor({ minIdleThreshold: usdc('0.25') }),
        { minDeposit: usdc('10'), onNonFatalError },
      ),
    ).resolves.toBeUndefined();

    expect(divigent.depositWithPermitAndWait).not.toHaveBeenCalled();
    expect(onNonFatalError).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'settlement',
      recoverable: true,
    }));
  });

  // Exercises: refuses to verify settlement receipts from a client bound to the wrong chain.
  it('skips idle deposit when settlement receipt client is on the wrong chain', async () => {
    const getTransactionReceipt = vi.fn();
    const divigent = createIncomeDivigent({ balances: [usdc('12')] });
    Object.assign(divigent, {
      publicClient: {
        chain: { id: 1 },
        getTransactionReceipt,
      },
    });
    const onNonFatalError = vi.fn();

    await expect(
      handleDivigentSettlement(
        settledResponse(),
        settlementHttp({ success: true, transaction: HASH_1 }) as never,
        divigent,
        new ReserveFloor({ minIdleThreshold: usdc('0.25') }),
        { minDeposit: usdc('10'), onNonFatalError },
      ),
    ).resolves.toBeUndefined();

    expect(getTransactionReceipt).not.toHaveBeenCalled();
    expect(divigent.depositWithPermitAndWait).not.toHaveBeenCalled();
    expect(onNonFatalError.mock.calls[0]?.[0].error).toMatchObject({
      code: 'DIVIGENT_X402_SETTLEMENT_CHAIN_MISMATCH',
    });
  });

  // Exercises: refuses to use settlement receipts from reverted transactions.
  it('skips idle deposit when settlement transaction receipt is not successful', async () => {
    const divigent = createIncomeDivigent({ balances: [usdc('12')] });
    Object.assign(divigent, {
      publicClient: {
        getTransactionReceipt: vi.fn(async () => ({
          status: 'reverted',
          logs: [],
        })),
      },
    });
    const onNonFatalError = vi.fn();

    await expect(
      handleDivigentSettlement(
        settledResponse(),
        settlementHttp({ success: true, transaction: HASH_1 }) as never,
        divigent,
        new ReserveFloor({ minIdleThreshold: usdc('0.25') }),
        { minDeposit: usdc('10'), onNonFatalError },
      ),
    ).resolves.toBeUndefined();

    expect(divigent.depositWithPermitAndWait).not.toHaveBeenCalled();
    expect(onNonFatalError.mock.calls[0]?.[0].error).toMatchObject({
      code: 'DIVIGENT_X402_SETTLEMENT_TX_REVERTED',
    });
  });

  // Exercises: derives settlement debit reserve from the EVM receipt when x402 omits amount.
  it('derives settlement debit reserve from settlement transfer logs', async () => {
    const transfer = transferLog(OWNER, SELLER, usdc('0.2'));
    const divigent = createIncomeDivigent({ balances: [usdc('12')] });
    Object.assign(divigent, {
      publicClient: {
        getTransactionReceipt: vi.fn(async () => ({
          logs: [{ address: addresses.usdc, ...transfer }],
        })),
      },
    });
    const onIdleDeposit = vi.fn();

    await expect(
      handleDivigentSettlement(
        settledResponse(),
        settlementHttp({ success: true, transaction: HASH_1 }) as never,
        divigent,
        new ReserveFloor({ minIdleThreshold: usdc('0.25') }),
        { config: { allowedPayTo: [SELLER] }, minDeposit: usdc('10'), onIdleDeposit },
      ),
    ).resolves.toBe(HASH_1);

    expect(divigent.depositWithPermitAndWait).toHaveBeenCalledWith(expect.objectContaining({
      amount: usdc('11.55'),
      wallet: OWNER,
    }));
    expect(onIdleDeposit).toHaveBeenCalledWith(expect.objectContaining({
      settlementReserve: usdc('0.2'),
    }));
  });

  // Exercises: does not infer settlement reserve from arbitrary wallet-out logs without payTo policy.
  it('requires allowedPayTo before using receipt transfer logs as settlement reserve', async () => {
    const transfer = transferLog(OWNER, SELLER, usdc('0.2'));
    const divigent = createIncomeDivigent({ balances: [usdc('12')] });
    Object.assign(divigent, {
      publicClient: {
        getTransactionReceipt: vi.fn(async () => ({
          status: 'success',
          logs: [{ address: addresses.usdc, ...transfer }],
        })),
      },
    });
    const onIdleDeposit = vi.fn();

    await expect(
      handleDivigentSettlement(
        settledResponse(),
        settlementHttp({ success: true, transaction: HASH_1 }) as never,
        divigent,
        new ReserveFloor({ minIdleThreshold: usdc('0.25') }),
        { minDeposit: usdc('10'), onIdleDeposit },
      ),
    ).resolves.toBe(HASH_1);

    expect(onIdleDeposit).toHaveBeenCalledWith(expect.objectContaining({
      idleAmount: usdc('11.75'),
    }));
    expect(onIdleDeposit.mock.calls[0]?.[0]).not.toHaveProperty('settlementReserve');
  });
});

describe('settlement wrappers', () => {
  // Exercises: exposes the Circle USDC x402 metadata required by Base mainnet sellers.
  it('builds Base mainnet USDC x402 price metadata', () => {
    expect(x402UsdcPrice({ chain: 'base', amount: 1000n })).toEqual({
      amount: '1000',
      asset: getAddresses('base').usdc,
      extra: {
        name: 'USD Coin',
        version: '2',
        assetTransferMethod: 'eip3009',
      },
    });

    expect(x402UsdcPrice({
      chain: 'base-sepolia',
      amount: '2000',
      asset: addresses.usdc,
    })).toEqual({
      amount: '2000',
      asset: addresses.usdc,
      extra: { assetTransferMethod: 'permit2' },
    });
  });

  // Exercises: direct SDK idle sweep uses the protocol minimum and reserve floor.
  it('public depositIdle deposits wallet USDC above the protocol minimum', async () => {
    const { divigent, simulateContract } = createDivigentWithClients({
      usdcBalance: usdc('12'),
      simulatedDepositResult: usdc('11.75'),
    });
    const depositWithPermit = divigent.depositWithPermit.bind(divigent);
    vi.spyOn(divigent, 'depositWithPermitAndWait').mockImplementation(async (params) => ({
      txHash: await depositWithPermit(params),
      sharesMinted: usdc('11.75'),
    }));
    const onIdleDeposit = vi.fn();

    await expect(
      divigent.depositIdle({ minIdleThreshold: usdc('0.25'), onIdleDeposit }),
    ).resolves.toBe(HASH_1);

    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'depositWithPermit',
      args: expect.arrayContaining([usdc('11.75'), OWNER]),
    }));
    expect(onIdleDeposit).toHaveBeenCalledWith(expect.objectContaining({
      wallet: OWNER,
      reserveFloor: usdc('0.25'),
      idleAmount: usdc('11.75'),
      txHash: HASH_1,
    }));
  });

  // Exercises: public attach handle wraps paid fetch and deposits post-settlement idle USDC.
  it('public attach handle wraps paid fetch and deposits idle USDC above the protocol minimum', async () => {
    const { client } = createX402Client();
    const { divigent, simulateContract } = createDivigentWithClients({
      usdcBalance: usdc('12'),
      simulatedDepositResult: usdc('11.7'),
    });
    const depositWithPermit = divigent.depositWithPermit.bind(divigent);
    vi.spyOn(divigent, 'depositWithPermitAndWait').mockImplementation(async (params) => ({
      txHash: await depositWithPermit(params),
      sharesMinted: usdc('11.7'),
    }));
    const handle = divigent.attachTo(client as never, { minIdleThreshold: usdc('0.25') });
    const inner = vi.fn(async () => settledResponse('https://api.example.com/paid'));
    const onIdleDeposit = vi.fn();

    const fetchWithYield = handle.wrapFetchWithYield(
      inner as unknown as typeof fetch,
      settlementHttp({
        success: true,
        transaction: HASH_1,
        payer: OWNER,
        amount: usdc('0.2').toString(),
      }) as never,
      { waitForIdleDeposit: true, onIdleDeposit },
    );

    await expect(fetchWithYield('https://api.example.com/paid')).resolves.toBeInstanceOf(Response);

    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'depositWithPermit',
      args: expect.arrayContaining([usdc('11.55'), OWNER]),
    }));
    expect(onIdleDeposit).toHaveBeenCalledWith(expect.objectContaining({
      wallet: OWNER,
      reserveFloor: usdc('0.25'),
      settlementReserve: usdc('0.2'),
      idleAmount: usdc('11.55'),
      txHash: HASH_1,
      dedupeKey: `84532:${HASH_1}`,
    }));

    handle.detach();
  });

  // Exercises: public seller attach handle deposits received x402 income after settlement.
  it('public seller attach handle deposits income above the protocol minimum', async () => {
    const onAfterSettle = vi.fn();
    const server = { onAfterSettle };
    const { divigent, simulateContract } = createDivigentWithClients({
      usdcBalance: usdc('12'),
      simulatedDepositResult: usdc('11'),
    });
    const depositWithPermit = divigent.depositWithPermit.bind(divigent);
    vi.spyOn(divigent, 'depositWithPermitAndWait').mockImplementation(async (params) => ({
      txHash: await depositWithPermit(params),
      sharesMinted: usdc('11'),
    }));
    const onIdleDeposit = vi.fn();

    const handle = divigent.attachToResourceServer(server as never, {
      minIdleThreshold: usdc('1'),
      onIdleDeposit,
    });

    const hook = onAfterSettle.mock.calls[0]?.[0] as (ctx: {
      result: { success: boolean; transaction: TxHash };
    }) => Promise<void>;
    await hook({ result: { success: true, transaction: HASH_1 } });

    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'depositWithPermit',
      args: expect.arrayContaining([usdc('11'), OWNER]),
    }));
    expect(onIdleDeposit).toHaveBeenCalledWith(expect.objectContaining({
      reserveFloor: usdc('1'),
      idleAmount: usdc('11'),
      dedupeKey: `84532:${HASH_1}`,
    }));

    handle.detach();
  });

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
        .mockReturnValueOnce({ success: true, transaction: HASH_1 })
        .mockReturnValueOnce({ success: true, transaction: HASH_2 })
        .mockReturnValueOnce({ success: true, transaction: HASH_1 }),
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

    expect(divigent.depositWithPermitAndWait).toHaveBeenCalledTimes(3);
    expect(divigent.depositWithPermitAndWait).toHaveBeenNthCalledWith(1, expect.objectContaining({
      amount: usdc('0.000150'),
      wallet: OWNER,
    }));
    expect(divigent.depositWithPermitAndWait).toHaveBeenNthCalledWith(3, expect.objectContaining({
      amount: usdc('0.000170'),
      wallet: OWNER,
    }));
  });

  // Exercises: derives settlement resources from string, URL, and Request fetch inputs.
  it('derives settlement resources from string, URL, and Request fetch inputs', async () => {
    const inputs: Array<Parameters<typeof fetch>[0]> = [
      'https://api.example.com/paid',
      new URL('https://api.example.com/paid'),
      new Request('https://api.example.com/paid'),
    ];
    const txHashes = [HASH_1, HASH_2, HASH_3] as const;

    for (const [index, input] of inputs.entries()) {
      const divigent = createIncomeDivigent({ balances: [usdc('0.000250')] });
      const inner = vi.fn(async () => settledResponse());
      const fetchWithYield = wrapFetchWithDivigentYield(
        inner as unknown as typeof fetch,
        settlementHttp({ success: true, transaction: txHashes[index] }) as never,
        divigent,
        new ReserveFloor({ minIdleThreshold: usdc('0.000100') }),
        { config: { allowedOrigin: 'https://api.example.com' } },
      );

      await fetchWithYield(input);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(divigent.depositWithPermitAndWait).toHaveBeenCalledWith(expect.objectContaining({
        amount: usdc('0.000150'),
        wallet: OWNER,
      }));
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
      settlementHttp({ success: true, transaction: HASH_1 }) as never,
      divigent,
      floor,
      { config: { onNonFatalError } },
    );

    const response = await fetchWithYield('https://api.example.com/paid');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(response).toBeInstanceOf(Response);
    expect(divigent.depositWithPermitAndWait).toHaveBeenCalledWith(expect.objectContaining({
      amount: usdc('0.000150'),
      wallet: OWNER,
    }));
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
      settlementHttp({ success: true, transaction: HASH_1 }) as never,
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
    expect(divigent.depositWithPermitAndWait).toHaveBeenCalledTimes(1);
  });
});
