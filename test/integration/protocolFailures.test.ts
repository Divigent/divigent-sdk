import { expect } from 'vitest';
import { createWalletClient, http, type Address, type PublicClient, type WalletClient } from 'viem';
import { base } from 'viem/chains';
import { routerAbi } from '../../src/abis';
import type { ContractAddresses } from '../../src/core/chains';
import { parseUsdc } from '../../src/core/utils';
import { Divigent } from '../../src/divigent';
import { evmAddress } from '../../src/types';
import {
  divigentBaseMainnetForkTest as test,
  rpcRequest,
  withForkSnapshot,
} from '../fork/setup';
import {
  approveUsdcAndWait,
  createInitializedAgent,
  depositAndAssert,
  expectFullExit,
  expectContractRevert,
  seedDeposit,
  sendAndExpectSuccess,
  withdrawAndAssert,
  withPreparedAgent,
  X402_AGENT_GUARD_PRIVATE_KEY,
  X402_AGENT_PLAN_PRIVATE_KEY,
  X402_TEST_ETH_BALANCE,
} from './helpers/x402AgentFork';

const ZERO_ADDRESS = evmAddress('0x0000000000000000000000000000000000000000');
const ROTATION_TREASURY_ONE = evmAddress('0x7777777777777777777777777777777777777777');
const ROTATION_TREASURY_TWO = evmAddress('0x8888888888888888888888888888888888888888');
const TREASURY_ROTATION_DELAY_SECONDS = 7 * 24 * 60 * 60;
const MAX_ORACLE_STALENESS_SECONDS = 2 * 60 * 60;

