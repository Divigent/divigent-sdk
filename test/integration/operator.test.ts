import { expect } from 'vitest';
import { parseUsdc } from '../../src/core/utils';
import { OperatorAckRequiredError } from '../../src/errors';
import {
  divigentBaseMainnetForkTest as test,
  withForkSnapshot,
} from '../fork/setup';
import {
  createInitializedAgent,
  createX402AgentForPrivateKey,
  expectAgentBalances,
  expectContractRevert,
  fundWalletEth,
  seedDeposit,
  sendAndExpectSuccess,
  withdrawAndAssert,
  X402_AGENT_OWNER_PRIVATE_KEY,
  X402_PAYMENT_OPERATOR_PRIVATE_KEY,
} from './helpers/x402AgentFork';
test.sequential(
  'x402 agent owner can explicitly delegate and revoke a payment operator',
  async ({ divigent, publicClient, rpcUrl }) => {
    await withForkSnapshot(rpcUrl, async () => {
      const ownerAgent = await createInitializedAgent({
        privateKey: X402_AGENT_OWNER_PRIVATE_KEY,
        rpcUrl,
        publicClient,
        addresses: divigent.addresses,
      });
      const operatorAgent = createX402AgentForPrivateKey({
        privateKey: X402_PAYMENT_OPERATOR_PRIVATE_KEY,
        rpcUrl,
        publicClient,
        addresses: divigent.addresses,
      });
      const amount = parseUsdc('10');

      await fundWalletEth(rpcUrl, operatorAgent.wallet);
      await expect(
        ownerAgent.sdk.setOperator({ operator: operatorAgent.wallet, approved: true }),
      ).rejects.toBeInstanceOf(OperatorAckRequiredError);

      const deposit = await seedDeposit(ownerAgent, publicClient, amount);
      const ownerUsdcBefore = await ownerAgent.sdk.usdcBalance(ownerAgent.wallet);
      const operatorUsdcBefore = await ownerAgent.sdk.usdcBalance(operatorAgent.wallet);

      const setOperatorHash = await ownerAgent.sdk.setOperator({
        operator: operatorAgent.wallet,
        approved: true,
        acknowledgeFullAuthority: true,
      });
      await sendAndExpectSuccess(publicClient, setOperatorHash);
      await expect(
        ownerAgent.sdk.isOperator(ownerAgent.wallet, operatorAgent.wallet),
      ).resolves.toBe(true);

      const revokeOperatorHash = await ownerAgent.sdk.setOperator({
        operator: operatorAgent.wallet,
        approved: false,
      });
      await sendAndExpectSuccess(publicClient, revokeOperatorHash);
      await expect(
        ownerAgent.sdk.isOperator(ownerAgent.wallet, operatorAgent.wallet),
      ).resolves.toBe(false);
      await expectContractRevert(
        operatorAgent.sdk.withdrawAndWait({
          shares: deposit.sharesMinted,
          wallet: ownerAgent.wallet,
          minUsdcOut: 0n,
        }),
        'NotAuthorised',
      );

      const restoreOperatorHash = await ownerAgent.sdk.setOperator({
        operator: operatorAgent.wallet,
        approved: true,
        acknowledgeFullAuthority: true,
      });
      await sendAndExpectSuccess(publicClient, restoreOperatorHash);
      await expect(
        ownerAgent.sdk.isOperator(ownerAgent.wallet, operatorAgent.wallet),
      ).resolves.toBe(true);

      const withdraw = await withdrawAndAssert(operatorAgent, publicClient, deposit.sharesMinted, {
        wallet: ownerAgent.wallet,
      });

      expect(withdraw.usdcReturned).toBeGreaterThan(0n);
      await expectAgentBalances(ownerAgent, {
        liquidUsdc: ownerUsdcBefore + withdraw.usdcReturned,
        dvUsdc: 0n,
      });
      await expectAgentBalances(ownerAgent, { liquidUsdc: operatorUsdcBefore }, operatorAgent.wallet);
    });
  },
);
