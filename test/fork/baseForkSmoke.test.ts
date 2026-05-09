import { expect } from 'vitest';
import { createWalletClient, http, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { Divigent } from '../../src/divigent';
import { parseUsdc } from '../../src/core/utils';
import type { EvmAddress } from '../../src/types';
import { divigentBaseMainnetForkTest as test } from './setup';

// Smoke/preflight coverage for Base fork setup. Function-level behavior lives
// in test/integration/* so reviewers can inspect each SDK flow directly.

// Deterministic local-only account used to prove planning behavior is not
// affected by state left on Anvil's default account.
const FRESH_LOCAL_FORK_PRIVATE_KEY =
  '0x1111111111111111111111111111111111111111111111111111111111111111';

test.sequential(
  'verifies the deployed Base mainnet contract wiring on an isolated fork',
  async ({ divigent, publicClient }) => {
    await expect(publicClient.getChainId()).resolves.toBe(base.id);
    await expect(divigent.verifyAddresses()).resolves.toBeUndefined();

    const [previewShares, pricePerShare, depositsPaused, withdrawCapacity] = await Promise.all([
      divigent.previewDeposit(parseUsdc('10')),
      divigent.pricePerShare(),
      divigent.depositsPaused(),
      divigent.withdrawCapacity(),
    ]);

    expect(previewShares).toBeGreaterThan(0n);
    expect(pricePerShare).toBeGreaterThan(0n);
    expect(typeof depositsPaused).toBe('boolean');
    expect(withdrawCapacity.totalWithdrawCap).toBeGreaterThanOrEqual(0n);
  },
);

test.sequential(
  'plans deposits conservatively for a fresh fork wallet without allowance',
  async ({ divigent, publicClient, rpcUrl }) => {
    const account = privateKeyToAccount(FRESH_LOCAL_FORK_PRIVATE_KEY);
    const walletClient = createWalletClient({ account, chain: base, transport: http(rpcUrl) });
    const freshDivigent = Divigent.create({
      publicClient: publicClient as unknown as PublicClient,
      walletClient: walletClient as unknown as WalletClient,
      chain: 'base',
      addresses: divigent.addresses,
    });
    const amount = parseUsdc('10');
    const plan = await freshDivigent.planDeposit({ amount, slippageBps: 25 });

    expect(plan.owner).toBe(account.address);
    expect(plan.wallet).toBe(account.address);
    expect(plan.allowance).toBe(0n);
    expect(plan.approvalRequired).toBe(amount);
    expect(plan.simulated).toBe(false);
    expect(plan.simulatedSharesOut).toBeUndefined();
    expect(plan.minSharesOut).toBeLessThanOrEqual(plan.previewShares);
  },
);

test.sequential(
  'broadcasts a real approval transaction against forked Base mainnet USDC',
  async ({ account, divigent, publicClient }) => {
    const amount = parseUsdc('0.123456');

    const plan = await divigent.planApproveUsdc(amount);
    expect(plan.owner).toBe(account.address);
    expect(plan.token).toBe(divigent.addresses.usdc);
    expect(plan.spender).toBe(divigent.addresses.router);
    expect(plan.amount).toBe(amount);
    expect(plan.simulationResult).toBe(true);

    const hash = await divigent.sendPlan(plan);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const allowance = await divigent.usdcAllowance(account.address as EvmAddress);

    expect(receipt.status).toBe('success');
    expect(allowance).toBe(amount);
  },
);
