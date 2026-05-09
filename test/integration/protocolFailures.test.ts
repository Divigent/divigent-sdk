import { expect } from 'vitest';
import { createWalletClient, http, type Address } from 'viem';
import { base } from 'viem/chains';
import { routerAbi } from '../../src/abis';
import { parseUsdc } from '../../src/core/utils';
import { divigentBaseMainnetForkTest as test } from '../fork/setup';
import {
  createX402AgentForPrivateKey,
  expectContractRevert,
  prepareX402Agent,
  rpcRequest,
  withSnapshot,
  X402_AGENT_GUARD_PRIVATE_KEY,
  X402_TEST_ETH_BALANCE,
} from './helpers/x402AgentFork';

// Verifies the SDK surfaces the on-chain emergency pause before taking agent funds.
test.sequential(
  'x402 agent deposit reverts when protocol deposits are paused',
  async ({ divigent, publicClient, rpcUrl }) => {
    await withSnapshot(rpcUrl, async () => {
      const agent = createX402AgentForPrivateKey({
        privateKey: X402_AGENT_GUARD_PRIVATE_KEY,
        rpcUrl,
        publicClient,
        addresses: divigent.addresses,
      });
      const amount = parseUsdc('10');

      await prepareX402Agent({ agent, rpcUrl, publicClient, initialize: true });
      const approveHash = await agent.sdk.approveUsdc(amount);
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      const emergencyMultisig = await publicClient.readContract({
        address: divigent.addresses.router,
        abi: routerAbi,
        functionName: 'EMERGENCY_MULTISIG',
      });
      await rpcRequest(rpcUrl, 'anvil_setBalance', [emergencyMultisig, X402_TEST_ETH_BALANCE]);
      await rpcRequest(rpcUrl, 'anvil_impersonateAccount', [emergencyMultisig]);

      try {
        const emergencyClient = createWalletClient({
          account: emergencyMultisig as Address,
          chain: base,
          transport: http(rpcUrl),
        });
        const pauseHash = await emergencyClient.writeContract({
          address: divigent.addresses.router,
          abi: routerAbi,
          functionName: 'pauseDeposits',
        });
        const pauseReceipt = await publicClient.waitForTransactionReceipt({ hash: pauseHash });
        expect(pauseReceipt.status).toBe('success');
      } finally {
        await rpcRequest(rpcUrl, 'anvil_stopImpersonatingAccount', [emergencyMultisig]);
      }

      await expect(divigent.depositsPaused()).resolves.toBe(true);
      await expectContractRevert(
        agent.sdk.deposit({ amount, slippageBps: 25 }),
        'DepositsPausedError',
      );
      await expect(agent.sdk.usdcBalance(agent.wallet)).resolves.toBe(parseUsdc('25'));
      await expect(agent.sdk.dvUsdcBalance(agent.wallet)).resolves.toBe(0n);
    });
  },
);
