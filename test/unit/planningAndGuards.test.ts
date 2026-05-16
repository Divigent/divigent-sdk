import { describe, expect, it } from 'vitest';
import { ContractFunctionRevertedError, encodeErrorResult } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { routerAbi } from '../../src/abis';
import { Divigent } from '../../src/divigent';
import {
  AddressMismatchError,
  ChainMismatchError,
  ContractRevertError,
  DivigentError,
  MinDepositNotMetError,
  OperatorAckRequiredError,
  ZeroAddressError,
} from '../../src/errors';
import { applySlippageDown } from '../../src/core/utils';
import { getAddresses, isZeroAddress } from '../../src/core/chains';
import {
  HASH_1,
  HASH_2,
  OPERATOR,
  OWNER,
  SECOND_OWNER,
  addresses,
  createDivigentWithClients,
  createMockClients,
  usdc,
} from './helpers';

describe('Divigent config and wallet guards', () => {
  // Exercises: rejects public or wallet clients bound to a different chain.
  it('rejects public or wallet clients bound to a different chain', () => {
    expect(() => {
      const { publicClient, walletClient } = createMockClients({ publicChainId: 1 });
      Divigent.create({ publicClient, walletClient, chain: 'base-sepolia', addresses });
    }).toThrow(ChainMismatchError);

    expect(() => {
      const { publicClient, walletClient } = createMockClients({ walletChainId: 1 });
      Divigent.create({ publicClient, walletClient, chain: 'base-sepolia', addresses });
    }).toThrow(ChainMismatchError);
  });
  // Exercises: requires a wallet account and chain for planning and writes.
  it('requires a wallet account and chain for planning and writes', async () => {
    const noAccount = createDivigentWithClients({ includeWalletAccount: false });
    await expect(noAccount.divigent.planApproveUsdc(1n)).rejects.toMatchObject({
      code: 'DIVIGENT_WALLET_ACCOUNT_REQUIRED',
    });
    await expect(noAccount.divigent.approveUsdc(1n)).rejects.toMatchObject({
      code: 'DIVIGENT_WALLET_ACCOUNT_REQUIRED',
    });

    const noChain = createDivigentWithClients({ includeWalletChain: false });
    await expect(noChain.divigent.planApproveUsdc(1n)).rejects.toMatchObject({
      code: 'DIVIGENT_WALLET_CHAIN_REQUIRED',
    });
    await expect(noChain.divigent.approveUsdc(1n)).rejects.toMatchObject({
      code: 'DIVIGENT_WALLET_CHAIN_REQUIRED',
    });
  });
  // Exercises: allows read-only clients without a wallet but rejects writes and signing.
  it('allows read-only clients without a wallet but rejects writes and signing', async () => {
    const { publicClient, readContract } = createMockClients({ previewDeposit: 123n });
    const divigent = Divigent.create({
      publicClient,
      chain: 'base-sepolia',
      addresses,
    });

    await expect(divigent.previewDeposit(usdc('0.001'))).resolves.toBe(123n);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'previewDeposit',
    }));
    await expect(Promise.resolve().then(() => divigent.approveUsdc(1n)))
      .rejects.toMatchObject({ code: 'DIVIGENT_WALLET_CLIENT_REQUIRED' });
    await expect(divigent.deposit({ amount: usdc('0.001'), minSharesOut: 1n }))
      .rejects.toMatchObject({ code: 'DIVIGENT_WALLET_CLIENT_REQUIRED' });
    await expect(Promise.resolve().then(() => divigent.signInitializeFor({
      wallet: OWNER,
      deadline: 2_000n,
    })))
      .rejects.toMatchObject({ code: 'DIVIGENT_WALLET_CLIENT_REQUIRED' });
  });
  // Exercises: ships canonical Base mainnet protocol addresses.
  it('creates a Base mainnet facade from the built-in address registry', () => {
    const { publicClient, walletClient } = createMockClients({
      publicChainId: base.id,
      walletChainId: base.id,
    });

    const divigent = Divigent.create({
      publicClient,
      walletClient,
      chain: 'base',
    });

    expect(divigent.chain).toBe('base');
    const mainnet = getAddresses('base');
    expect(mainnet.router).toBe('0xE958A89c2CCa697d4896990685800cc1D5AF2A01');
    expect(mainnet.oracle).toBe('0x3Ba775E8fAE60E72c99dE10C720fC44ab38BF71A');
    expect(mainnet.feeCollector).toBe('0x1a2eF76E6E323D95f836917f812f6D159c3A0960');
    expect(mainnet.dvUsdc).toBe('0x1497f7F3b156e110b1d90BC7F1759F40fb48Ea4F');
    expect(mainnet.usdc).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(isZeroAddress(mainnet.router)).toBe(false);
    expect(isZeroAddress(mainnet.oracle)).toBe(false);
    expect(isZeroAddress(mainnet.feeCollector)).toBe(false);
    expect(isZeroAddress(mainnet.dvUsdc)).toBe(false);
  });
  // Exercises: infers the deployment chain from bound viem clients when callers omit `chain`.
  it('infers Base mainnet from viem client chain ids when chain is omitted', () => {
    const { publicClient, walletClient } = createMockClients({
      publicChainId: base.id,
      walletChainId: base.id,
    });

    const divigent = Divigent.create({ publicClient, walletClient });

    expect(divigent.chain).toBe('base');
  });
  // Exercises: validates custom address overrides before any on-chain call.
  it('validates custom address overrides before any on-chain call', () => {
    const { publicClient, walletClient } = createMockClients();

    expect(() => Divigent.create({
      publicClient,
      walletClient,
      chain: 'base-sepolia',
      addresses: { ...addresses, router: '0x0000000000000000000000000000000000000000' as never },
    })).toThrow(ZeroAddressError);

    expect(() => Divigent.create({
      publicClient,
      walletClient,
      chain: 'base-sepolia',
      addresses: { ...addresses, oracle: 'not-an-address' as never },
    })).toThrow(DivigentError);
  });
});

