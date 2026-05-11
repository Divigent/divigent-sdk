import { expect } from 'vitest';
import { parseUsdc } from '../../src/core/utils';
import { divigentBaseMainnetForkTest as test } from '../fork/setup';
import {
  approveUsdcAndWait,
  depositAndAssert,
  expectDepositApplied,
  withPreparedAgent,
  X402_AGENT_DEPOSIT_PRIVATE_KEY,
} from './helpers/x402AgentFork';
test.sequential(
  'x402 agent deposits idle USDC through approve plus deposit',
  async ({ divigent, publicClient, rpcUrl }) => {
    const depositAmount = parseUsdc('10');
    const fundingAmount = parseUsdc('25');

    await withPreparedAgent({
      privateKey: X402_AGENT_DEPOSIT_PRIVATE_KEY,
      rpcUrl,
      publicClient,
      addresses: divigent.addresses,
      fundingAmount,
      initialize: true,
    }, async (agent) => {
      await expect(agent.sdk.verifyAddresses()).resolves.toBeUndefined();
      await expect(agent.sdk.usdcBalance(agent.wallet)).resolves.toBe(fundingAmount);

      await approveUsdcAndWait(agent, publicClient, depositAmount);
      await expect(agent.sdk.usdcAllowance(agent.wallet)).resolves.toBe(depositAmount);

      const depositPlan = await agent.sdk.planDeposit({ amount: depositAmount, slippageBps: 25 });
      expect(depositPlan.wallet).toBe(agent.wallet);
      expect(depositPlan.simulated).toBe(true);
      expect(depositPlan.approvalRequired).toBe(0n);
      expect(depositPlan.simulatedSharesOut).toBeGreaterThanOrEqual(depositPlan.minSharesOut);

      const deposit = await depositAndAssert(agent, publicClient, depositAmount);
      await expectDepositApplied(agent, {
        amount: depositAmount,
        sharesMinted: deposit.sharesMinted,
        liquidUsdc: fundingAmount - depositAmount,
        allowance: 0n,
      });
    });
  },
);
