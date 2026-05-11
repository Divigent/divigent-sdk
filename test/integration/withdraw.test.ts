import { expect } from 'vitest';
import { parseUsdc } from '../../src/core/utils';
import { divigentBaseMainnetForkTest as test } from '../fork/setup';
import {
  approveAndDepositAndAssert,
  expectFullExit,
  expectPartialWithdrawApplied,
  seedDeposit,
  withdrawAndAssert,
  withPreparedAgent,
  X402_AGENT_FULL_EXIT_PRIVATE_KEY,
  X402_AGENT_WITHDRAW_PRIVATE_KEY,
} from './helpers/x402AgentFork';
// Exercises: x402 agent withdraws part of its position for payment liquidity.
test.sequential(
  'x402 agent withdraws part of its position for payment liquidity',
  async ({ divigent, publicClient, rpcUrl }) => {
    const depositAmount = parseUsdc('10');
    const desiredLiquidity = parseUsdc('4');

    await withPreparedAgent({
      privateKey: X402_AGENT_WITHDRAW_PRIVATE_KEY,
      rpcUrl,
      publicClient,
      addresses: divigent.addresses,
      initialize: true,
    }, async (agent) => {
      const deposit = await seedDeposit(agent, publicClient, depositAmount);

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
      const withdraw = await withdrawAndAssert(agent, publicClient, sharesForPaymentLiquidity);

      expect(withdraw.usdcReturned).toBeGreaterThanOrEqual(withdrawPlan.minUsdcOut);
      const principalOut = (depositAmount * sharesForPaymentLiquidity) / deposit.sharesMinted;
      const expectedRemainingCostBasis = depositAmount - principalOut;
      await expectPartialWithdrawApplied(agent, {
        liquidBeforeWithdraw,
        sharesBeforeWithdraw,
        sharesBurned: sharesForPaymentLiquidity,
        usdcReturned: withdraw.usdcReturned,
        remainingCostBasis: expectedRemainingCostBasis,
      });

      const secondDepositAmount = parseUsdc('10');
      await approveAndDepositAndAssert(agent, publicClient, secondDepositAmount);
      await expect(agent.sdk.costBasis(agent.wallet))
        .resolves.toBe(expectedRemainingCostBasis + secondDepositAmount);
    });
  },
);
// Exercises: x402 agent fully exits Divigent when it wants all liquidity back.
test.sequential(
  'x402 agent fully exits Divigent when it wants all liquidity back',
  async ({ divigent, publicClient, rpcUrl }) => {
    const depositAmount = parseUsdc('10');

    await withPreparedAgent({
      privateKey: X402_AGENT_FULL_EXIT_PRIVATE_KEY,
      rpcUrl,
      publicClient,
      addresses: divigent.addresses,
      initialize: true,
    }, async (agent) => {
      const deposit = await seedDeposit(agent, publicClient, depositAmount);
      const balanceBeforeExit = await agent.sdk.usdcBalance(agent.wallet);

      const withdraw = await withdrawAndAssert(agent, publicClient, deposit.sharesMinted);

      expect(withdraw.usdcReturned).toBeGreaterThan(0n);
      expect(await agent.sdk.usdcBalance(agent.wallet)).toBe(
        balanceBeforeExit + withdraw.usdcReturned,
      );
      await expectFullExit(agent);
    });
  },
);
