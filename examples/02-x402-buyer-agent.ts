/**
 * Example 02 — x402 buyer agent with payment-ready treasury
 *
 * Scenario: an AI agent makes frequent paid x402 calls (research, data, AI
 * inference). Without Divigent, idle USDC between calls sits unproductive.
 * With Divigent attached, after each x402 settlement the agent's idle USDC
 * (above a configured liquid floor) goes back into monitored venues.
 *
 * If the next call's price exceeds the wallet's liquid balance, Divigent
 * recalls liquidity from venues BEFORE x402 signs the authorization — no
 * mid-campaign payment failures.
 *
 * Run:
 *   BASE_MAINNET_RPC_URL=https://... PRIVATE_KEY=0x... \
 *   npx tsx examples/02-x402-buyer-agent.ts
 */
import { Divigent, parseUsdc, formatUsdc } from '@divigent/sdk';
import { x402HTTPClient } from '@x402/core/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const rpcUrl = process.env.BASE_MAINNET_RPC_URL;
const pk = process.env.PRIVATE_KEY as `0x${string}` | undefined;
if (!rpcUrl || !pk) {
  throw new Error('Set BASE_MAINNET_RPC_URL and PRIVATE_KEY env vars.');
}

const account = privateKeyToAccount(pk);
const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain: base, transport: http(rpcUrl) });

const divigent = Divigent.create({ publicClient, walletClient, chain: 'base' });
await divigent.verifyAddresses();

// --- x402 client wiring ---
// (Replace `client` construction with whatever your x402 setup uses; this
// follows the @x402/core minimal pattern.)
declare const client: import('@x402/core/client').x402Client;

// Attach Divigent to the x402 client. Behavior:
//   - Before each payment: recall from venues if needed to make wallet liquid.
//   - After each settlement: deposit USDC above `minIdleThreshold` back into Divigent.
//   - Adaptive reserve: scales with recent payment sizes (EMA).
const handle = divigent.attachTo(client, {
  // Always keep at least this much USDC liquid in the wallet.
  minIdleThreshold: parseUsdc('0.25'),
  // Scale the reserve with the EMA of recent payment sizes (1.0 = "keep ~1 payment").
  reserveRatio: 0.5,
  reserveMultiplier: 2,
  // Refuse any single payment above this cap (safety rail).
  maxPaymentAmount: parseUsdc('5'),
  maxSessionPaymentAmount: parseUsdc('50'),
  // Lock to specific hosts/resources — refuse to pay anywhere else.
  allowedOrigins: ['https://api.example.com'],
  allowedResources: ['https://api.example.com/v1/*'],
});

const httpClient = new x402HTTPClient(client);
const fetchWithPayment = wrapFetchWithPayment(fetch, httpClient);
const fetchWithYield = handle.wrapFetchWithYield(fetchWithPayment, httpClient, {
  // Wait for the post-settlement Divigent deposit to confirm before returning.
  // Set to false for "fire and forget" if your loop is latency-sensitive.
  waitForIdleDeposit: false,
  onIdleDeposit: (ctx) => {
    console.log(
      `[divigent] swept ${formatUsdc(ctx.idleAmount)} USDC, kept ${formatUsdc(ctx.reserveFloor)} USDC liquid`,
    );
  },
});

// Make the paid call. Divigent handles recall + sweep transparently.
const res = await fetchWithYield('https://api.example.com/v1/report');
console.log('paid response status:', res.status);

// Clean detach when done.
handle.detach();