describe('configured deployment self-checks', () => {
  // Exercises: accepts matching router, dvUSDC, and fee collector self-identifying reads.
  it('accepts matching router, dvUSDC, and fee collector self-identifying reads', async () => {
    const { divigent } = createDivigentWithClients();
    await expect(divigent.verifyAddresses()).resolves.toBeUndefined();
  });
  // Exercises: rejects address registries that disagree with on-chain self-identifying reads.
  it('rejects address registries that disagree with on-chain self-identifying reads', async () => {
    const { divigent } = createDivigentWithClients({
      readContract: (request) => {
        if (request.functionName === 'USDC') return SECOND_OWNER;
        if (request.functionName === 'DV_USDC') return addresses.dvUsdc;
        if (request.functionName === 'FEE_COLLECTOR') return addresses.feeCollector;
        if (request.functionName === 'ORACLE') return addresses.oracle;
        if (request.functionName === 'VAULT_ROUTER') return addresses.router;
        throw new Error(`Unhandled readContract function ${String(request.functionName)}`);
      },
    });

    await expect(divigent.verifyAddresses()).rejects.toBeInstanceOf(AddressMismatchError);
  });
});

describe('wallet initialization convenience', () => {
  // Exercises: skips initialization when the wallet is already authorized.
  it('does not broadcast when the wallet is already initialized', async () => {
    const { divigent, writeContract } = createDivigentWithClients({ isAuthorized: true });

    await expect(divigent.ensureInitializedAndWait()).resolves.toBeUndefined();
    expect(writeContract).not.toHaveBeenCalled();
  });

  // Exercises: initializes the connected signer and waits for the receipt.
  it('initializes the connected signer and waits for the receipt', async () => {
    const { divigent, simulateContract, writeContract, waitForTransactionReceipt } = createDivigentWithClients();

    await expect(
      divigent.ensureInitializedAndWait({ confirmations: 2, pollingInterval: 50 }),
    ).resolves.toBe(HASH_1);

    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'initialize',
    }));
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: HASH_1,
      confirmations: 2,
      pollingInterval: 50,
    });
  });

  // Exercises: refuses to initialize a different wallet with the signer-only helper.
  it('rejects a non-signer wallet for signer-only initialization', async () => {
    const { divigent, writeContract } = createDivigentWithClients();

    await expect(divigent.ensureInitializedAndWait({ wallet: SECOND_OWNER })).rejects.toMatchObject({
      code: 'DIVIGENT_WALLET_MISMATCH',
    });
    expect(writeContract).not.toHaveBeenCalled();
  });
});

