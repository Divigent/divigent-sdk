import { describe, expect, it, vi } from 'vitest';
import { signUsdcPermit } from '../../src/contracts/usdc';
import { PermitUnsupportedFor7702AccountError } from '../../src/errors';
import {
  HASH_1,
  HASH_2,
  OWNER,
  SECOND_OWNER,
  addresses,
  createDivigentWithClients,
  createMockClients,
  highSSignature,
  lowSSignature,
  signatureWithParts,
  usdc,
} from '../helpers';

describe('USDC permit signing', () => {
  // Rejects contract-code owners so callers can fall back from EOA permit flow.
  it('rejects contract-code owners so callers can fall back from EOA permit flow', async () => {
    const { publicClient, walletClient } = createMockClients({ getCode: '0x1234' });

    await expect(
      signUsdcPermit({
        walletClient,
        publicClient,
        usdc: addresses.usdc,
        spender: addresses.router,
        value: usdc('0.001'),
        deadline: 2_000n,
      }),
    ).rejects.toBeInstanceOf(PermitUnsupportedFor7702AccountError);
  });

  // Normalizes high-s signatures and flips v before returning permit parts.
  it('normalizes high-s signatures and flips v before returning permit parts', async () => {
    const { publicClient, walletClient } = createMockClients({
      signTypedData: () => highSSignature(27),
    });

    const permit = await signUsdcPermit({
      walletClient,
      publicClient,
      usdc: addresses.usdc,
      spender: addresses.router,
      value: usdc('0.001'),
      deadline: 2_000n,
    });

    expect(permit.r).toBe(`0x${'0'.repeat(63)}1`);
    expect(permit.s).toBe(`0x${'0'.repeat(63)}1`);
    expect(permit.v).toBe(28);
    expect(permit.deadline).toBe(2_000n);
  });

  // Accepts compact v values and leaves low-s signatures unchanged.
  it('accepts compact v values and leaves low-s signatures unchanged', async () => {
    const first = createMockClients({
      signTypedData: () => signatureWithParts(1n, 2n, 0),
    });
    const firstPermit = await signUsdcPermit({
      walletClient: first.walletClient,
      publicClient: first.publicClient,
      usdc: addresses.usdc,
      spender: addresses.router,
      value: usdc('0.001'),
      deadline: 2_000n,
    });
    expect(firstPermit).toMatchObject({
      r: `0x${'0'.repeat(63)}1`,
      s: `0x${'0'.repeat(63)}2`,
      v: 27,
    });

    const second = createMockClients({
      signTypedData: () => signatureWithParts(1n, 2n, 1),
    });
    const secondPermit = await signUsdcPermit({
      walletClient: second.walletClient,
      publicClient: second.publicClient,
      usdc: addresses.usdc,
      spender: addresses.router,
      value: usdc('0.001'),
      deadline: 2_000n,
    });
    expect(secondPermit).toMatchObject({
      s: `0x${'0'.repeat(63)}2`,
      v: 28,
    });
  });

  // Signs the exact Circle USDC EIP-2612 domain and money fields.
  it('signs the exact Circle USDC EIP-2612 domain and money fields', async () => {
    const { publicClient, walletClient, signTypedData } = createMockClients({
      signTypedData: () => lowSSignature(),
    });

    await signUsdcPermit({
      walletClient,
      publicClient,
      usdc: addresses.usdc,
      spender: addresses.router,
      value: usdc('123.456789'),
      deadline: 2_000n,
      owner: OWNER,
    });

    expect(signTypedData).toHaveBeenCalledWith(expect.objectContaining({
      domain: {
        name: 'USD Coin',
        version: '2',
        chainId: 84532,
        verifyingContract: addresses.usdc,
      },
      primaryType: 'Permit',
      message: {
        owner: OWNER,
        spender: addresses.router,
        value: usdc('123.456789'),
        nonce: 7n,
        deadline: 2_000n,
      },
    }));
  });

  // Uses an explicit permit owner instead of silently signing for the wallet account.
  it('uses an explicit permit owner instead of silently signing for the wallet account', async () => {
    const { publicClient, walletClient, signTypedData } = createMockClients({
      signTypedData: () => lowSSignature(),
    });

    await signUsdcPermit({
      walletClient,
      publicClient,
      usdc: addresses.usdc,
      spender: addresses.router,
      value: usdc('0.001'),
      deadline: 2_000n,
      owner: SECOND_OWNER,
    });

    expect(signTypedData).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({
        owner: SECOND_OWNER,
        spender: addresses.router,
        value: usdc('0.001'),
      }),
    }));
  });

  // Rejects unexpected v values.
  it('rejects unexpected v values', async () => {
    const { publicClient, walletClient } = createMockClients({
      signTypedData: () => signatureWithParts(1n, 2n, 29),
    });

    await expect(
      signUsdcPermit({
        walletClient,
        publicClient,
        usdc: addresses.usdc,
        spender: addresses.router,
        value: usdc('0.001'),
        deadline: 2_000n,
      }),
    ).rejects.toMatchObject({ code: 'DIVIGENT_INVALID_SIGNATURE_V' });
  });

  // Requires wallet account and chain before attempting permit reads.
  it('requires wallet account and chain before attempting permit reads', async () => {
    const noAccount = createMockClients({ includeWalletAccount: false });
    await expect(
      signUsdcPermit({
        walletClient: noAccount.walletClient,
        publicClient: noAccount.publicClient,
        usdc: addresses.usdc,
        spender: addresses.router,
        value: usdc('0.001'),
        deadline: 2_000n,
      }),
    ).rejects.toMatchObject({ code: 'DIVIGENT_WALLET_ACCOUNT_REQUIRED' });
    expect(noAccount.readContract).not.toHaveBeenCalled();

    const noChain = createMockClients({ includeWalletChain: false });
    await expect(
      signUsdcPermit({
        walletClient: noChain.walletClient,
        publicClient: noChain.publicClient,
        usdc: addresses.usdc,
        spender: addresses.router,
        value: usdc('0.001'),
        deadline: 2_000n,
      }),
    ).rejects.toMatchObject({ code: 'DIVIGENT_WALLET_CHAIN_REQUIRED' });
    expect(noChain.readContract).not.toHaveBeenCalled();
  });
});

