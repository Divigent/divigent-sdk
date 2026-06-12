import { describe, expect, it, vi } from 'vitest';
import { ContractFunctionRevertedError, encodeErrorResult, hashTypedData } from 'viem';
import { routerAbi } from '../../src/abis';
import { signUsdcPermit } from '../../src/contracts/usdc';
import {
  PermitUnsupportedFor7702AccountError,
  PermitUnsupportedForTokenError,
} from '../../src/errors';
import { getAddresses } from '../../src/core/chains';
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

const baseAddresses = {
  router: '0x1e79FAc6B154B49101252C447E0e68a0a20fc3c0',
  usdc:   '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
} as const;

const permitTypes = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

const initializeForTypes = {
  InitializeFor: [
    { name: 'wallet', type: 'address' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

describe('EIP-712 hash vectors', () => {
  const vectors = [
    {
      name: 'Base USDC permit',
      domain: {
        name: 'USD Coin',
        version: '2',
        chainId: 8453,
        verifyingContract: baseAddresses.usdc,
      },
      types: permitTypes,
      primaryType: 'Permit',
      message: {
        owner: OWNER,
        spender: baseAddresses.router,
        value: 123456789n,
        nonce: 7n,
        deadline: 2_000n,
      },
      hash: '0x94badd748891139e6e42ce50ecca24347a294db90d59078005214079601d0e99',
    },
    {
      name: 'Base Sepolia USDC permit',
      domain: {
        name: 'USD Coin',
        version: '2',
        chainId: 84532,
        verifyingContract: getAddresses('base-sepolia').usdc,
      },
      types: permitTypes,
      primaryType: 'Permit',
      message: {
        owner: OWNER,
        spender: getAddresses('base-sepolia').router,
        value: 123456789n,
        nonce: 7n,
        deadline: 2_000n,
      },
      hash: '0x3b2c826346d7fa4f47b914e825b0f32116941e8d25136fee33c118e927eb0b2d',
    },
    {
      name: 'Base InitializeFor',
      domain: {
        name: 'DivigentVaultRouter',
        version: '1',
        chainId: 8453,
        verifyingContract: baseAddresses.router,
      },
      types: initializeForTypes,
      primaryType: 'InitializeFor',
      message: {
        wallet: OWNER,
        deadline: 2_000n,
        nonce: 7n,
      },
      hash: '0xb96de1e4ce36f9e732e17f7d5b1fb1675f8edbcc89eaf5741f23653df52dc01c',
    },
    {
      name: 'Base Sepolia InitializeFor',
      domain: {
        name: 'DivigentVaultRouter',
        version: '1',
        chainId: 84532,
        verifyingContract: getAddresses('base-sepolia').router,
      },
      types: initializeForTypes,
      primaryType: 'InitializeFor',
      message: {
        wallet: OWNER,
        deadline: 2_000n,
        nonce: 7n,
      },
      hash: '0x892908f2cae86fc6a532743ac8f0ef2619050ed3f41722d95740d8f7ba68cd9f',
    },
  ] as const;

  // Exercises: pins every permit typed-data vector to its expected EIP-712 hash.
  it.each(vectors)('pins $name hash', (vector) => {
    expect(hashTypedData(vector as never)).toBe(vector.hash);
  });
});

describe('USDC permit signing', () => {
  // Exercises: rejects contract-code owners so callers can fall back from EOA permit flow.
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
  // Exercises: unsupported token permit fields surface as a typed fallback reason.
  it('rejects tokens without permit metadata with a typed unsupported-token error', async () => {
    const { publicClient, walletClient } = createMockClients({
      readContract: (request) => {
        if (request.functionName === 'name') return 'USD Coin';
        if (request.functionName === 'version') throw new Error('method unavailable');
        throw new Error(`Unhandled readContract function ${String(request.functionName)}`);
      },
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
    ).rejects.toMatchObject({
      code: 'DIVIGENT_PERMIT_UNSUPPORTED_TOKEN',
      field: 'version',
    });
  });
  // Exercises: normalizes high-s signatures and flips v before returning permit parts.
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
  // Exercises: accepts compact v values and leaves low-s signatures unchanged.
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
  // Exercises: signs the exact Circle USDC EIP-2612 domain and money fields.
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
  // Exercises: rejects owner overrides that cannot be signed by the connected account.
  it('rejects a permit owner that differs from the wallet signer', async () => {
    const { publicClient, walletClient, signTypedData } = createMockClients({
      signTypedData: () => lowSSignature(),
    });

    await expect(signUsdcPermit({
      walletClient,
      publicClient,
      usdc: addresses.usdc,
      spender: addresses.router,
      value: usdc('0.001'),
      deadline: 2_000n,
      owner: SECOND_OWNER,
    })).rejects.toMatchObject({ code: 'DIVIGENT_PERMIT_OWNER_MISMATCH' });

    expect(signTypedData).not.toHaveBeenCalled();
  });
  // Exercises: rejects expired or near-expired permit deadlines before prompting the wallet.
  it('rejects too-soon permit deadlines before signing', async () => {
    const { publicClient, walletClient, signTypedData } = createMockClients();

    await expect(signUsdcPermit({
      walletClient,
      publicClient,
      usdc: addresses.usdc,
      spender: addresses.router,
      value: usdc('0.001'),
      deadline: 1_000n,
    })).rejects.toMatchObject({ code: 'DIVIGENT_SIGNATURE_DEADLINE_TOO_SOON' });

    expect(signTypedData).not.toHaveBeenCalled();
  });
  // Exercises: rejects unexpected v values.
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
  // Exercises: requires wallet account and chain before attempting permit reads.
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

describe('initializeFor signing', () => {
  // Exercises: rejects router EIP-712 chain-id mismatches before signing.
  it('rejects router EIP-712 chain-id mismatches before signing', async () => {
    const { divigent, signTypedData } = createDivigentWithClients({
      readContract: (request) => {
        if (request.functionName === 'eip712Domain') {
          return ['0x0f', 'DivigentVaultRouter', '1', 1n, addresses.router, '0x00', []];
        }
        if (request.functionName === 'nonces') return 7n;
        throw new Error(`Unhandled readContract function ${String(request.functionName)}`);
      },
    });

    await expect(divigent.signInitializeFor({
      wallet: OWNER,
      deadline: 2_000n,
    })).rejects.toMatchObject({
      code: 'DIVIGENT_EIP712_DOMAIN_MISMATCH',
      context: { field: 'chainId' },
    });
    expect(signTypedData).not.toHaveBeenCalled();
  });
  // Exercises: rejects router EIP-712 verifying-contract mismatches before signing.
  it('rejects router EIP-712 verifying-contract mismatches before signing', async () => {
    const { divigent, signTypedData } = createDivigentWithClients({
      readContract: (request) => {
        if (request.functionName === 'eip712Domain') {
          return ['0x0f', 'DivigentVaultRouter', '1', 84532n, SECOND_OWNER, '0x00', []];
        }
        if (request.functionName === 'nonces') return 7n;
        throw new Error(`Unhandled readContract function ${String(request.functionName)}`);
      },
    });

    await expect(divigent.signInitializeFor({
      wallet: OWNER,
      deadline: 2_000n,
    })).rejects.toMatchObject({
      code: 'DIVIGENT_EIP712_DOMAIN_MISMATCH',
      context: { field: 'verifyingContract' },
    });
    expect(signTypedData).not.toHaveBeenCalled();
  });
  // Exercises: normalizes InitializeFor signatures to the low-s form accepted by the router.
  it('normalizes high-s InitializeFor signatures', async () => {
    const { divigent } = createDivigentWithClients({
      signTypedData: () => highSSignature(27),
      readContract: (request) => {
        if (request.functionName === 'eip712Domain') {
          return ['0x0f', 'DivigentVaultRouter', '1', 84532n, addresses.router, '0x00', []];
        }
        if (request.functionName === 'nonces') return 7n;
        throw new Error(`Unhandled readContract function ${String(request.functionName)}`);
      },
    });

    const signature = await divigent.signInitializeFor({
      wallet: OWNER,
      deadline: 2_000n,
    });

    expect(signature.slice(2, 66)).toBe('0'.repeat(63) + '1');
    expect(signature.slice(66, 130)).toBe('0'.repeat(63) + '1');
    expect(signature.slice(130, 132)).toBe('1c');
  });
  // Exercises: rejects expired or near-expired InitializeFor deadlines before signing.
  it('rejects too-soon InitializeFor deadlines before signing', async () => {
    const { divigent, signTypedData } = createDivigentWithClients();

    await expect(divigent.signInitializeFor({
      wallet: OWNER,
      deadline: 1_000n,
    })).rejects.toMatchObject({ code: 'DIVIGENT_SIGNATURE_DEADLINE_TOO_SOON' });

    expect(signTypedData).not.toHaveBeenCalled();
  });
});

describe('depositWithPermit behavior', () => {
  // Exercises: uses chain time + 3600 seconds for the default permit deadline.
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
  // Exercises: falls back to approve, wait, then deposit for 7702/smart-account owners.
  it('falls back to approve, wait, then deposit for 7702/smart-account owners', async () => {
    const amount = usdc('0.001');
    const allowances = [0n, amount + 1n];
    const { divigent, simulateContract, writeContract, waitForTransactionReceipt } =
      createDivigentWithClients({
        getCode: '0x1234',
        previewDeposit: 1_000_000n,
        writeHashes: [HASH_1, HASH_2],
        readContract: (request) => {
          if (request.functionName === 'MIN_DEPOSIT') return 0n;
          if (request.functionName === 'previewDeposit') return 1_000_000n;
          if (request.functionName === 'allowance') return allowances.shift() ?? usdc('0.001');
          throw new Error(`Unhandled readContract function ${String(request.functionName)}`);
        },
      });

    await expect(divigent.depositWithPermit({ amount })).resolves.toBe(HASH_2);

    expect(simulateContract.mock.calls.map((call) => call[0].functionName)).toEqual([
      'approve',
      'deposit',
    ]);
    expect(simulateContract.mock.calls[0]?.[0]).toMatchObject({
      functionName: 'approve',
      args: [addresses.router, amount + 1n],
    });
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash: HASH_1 });
    expect(writeContract).toHaveBeenCalledTimes(2);
  });
  // Exercises: falls back when a permit-like USDC token lacks permit metadata.
  it('falls back to approve, wait, then deposit when permit metadata reads revert', async () => {
    const amount = usdc('0.001');
    const allowances = [0n, amount + 1n];
    const { divigent, simulateContract, signTypedData, writeContract, waitForTransactionReceipt } =
      createDivigentWithClients({
        writeHashes: [HASH_1, HASH_2],
        readContract: (request) => {
          if (request.functionName === 'MIN_DEPOSIT') return 0n;
          if (request.functionName === 'name') return 'USD Coin';
          if (request.functionName === 'version') throw new Error('version reverted');
          if (request.functionName === 'nonces') return 0n;
          if (request.functionName === 'previewDeposit') return 1_000_000n;
          if (request.functionName === 'allowance') return allowances.shift() ?? usdc('0.001');
          throw new Error(`Unhandled readContract function ${String(request.functionName)}`);
        },
      });

    await expect(divigent.depositWithPermit({ amount })).resolves.toBe(HASH_2);

    expect(signTypedData).not.toHaveBeenCalled();
    expect(simulateContract.mock.calls.map((call) => call[0].functionName)).toEqual([
      'approve',
      'deposit',
    ]);
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash: HASH_1 });
    expect(writeContract).toHaveBeenCalledTimes(2);
  });
  // Exercises: skips the approval transaction when fallback allowance already covers the deposit.
  it('skips fallback approval when existing allowance is sufficient', async () => {
    const amount = usdc('0.001');
    const { divigent, simulateContract, writeContract, waitForTransactionReceipt } =
      createDivigentWithClients({
        getCode: '0x1234',
        previewDeposit: 1_000_000n,
        allowance: amount + 1n,
        writeHashes: [HASH_1],
      });

    await expect(divigent.depositWithPermit({ amount })).resolves.toBe(HASH_1);

    expect(simulateContract.mock.calls.map((call) => call[0].functionName)).toEqual(['deposit']);
    expect(waitForTransactionReceipt).not.toHaveBeenCalled();
    expect(writeContract).toHaveBeenCalledTimes(1);
  });
  // Exercises: does not fall back when fallbackOn7702 is false.
  it('does not fall back when fallbackOn7702 is false', async () => {
    const { divigent, writeContract } = createDivigentWithClients({ getCode: '0x1234' });

    await expect(
      divigent.depositWithPermit({ amount: usdc('0.001'), fallbackOn7702: false }),
    ).rejects.toBeInstanceOf(PermitUnsupportedFor7702AccountError);
    expect(writeContract).not.toHaveBeenCalled();
  });
  // Exercises: new fallbackOnPermitUnsupported flag disables all unsupported-permit fallbacks.
  it('does not fall back when fallbackOnPermitUnsupported is false', async () => {
    const { divigent, writeContract } = createDivigentWithClients({ getCode: '0x1234' });

    await expect(
      divigent.depositWithPermit({ amount: usdc('0.001'), fallbackOnPermitUnsupported: false }),
    ).rejects.toBeInstanceOf(PermitUnsupportedFor7702AccountError);
    expect(writeContract).not.toHaveBeenCalled();
  });
  // Exercises: unsupported token metadata also honors the explicit no-fallback flag.
  it('does not fall back from unsupported token permit metadata when disabled', async () => {
    const { divigent, writeContract } = createDivigentWithClients({
      readContract: (request) => {
        if (request.functionName === 'MIN_DEPOSIT') return 0n;
        if (request.functionName === 'previewDeposit') return 1_000_000n;
        if (request.functionName === 'name') return 'USD Coin';
        if (request.functionName === 'version') throw new Error('method unavailable');
        throw new Error(`Unhandled readContract function ${String(request.functionName)}`);
      },
    });

    await expect(
      divigent.depositWithPermit({
        amount: usdc('0.001'),
        fallbackOnPermitUnsupported: false,
      }),
    ).rejects.toBeInstanceOf(PermitUnsupportedForTokenError);
    expect(writeContract).not.toHaveBeenCalled();
  });
  // Exercises: fallback does not silently approve signer funds for a different credited wallet.
  it('rejects permit fallback when the deposit wallet differs from the signer', async () => {
    const { divigent, writeContract } = createDivigentWithClients({ getCode: '0x1234' });

    await expect(
      divigent.depositWithPermit({ amount: usdc('0.001'), wallet: SECOND_OWNER }),
    ).rejects.toMatchObject({ code: 'DIVIGENT_PERMIT_OWNER_MISMATCH' });
    expect(writeContract).not.toHaveBeenCalled();
  });
  // Exercises: falls back when a permit signature is accepted locally but router simulation
  // reports that the permit allowance did not materialize on-chain.
  it('falls back to approval deposit when permit execution reports insufficient allowance', async () => {
    const amount = usdc('0.001');
    const allowances = [0n, amount + 1n];
    const data = encodeErrorResult({
      abi: routerAbi,
      errorName: 'InsufficientPermitAllowance',
      args: [0n, amount],
    });
    const { divigent, simulateContract, signTypedData, writeContract, waitForTransactionReceipt } =
      createDivigentWithClients({
        signTypedData: () => lowSSignature(),
        writeHashes: [HASH_1, HASH_2],
        readContract: (request) => {
          if (request.functionName === 'previewDeposit') return 1_000_000n;
          if (request.functionName === 'MIN_DEPOSIT') return 0n;
          if (request.functionName === 'name') return 'USD Coin';
          if (request.functionName === 'version') return '2';
          if (request.functionName === 'nonces') return 7n;
          if (request.functionName === 'allowance') return allowances.shift() ?? amount + 1n;
          throw new Error(`Unhandled readContract function ${String(request.functionName)}`);
        },
        simulateContract: (request) => {
          if (request.functionName === 'depositWithPermit') {
            throw new ContractFunctionRevertedError({
              abi: routerAbi,
              data,
              functionName: 'depositWithPermit',
            });
          }
          if (request.functionName === 'approve') {
            return { request: { ...request, gas: 111n }, result: true };
          }
          if (request.functionName === 'deposit') {
            return { request: { ...request, gas: 222n }, result: 900_000n };
          }
          throw new Error(`Unhandled simulateContract function ${String(request.functionName)}`);
        },
      });

    await expect(divigent.depositWithPermit({ amount })).resolves.toBe(HASH_2);

    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(simulateContract.mock.calls.map((call) => call[0].functionName)).toEqual([
      'depositWithPermit',
      'approve',
      'deposit',
    ]);
    expect(simulateContract.mock.calls[1]?.[0]).toMatchObject({
      functionName: 'approve',
      args: [addresses.router, amount + 1n],
    });
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash: HASH_1 });
    expect(writeContract).toHaveBeenCalledTimes(2);
  });
  // Exercises: raw ERC20 allowance text is not trusted for approval fallback.
  it.each([
    'ERC20: insufficient allowance',
    'ERC20InsufficientAllowance(address,uint256,uint256)',
  ])('does not fall back to approval deposit when permit execution reports %s', async (message) => {
    const amount = usdc('0.001');
    const { divigent, simulateContract, writeContract } = createDivigentWithClients({
      signTypedData: () => lowSSignature(),
      simulateContract: (request) => {
        if (request.functionName === 'depositWithPermit') throw new Error(message);
        throw new Error(`Unhandled simulateContract function ${String(request.functionName)}`);
      },
    });

    await expect(divigent.depositWithPermit({ amount })).rejects.toMatchObject({
      code: 'DIVIGENT_WRITE_FAILED',
    });
    expect(simulateContract.mock.calls.map((call) => call[0].functionName)).toEqual([
      'depositWithPermit',
    ]);
    expect(writeContract).not.toHaveBeenCalled();
  });
  // Exercises: unrelated router reverts propagate instead of being hidden by approval fallback.
  it('does not fall back to approval deposit for unrelated permit execution reverts', async () => {
    const amount = usdc('0.001');
    const data = encodeErrorResult({
      abi: routerAbi,
      errorName: 'InvalidAmount',
    });
    const { divigent, simulateContract, writeContract } = createDivigentWithClients({
      signTypedData: () => lowSSignature(),
      readContract: (request) => {
        if (request.functionName === 'previewDeposit') return 1_000_000n;
        if (request.functionName === 'MIN_DEPOSIT') return 0n;
        if (request.functionName === 'name') return 'USD Coin';
        if (request.functionName === 'version') return '2';
        if (request.functionName === 'nonces') return 7n;
        throw new Error(`Unhandled readContract function ${String(request.functionName)}`);
      },
      simulateContract: (request) => {
        if (request.functionName === 'depositWithPermit') {
          throw new ContractFunctionRevertedError({
            abi: routerAbi,
            data,
            functionName: 'depositWithPermit',
          });
        }
        throw new Error(`Unhandled simulateContract function ${String(request.functionName)}`);
      },
    });

    await expect(divigent.depositWithPermit({ amount })).rejects.toMatchObject({
      errorName: 'InvalidAmount',
    });
    expect(simulateContract.mock.calls.map((call) => call[0].functionName)).toEqual([
      'depositWithPermit',
    ]);
    expect(writeContract).not.toHaveBeenCalled();
  });
  // Exercises: malicious or incidental RPC text cannot trigger approval fallback.
  it('does not fall back to approval deposit based on free-form error text', async () => {
    const amount = usdc('0.001');
    const { divigent, simulateContract, writeContract } = createDivigentWithClients({
      signTypedData: () => lowSSignature(),
      simulateContract: (request) => {
        if (request.functionName === 'depositWithPermit') {
          throw new Error(
            'malicious RPC text: insufficient allowance; transfer amount exceeds allowance',
          );
        }
        throw new Error(`Unhandled simulateContract function ${String(request.functionName)}`);
      },
    });

    await expect(divigent.depositWithPermit({
      amount,
      deadline: 2_000n,
    })).rejects.toMatchObject({
      code: 'DIVIGENT_WRITE_FAILED',
    });
    expect(simulateContract.mock.calls.map((call) => call[0].functionName)).toEqual([
      'depositWithPermit',
    ]);
    expect(writeContract).not.toHaveBeenCalled();
  });
  // Exercises: rejects expired permit-deposit deadlines before signing.
  it('rejects too-soon permit-deposit deadlines before signing', async () => {
    const { divigent, signTypedData, simulateContract } = createDivigentWithClients();

    await expect(divigent.depositWithPermit({
      amount: usdc('0.001'),
      deadline: 1_000n,
    })).rejects.toMatchObject({
      code: 'DIVIGENT_SIGNATURE_DEADLINE_TOO_SOON',
    });
    expect(signTypedData).not.toHaveBeenCalled();
    expect(simulateContract).not.toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'depositWithPermit',
    }));
  });
  // Exercises: surfaces replayed permit allowance failures from router simulation.
  it('surfaces replayed permit allowance failures from router simulation', async () => {
    const amount = usdc('0.001');
    const data = encodeErrorResult({
      abi: routerAbi,
      errorName: 'InsufficientPermitAllowance',
      args: [0n, amount],
    });
    const { divigent } = createDivigentWithClients({
      signTypedData: () => lowSSignature(),
      simulateContract: (request) => {
        if (request.functionName === 'depositWithPermit') {
          throw new ContractFunctionRevertedError({
            abi: routerAbi,
            data,
            functionName: 'depositWithPermit',
          });
        }
        throw new Error(`Unhandled simulateContract function ${String(request.functionName)}`);
      },
    });

    await expect(divigent.depositWithPermit({
      amount,
      deadline: 2_000n,
      fallbackOnPermitUnsupported: false,
    })).rejects.toMatchObject({
      errorName: 'InsufficientPermitAllowance',
      args: [0n, amount],
      code: 'DIVIGENT_CONTRACT_REVERT',
    });
  });
  // Exercises: keeps the permit queue locked until the nonce-consuming tx is mined.
  it('serializes permit signing per owner until the transaction receipt is observed', async () => {
    let releaseFirstReceipt!: () => void;
    let firstReceiptPending = false;
    const firstReceipt = new Promise<void>((resolve) => {
      releaseFirstReceipt = resolve;
    });
    const { divigent, signTypedData, waitForTransactionReceipt } = createDivigentWithClients({
      writeHashes: [HASH_1, HASH_2],
      signTypedData: () => lowSSignature(),
      waitForTransactionReceipt: async ({ hash }) => {
        if (hash === HASH_1) {
          firstReceiptPending = true;
          await firstReceipt;
          firstReceiptPending = false;
        }
        return { transactionHash: hash, logs: [] };
      },
    });

    const first = divigent.depositWithPermit({ amount: usdc('0.001'), wallet: OWNER });
    await vi.waitFor(() => expect(waitForTransactionReceipt).toHaveBeenCalledTimes(1));
    expect(firstReceiptPending).toBe(true);

    const second = divigent.depositWithPermit({ amount: usdc('0.002'), wallet: OWNER });
    await Promise.resolve();
    expect(signTypedData).toHaveBeenCalledTimes(1);

    releaseFirstReceipt();
    await Promise.all([first, second]);

    expect(signTypedData).toHaveBeenCalledTimes(2);
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(2);
  });
  // Exercises: keeps the permit queue usable after a failed permit attempt.
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
