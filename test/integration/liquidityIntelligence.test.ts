import { expect, vi } from 'vitest';
import {
  createWalletClient,
  http,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import {
  Divigent,
  parseUsdc,
  txHash,
  type DivigentCallExecutor,
} from '../../src/index';
import { divigentBaseMainnetForkTest as test } from '../fork/setup';
import {
  createLocalX402Client,
  expectDepositedEvent,
  readAgentBalances,
  seedDeposit,
  withPreparedAgent,
  x402AgentPaymentContext,
} from './helpers/x402AgentFork';

const LIQUIDITY_AGENT_PRIVATE_KEY =
  '0x1212121212121212121212121212121212121212121212121212121212121212';
const RECALL_AGENT_PRIVATE_KEY =
  '0x1313131313131313131313131313131313131313131313131313131313131313';
const SELLER_INCOME_PRIVATE_KEY =
  '0x1414141414141414141414141414141414141414141414141414141414141414';
const EXECUTOR_AGENT_PRIVATE_KEY =
  '0x1515151515151515151515151515151515151515151515151515151515151515';
const EMA_AGENT_PRIVATE_KEY =
  '0x1616161616161616161616161616161616161616161616161616161616161616';

// Exercises: read-only liquidity intelligence against real forked protocol state.
test.sequential(
  'assesses liquidity policy, deployable excess, route, and venue health on fork',
  async ({ divigent, publicClient, rpcUrl }) => {
    const fundingAmount = parseUsdc('50');
    const seedAmount = parseUsdc('20');
    const pendingPayment = parseUsdc('5');
    const minOperatingBalance = parseUsdc('2');
    const upcomingKnownPayouts = parseUsdc('1');

    await withPreparedAgent({
      privateKey: LIQUIDITY_AGENT_PRIVATE_KEY,
      rpcUrl,
      publicClient,
      addresses: divigent.addresses,
      fundingAmount,
      initialize: true,
    }, async (agent) => {
      await seedDeposit(agent, publicClient, seedAmount);

      const assessment = await agent.sdk.assessLiquidity({
        pendingPaymentAmount: pendingPayment,
        includeVenueHealth: true,
        policyContext: {
          minOperatingBalance,
          upcomingKnownPayouts,
          recentPaymentEma: parseUsdc('10'),
          reserveRatio: 0.5,
          reserveMultiplier: 1,
          maxDeployablePercent: 50,
          riskPreference: 'balanced',
        },
      });

      expect(assessment).toMatchObject({
        wallet: agent.wallet,
        riskPreference: 'balanced',
        paymentReady: true,
        canBecomePaymentReady: true,
        reserveHealthy: true,
        liquidityStatus: 'healthy',
        pendingPaymentAmount: pendingPayment,
        walletBalance: fundingAmount - seedAmount,
        positionCurrentValue: expect.any(BigInt),
        minOperatingBalance,
        knownUpcomingOutflows: upcomingKnownPayouts,
        upcomingKnownPayouts,
        adaptiveReserve: parseUsdc('5'),
        requiredReserve: parseUsdc('5'),
        targetLiquidBalance: parseUsdc('10'),
        maxDeployableAmount: parseUsdc('15'),
        deployableExcess: parseUsdc('15'),
        recommendedDeploymentAmount: parseUsdc('15'),
        recommendedAction: 'deploy',
        recommendedActions: ['deploy'],
        recallRequired: false,
        recommendedRecallAmount: 0n,
        venueHealth: expect.objectContaining({
          oracleFresh: true,
        }),
      });
      expect(assessment.positionCurrentValue).toBeGreaterThan(0n);
      expect(assessment.preferredVenue).toMatch(/^(AAVE|MORPHO)$/);
      expect(assessment.venueHealth?.rates.length).toBeGreaterThanOrEqual(2);
      expect(['healthy', 'degraded']).toContain(assessment.venueHealth?.status);
    });
  },
);

// Exercises: `ensurePaymentReady` recalls real USDC from a forked Divigent position.
test.sequential(
  'ensures payment readiness by executing a real fork recall',
  async ({ divigent, publicClient, rpcUrl }) => {
    const fundingAmount = parseUsdc('25');
    const seedAmount = parseUsdc('20');
    const pendingPayment = parseUsdc('8');
    const minOperatingBalance = parseUsdc('2');

    await withPreparedAgent({
      privateKey: RECALL_AGENT_PRIVATE_KEY,
      rpcUrl,
      publicClient,
      addresses: divigent.addresses,
      fundingAmount,
      initialize: true,
    }, async (agent) => {
      const deposit = await seedDeposit(agent, publicClient, seedAmount);
      const before = await readAgentBalances(agent);
      expect(before.liquidUsdc).toBe(fundingAmount - seedAmount);

      const result = await agent.sdk.ensurePaymentReady({
        pendingPaymentAmount: pendingPayment,
        minOperatingBalance,
        includeVenueHealth: true,
      });

      expect(result.recallTxHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(result.usdcReturned).toBeGreaterThanOrEqual(pendingPayment - before.liquidUsdc);
      expect(result.assessment).toMatchObject({
        paymentReady: false,
        canBecomePaymentReady: true,
        liquidityStatus: 'needs_recall',
        recommendedRecallAmount: pendingPayment + minOperatingBalance - before.liquidUsdc,
        recommendedAction: 'recall',
        recommendedActions: ['recall'],
      });

      const after = await readAgentBalances(agent);
      expect(after.liquidUsdc).toBeGreaterThanOrEqual(pendingPayment);
      expect(after.dvUsdc).toBeLessThan(deposit.sharesMinted);
    });
  },
);

// Exercises: x402 hook EMA state flows into handle.assessLiquidity while reading real fork state.
test.sequential(
  'assesses liquidity through the x402 handle using the observed payment EMA on fork',
  async ({ divigent, publicClient, rpcUrl }) => {
    await withPreparedAgent({
      privateKey: EMA_AGENT_PRIVATE_KEY,
      rpcUrl,
      publicClient,
      addresses: divigent.addresses,
      fundingAmount: parseUsdc('25'),
      initialize: true,
    }, async (agent) => {
      const { client, hooks } = createLocalX402Client();
      const handle = agent.sdk.attachTo(client as never, {
        minIdleThreshold: 0n,
        reserveRatio: 0.1,
        reserveMultiplier: 3,
        maxPaymentAmount: parseUsdc('5'),
      });
      const payment = x402AgentPaymentContext({
        sdk: agent.sdk,
        amount: parseUsdc('1'),
      });

      await hooks.before?.(payment);
      await hooks.after?.(payment);

      await expect(handle.assessLiquidity({ minDeposit: 0n })).resolves.toMatchObject({
        wallet: agent.wallet,
        adaptiveReserve: parseUsdc('0.06'),
        requiredReserve: parseUsdc('0.06'),
      });
      handle.detach();
    });
  },
);

// Exercises: seller-side x402 income hook sweeps merchant wallet USDC into Divigent on fork.
test.sequential(
  'seller income hook deposits received wallet USDC above reserve on fork',
  async ({ divigent, publicClient, rpcUrl }) => {
    const fundingAmount = parseUsdc('25');
    const reserveFloor = parseUsdc('1');
    const expectedIdleDeposit = fundingAmount - reserveFloor;
    const settlementTx = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    await withPreparedAgent({
      privateKey: SELLER_INCOME_PRIVATE_KEY,
      rpcUrl,
      publicClient,
      addresses: divigent.addresses,
      fundingAmount,
      initialize: true,
    }, async (agent) => {
      let afterSettle: ((ctx: { result: { success: boolean; transaction: string } }) => Promise<void> | void) | undefined;
      const server = {
        onAfterSettle(hook: typeof afterSettle) {
          afterSettle = hook;
          return server;
        },
      };
      const onIdleDeposit = vi.fn();
      const handle = agent.sdk.attachToResourceServer(server as never, {
        minIdleThreshold: reserveFloor,
        onIdleDeposit,
      });

      expect(afterSettle).toBeDefined();
      await afterSettle?.({ result: { success: true, transaction: settlementTx } });
      await afterSettle?.({ result: { success: true, transaction: settlementTx } });

      const after = await readAgentBalances(agent);
      expect(after.liquidUsdc).toBe(reserveFloor);
      expect(after.dvUsdc).toBeGreaterThan(0n);
      expect(onIdleDeposit).toHaveBeenCalledTimes(1);
      expect(onIdleDeposit).toHaveBeenCalledWith(expect.objectContaining({
        wallet: agent.wallet,
        walletBalance: fundingAmount,
        reserveFloor,
        idleAmount: expectedIdleDeposit,
        dedupeKey: `8453:${settlementTx}`,
        txHash: expect.stringMatching(/^0x[a-fA-F0-9]{64}$/),
      }));

      const depositedTx = onIdleDeposit.mock.calls[0]?.[0]?.txHash as Hex | undefined;
      expect(depositedTx).toBeDefined();
      if (depositedTx === undefined) throw new Error('missing seller deposit tx');
      const receipt = await publicClient.getTransactionReceipt({ hash: depositedTx });
      expectDepositedEvent(receipt, {
        wallet: agent.wallet,
        usdcAmount: expectedIdleDeposit,
      });
      handle.detach();
    });
  },
);

// Exercises: executor-backed approval deposits convert real plans into raw calls on fork.
test.sequential(
  'executor-backed approval deposit executes real approve and deposit calls on fork',
  async ({ divigent, publicClient, rpcUrl }) => {
    const fundingAmount = parseUsdc('25');
    const depositAmount = parseUsdc('10');

    await withPreparedAgent({
      privateKey: EXECUTOR_AGENT_PRIVATE_KEY,
      rpcUrl,
      publicClient,
      addresses: divigent.addresses,
      fundingAmount,
      initialize: true,
    }, async (agent) => {
      const account = privateKeyToAccount(EXECUTOR_AGENT_PRIVATE_KEY);
      const walletClient = createWalletClient({
        account,
        chain: base,
        transport: http(rpcUrl),
      });
      const callCounts: number[] = [];
      const executor: DivigentCallExecutor = {
        account: agent.wallet,
        chainId: base.id,
        kind: 'custom',
        async executeCalls(calls) {
          callCounts.push(calls.length);
          let lastHash: Hex | undefined;
          for (const [index, call] of calls.entries()) {
            if (index > 0) {
              // This test executor serializes a smart-account batch into EOA txs,
              // so preflight the next call after the previous receipt is visible.
              await publicClient.call({
                account: agent.wallet,
                to: call.to,
                data: call.data,
                ...(call.value !== undefined && { value: call.value }),
              });
            }
            lastHash = await walletClient.sendTransaction({
              account,
              chain: base,
              to: call.to,
              data: call.data,
              ...(call.value !== undefined && { value: call.value }),
            });
            const receipt = await publicClient.waitForTransactionReceipt({ hash: lastHash });
            expect(receipt.status, `executor call ${index} ${lastHash}`).toBe('success');
          }
          if (lastHash === undefined) throw new Error('executor received no calls');
          return { txHash: txHash(lastHash), raw: { calls: calls.length } };
        },
      };
      const executorSdk = Divigent.create({
        publicClient,
        walletClient,
        chain: 'base',
        addresses: divigent.addresses,
        executor,
      });

      const deposit = await executorSdk.depositWithApprovalAndWait({
        amount: depositAmount,
      });

      expect(callCounts).toEqual([2]);
      expect(deposit.sharesMinted).toBeGreaterThan(0n);
      await expect(executorSdk.usdcBalance(agent.wallet)).resolves.toBe(fundingAmount - depositAmount);
      await expect(executorSdk.dvUsdcBalance(agent.wallet)).resolves.toBe(deposit.sharesMinted);
      const receipt = await publicClient.getTransactionReceipt({ hash: deposit.txHash });
      expectDepositedEvent(receipt, {
        wallet: agent.wallet,
        usdcAmount: depositAmount,
        sharesMinted: deposit.sharesMinted,
      });
    });
  },
);
