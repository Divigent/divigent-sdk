import { expect } from 'vitest';
import { parseUsdc } from '../../src/core/utils';
import { divigentBaseMainnetForkTest as test } from '../fork/setup';
import {
  depositWithPermitAndAssert,
  expectDepositApplied,
  expectFullExit,
  withdrawAndAssert,
  withPreparedAgent,
  X402_AGENT_PERMIT_PRIVATE_KEY,
} from './helpers/x402AgentFork';
test.sequential(
  'x402 agent deposits with USDC permit when no approval exists',
  async ({ divigent, publicClient, rpcUrl }) => {
    const amount = parseUsdc('10');

    await withPreparedAgent({
      privateKey: X402_AGENT_PERMIT_PRIVATE_KEY,
      rpcUrl,
      publicClient,
      addresses: divigent.addresses,
      initialize: true,
    }, async (agent) => {
      await expect(agent.sdk.usdcAllowance(agent.wallet)).resolves.toBe(0n);

      const { timestamp } = await publicClient.getBlock();
      const deadline = timestamp + 3600n;
      const permit = await agent.sdk.signPermit({ amount, deadline });
      expect([27, 28]).toContain(permit.v);
      expect(permit.deadline).toBe(deadline);
      expect(permit.r).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(permit.s).toMatch(/^0x[a-fA-F0-9]{64}$/);

      const deposit = await depositWithPermitAndAssert(agent, publicClient, {
        amount,
        deadline,
      });
      await expectDepositApplied(agent, {
        amount,
        sharesMinted: deposit.sharesMinted,
        allowance: 0n,
      });

      const withdraw = await withdrawAndAssert(agent, publicClient, deposit.sharesMinted);
      expect(withdraw.usdcReturned).toBeGreaterThan(0n);
      await expectFullExit(agent);
    });
  },
);
