import { expect } from 'vitest';
import { divigentBaseMainnetForkTest as test } from '../fork/setup';
import {
  createX402AgentForPrivateKey,
  rpcRequest,
  withSnapshot,
  X402_AGENT_INITIALIZE_OWNER_PRIVATE_KEY,
  X402_AGENT_INITIALIZE_RELAYER_PRIVATE_KEY,
  X402_TEST_ETH_BALANCE,
} from './helpers/x402AgentFork';

// Verifies an agent owner can authorize via a relayed EIP-712 initialize signature.
test.sequential(
  'x402 agent authorizes itself through a relayed initializeFor signature',
  async ({ divigent, publicClient, rpcUrl }) => {
    await withSnapshot(rpcUrl, async () => {
      const ownerAgent = createX402AgentForPrivateKey({
        privateKey: X402_AGENT_INITIALIZE_OWNER_PRIVATE_KEY,
        rpcUrl,
        publicClient,
        addresses: divigent.addresses,
      });
      const relayerAgent = createX402AgentForPrivateKey({
        privateKey: X402_AGENT_INITIALIZE_RELAYER_PRIVATE_KEY,
        rpcUrl,
        publicClient,
        addresses: divigent.addresses,
      });
      await rpcRequest(rpcUrl, 'anvil_setBalance', [relayerAgent.wallet, X402_TEST_ETH_BALANCE]);

      const nonceBefore = await ownerAgent.sdk.nonce(ownerAgent.wallet);
      const { timestamp } = await publicClient.getBlock();
      const deadline = timestamp + 3600n;
      const sig = await ownerAgent.sdk.signInitializeFor({
        wallet: ownerAgent.wallet,
        deadline,
      });
      const hash = await relayerAgent.sdk.initializeFor({
        wallet: ownerAgent.wallet,
        deadline,
        sig,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      expect(receipt.status).toBe('success');
      await expect(ownerAgent.sdk.isAuthorized(ownerAgent.wallet)).resolves.toBe(true);
      await expect(ownerAgent.sdk.nonce(ownerAgent.wallet)).resolves.toBe(nonceBefore + 1n);
    });
  },
);
