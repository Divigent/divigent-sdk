import { expect } from 'vitest';
import { parseUsdc } from '../../src/core/utils';
import { divigentBaseMainnetForkTest as test } from '../fork/setup';
import {
  approveUsdcAndWait,
  depositAndAssert,
  expectContractRevert,
  initializeAndExpectAuthorized,
  withPreparedAgent,
  X402_AGENT_GUARD_PRIVATE_KEY,
} from './helpers/x402AgentFork';
test.sequential(
  'x402 agent receives clear guardrails for unsafe deposit and withdraw attempts',
  async ({ divigent, publicClient, rpcUrl }) => {
    const amount = parseUsdc('10');

    await withPreparedAgent({
      privateKey: X402_AGENT_GUARD_PRIVATE_KEY,
      rpcUrl,
      publicClient,
      addresses: divigent.addresses,
    }, async (agent) => {
      await approveUsdcAndWait(agent, publicClient, amount);
      await expectContractRevert(agent.sdk.deposit({ amount, slippageBps: 25 }), 'NotAuthorised');
      await expect(agent.sdk.isAuthorized(agent.wallet)).resolves.toBe(false);

      await initializeAndExpectAuthorized(agent, publicClient);

      const previewShares = await agent.sdk.previewDeposit(amount);
      await expectContractRevert(
        agent.sdk.deposit({ amount, minSharesOut: previewShares + 1n }),
        'SlippageExceeded',
      );

      const deposit = await depositAndAssert(agent, publicClient, amount);
      await expectContractRevert(
        agent.sdk.withdraw({ shares: deposit.sharesMinted + 1n, minUsdcOut: 0n }),
        'InsufficientShares',
      );

      const previewUsdcOut = await agent.sdk.previewRedeem(deposit.sharesMinted, agent.wallet);
      await expectContractRevert(
        agent.sdk.withdraw({
          shares: deposit.sharesMinted,
          minUsdcOut: previewUsdcOut + parseUsdc('1'),
        }),
        'SlippageExceeded',
      );
      expect(await agent.sdk.dvUsdcBalance(agent.wallet)).toBe(deposit.sharesMinted);
    });
  },
);
