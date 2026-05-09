import { expect } from 'vitest';
import { parseUsdc } from '../../src/core/utils';
import { OperatorAckRequiredError } from '../../src/errors';
import { divigentBaseMainnetForkTest as test } from '../fork/setup';
import {
  approveAndDepositIdleUsdc,
  createX402AgentForPrivateKey,
  expectContractRevert,
  prepareX402Agent,
  rpcRequest,
  withSnapshot,
  X402_AGENT_OWNER_PRIVATE_KEY,
  X402_PAYMENT_OPERATOR_PRIVATE_KEY,
  X402_TEST_ETH_BALANCE,
} from './helpers/x402AgentFork';

// Verifies an agent owner must explicitly acknowledge operator withdrawal authority.
test.sequential(
  'x402 agent owner can explicitly delegate and revoke a payment operator',
  async ({ divigent, publicClient, rpcUrl }) => {
    await withSnapshot(rpcUrl, async () => {
      const ownerAgent = createX402AgentForPrivateKey({
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

      await prepareX402Agent({
        agent: ownerAgent,
        rpcUrl,
        publicClient,
        initialize: true,
      });
      await rpcRequest(rpcUrl, 'anvil_setBalance', [operatorAgent.wallet, X402_TEST_ETH_BALANCE]);
      await expect(
        ownerAgent.sdk.setOperator({ operator: operatorAgent.wallet, approved: true }),
      ).rejects.toBeInstanceOf(OperatorAckRequiredError);

      const deposit = await approveAndDepositIdleUsdc(ownerAgent, publicClient, amount);
      const ownerUsdcBefore = await ownerAgent.sdk.usdcBalance(ownerAgent.wallet);
      const operatorUsdcBefore = await ownerAgent.sdk.usdcBalance(operatorAgent.wallet);

      const setOperatorHash = await ownerAgent.sdk.setOperator({
        operator: operatorAgent.wallet,
        approved: true,
        acknowledgeFullAuthority: true,
      });
      const setOperatorReceipt = await publicClient.waitForTransactionReceipt({
        hash: setOperatorHash,
      });
      expect(setOperatorReceipt.status).toBe('success');
      await expect(
        ownerAgent.sdk.isOperator(ownerAgent.wallet, operatorAgent.wallet),
      ).resolves.toBe(true);

      const revokeOperatorHash = await ownerAgent.sdk.setOperator({
        operator: operatorAgent.wallet,
        approved: false,
      });
      const revokeOperatorReceipt = await publicClient.waitForTransactionReceipt({
        hash: revokeOperatorHash,
      });
      expect(revokeOperatorReceipt.status).toBe('success');
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
      const restoreOperatorReceipt = await publicClient.waitForTransactionReceipt({
        hash: restoreOperatorHash,
      });
      expect(restoreOperatorReceipt.status).toBe('success');
      await expect(
        ownerAgent.sdk.isOperator(ownerAgent.wallet, operatorAgent.wallet),
      ).resolves.toBe(true);

      const withdraw = await operatorAgent.sdk.withdrawAndWait({
        shares: deposit.sharesMinted,
        wallet: ownerAgent.wallet,
        slippageBps: 25,
      });

      expect(withdraw.usdcReturned).toBeGreaterThan(0n);
      expect(await ownerAgent.sdk.usdcBalance(ownerAgent.wallet)).toBe(
        ownerUsdcBefore + withdraw.usdcReturned,
      );
      expect(await ownerAgent.sdk.usdcBalance(operatorAgent.wallet)).toBe(operatorUsdcBefore);
      expect(await ownerAgent.sdk.dvUsdcBalance(ownerAgent.wallet)).toBe(0n);
    });
  },
);
