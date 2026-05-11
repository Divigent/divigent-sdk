import { expect } from 'vitest';
import { parseUsdc } from '../../src/core/utils';
import { attachDivigentYield } from '../../src/x402/attach';
import { divigentBaseMainnetForkTest as test } from '../fork/setup';
import {
  createLocalX402Client,
  readAgentBalances,
  seedDeposit,
  withPreparedAgent,
  x402AgentPaymentContext,
  X402_AGENT_RECALL_PRIVATE_KEY,
  X402_SELLER,
} from './helpers/x402AgentFork';
test.sequential(
  'x402 agent recall hook withdraws enough liquidity before an allowed x402 payment',
  async ({ divigent, publicClient, rpcUrl }) => {
    const depositAmount = parseUsdc('10');
    const paymentAmount = parseUsdc('4');
    const reserveFloor = parseUsdc('0.25');
    const beforePayments: Array<{
      paymentAmount: bigint;
      walletBalance: bigint;
      reserveFloor: bigint;
      deficit: bigint;
      recallShares?: bigint;
      recallTxHash?: unknown;
    }> = [];

    await withPreparedAgent({
      privateKey: X402_AGENT_RECALL_PRIVATE_KEY,
      rpcUrl,
      publicClient,
      addresses: divigent.addresses,
      fundingAmount: parseUsdc('12'),
      initialize: true,
    }, async (agent) => {
      await seedDeposit(agent, publicClient, depositAmount);
      const beforeRecall = await readAgentBalances(agent);
      expect(beforeRecall.liquidUsdc).toBe(parseUsdc('2'));

      const { client, hooks } = createLocalX402Client();
      attachDivigentYield(client as never, agent.sdk, {
        minIdleThreshold: reserveFloor,
        maxPaymentAmount: parseUsdc('5'),
        allowedPayTo: [X402_SELLER],
        allowedResource: 'https://merchant.divigent.test/paid/*',
        slippageBps: 25,
        onBeforePayment: (ctx) => {
          beforePayments.push(ctx);
        },
      });

      await hooks.before?.(x402AgentPaymentContext({
        sdk: agent.sdk,
        amount: paymentAmount,
      }));

      const afterRecall = await readAgentBalances(agent);
      expect(afterRecall.liquidUsdc).toBeGreaterThanOrEqual(paymentAmount + reserveFloor);
      expect(afterRecall.dvUsdc).toBeLessThan(beforeRecall.dvUsdc);
      expect(beforePayments).toHaveLength(1);
      expect(beforePayments[0]).toEqual(expect.objectContaining({
        paymentAmount,
        walletBalance: beforeRecall.liquidUsdc,
        reserveFloor,
        deficit: paymentAmount + reserveFloor - beforeRecall.liquidUsdc,
        recallShares: expect.any(BigInt),
        recallTxHash: expect.any(String),
      }));
    });
  },
);
