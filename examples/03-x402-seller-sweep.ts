/**
 * Example 03 — x402 seller sweep
 *
 * Scenario: you run an x402-paid HTTP service. Settlements land in your
 * treasury wallet as raw USDC. With Divigent attached to the resource server,
 * incoming USDC is automatically swept into monitored venues after each
 * settlement — your float earns yield without compromising payout liquidity.
 *
 * Recall-before-spend still applies: if the operator wallet ever needs to
 * send out (refund, payroll, gas top-up), Divigent recalls the needed amount
 * from venues before the outbound transfer.
 *
 * Run:
 *   BASE_MAINNET_RPC_URL=https://... TREASURY_KEY=0x... \
 *   npx tsx examples/03-x402-seller-sweep.ts
 */
import { Divigent, parseUsdc, formatUsdc } from '@divigent/sdk';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import express from 'express';
import { x402Middleware } from '@x402/express';

const rpcUrl = process.env.BASE_MAINNET_RPC_URL;
const pk = process.env.TREASURY_KEY as `0x${string}` | undefined;
if (!rpcUrl || !pk) {
  throw new Error('Set BASE_MAINNET_RPC_URL and TREASURY_KEY env vars.');
}

const treasury = privateKeyToAccount(pk);
const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account: treasury, chain: base, transport: http(rpcUrl) });

const divigent = Divigent.create({ publicClient, walletClient, chain: 'base' });
await divigent.verifyAddresses();

// --- minimal x402-paid Express server ---
const app = express();
const resourceServer = x402Middleware(app, {
  payTo: treasury.address,
  network: 'base',
  routes: {
    'GET /api/report': { price: parseUsdc('0.10'), description: 'Daily report' },
  },
});

// Attach Divigent to the resource server. After each x402 settlement, USDC
// above the configured idle threshold is deposited into Divigent automatically.
const handle = divigent.attachToResourceServer(resourceServer, {
  // Keep at least this much USDC liquid for refunds, gas, payroll, etc.
  minIdleThreshold: parseUsdc('100'),
  // Scale buffer with recent payout EMA (none for a seller — just floor).
  reserveRatio: 0,
  reserveMultiplier: 0,
  // Sweep ratio: deposit 95% of incoming USDC above the floor.
  sweepRatio: 0.95,
  onIdleDeposit: (ctx) => {
    console.log(
      `[divigent] swept ${formatUsdc(ctx.idleAmount)} USDC into Divigent — tx ${ctx.txHash}`,
    );
  },
});

app.get('/api/report', (_req, res) => {
  res.json({ generated_at: new Date().toISOString(), data: { /* ... */ } });
});

app.listen(3000, () => console.log('paid resource server listening on :3000'));

// On shutdown: detach so no further sweeps fire.
process.on('SIGTERM', () => {
  handle.detach();
  process.exit(0);
});
