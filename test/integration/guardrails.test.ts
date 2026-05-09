import { expect } from 'vitest';
import { parseUsdc } from '../../src/core/utils';
import { divigentBaseMainnetForkTest as test } from '../fork/setup';
import {
  createX402AgentForPrivateKey,
  expectContractRevert,
  prepareX402Agent,
  withSnapshot,
  X402_AGENT_GUARD_PRIVATE_KEY,
} from './helpers/x402AgentFork';

// Verifies contract guardrails surface clearly for unsafe agent actions.
test.sequential(
  'x402 agent receives clear guardrails for unsafe deposit and withdraw attempts',
  async ({ divigent, publicClient, rpcUrl }) => {
    await withSnapshot(rpcUrl, async () => {
      const agent = createX402AgentForPrivateKey({
        privateKey: X402_AGENT_GUARD_PRIVATE_KEY,
        rpcUrl,
        publicClient,
        addresses: divigent.addresses,
      });
      const amount = parseUsdc('10');

      await prepareX402Agent({ agent, rpcUrl, publicClient });
      const approveHash = await agent.sdk.approveUsdc(amount);
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      await expectContractRevert(agent.sdk.deposit({ amount, slippageBps: 25 }), 'NotAuthorised');
      await expect(agent.sdk.isAuthorized(agent.wallet)).resolves.toBe(false);

      const initializeHash = await agent.sdk.initialize();
      const initializeReceipt = await publicClient.waitForTransactionReceipt({
        hash: initializeHash,
      });
      expect(initializeReceipt.status).toBe('success');

      const previewShares = await agent.sdk.previewDeposit(amount);
      await expectContractRevert(
        agent.sdk.deposit({ amount, minSharesOut: previewShares + 1n }),
        'SlippageExceeded',
      );

      const deposit = await agent.sdk.depositAndWait({ amount, slippageBps: 25 });
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
