import { expect } from 'vitest';
import { parseUsdc } from '../../src/core/utils';
import { attachDivigentYield } from '../../src/x402/attach';
import { divigentBaseMainnetForkTest as test } from '../fork/setup';
import {
  approveAndDepositIdleUsdc,
  createLocalX402Client,
  createX402AgentForPrivateKey,
  withSnapshot,
  prepareX402Agent,
  x402AgentPaymentContext,
  X402_AGENT_RECALL_PRIVATE_KEY,
  X402_SELLER,
} from './helpers/x402AgentFork';

// Verifies the x402 hook recalls just enough Divigent liquidity before an allowed payment.
test.sequential(
  'x402 agent recall hook withdraws enough liquidity before an allowed x402 payment',
  async ({ divigent, publicClient, rpcUrl }) => {
    await withSnapshot(rpcUrl, async () => {
      const agent = createX402AgentForPrivateKey({
        privateKey: X402_AGENT_RECALL_PRIVATE_KEY,
        rpcUrl,
        publicClient,
        addresses: divigent.addresses,
      });
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

      await prepareX402Agent({
        agent,
        rpcUrl,
        publicClient,
        fundingAmount: parseUsdc('12'),
        initialize: true,
      });
      await approveAndDepositIdleUsdc(agent, publicClient, depositAmount);
      const liquidBeforeRecall = await agent.sdk.usdcBalance(agent.wallet);
      const sharesBeforeRecall = await agent.sdk.dvUsdcBalance(agent.wallet);
      expect(liquidBeforeRecall).toBe(parseUsdc('2'));

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

      const liquidAfterRecall = await agent.sdk.usdcBalance(agent.wallet);
      const sharesAfterRecall = await agent.sdk.dvUsdcBalance(agent.wallet);
      expect(liquidAfterRecall).toBeGreaterThanOrEqual(paymentAmount + reserveFloor);
      expect(sharesAfterRecall).toBeLessThan(sharesBeforeRecall);
      expect(beforePayments).toHaveLength(1);
      expect(beforePayments[0]).toEqual(expect.objectContaining({
        paymentAmount,
        walletBalance: liquidBeforeRecall,
        reserveFloor,
        deficit: paymentAmount + reserveFloor - liquidBeforeRecall,
        recallShares: expect.any(BigInt),
        recallTxHash: expect.any(String),
      }));
    });
  },
);
