import { expect, vi } from 'vitest';
import { parseUsdc } from '../../src/core/utils';
import { divigentBaseMainnetForkTest as test } from '../fork/setup';
import {
  createLocalX402Client,
  expectDepositedEvent,
  readAgentBalances,
  withPreparedAgent,
  X402_AGENT_AUTO_DEPOSIT_PRIVATE_KEY,
  X402_SAFE_RESOURCE,
} from './helpers/x402AgentFork';

function paidResponse(url: string): Response {
  const response = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as Response & { url: string };
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

// Exercises: x402 settlement wrapper auto-deposits idle USDC into Divigent after payment settlement.
test.sequential(
  'x402 settlement wrapper auto-deposits idle USDC after paid response',
  async ({ divigent, publicClient, rpcUrl }) => {
    const fundingAmount = parseUsdc('25');
    const reserveFloor = parseUsdc('1');
    const settlementAmount = parseUsdc('0.2');
    const expectedIdleDeposit = fundingAmount - reserveFloor - settlementAmount;
    const settlementTx = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    await withPreparedAgent({
      privateKey: X402_AGENT_AUTO_DEPOSIT_PRIVATE_KEY,
      rpcUrl,
      publicClient,
      addresses: divigent.addresses,
      fundingAmount,
      initialize: true,
    }, async (agent) => {
      const before = await readAgentBalances(agent);
      expect(before.liquidUsdc).toBe(fundingAmount);
      expect(before.dvUsdc).toBe(0n);

      const { client } = createLocalX402Client();
      const handle = agent.sdk.attachTo(client as never, {
        minIdleThreshold: reserveFloor,
        reserveRatio: 0,
        reserveMultiplier: 0,
        allowedResource: X402_SAFE_RESOURCE,
      });
      const paidFetch = vi.fn(async () => paidResponse(X402_SAFE_RESOURCE));
      const http = {
        getPaymentSettleResponse: vi.fn(() => ({
          success: true,
          transaction: settlementTx,
          payer: agent.wallet,
          amount: settlementAmount.toString(),
        })),
      };
      const onIdleDeposit = vi.fn();

      const fetchWithYield = handle.wrapFetchWithYield(
        paidFetch as unknown as typeof fetch,
        http as never,
        { waitForIdleDeposit: true, onIdleDeposit },
      );

      const response = await fetchWithYield(X402_SAFE_RESOURCE);
      expect(response.status).toBe(200);
      expect(paidFetch).toHaveBeenCalledTimes(1);
      expect(http.getPaymentSettleResponse).toHaveBeenCalledTimes(1);

      const after = await readAgentBalances(agent);
      expect(after.liquidUsdc).toBe(reserveFloor + settlementAmount);
      expect(after.dvUsdc).toBeGreaterThan(0n);
      expect(onIdleDeposit).toHaveBeenCalledWith(expect.objectContaining({
        wallet: agent.wallet,
        walletBalance: fundingAmount,
        reserveFloor,
        settlementReserve: settlementAmount,
        idleAmount: expectedIdleDeposit,
        dedupeKey: `8453:${settlementTx}`,
        txHash: expect.stringMatching(/^0x[a-fA-F0-9]{64}$/),
      }));

      const txHash = onIdleDeposit.mock.calls[0]?.[0].txHash;
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      expectDepositedEvent(receipt, {
        wallet: agent.wallet,
        usdcAmount: expectedIdleDeposit,
      });

      handle.detach();
    });
  },
);
