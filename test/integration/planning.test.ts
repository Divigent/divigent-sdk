import { expect } from 'vitest';
import { parseUsdc } from '../../src/core/utils';
import { divigentBaseMainnetForkTest as test } from '../fork/setup';
import {
  expectFullExit,
  sendDepositPlanAndAssert,
  sendAndExpectSuccess,
  sendWithdrawPlanAndAssert,
  withPreparedAgent,
  X402_AGENT_PLAN_PRIVATE_KEY,
} from './helpers/x402AgentFork';
test.sequential(
  'x402 agent executes planned approve, deposit, and withdraw transactions',
  async ({ divigent, publicClient, rpcUrl }) => {
    const amount = parseUsdc('12');

    await withPreparedAgent({
      privateKey: X402_AGENT_PLAN_PRIVATE_KEY,
      rpcUrl,
      publicClient,
      addresses: divigent.addresses,
      initialize: true,
    }, async (agent) => {
      const missingApprovalPlan = await agent.sdk.planDeposit({ amount, slippageBps: 25 });
      expect(missingApprovalPlan.wallet).toBe(agent.wallet);
      expect(missingApprovalPlan.allowance).toBe(0n);
      expect(missingApprovalPlan.approvalRequired).toBe(amount);
      expect(missingApprovalPlan.simulated).toBe(false);
      expect(missingApprovalPlan.simulatedSharesOut).toBeUndefined();

      const approvePlan = await agent.sdk.planApproveUsdc(amount);
      expect(approvePlan.owner).toBe(agent.wallet);
      expect(approvePlan.token).toBe(agent.sdk.addresses.usdc);
      expect(approvePlan.spender).toBe(agent.sdk.addresses.router);
      expect(approvePlan.amount).toBe(amount);
      expect(approvePlan.simulationResult).toBe(true);
      const approveHash = await agent.sdk.sendPlan(approvePlan);
      await sendAndExpectSuccess(publicClient, approveHash);
      await expect(agent.sdk.usdcAllowance(agent.wallet)).resolves.toBe(amount);

      const depositPlan = await agent.sdk.planDeposit({ amount, slippageBps: 25 });
      expect(depositPlan.simulated).toBe(true);
      expect(depositPlan.approvalRequired).toBe(0n);
      const deposit = await sendDepositPlanAndAssert(agent, publicClient, depositPlan);
      await expect(agent.sdk.dvUsdcBalance(agent.wallet)).resolves.toBe(deposit.sharesMinted);

      const withdrawPlan = await agent.sdk.planWithdraw({
        shares: deposit.sharesMinted,
        slippageBps: 25,
      });
      expect(withdrawPlan.simulatedUsdcOut).toBeGreaterThanOrEqual(withdrawPlan.minUsdcOut);
      const balanceBeforeWithdraw = await agent.sdk.usdcBalance(agent.wallet);
      const withdraw = await sendWithdrawPlanAndAssert(agent, publicClient, withdrawPlan);

      await expect(agent.sdk.usdcBalance(agent.wallet)).resolves.toBe(
        balanceBeforeWithdraw + withdraw.usdcReturned,
      );
      await expectFullExit(agent);
    });
  },
);
