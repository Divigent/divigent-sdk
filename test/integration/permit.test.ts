import { expect } from 'vitest';
import { parseUsdc } from '../../src/core/utils';
import { divigentBaseMainnetForkTest as test } from '../fork/setup';
import {
  createX402AgentForPrivateKey,
  expectDepositedEvent,
  expectWithdrawnEvent,
  prepareX402Agent,
  withSnapshot,
  X402_AGENT_PERMIT_PRIVATE_KEY,
} from './helpers/x402AgentFork';

// Verifies an agent can deposit with USDC permit without a prior approval transaction.
test.sequential(
  'x402 agent deposits with USDC permit when no approval exists',
  async ({ divigent, publicClient, rpcUrl }) => {
    await withSnapshot(rpcUrl, async () => {
      const agent = createX402AgentForPrivateKey({
        privateKey: X402_AGENT_PERMIT_PRIVATE_KEY,
        rpcUrl,
        publicClient,
        addresses: divigent.addresses,
      });
      const amount = parseUsdc('10');

      await prepareX402Agent({ agent, rpcUrl, publicClient, initialize: true });
      await expect(agent.sdk.usdcAllowance(agent.wallet)).resolves.toBe(0n);

      const { timestamp } = await publicClient.getBlock();
      const deadline = timestamp + 3600n;
      const permit = await agent.sdk.signPermit({ amount, deadline });
      expect([27, 28]).toContain(permit.v);
      expect(permit.deadline).toBe(deadline);
      expect(permit.r).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(permit.s).toMatch(/^0x[a-fA-F0-9]{64}$/);

      const deposit = await agent.sdk.depositWithPermitAndWait({
        amount,
        deadline,
        slippageBps: 25,
      });
      const depositReceipt = await publicClient.getTransactionReceipt({ hash: deposit.txHash });
      expectDepositedEvent(depositReceipt, {
        wallet: agent.wallet,
        usdcAmount: amount,
        sharesMinted: deposit.sharesMinted,
      });
      expect(deposit.sharesMinted).toBeGreaterThan(0n);
      await expect(agent.sdk.usdcAllowance(agent.wallet)).resolves.toBe(0n);
      await expect(agent.sdk.dvUsdcBalance(agent.wallet)).resolves.toBe(deposit.sharesMinted);

      const withdraw = await agent.sdk.withdrawAndWait({
        shares: deposit.sharesMinted,
        slippageBps: 25,
      });
      const withdrawReceipt = await publicClient.getTransactionReceipt({ hash: withdraw.txHash });
      expectWithdrawnEvent(withdrawReceipt, {
        wallet: agent.wallet,
        sharesBurned: deposit.sharesMinted,
        usdcReturned: withdraw.usdcReturned,
      });
      expect(withdraw.usdcReturned).toBeGreaterThan(0n);
      await expect(agent.sdk.dvUsdcBalance(agent.wallet)).resolves.toBe(0n);
      const finalPosition = await agent.sdk.getPosition(agent.wallet);
      expect(finalPosition.depositedUSDC).toBe(0n);
      expect(finalPosition.currentValue).toBe(0n);
    });
  },
);
