import { expect } from 'vitest';
import { parseUsdc } from '../../src/core/utils';
import { divigentBaseMainnetForkTest as test } from '../fork/setup';
import {
  createX402AgentForPrivateKey,
  expectDepositedEvent,
  prepareX402Agent,
  withSnapshot,
  X402_AGENT_DEPOSIT_PRIVATE_KEY,
} from './helpers/x402AgentFork';

// Verifies an initialized agent can deposit idle USDC into Divigent.
test.sequential(
  'x402 agent deposits idle USDC through approve plus deposit',
  async ({ divigent, publicClient, rpcUrl }) => {
    await withSnapshot(rpcUrl, async () => {
      const agent = createX402AgentForPrivateKey({
        privateKey: X402_AGENT_DEPOSIT_PRIVATE_KEY,
        rpcUrl,
        publicClient,
        addresses: divigent.addresses,
      });
      const depositAmount = parseUsdc('10');
      const fundingAmount = parseUsdc('25');

      await prepareX402Agent({
        agent,
        rpcUrl,
        publicClient,
        fundingAmount,
        initialize: true,
      });
      await expect(agent.sdk.verifyAddresses()).resolves.toBeUndefined();
      await expect(agent.sdk.usdcBalance(agent.wallet)).resolves.toBe(fundingAmount);

      const approveHash = await agent.sdk.approveUsdc(depositAmount);
      const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
      expect(approveReceipt.status).toBe('success');
      await expect(agent.sdk.usdcAllowance(agent.wallet)).resolves.toBe(depositAmount);

      const depositPlan = await agent.sdk.planDeposit({ amount: depositAmount, slippageBps: 25 });
      expect(depositPlan.wallet).toBe(agent.wallet);
      expect(depositPlan.simulated).toBe(true);
      expect(depositPlan.approvalRequired).toBe(0n);
      expect(depositPlan.simulatedSharesOut).toBeGreaterThanOrEqual(depositPlan.minSharesOut);

      const deposit = await agent.sdk.depositAndWait({ amount: depositAmount, slippageBps: 25 });
      const depositReceipt = await publicClient.getTransactionReceipt({ hash: deposit.txHash });
      expectDepositedEvent(depositReceipt, {
        wallet: agent.wallet,
        usdcAmount: depositAmount,
        sharesMinted: deposit.sharesMinted,
      });
      expect(deposit.sharesMinted).toBeGreaterThan(0n);
      expect(await agent.sdk.usdcBalance(agent.wallet)).toBe(fundingAmount - depositAmount);
      expect(await agent.sdk.usdcAllowance(agent.wallet)).toBe(0n);
      expect(await agent.sdk.dvUsdcBalance(agent.wallet)).toBe(deposit.sharesMinted);

      const position = await agent.sdk.getPosition(agent.wallet);
      expect(position.depositedUSDC).toBe(depositAmount);
      expect(position.currentValue).toBeGreaterThan(0n);
      expect(await agent.sdk.costBasis(agent.wallet)).toBe(depositAmount);
      expect(await agent.sdk.convertToAssets(deposit.sharesMinted)).toBeGreaterThan(0n);
    });
  },
);