describe('router read facades', () => {
  // Exercises: exposes getRecommendedRoute without raw ABI reads.
  it('exposes getRecommendedRoute without raw ABI reads', async () => {
    const amount = usdc('0.001');
    const { divigent, readContract } = createDivigentWithClients({
      recommendedRoute: 1,
    });

    await expect(divigent.getRecommendedRoute(amount)).resolves.toBe('MORPHO');
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: addresses.router,
      functionName: 'getRecommendedRoute',
      args: [amount],
    }));
  });
});

describe('operator acknowledgement guard', () => {
  // Exercises: blocks granting operator authority without explicit acknowledgement.
  it('blocks granting operator authority without explicit acknowledgement', async () => {
    const { divigent, simulateContract } = createDivigentWithClients();
    await expect(
      divigent.setOperator({ operator: OPERATOR, approved: true }),
    ).rejects.toBeInstanceOf(OperatorAckRequiredError);
    expect(simulateContract).not.toHaveBeenCalled();
  });
  // Exercises: allows revoking without acknowledgement and granting with acknowledgement.
  it('allows revoking without acknowledgement and granting with acknowledgement', async () => {
    const { divigent, simulateContract, writeContract } = createDivigentWithClients();

    await expect(
      divigent.setOperator({ operator: OPERATOR, approved: false }),
    ).resolves.toBe(HASH_1);
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'setOperator',
      args: [OPERATOR, false],
    }));

    await divigent.setOperator({
      operator: OPERATOR,
      approved: true,
      acknowledgeFullAuthority: true,
    });
    expect(writeContract).toHaveBeenCalledTimes(2);
  });
});

