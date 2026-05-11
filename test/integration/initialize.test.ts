import { expect } from 'vitest';
import {
  divigentBaseMainnetForkTest as test,
  withForkSnapshot,
} from '../fork/setup';
import {
  createX402AgentForPrivateKey,
  fundWalletEth,
  sendAndExpectSuccess,
  X402_AGENT_INITIALIZE_OWNER_PRIVATE_KEY,
  X402_AGENT_INITIALIZE_RELAYER_PRIVATE_KEY,
} from './helpers/x402AgentFork';
test.sequential(
  'x402 agent authorizes itself through a relayed initializeFor signature',
  async ({ divigent, publicClient, rpcUrl }) => {
    await withForkSnapshot(rpcUrl, async () => {
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
      await fundWalletEth(rpcUrl, relayerAgent.wallet);

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

      await sendAndExpectSuccess(publicClient, hash);
      await expect(ownerAgent.sdk.isAuthorized(ownerAgent.wallet)).resolves.toBe(true);
      await expect(ownerAgent.sdk.nonce(ownerAgent.wallet)).resolves.toBe(nonceBefore + 1n);
    });
  },
);
