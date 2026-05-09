import { expect } from 'vitest';
import { parseDepositReceipt, parseWithdrawReceipt } from '../../src/core/receipts';
import { parseUsdc } from '../../src/core/utils';
import { divigentBaseMainnetForkTest as test } from '../fork/setup';
import {
  createX402AgentForPrivateKey,
  expectDepositedEvent,
  expectWithdrawnEvent,
  prepareX402Agent,
  withSnapshot,
  X402_AGENT_PLAN_PRIVATE_KEY,
} from './helpers/x402AgentFork';

// Verifies transaction plans are executable for agent approve, deposit, and withdraw flows.
test.sequential(
  'x402 agent executes planned approve, deposit, and withdraw transactions',
  async ({ divigent, publicClient, rpcUrl }) => {
    await withSnapshot(rpcUrl, async () => {
      const agent = createX402AgentForPrivateKey({
        privateKey: X402_AGENT_PLAN_PRIVATE_KEY,
        rpcUrl,
        publicClient,
        addresses: divigent.addresses,
      });
      const amount = parseUsdc('12');

      await prepareX402Agent({ agent, rpcUrl, publicClient, initialize: true });

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
      const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
      expect(approveReceipt.status).toBe('success');
      await expect(agent.sdk.usdcAllowance(agent.wallet)).resolves.toBe(amount);

      const depositPlan = await agent.sdk.planDeposit({ amount, slippageBps: 25 });
      expect(depositPlan.simulated).toBe(true);
      expect(depositPlan.approvalRequired).toBe(0n);
      const depositHash = await agent.sdk.sendPlan(depositPlan);
      const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });
      const deposit = parseDepositReceipt(depositReceipt);
      expectDepositedEvent(depositReceipt, {
        wallet: agent.wallet,
        usdcAmount: amount,
        sharesMinted: deposit.sharesMinted,
      });
      expect(deposit.txHash).toBe(depositHash);
      expect(deposit.sharesMinted).toBeGreaterThanOrEqual(depositPlan.minSharesOut);
      await expect(agent.sdk.dvUsdcBalance(agent.wallet)).resolves.toBe(deposit.sharesMinted);

      const withdrawPlan = await agent.sdk.planWithdraw({
        shares: deposit.sharesMinted,
        slippageBps: 25,
      });
      expect(withdrawPlan.simulatedUsdcOut).toBeGreaterThanOrEqual(withdrawPlan.minUsdcOut);
      const balanceBeforeWithdraw = await agent.sdk.usdcBalance(agent.wallet);
      const withdrawHash = await agent.sdk.sendPlan(withdrawPlan);
      const withdrawReceipt = await publicClient.waitForTransactionReceipt({ hash: withdrawHash });
      const withdraw = parseWithdrawReceipt(withdrawReceipt);
      expectWithdrawnEvent(withdrawReceipt, {
        wallet: agent.wallet,
        sharesBurned: deposit.sharesMinted,
        usdcReturned: withdraw.usdcReturned,
      });

      expect(withdraw.txHash).toBe(withdrawHash);
      expect(withdraw.usdcReturned).toBeGreaterThanOrEqual(withdrawPlan.minUsdcOut);
      await expect(agent.sdk.usdcBalance(agent.wallet)).resolves.toBe(
        balanceBeforeWithdraw + withdraw.usdcReturned,
      );
      await expect(agent.sdk.dvUsdcBalance(agent.wallet)).resolves.toBe(0n);
      await expect(agent.sdk.costBasis(agent.wallet)).resolves.toBe(0n);
    });
  },
);
