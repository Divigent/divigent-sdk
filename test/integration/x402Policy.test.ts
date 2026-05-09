import { expect } from 'vitest';
import { parseUsdc } from '../../src/core/utils';
import { PaymentCapExceededError } from '../../src/errors';
import { attachDivigentYield } from '../../src/x402/attach';
import { divigentBaseMainnetForkTest as test } from '../fork/setup';
import {
  approveAndDepositIdleUsdc,
  createLocalX402Client,
  createX402AgentForPrivateKey,
  prepareX402Agent,
  withSnapshot,
  x402AgentPaymentContext,
  X402_AGENT_POLICY_PRIVATE_KEY,
  X402_SELLER,
} from './helpers/x402AgentFork';

// Verifies x402 policy rejects unsafe payments before touching agent funds.
test.sequential(
  'x402 agent policy refuses unsafe x402 payments without moving funds',
  async ({ divigent, publicClient, rpcUrl }) => {
    await withSnapshot(rpcUrl, async () => {
      const agent = createX402AgentForPrivateKey({
        privateKey: X402_AGENT_POLICY_PRIVATE_KEY,
        rpcUrl,
        publicClient,
        addresses: divigent.addresses,
      });
      const depositAmount = parseUsdc('10');

      await prepareX402Agent({
        agent,
        rpcUrl,
        publicClient,
        fundingAmount: parseUsdc('12'),
        initialize: true,
      });
      await approveAndDepositIdleUsdc(agent, publicClient, depositAmount);
      const liquidBeforePolicy = await agent.sdk.usdcBalance(agent.wallet);
      const sharesBeforePolicy = await agent.sdk.dvUsdcBalance(agent.wallet);

      const { client, hooks } = createLocalX402Client();
      attachDivigentYield(client as never, agent.sdk, {
        minIdleThreshold: parseUsdc('1'),
        maxPaymentAmount: parseUsdc('1'),
        allowedPayTo: [X402_SELLER],
        allowedResource: 'https://merchant.divigent.test/paid/*',
        slippageBps: 25,
      });

      await hooks.before?.(x402AgentPaymentContext({
        sdk: agent.sdk,
        amount: parseUsdc('4'),
        payTo: '0x5555555555555555555555555555555555555555',
      }));
      await hooks.before?.(x402AgentPaymentContext({
        sdk: agent.sdk,
        amount: parseUsdc('4'),
        resource: 'https://evil.example.test/paid/quote',
      }));
      await expect(
        hooks.before?.(x402AgentPaymentContext({
          sdk: agent.sdk,
          amount: parseUsdc('1.000001'),
        })),
      ).rejects.toBeInstanceOf(PaymentCapExceededError);

      expect(await agent.sdk.usdcBalance(agent.wallet)).toBe(liquidBeforePolicy);
      expect(await agent.sdk.dvUsdcBalance(agent.wallet)).toBe(sharesBeforePolicy);
    });
  },
);
