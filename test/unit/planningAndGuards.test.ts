import { describe, expect, it } from 'vitest';
import { base, baseSepolia } from 'viem/chains';
import { Divigent } from '../../src/divigent';
import {
  AddressMismatchError,
  ChainMismatchError,
  DivigentError,
  OperatorAckRequiredError,
  ZeroAddressError,
} from '../../src/errors';
import { applySlippageDown } from '../../src/core/utils';
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
  // Rejects public or wallet clients bound to a different chain.
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

  // Requires a wallet account and chain for planning and writes.
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

  // Requires explicit deployment addresses for Base mainnet until canonical addresses exist.
  it('requires explicit deployment addresses for Base mainnet until canonical addresses exist', () => {
    const { publicClient, walletClient } = createMockClients({
      publicChainId: base.id,
      walletChainId: base.id,
    });

    expect(() => Divigent.create({
      publicClient,
      walletClient,
      chain: 'base',
    })).toThrow(DivigentError);
  });

  // Validates custom address overrides before any on-chain call.
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
  // Accepts matching router, dvUSDC, and fee collector self-identifying reads.
  it('accepts matching router, dvUSDC, and fee collector self-identifying reads', async () => {
    const { divigent } = createDivigentWithClients();
    await expect(divigent.verifyAddresses()).resolves.toBeUndefined();
  });

  // Rejects address registries that disagree with on-chain self-identifying reads.
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

describe('operator acknowledgement guard', () => {
  // Blocks granting operator authority without explicit acknowledgement.
  it('blocks granting operator authority without explicit acknowledgement', async () => {
    const { divigent, simulateContract } = createDivigentWithClients();
    await expect(
      divigent.setOperator({ operator: OPERATOR, approved: true }),
    ).rejects.toBeInstanceOf(OperatorAckRequiredError);
    expect(simulateContract).not.toHaveBeenCalled();
  });

  // Allows revoking without acknowledgement and granting with acknowledgement.
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
  // Uses explicit minSharesOut without previewing deposit.
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

  // Derives minSharesOut from previewDeposit using default and custom slippage.
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

  // Uses explicit minUsdcOut without previewing redeem.
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

  // Derives minUsdcOut from previewRedeem using default and custom slippage.
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

  // Rejects invalid slippage before broadcasting.
  it('rejects invalid slippage before broadcasting', async () => {
    const { divigent, writeContract } = createDivigentWithClients();

    await expect(divigent.deposit({ amount: usdc('0.001'), slippageBps: 10_001 }))
      .rejects.toBeInstanceOf(DivigentError);
    await expect(divigent.withdraw({ shares: 1_000n, slippageBps: -1 }))
      .rejects.toBeInstanceOf(DivigentError);
    expect(writeContract).not.toHaveBeenCalled();
  });
});

describe('transaction planning', () => {
  // Plans an approval with owner, token, spender, simulation result, and fee overrides.
  it('plans an approval with owner, token, spender, simulation result, and fee overrides', async () => {
    const { divigent } = createDivigentWithClients();

    const plan = await divigent.planApproveUsdc(usdc('0.001'), {
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 2n,
    });

    expect(plan).toMatchObject({
      kind: 'approveUsdc',
      owner: OWNER,
      token: addresses.usdc,
      spender: addresses.router,
      amount: usdc('0.001'),
      simulationResult: true,
    });
    expect(plan.request).toMatchObject({
      address: addresses.usdc,
      functionName: 'approve',
      args: [addresses.router, usdc('0.001')],
      account: { address: OWNER, type: 'json-rpc' },
      chain: expect.objectContaining({ id: baseSepolia.id }),
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 2n,
    });
  });

  // Broadcasts a planned transaction request without rebuilding it.
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

  // Plans deposit approval requirement and skips deposit simulation when allowance is short.
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

  // Handles allowance boundaries without off-by-one approval mistakes.
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

  // Simulates deposit when allowance is sufficient.
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

  // Plans withdraw using previewRedeem and fee overrides.
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