describe('deposit and withdraw min-output derivation', () => {
  // Exercises: rejects deposits below the router minimum before previewing or broadcasting.
  it('throws a typed error when deposit amount is below MIN_DEPOSIT', async () => {
    const { divigent, readContract, simulateContract, writeContract } = createDivigentWithClients({
      minDeposit: usdc('10'),
    });

    await expect(divigent.deposit({ amount: usdc('9.999999') }))
      .rejects.toBeInstanceOf(MinDepositNotMetError);
    await expect(divigent.depositWithPermit({ amount: usdc('9.999999') }))
      .rejects.toMatchObject({
        code: 'DIVIGENT_MIN_DEPOSIT_NOT_MET',
        context: {
          amount: usdc('9.999999'),
          minDeposit: usdc('10'),
        },
      });

    expect(readContract).not.toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'previewDeposit',
    }));
    expect(simulateContract).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
  });
  // Exercises: uses explicit minSharesOut without previewing deposit.
  it('uses explicit minSharesOut without previewing deposit', async () => {
    const { divigent, readContract, simulateContract } = createDivigentWithClients();

    await divigent.deposit({ amount: usdc('0.001'), minSharesOut: 777n });

    expect(readContract).not.toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'previewDeposit',
    }));
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'deposit',
      args: [usdc('0.001'), OWNER, 777n],
    }));
  });
  // Exercises: derives minSharesOut from previewDeposit using default and custom slippage.
  it('derives minSharesOut from previewDeposit using default and custom slippage', async () => {
    const first = createDivigentWithClients({ previewDeposit: 1_000_000n });
    await first.divigent.deposit({ amount: usdc('0.001') });
    expect(first.simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'deposit',
      args: [usdc('0.001'), OWNER, applySlippageDown(1_000_000n, 10)],
    }));

    const second = createDivigentWithClients({ previewDeposit: 1_000_000n });
    await second.divigent.deposit({ amount: usdc('0.001'), slippageBps: 50 });
    expect(second.simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'deposit',
      args: [usdc('0.001'), OWNER, applySlippageDown(1_000_000n, 50)],
    }));
  });
  // Exercises: builds operator-driven deposits for the credited wallet while the signer pays USDC.
  it('builds operator-driven deposits for the credited wallet while the signer pays USDC', async () => {
    const { divigent, simulateContract } = createDivigentWithClients({
      previewDeposit: 1_000_000n,
    });

    await divigent.deposit({
      amount: usdc('0.001'),
      wallet: SECOND_OWNER,
      slippageBps: 25,
    });

    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'deposit',
      account: { address: OWNER, type: 'json-rpc' },
      args: [usdc('0.001'), SECOND_OWNER, applySlippageDown(1_000_000n, 25)],
    }));
  });
  // Exercises: uses explicit minUsdcOut without previewing redeem.
  it('uses explicit minUsdcOut without previewing redeem', async () => {
    const { divigent, readContract, simulateContract } = createDivigentWithClients();

    await divigent.withdraw({ shares: 1_000n, minUsdcOut: usdc('0.000888') });

    expect(readContract).not.toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'previewRedeem',
    }));
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'withdraw',
      args: [1_000n, OWNER, usdc('0.000888')],
    }));
  });
  // Exercises: derives minUsdcOut from previewRedeem using default and custom slippage.
  it('derives minUsdcOut from previewRedeem using default and custom slippage', async () => {
    const first = createDivigentWithClients({ previewRedeem: usdc('2') });
    await first.divigent.withdraw({ shares: 1_000n });
    expect(first.simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'withdraw',
      args: [1_000n, OWNER, applySlippageDown(usdc('2'), 10)],
    }));

    const second = createDivigentWithClients({ previewRedeem: usdc('2') });
    await second.divigent.withdraw({ shares: 1_000n, slippageBps: 75 });
    expect(second.simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'withdraw',
      args: [1_000n, OWNER, applySlippageDown(usdc('2'), 75)],
    }));
  });
  // Exercises: rejects invalid slippage before broadcasting.
  it('rejects invalid slippage before broadcasting', async () => {
    const { divigent, writeContract } = createDivigentWithClients();

    await expect(divigent.deposit({ amount: usdc('0.001'), slippageBps: 10_001 }))
      .rejects.toBeInstanceOf(DivigentError);
    await expect(divigent.withdraw({ shares: 1_000n, slippageBps: -1 }))
      .rejects.toBeInstanceOf(DivigentError);
    expect(writeContract).not.toHaveBeenCalled();
  });
  // Exercises: decodes previewWithdrawNet reverts for representative router errors.
  it.each([
    ['NoPositionToWithdraw', []],
    ['PositionRoundsToZero', []],
    ['PreviewMathDegenerate', []],
    ['UnserviceableNet', [usdc('10'), usdc('5')]],
  ] as const)('decodes previewWithdrawNet %s reverts', async (errorName, args) => {
    const data = encodeErrorResult({
      abi: routerAbi,
      errorName,
      args,
    } as never);
    const { divigent } = createDivigentWithClients({
      readContract: (request) => {
        if (request.functionName === 'previewWithdrawNet') {
          throw new ContractFunctionRevertedError({
            abi: routerAbi,
            data,
            functionName: 'previewWithdrawNet',
          });
        }
        throw new Error(`Unhandled readContract function ${String(request.functionName)}`);
      },
    });

    await expect(divigent.previewWithdrawNet(usdc('10'), OWNER))
      .rejects.toMatchObject({
        errorName,
        code: 'DIVIGENT_CONTRACT_REVERT',
      });
    await expect(divigent.previewWithdrawNet(usdc('10'), OWNER))
      .rejects.toBeInstanceOf(ContractRevertError);
  });
  // Exercises: decodes replayed initialize attempts as WalletAlreadyAuthorised.
  it('decodes replayed initialize attempts as WalletAlreadyAuthorised', async () => {
    const data = encodeErrorResult({
      abi: routerAbi,
      errorName: 'WalletAlreadyAuthorised',
    });
    const { divigent } = createDivigentWithClients({
      simulateContract: (request) => {
        if (request.functionName === 'initialize') {
          throw new ContractFunctionRevertedError({
            abi: routerAbi,
            data,
            functionName: 'initialize',
          });
        }
        throw new Error(`Unhandled simulateContract function ${String(request.functionName)}`);
      },
    });

    await expect(divigent.initialize()).rejects.toMatchObject({
      errorName: 'WalletAlreadyAuthorised',
      code: 'DIVIGENT_CONTRACT_REVERT',
    });
  });
});

