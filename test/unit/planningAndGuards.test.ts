import { describe, expect, it, vi } from 'vitest';
import { ContractFunctionRevertedError, encodeErrorResult } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { routerAbi, usdcAbi } from '../../src/abis';
import { Divigent, type DivigentTransactionPlan } from '../../src/divigent';
import type { DivigentCallExecutor } from '../../src/execution';
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
  HASH_3,
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
  // Exercises: accepts the deprecated Steakhouse Prime field as an address override alias.
  it('normalizes legacy Steakhouse Prime override aliases', () => {
    const { publicClient, walletClient } = createMockClients();
    const { steakhouseUSDCVault, ...withoutNewName } = addresses;

    const divigent = Divigent.create({
      publicClient,
      walletClient,
      chain: 'base-sepolia',
      addresses: {
        ...withoutNewName,
        steakhouseUSDCPrimeVault: steakhouseUSDCVault,
      },
    });

    expect(divigent.addresses.steakhouseUSDCVault).toBe(steakhouseUSDCVault);
    expect(divigent.addresses.steakhouseUSDCPrimeVault).toBe(steakhouseUSDCVault);
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
  // Exercises: bare clients must not silently fall back to the testnet deployment.
  it('requires an explicit chain when clients do not expose chain metadata', () => {
    const { publicClient } = createMockClients();
    const unboundPublicClient = { ...publicClient, chain: undefined };

    let thrown: unknown;
    try {
      Divigent.create({
        publicClient: unboundPublicClient as typeof publicClient,
        addresses,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(DivigentError);
    expect(thrown).toMatchObject({
      code: 'DIVIGENT_CHAIN_REQUIRED',
      category: 'config',
    });
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
  // Exercises: runtime fee objects cannot shadow simulated request identity fields.
  it.each(Object.entries({
    address: SECOND_OWNER,
    functionName: 'withdraw',
    args: [1n, SECOND_OWNER, 1n],
    account: SECOND_OWNER,
    chain: baseSepolia,
    value: 1n,
    data: '0xdeadbeef',
  }))('rejects unknown runtime fee key %s in approval plans', async (key, value) => {
    const { divigent } = createDivigentWithClients();

    await expect(divigent.planApproveUsdc(usdc('0.001'), { [key]: value } as never))
      .rejects.toMatchObject({
        code: 'DIVIGENT_INVALID_FEE_OVERRIDES',
        category: 'validation',
      });
  });
  // Exercises: deposit and withdraw planners share the same fee allowlist boundary.
  it('rejects unknown runtime fee keys in deposit and withdraw plans', async () => {
    const deposit = createDivigentWithClients({ allowance: usdc('0.001') });
    const withdraw = createDivigentWithClients();
    const fees = {
      maxFeePerGas: 10n,
      args: [1n, SECOND_OWNER, 1n],
    } as never;

    await expect(deposit.divigent.planDeposit({ amount: usdc('0.001'), fees }))
      .rejects.toMatchObject({
        code: 'DIVIGENT_INVALID_FEE_OVERRIDES',
        category: 'validation',
      });
    await expect(withdraw.divigent.planWithdraw({ shares: 1_000n, fees }))
      .rejects.toMatchObject({
        code: 'DIVIGENT_INVALID_FEE_OVERRIDES',
        category: 'validation',
      });
  });
  // Exercises: fee values are validated before they reach viem's write path.
  it.each([
    ['wrong type', { maxFeePerGas: '100' }],
    ['negative bigint', { maxPriorityFeePerGas: -1n }],
  ])('rejects %s fee override values', async (_label, fees) => {
    const { divigent } = createDivigentWithClients();

    await expect(divigent.planApproveUsdc(usdc('0.001'), fees as never))
      .rejects.toMatchObject({
        code: 'DIVIGENT_INVALID_FEE_OVERRIDES',
        category: 'validation',
      });
  });
  // Exercises: direct write helpers sanitize fee overrides before broadcasting.
  it('rejects malicious fee keys in direct approval and router write paths', async () => {
    const approval = createDivigentWithClients({ allowance: 0n });
    const router = createDivigentWithClients();

    await expect(approval.divigent.depositWithApproval({
      amount: usdc('0.001'),
      minSharesOut: 1n,
      fees: { address: SECOND_OWNER } as never,
    })).rejects.toMatchObject({
      code: 'DIVIGENT_INVALID_FEE_OVERRIDES',
      category: 'validation',
    });
    expect(approval.writeContract).not.toHaveBeenCalled();

    await expect(router.divigent.deposit({
      amount: usdc('0.001'),
      minSharesOut: 1n,
      fees: { functionName: 'withdraw' } as never,
    })).rejects.toMatchObject({
      code: 'DIVIGENT_INVALID_FEE_OVERRIDES',
      category: 'validation',
    });
    expect(router.writeContract).not.toHaveBeenCalled();
  });
  // Exercises: executor-backed planning uses the executor account and routes calls through executeCalls.
  it('routes planned writes through a configured executor', async () => {
    const { publicClient, simulateContract, writeContract } = createMockClients();
    const executeCalls = vi.fn(async () => ({ txHash: HASH_2 }));
    const executor: DivigentCallExecutor = {
      account: OWNER,
      kind: 'custom',
      executeCalls,
    };
    const divigent = Divigent.create({
      publicClient,
      executor,
      chain: 'base-sepolia',
      addresses,
    });

    const plan = await divigent.planApproveUsdc(usdc('0.001'));

    expect(plan.owner).toBe(OWNER);
    expect(plan.request).toMatchObject({
      account: OWNER,
      functionName: 'approve',
    });
    await expect(divigent.sendPlan(plan)).resolves.toBe(HASH_2);
    expect(writeContract).not.toHaveBeenCalled();
    expect(executeCalls).toHaveBeenCalledWith(
      [expect.objectContaining({
        to: addresses.usdc,
        data: expect.stringMatching(/^0x095ea7b3/),
      })],
      expect.objectContaining({
        chain: 'base-sepolia',
        chainId: baseSepolia.id,
        addresses,
      }),
    );
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      account: OWNER,
      functionName: 'approve',
    }));
  });

  // Exercises: executor bundles can resolve asynchronously through waitForResult.
  it('resolves executor call-bundle handles through waitForResult', async () => {
    const { publicClient } = createMockClients();
    const executeCalls = vi.fn(async () => ({ callBundleId: 'bundle-1' }));
    const waitForResult = vi.fn(async () => ({ txHash: HASH_3 }));
    const divigent = Divigent.create({
      publicClient,
      executor: {
        account: OWNER,
        kind: 'custom',
        executeCalls,
        waitForResult,
      },
      chain: 'base-sepolia',
      addresses,
    });
    const plan = await divigent.planApproveUsdc(usdc('0.001'));

    await expect(divigent.sendPlans([plan], { confirmations: 2 }))
      .resolves.toMatchObject({
        mode: 'batched',
        txHashes: [HASH_3],
        handle: { callBundleId: 'bundle-1' },
      });

    expect(waitForResult).toHaveBeenCalledWith(
      { callBundleId: 'bundle-1' },
      expect.objectContaining({
        waitOptions: { confirmations: 2 },
      }),
    );
  });

  // Exercises: executor call conversion fails fast when calldata args are malformed.
  it('rejects executor plans with missing ABI arguments before broadcasting', async () => {
    const { publicClient } = createMockClients();
    const executeCalls = vi.fn(async () => ({ txHash: HASH_1 }));
    const divigent = Divigent.create({
      publicClient,
      executor: {
        account: OWNER,
        kind: 'custom',
        executeCalls,
      },
      chain: 'base-sepolia',
      addresses,
    });
    const plan = {
      kind: 'approveUsdc',
      owner: OWNER,
      request: {
        address: addresses.usdc,
        abi: usdcAbi,
        functionName: 'approve',
        account: OWNER,
      },
    } as unknown as DivigentTransactionPlan;

    await expect(divigent.sendPlan(plan)).rejects.toMatchObject({
      code: 'DIVIGENT_PLAN_ARGS_MISSING',
    });
    expect(executeCalls).not.toHaveBeenCalled();
  });
  // Exercises: sequential EOA batches wait for intermediate transactions before broadcasting the next plan.
  it('sends EOA plan batches sequentially and waits between transactions', async () => {
    const { divigent, writeContract, waitForTransactionReceipt } = createDivigentWithClients({
      allowance: usdc('0.002') + 1n,
      writeHashes: [HASH_1, HASH_2],
    });
    const first = await divigent.planApproveUsdc(usdc('0.001'));
    const second = await divigent.planApproveUsdc(usdc('0.002'));

    await expect(divigent.sendPlans([first, second], { confirmations: 2 }))
      .resolves.toEqual({
        mode: 'sequential',
        txHashes: [HASH_1, HASH_2],
      });

    expect(writeContract).toHaveBeenCalledTimes(2);
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: HASH_1,
      confirmations: 2,
    });
  });
  // Exercises: approval-backed deposits batch approve + deposit for smart account executors.
  it('batches approve and deposit for executor-backed approval deposits', async () => {
    const { publicClient, readContract, writeContract } = createMockClients({
      allowance: 0n,
      previewDeposit: 1_000_000n,
    });
    const executeCalls = vi.fn(async () => ({ txHash: HASH_3 }));
    const divigent = Divigent.create({
      publicClient,
      executor: {
        account: OWNER,
        kind: 'custom',
        executeCalls,
      },
      chain: 'base-sepolia',
      addresses,
    });

    await expect(divigent.depositWithApproval({ amount: usdc('0.001') }))
      .resolves.toBe(HASH_3);

    expect(writeContract).not.toHaveBeenCalled();
    expect(executeCalls).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          to: addresses.usdc,
          data: expect.stringMatching(/^0x095ea7b3/),
        }),
        expect.objectContaining({
          to: addresses.router,
          data: expect.stringMatching(/^0xbc157ac1/),
        }),
      ],
      expect.any(Object),
    );
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'allowance',
      args: [OWNER, addresses.router],
    }));
  });
  // Exercises: executor deposits do not approve again when the smart account allowance is already deposit-safe.
  it('skips executor approval when allowance already covers the buffered deposit', async () => {
    const amount = usdc('0.001');
    const { publicClient } = createMockClients({
      allowance: amount + 1n,
      previewDeposit: 1_000_000n,
    });
    const executeCalls = vi.fn(async () => ({ txHash: HASH_2 }));
    const divigent = Divigent.create({
      publicClient,
      executor: {
        account: OWNER,
        kind: 'custom',
        executeCalls,
      },
      chain: 'base-sepolia',
      addresses,
    });

    await divigent.depositWithApproval({ amount });

    expect(executeCalls).toHaveBeenCalledWith(
      [expect.objectContaining({ to: addresses.router })],
      expect.any(Object),
    );
  });
  // Exercises: executor-backed deposits cannot approve one account while funding another wallet.
  it('rejects executor approval deposits for a different funding wallet', async () => {
    const { publicClient } = createMockClients();
    const divigent = Divigent.create({
      publicClient,
      executor: {
        account: OWNER,
        kind: 'custom',
        executeCalls: vi.fn(async () => ({ txHash: HASH_1 })),
      },
      chain: 'base-sepolia',
      addresses,
    });

    await expect(divigent.depositWithApproval({
      amount: usdc('0.001'),
      wallet: SECOND_OWNER,
    })).rejects.toMatchObject({
      code: 'DIVIGENT_EXECUTOR_WALLET_MISMATCH',
    });
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
  // Exercises: below-minimum deposits cannot hide behind a short allowance plan.
  it('rejects planDeposit below MIN_DEPOSIT before allowance handling', async () => {
    const { divigent, readContract, simulateContract } = createDivigentWithClients({
      allowance: 0n,
      minDeposit: usdc('10'),
      previewDeposit: 1_000_000n,
    });

    await expect(divigent.planDeposit({ amount: usdc('9.999999') }))
      .rejects.toBeInstanceOf(MinDepositNotMetError);

    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'MIN_DEPOSIT',
    }));
    expect(readContract).not.toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'previewDeposit',
    }));
    expect(readContract).not.toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'allowance',
    }));
    expect(simulateContract).not.toHaveBeenCalled();
  });
  // Exercises: deposit plans check allowance from the wallet that funds the deposit,
  // not from an operator or relayer submitting the transaction.
  it('plans deposit approval requirement from the funding wallet override', async () => {
    const amount = usdc('0.001');
    const { divigent, readContract } = createDivigentWithClients({
      previewDeposit: 1_000_000n,
      readContract: (request) => {
        if (request.functionName === 'MIN_DEPOSIT') return 0n;
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

describe('liquidity intelligence helpers', () => {
  // Exercises: returns an explainable read-only liquidity decision without moving funds.
  it('assesses reserve, deployable excess, venue, and health from policy context', async () => {
    const { divigent } = createDivigentWithClients({
      usdcBalance: usdc('100'),
      position: [usdc('20'), usdc('20'), 0n],
      minDeposit: usdc('10'),
      recommendedRoute: 1,
    });

    const assessment = await divigent.assessLiquidity({
      pendingPaymentAmount: usdc('5'),
      includeVenueHealth: true,
      policyContext: {
        minOperatingBalance: usdc('10'),
        upcomingKnownPayouts: usdc('20'),
        recentPaymentEma: usdc('50'),
        reserveRatio: 0.2,
        reserveMultiplier: 1,
        riskPreference: 'conservative',
      },
    });

    expect(assessment).toMatchObject({
      wallet: OWNER,
      riskPreference: 'conservative',
      paymentReady: true,
      canBecomePaymentReady: true,
      reserveHealthy: true,
      liquidityStatus: 'healthy',
      pendingPaymentAmount: usdc('5'),
      walletBalance: usdc('100'),
      positionCurrentValue: usdc('20'),
      minOperatingBalance: usdc('10'),
      knownUpcomingOutflows: usdc('20'),
      upcomingKnownPayouts: usdc('20'),
      adaptiveReserve: usdc('10'),
      requiredReserve: usdc('45'),
      targetLiquidBalance: usdc('50'),
      maxDeployableAmount: usdc('50'),
      deployableExcess: usdc('50'),
      recommendedDeploymentAmount: usdc('50'),
      recallRequired: false,
      recommendedRecallAmount: 0n,
      preferredVenue: 'MORPHO',
      venueHealth: expect.objectContaining({
        status: 'healthy',
        oracleFresh: true,
      }),
    });
  });

  // Exercises: recalls through the existing withdraw path when assessment says liquidity is short.
  it('ensures payment readiness by recalling the assessed deficit', async () => {
    const { divigent } = createDivigentWithClients({
      usdcBalance: usdc('1'),
      position: [usdc('20'), usdc('20'), 0n],
      previewWithdrawNet: 42n,
    });
    const withdrawAndWait = vi.spyOn(divigent, 'withdrawAndWait').mockResolvedValue({
      txHash: HASH_1,
      usdcReturned: usdc('5'),
    });

    const result = await divigent.ensurePaymentReady({
      pendingPayment: { amount: usdc('5') },
      policyContext: {
        minOperatingBalance: usdc('1'),
        riskPreference: 'balanced',
      },
      slippageBps: 25,
      confirmations: 2,
    });

    expect(result).toMatchObject({
      recallTxHash: HASH_1,
      usdcReturned: usdc('5'),
      assessment: expect.objectContaining({
        paymentReady: false,
        canBecomePaymentReady: true,
        liquidityStatus: 'needs_recall',
        recommendedRecallAmount: usdc('5'),
        executableRecallAmount: usdc('5'),
        recallCoversTarget: true,
        recommendedRecallShares: 42n,
        recommendedAction: 'recall',
      }),
    });
    expect(withdrawAndWait).toHaveBeenCalledWith(expect.objectContaining({
      shares: 42n,
      wallet: OWNER,
      slippageBps: 25,
      confirmations: 2,
    }));
  });

  // Exercises: distinguishes payment-only recall from a full reserve-restoring recall.
  it('marks recall as partial when the position can cover payment but not the full reserve target', async () => {
    const { divigent } = createDivigentWithClients({
      usdcBalance: usdc('1'),
      position: [usdc('4.1'), usdc('4.1'), 0n],
      previewWithdrawNet: 99n,
    });
    const withdrawAndWait = vi.spyOn(divigent, 'withdrawAndWait').mockResolvedValue({
      txHash: HASH_1,
      usdcReturned: usdc('4'),
    });

    const result = await divigent.ensurePaymentReady({
      pendingPaymentAmount: usdc('5'),
      minOperatingBalance: usdc('1'),
    });

    expect(result).toMatchObject({
      recallTxHash: HASH_1,
      usdcReturned: usdc('4'),
      assessment: expect.objectContaining({
        paymentReady: false,
        canBecomePaymentReady: true,
        liquidityStatus: 'partial_recall_only',
        recommendedRecallAmount: usdc('5'),
        executableRecallAmount: usdc('4.020101'),
        executableRecallNetAmount: usdc('4'),
        recallCoversTarget: false,
        recallUnavailableCode: 'position_insufficient',
        recommendedRecallShares: 99n,
        recommendedAction: 'recall',
      }),
    });
    expect(withdrawAndWait).toHaveBeenCalledWith(expect.objectContaining({
      shares: 99n,
      wallet: OWNER,
    }));
  });

  // Exercises: refuses to report payment-ready when deployed liquidity cannot cover the payment.
  it('reports insufficient liquidity when partial recall cannot satisfy the payment amount', async () => {
    const { divigent } = createDivigentWithClients({
      usdcBalance: usdc('1'),
      position: [usdc('3'), usdc('3'), 0n],
    });

    await expect(divigent.ensurePaymentReady({
      pendingPaymentAmount: usdc('5'),
      minOperatingBalance: usdc('1'),
    })).rejects.toMatchObject({
      code: 'DIVIGENT_LIQUIDITY_RECALL_UNAVAILABLE',
      context: expect.objectContaining({
        recallUnavailableCode: 'position_insufficient',
        recallUnavailableReason: 'deployed Divigent position cannot fully satisfy the target reserve',
      }),
    });

    const assessment = await divigent.assessLiquidity({
      pendingPaymentAmount: usdc('5'),
      minOperatingBalance: usdc('1'),
    });

    expect(assessment).toMatchObject({
      canBecomePaymentReady: false,
      liquidityStatus: 'insufficient_liquidity',
      recallUnavailableCode: 'position_insufficient',
      recommendedAction: 'insufficient_liquidity',
    });
  });

  // Exercises: treats reserve-only shortfalls as non-blocking when the payment amount is already liquid.
  it('does not throw when only the reserve is low and no recall is available', async () => {
    const { divigent } = createDivigentWithClients({
      usdcBalance: usdc('5'),
      position: [0n, 0n, 0n],
    });

    await expect(divigent.ensurePaymentReady({
      pendingPaymentAmount: usdc('4'),
      minOperatingBalance: usdc('2'),
    })).resolves.toMatchObject({
      assessment: expect.objectContaining({
        paymentReady: true,
        reserveHealthy: false,
        liquidityStatus: 'reserve_low',
        recallRequired: true,
        recommendedAction: 'none',
      }),
    });
  });

  // Exercises: payment-ready callers can keep reserve top-ups off the critical path.
  it('skips reserve-only top-up by default when the payment is already liquid', async () => {
    const { divigent } = createDivigentWithClients({
      usdcBalance: usdc('5'),
      position: [usdc('20'), usdc('20'), 0n],
      previewWithdrawNet: 42n,
    });
    const withdrawAndWait = vi.spyOn(divigent, 'withdrawAndWait').mockResolvedValue({
      txHash: HASH_1,
      usdcReturned: usdc('2'),
    });

    await expect(divigent.ensurePaymentReady({
      pendingPaymentAmount: usdc('4'),
      minOperatingBalance: usdc('3'),
    })).resolves.toMatchObject({
      assessment: expect.objectContaining({
        paymentReady: true,
        liquidityStatus: 'reserve_low',
        recommendedAction: 'recall',
      }),
    });
    expect(withdrawAndWait).not.toHaveBeenCalled();
  });

  // Exercises: reserve top-up can be opted into when the caller wants the full target restored.
  it('recalls reserve-only shortfalls when reserveTopUp is opportunistic', async () => {
    const { divigent } = createDivigentWithClients({
      usdcBalance: usdc('5'),
      position: [usdc('20'), usdc('20'), 0n],
      previewWithdrawNet: 42n,
    });
    const withdrawAndWait = vi.spyOn(divigent, 'withdrawAndWait').mockResolvedValue({
      txHash: HASH_1,
      usdcReturned: usdc('2'),
    });

    await expect(divigent.ensurePaymentReady({
      pendingPaymentAmount: usdc('4'),
      minOperatingBalance: usdc('3'),
      reserveTopUp: 'opportunistic',
    })).resolves.toMatchObject({
      recallTxHash: HASH_1,
      assessment: expect.objectContaining({
        paymentReady: true,
        liquidityStatus: 'reserve_low',
        recommendedAction: 'recall',
      }),
    });
    expect(withdrawAndWait).toHaveBeenCalledWith(expect.objectContaining({
      shares: 42n,
      wallet: OWNER,
    }));
  });

  // Exercises: balanced preserves the computed reserve, while capital-efficient can reduce adaptive reserve only.
  it('applies balanced and capital-efficient risk profile reserve math', async () => {
    const { divigent } = createDivigentWithClients({ usdcBalance: usdc('100') });

    await expect(divigent.assessLiquidity({
      minOperatingBalance: usdc('10'),
      recentPaymentEma: usdc('100'),
      reserveRatio: 0.2,
      reserveMultiplier: 1,
      riskPreference: 'balanced',
    })).resolves.toMatchObject({
      requiredReserve: usdc('20'),
      recommendedDeploymentAmount: usdc('80'),
      recommendedAction: 'deploy',
    });

    await expect(divigent.assessLiquidity({
      minOperatingBalance: usdc('10'),
      recentPaymentEma: usdc('100'),
      reserveRatio: 0.2,
      reserveMultiplier: 1,
      riskPreference: 'capital-efficient',
    })).resolves.toMatchObject({
      requiredReserve: usdc('15'),
      recommendedDeploymentAmount: usdc('85'),
      recommendedAction: 'deploy',
    });
  });

  // Exercises: route failures do not leave a positive deploy recommendation behind.
  it('zeros recommended deployment when no deposit route is available', async () => {
    const { divigent } = createDivigentWithClients({
      usdcBalance: usdc('100'),
      minDeposit: usdc('10'),
    });
    vi.spyOn(divigent, 'getRecommendedRoute').mockRejectedValue(new Error('no safe route'));

    await expect(divigent.assessLiquidity()).resolves.toMatchObject({
      deployableExcess: usdc('90'),
      recommendedDeploymentAmount: 0n,
      recommendedAction: 'none',
      venueUnavailableReason: 'no safe route',
    });
  });

  // Exercises: venue health reflects stale oracle / venue-rate safety without changing balances.
  it('reports degraded venue health when oracle or venue data is unsafe', async () => {
    const { divigent } = createDivigentWithClients();
    vi.spyOn(divigent, 'oracleStatus').mockResolvedValue({
      lastObservationTime: 1n,
      fresh: false,
    });

    await expect(divigent.assessLiquidity({
      includeVenueHealth: true,
    })).resolves.toMatchObject({
      venueHealth: expect.objectContaining({
        status: 'degraded',
        oracleFresh: false,
      }),
    });
  });

  // Exercises: validates liquidity policy percentages before making route decisions.
  it('rejects invalid liquidity policy percentages', async () => {
    const { divigent } = createDivigentWithClients();

    await expect(divigent.assessLiquidity({
      maxDeployablePercent: 101,
    })).rejects.toMatchObject({
      code: 'DIVIGENT_INVALID_LIQUIDITY_POLICY',
    });
  });

  // Exercises: avoids ambiguous treasury input when both payout aliases are supplied.
  it('rejects conflicting upcoming payout aliases', async () => {
    const { divigent } = createDivigentWithClients();

    await expect(divigent.assessLiquidity({
      knownUpcomingOutflows: usdc('1'),
      upcomingKnownPayouts: usdc('2'),
    })).rejects.toMatchObject({
      code: 'DIVIGENT_INVALID_LIQUIDITY_POLICY',
    });
  });
});
