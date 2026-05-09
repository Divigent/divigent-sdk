import { expect } from 'vitest';
import { parseUsdc } from '../../src/core/utils';
import { divigentBaseMainnetForkTest as test } from '../fork/setup';
import {
  approveAndDepositIdleUsdc,
  createX402AgentForPrivateKey,
  expectWithdrawnEvent,
  prepareX402Agent,
  withSnapshot,
  X402_AGENT_FULL_EXIT_PRIVATE_KEY,
  X402_AGENT_WITHDRAW_PRIVATE_KEY,
} from './helpers/x402AgentFork';

// Verifies an agent can withdraw part of its position to restore payment liquidity.
test.sequential(
  'x402 agent withdraws part of its position for payment liquidity',
  async ({ divigent, publicClient, rpcUrl }) => {
    await withSnapshot(rpcUrl, async () => {
      const agent = createX402AgentForPrivateKey({
        privateKey: X402_AGENT_WITHDRAW_PRIVATE_KEY,
        rpcUrl,
        publicClient,
        addresses: divigent.addresses,
      });
      const depositAmount = parseUsdc('10');
      const desiredLiquidity = parseUsdc('4');

      await prepareX402Agent({ agent, rpcUrl, publicClient, initialize: true });
      const deposit = await approveAndDepositIdleUsdc(agent, publicClient, depositAmount);

      const sharesForPaymentLiquidity = await agent.sdk.previewWithdrawNet(
        desiredLiquidity,
        agent.wallet,
      );
      expect(sharesForPaymentLiquidity).toBeGreaterThan(0n);
      expect(sharesForPaymentLiquidity).toBeLessThanOrEqual(deposit.sharesMinted);

      const withdrawPlan = await agent.sdk.planWithdraw({
        shares: sharesForPaymentLiquidity,
        slippageBps: 25,
      });
      expect(withdrawPlan.wallet).toBe(agent.wallet);
      expect(withdrawPlan.simulatedUsdcOut).toBeGreaterThanOrEqual(withdrawPlan.minUsdcOut);

      const liquidBeforeWithdraw = await agent.sdk.usdcBalance(agent.wallet);
      const sharesBeforeWithdraw = await agent.sdk.dvUsdcBalance(agent.wallet);
      const withdraw = await agent.sdk.withdrawAndWait({
        shares: sharesForPaymentLiquidity,
        slippageBps: 25,
      });
      const withdrawReceipt = await publicClient.getTransactionReceipt({ hash: withdraw.txHash });
      expectWithdrawnEvent(withdrawReceipt, {
        wallet: agent.wallet,
        sharesBurned: sharesForPaymentLiquidity,
        usdcReturned: withdraw.usdcReturned,
      });

      expect(withdraw.usdcReturned).toBeGreaterThanOrEqual(withdrawPlan.minUsdcOut);
      expect(await agent.sdk.usdcBalance(agent.wallet)).toBe(
        liquidBeforeWithdraw + withdraw.usdcReturned,
      );
      expect(await agent.sdk.dvUsdcBalance(agent.wallet)).toBe(
        sharesBeforeWithdraw - sharesForPaymentLiquidity,
      );
      const remainingPosition = await agent.sdk.getPosition(agent.wallet);
      expect(remainingPosition.currentValue).toBeGreaterThan(0n);
    });
  },
);

// Verifies an agent can fully exit Divigent back to liquid USDC.
test.sequential(
  'x402 agent fully exits Divigent when it wants all liquidity back',
  async ({ divigent, publicClient, rpcUrl }) => {
    await withSnapshot(rpcUrl, async () => {
      const agent = createX402AgentForPrivateKey({
        privateKey: X402_AGENT_FULL_EXIT_PRIVATE_KEY,
        rpcUrl,
        publicClient,
        addresses: divigent.addresses,
      });
      const depositAmount = parseUsdc('10');

      await prepareX402Agent({ agent, rpcUrl, publicClient, initialize: true });
      const deposit = await approveAndDepositIdleUsdc(agent, publicClient, depositAmount);
      const balanceBeforeExit = await agent.sdk.usdcBalance(agent.wallet);

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
      expect(await agent.sdk.usdcBalance(agent.wallet)).toBe(
        balanceBeforeExit + withdraw.usdcReturned,
      );
      await expect(agent.sdk.dvUsdcBalance(agent.wallet)).resolves.toBe(0n);
      await expect(agent.sdk.costBasis(agent.wallet)).resolves.toBe(0n);
      const finalPosition = await agent.sdk.getPosition(agent.wallet);
      expect(finalPosition.depositedUSDC).toBe(0n);
      expect(finalPosition.currentValue).toBe(0n);
    });
  },
);