describe('depositWithPermit behavior', () => {
  // Uses chain time + 3600 seconds for the default permit deadline.
  it('uses chain time + 3600 seconds for the default permit deadline', async () => {
    const { divigent, signTypedData } = createDivigentWithClients({
      blockTimestamp: 123_456n,
      allowance: usdc('0.001'),
      writeHashes: [HASH_1],
      signTypedData: () => lowSSignature(),
    });

    await divigent.depositWithPermit({ amount: usdc('0.001') });

    const signed = signTypedData.mock.calls[0]?.[0] as {
      message: { deadline: bigint };
    };
    expect(signed.message.deadline).toBe(127_056n);
  });

  // Falls back to approve, wait, then deposit for 7702/smart-account owners.
  it('falls back to approve, wait, then deposit for 7702/smart-account owners', async () => {
    const { divigent, simulateContract, writeContract, waitForTransactionReceipt } =
      createDivigentWithClients({
        getCode: '0x1234',
        previewDeposit: 1_000_000n,
        writeHashes: [HASH_1, HASH_2],
      });

    await expect(divigent.depositWithPermit({ amount: usdc('0.001') })).resolves.toBe(HASH_2);

    expect(simulateContract.mock.calls.map((call) => call[0].functionName)).toEqual([
      'approve',
      'deposit',
    ]);
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash: HASH_1 });
    expect(writeContract).toHaveBeenCalledTimes(2);
  });

  // Does not fall back when fallbackOn7702 is false.
  it('does not fall back when fallbackOn7702 is false', async () => {
    const { divigent, writeContract } = createDivigentWithClients({ getCode: '0x1234' });

    await expect(
      divigent.depositWithPermit({ amount: usdc('0.001'), fallbackOn7702: false }),
    ).rejects.toBeInstanceOf(PermitUnsupportedFor7702AccountError);
    expect(writeContract).not.toHaveBeenCalled();
  });

  // Serializes permit signing per owner to avoid nonce collisions.
  it('serializes permit signing per owner to avoid nonce collisions', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { divigent, signTypedData } = createDivigentWithClients({
      signTypedData: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return lowSSignature();
      },
    });

    await Promise.all([
      divigent.depositWithPermit({ amount: usdc('0.001'), wallet: OWNER }),
      divigent.depositWithPermit({ amount: usdc('0.002'), wallet: OWNER }),
    ]);

    expect(signTypedData).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
  });

  // Keeps the permit queue usable after a failed permit attempt.
  it('keeps the permit queue usable after a failed permit attempt', async () => {
    const signTypedData = vi
      .fn()
      .mockRejectedValueOnce(new Error('wallet temporarily unavailable'))
      .mockResolvedValueOnce(lowSSignature());
    const { divigent } = createDivigentWithClients({ signTypedData });

    await expect(divigent.depositWithPermit({ amount: usdc('0.001') })).rejects.toMatchObject({
      code: 'DIVIGENT_SIGN_FAILED',
    });
    await expect(divigent.depositWithPermit({ amount: usdc('0.001') })).resolves.toBeTruthy();
    expect(signTypedData).toHaveBeenCalledTimes(2);
  });
});