async function withEmergencyDivigent<T>(params: {
  publicClient: PublicClient;
  rpcUrl: string;
  addresses: ContractAddresses;
  fn: (emergencyDivigent: Divigent) => Promise<T>;
}): Promise<T> {
  const emergencyMultisig = await params.publicClient.readContract({
    address: params.addresses.router,
    abi: routerAbi,
    functionName: 'EMERGENCY_MULTISIG',
  });
  await rpcRequest(params.rpcUrl, 'anvil_setBalance', [emergencyMultisig, X402_TEST_ETH_BALANCE]);
  await rpcRequest(params.rpcUrl, 'anvil_impersonateAccount', [emergencyMultisig]);

  try {
    const emergencyClient = createWalletClient({
      account: emergencyMultisig as Address,
      chain: base,
      transport: http(params.rpcUrl),
    });
    const emergencyDivigent = Divigent.create({
      publicClient: params.publicClient,
      walletClient: emergencyClient as unknown as WalletClient,
      chain: 'base',
      addresses: params.addresses,
    });
    return await params.fn(emergencyDivigent);
  } finally {
    await rpcRequest(params.rpcUrl, 'anvil_stopImpersonatingAccount', [emergencyMultisig]);
  }
}
test.sequential(
  'SDK pause keeps deposits blocked while permissionless withdraw remains available',
  async ({ divigent, publicClient, rpcUrl }) => {
    const amount = parseUsdc('10');

    await withPreparedAgent({
      privateKey: X402_AGENT_GUARD_PRIVATE_KEY,
      rpcUrl,
      publicClient,
      addresses: divigent.addresses,
      initialize: true,
    }, async (agent) => {
      await approveUsdcAndWait(agent, publicClient, amount * 2n);
      const deposit = await depositAndAssert(agent, publicClient, amount);

      await withEmergencyDivigent({
        publicClient,
        rpcUrl,
        addresses: divigent.addresses,
        fn: async (emergencyDivigent) => {
          await sendAndExpectSuccess(publicClient, emergencyDivigent.pauseDeposits());
        },
      });

      await expect(divigent.depositsPaused()).resolves.toBe(true);
      await expectContractRevert(
        agent.sdk.deposit({ amount, slippageBps: 25 }),
        'DepositsPausedError',
      );
      await expect(agent.sdk.usdcBalance(agent.wallet)).resolves.toBe(parseUsdc('15'));

      const withdraw = await withdrawAndAssert(agent, publicClient, deposit.sharesMinted);
      expect(withdraw.usdcReturned).toBeGreaterThan(0n);
      await expectFullExit(agent);

      await withEmergencyDivigent({
        publicClient,
        rpcUrl,
        addresses: divigent.addresses,
        fn: async (emergencyDivigent) => {
          await sendAndExpectSuccess(publicClient, emergencyDivigent.unpauseDeposits());
        },
      });
      await expect(divigent.depositsPaused()).resolves.toBe(false);
    });
  },
);
test.sequential(
  'SDK treasury rotation can be proposed, cancelled, proposed again, and executed',
  async ({ divigent, publicClient, rpcUrl }) => {
    await withForkSnapshot(rpcUrl, async () => {
      const before = await divigent.treasuryStatus();
      expect(before.pending).toBe(ZERO_ADDRESS);
      expect(before.effectiveAt).toBe(0n);

      await withEmergencyDivigent({
        publicClient,
        rpcUrl,
        addresses: divigent.addresses,
        fn: async (emergencyDivigent) => {
          await sendAndExpectSuccess(
            publicClient,
            emergencyDivigent.proposeTreasuryRotation(ROTATION_TREASURY_ONE),
          );
        },
      });
      const proposed = await divigent.treasuryStatus();
      expect(proposed.current).toBe(before.current);
      expect(proposed.pending).toBe(ROTATION_TREASURY_ONE);
      expect(proposed.effectiveAt).toBeGreaterThan(0n);

      await withEmergencyDivigent({
        publicClient,
        rpcUrl,
        addresses: divigent.addresses,
        fn: async (emergencyDivigent) => {
          await sendAndExpectSuccess(publicClient, emergencyDivigent.cancelTreasuryRotation());
        },
      });
      const cancelled = await divigent.treasuryStatus();
      expect(cancelled.current).toBe(before.current);
      expect(cancelled.pending).toBe(ZERO_ADDRESS);
      expect(cancelled.effectiveAt).toBe(0n);

      await withEmergencyDivigent({
        publicClient,
        rpcUrl,
        addresses: divigent.addresses,
        fn: async (emergencyDivigent) => {
          await sendAndExpectSuccess(
            publicClient,
            emergencyDivigent.proposeTreasuryRotation(ROTATION_TREASURY_TWO),
          );
        },
      });
      await rpcRequest(rpcUrl, 'evm_increaseTime', [TREASURY_ROTATION_DELAY_SECONDS + 1]);
      await rpcRequest(rpcUrl, 'evm_mine');
      await withEmergencyDivigent({
        publicClient,
        rpcUrl,
        addresses: divigent.addresses,
        fn: async (emergencyDivigent) => {
          await sendAndExpectSuccess(publicClient, emergencyDivigent.executeTreasuryRotation());
        },
      });
      const executed = await divigent.treasuryStatus();
      expect(executed.current).toBe(ROTATION_TREASURY_TWO);
      expect(executed.pending).toBe(ZERO_ADDRESS);
      expect(executed.effectiveAt).toBe(0n);
    });
  },
);
test.sequential(
  'SDK recordObservation refreshes a stale oracle before deposits resume',
  async ({ divigent, publicClient, rpcUrl }) => {
    await withForkSnapshot(rpcUrl, async () => {
      await rpcRequest(rpcUrl, 'evm_increaseTime', [MAX_ORACLE_STALENESS_SECONDS + 1]);
      await rpcRequest(rpcUrl, 'evm_mine');
      const staleStatus = await divigent.oracleStatus();
      expect(staleStatus.fresh).toBe(false);

      const recordHash = await divigent.recordObservation();
      await sendAndExpectSuccess(publicClient, recordHash);
      const freshStatus = await divigent.oracleStatus();
      expect(freshStatus.fresh).toBe(true);
      expect(freshStatus.lastObservationTime).toBeGreaterThan(staleStatus.lastObservationTime);

      const agent = await createInitializedAgent({
        privateKey: X402_AGENT_PLAN_PRIVATE_KEY,
        rpcUrl,
        publicClient,
        addresses: divigent.addresses,
      });
      const amount = parseUsdc('10');
      await seedDeposit(agent, publicClient, amount);
    });
  },
);
