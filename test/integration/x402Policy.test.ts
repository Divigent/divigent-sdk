import { expect } from 'vitest';
import { parseUsdc } from '../../src/core/utils';
import { PaymentCapExceededError } from '../../src/errors';
import { attachDivigentYield } from '../../src/x402/attach';
import { divigentBaseMainnetForkTest as test } from '../fork/setup';
import {
  createLocalX402Client,
  expectAgentBalances,
  readAgentBalances,
  seedDeposit,
  withPreparedAgent,
  x402AgentPaymentContext,
  X402_AGENT_POLICY_PRIVATE_KEY,
  X402_SELLER,
} from './helpers/x402AgentFork';
test.sequential(
  'x402 agent policy refuses unsafe x402 payments without moving funds',
  async ({ divigent, publicClient, rpcUrl }) => {
    const depositAmount = parseUsdc('10');

    await withPreparedAgent({
      privateKey: X402_AGENT_POLICY_PRIVATE_KEY,
      rpcUrl,
      publicClient,
      addresses: divigent.addresses,
      fundingAmount: parseUsdc('12'),
      initialize: true,
    }, async (agent) => {
      await seedDeposit(agent, publicClient, depositAmount);
      const balancesBeforePolicy = await readAgentBalances(agent);

      const { client, hooks } = createLocalX402Client();
      attachDivigentYield(client as never, agent.sdk, {
        minIdleThreshold: parseUsdc('1'),
        maxPaymentAmount: parseUsdc('1'),
        allowedPayTo: [X402_SELLER],
        allowedResource: 'https://merchant.divigent.test/paid/*',
        slippageBps: 25,
      });

      const ignoredPayments = [
        {
          label: 'payTo allowlist',
          context: {
            amount: parseUsdc('4'),
            payTo: '0x5555555555555555555555555555555555555555',
          },
        },
        {
          label: 'resource allowlist',
          context: {
            amount: parseUsdc('4'),
            resource: 'https://evil.example.test/paid/quote',
          },
        },
      ];
      for (const payment of ignoredPayments) {
        await expect(
          hooks.before?.(x402AgentPaymentContext({
            sdk: agent.sdk,
            ...payment.context,
          })),
          payment.label,
        ).resolves.toBeUndefined();
      }
      await expect(
        hooks.before?.(x402AgentPaymentContext({
          sdk: agent.sdk,
          amount: parseUsdc('1.000001'),
        })),
      ).rejects.toBeInstanceOf(PaymentCapExceededError);

      await expectAgentBalances(agent, balancesBeforePolicy);
    });
  },
);