describe('transaction planning', () => {
  // Exercises: public approval helper uses the same deposit-safe buffer as internal fallbacks.
  it('approves a deposit-safe allowance amount', async () => {
    const amount = usdc('0.001');
    const { divigent, simulateContract } = createDivigentWithClients({
      writeHashes: [HASH_1],
    });

    await expect(divigent.approveUsdc(amount)).resolves.toBe(HASH_1);

    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'approve',
      args: [addresses.router, amount + 1n],
    }));
  });
  // Exercises: approval buffering preserves exact values for revokes and max approvals.
  it.each([
    ['zero revokes', 0n],
    ['max uint256 approvals', (1n << 256n) - 1n],
  ])('does not buffer %s', async (_label, approvalAmount) => {
    const { divigent, simulateContract } = createDivigentWithClients({
      writeHashes: [HASH_1],
    });

    await expect(divigent.approveUsdc(approvalAmount)).resolves.toBe(HASH_1);

    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'approve',
      args: [addresses.router, approvalAmount],
    }));
  });
  // Exercises: plans an approval with owner, token, spender, simulation result, and fee overrides.
  it('plans an approval with owner, token, spender, simulation result, and fee overrides', async () => {
    const amount = usdc('0.001');
    const { divigent } = createDivigentWithClients();

    const plan = await divigent.planApproveUsdc(amount, {
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 2n,
    });

    expect(plan).toMatchObject({
      kind: 'approveUsdc',
      owner: OWNER,
      token: addresses.usdc,
      spender: addresses.router,
      amount,
      approvalAmount: amount + 1n,
      simulationResult: true,
    });
    expect(plan.request).toMatchObject({
      address: addresses.usdc,
      functionName: 'approve',
      args: [addresses.router, amount + 1n],
      account: { address: OWNER, type: 'json-rpc' },
      chain: expect.objectContaining({ id: baseSepolia.id }),
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 2n,
    });
  });
  // Exercises: broadcasts a planned transaction request without rebuilding it.
  it('broadcasts a planned transaction request without rebuilding it', async () => {
    const { divigent, writeContract } = createDivigentWithClients({
      writeHashes: [HASH_2],
    });
    const plan = await divigent.planApproveUsdc(usdc('0.001'), {
      maxFeePerGas: 10n,
    });

    await expect(divigent.sendPlan(plan)).resolves.toBe(HASH_2);
    expect(writeContract).toHaveBeenCalledWith(plan.request);
  });
  // Exercises: plans deposit approval requirement and skips deposit simulation when allowance is short.
  it('plans deposit approval requirement and skips deposit simulation when allowance is short', async () => {
    const { divigent, simulateContract } = createDivigentWithClients({
      allowance: usdc('0.000250'),
      previewDeposit: 1_000_000n,
    });

    const plan = await divigent.planDeposit({ amount: usdc('0.001') });

    expect(plan.approvalRequired).toBe(usdc('0.000750'));
    expect(plan.simulated).toBe(false);
    expect(plan.simulatedSharesOut).toBeUndefined();
    expect(plan.request).toMatchObject({
      address: addresses.router,
      functionName: 'deposit',
      args: [usdc('0.001'), OWNER, applySlippageDown(1_000_000n, 10)],
    });
    expect(simulateContract).not.toHaveBeenCalled();
  });
  // Exercises: deposit plans check allowance from the wallet that funds the deposit,
  // not from an operator or relayer submitting the transaction.
  it('plans deposit approval requirement from the funding wallet override', async () => {
    const amount = usdc('0.001');
    const { divigent, readContract } = createDivigentWithClients({
      previewDeposit: 1_000_000n,
      readContract: (request) => {
        if (request.functionName === 'previewDeposit') return 1_000_000n;
        if (request.functionName === 'allowance') {
          expect(request.args).toEqual([SECOND_OWNER, addresses.router]);
          return amount - 10n;
        }
        throw new Error(`Unhandled readContract function ${String(request.functionName)}`);
      },
    });

    const plan = await divigent.planDeposit({ amount, wallet: SECOND_OWNER });

    expect(plan.owner).toBe(OWNER);
    expect(plan.wallet).toBe(SECOND_OWNER);
    expect(plan.allowance).toBe(amount - 10n);
    expect(plan.approvalRequired).toBe(10n);
    expect(plan.simulated).toBe(false);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'allowance',
      args: [SECOND_OWNER, addresses.router],
    }));
  });
  // Exercises: handles allowance boundaries without off-by-one approval mistakes.
  it('handles allowance boundaries without off-by-one approval mistakes', async () => {
    const amount = usdc('0.001');
    const cases = [
      { allowance: amount - 1n, approvalRequired: 1n, simulated: false },
      { allowance: amount, approvalRequired: 0n, simulated: true },
      { allowance: amount + 1n, approvalRequired: 0n, simulated: true },
    ] as const;

    for (const item of cases) {
      const { divigent, simulateContract } = createDivigentWithClients({
        allowance: item.allowance,
        previewDeposit: 1_000_000n,
      });

      const plan = await divigent.planDeposit({ amount });

      expect(plan.allowance).toBe(item.allowance);
      expect(plan.approvalRequired).toBe(item.approvalRequired);
      expect(plan.simulated).toBe(item.simulated);
      expect(simulateContract).toHaveBeenCalledTimes(item.simulated ? 1 : 0);
    }
  });
  // Exercises: simulates deposit when allowance is sufficient.
  it('simulates deposit when allowance is sufficient', async () => {
    const { divigent, simulateContract } = createDivigentWithClients({
      allowance: usdc('0.001'),
      previewDeposit: 1_000_000n,
      simulatedDepositResult: 999_000n,
    });

    const plan = await divigent.planDeposit({ amount: usdc('0.001'), slippageBps: 50 });

    expect(plan.approvalRequired).toBe(0n);
    expect(plan.simulated).toBe(true);
    expect(plan.simulatedSharesOut).toBe(999_000n);
    expect(plan.minSharesOut).toBe(applySlippageDown(1_000_000n, 50));
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'deposit',
      args: [usdc('0.001'), OWNER, applySlippageDown(1_000_000n, 50)],
    }));
  });
  // Exercises: plans withdraw using previewRedeem and fee overrides.
  it('plans withdraw using previewRedeem and fee overrides', async () => {
    const { divigent, simulateContract } = createDivigentWithClients({
      previewRedeem: usdc('2'),
      simulatedWithdrawResult: usdc('1.998'),
    });

    const plan = await divigent.planWithdraw({
      shares: 1_000n,
      slippageBps: 25,
      fees: { maxFeePerGas: 12n },
    });

    expect(plan).toMatchObject({
      kind: 'withdraw',
      owner: OWNER,
      wallet: OWNER,
      shares: 1_000n,
      previewUsdcOut: usdc('2'),
      minUsdcOut: applySlippageDown(usdc('2'), 25),
      slippageBps: 25,
      simulatedUsdcOut: usdc('1.998'),
    });
    expect(plan.request).toMatchObject({ maxFeePerGas: 12n });
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'withdraw',
      args: [1_000n, OWNER, applySlippageDown(usdc('2'), 25)],
    }));
  });
});
