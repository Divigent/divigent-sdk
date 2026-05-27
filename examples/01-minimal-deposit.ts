/**
 * Example 01 — Minimal deposit
 *
 * The simplest possible Divigent integration: read the current position,
 * approve USDC, deposit. Makes the wallet payment-ready: liquid for spend
 * while excess USDC earns in monitored venues (Aave V3 / MetaMorpho).
 *
 * Run:
 *   BASE_MAINNET_RPC_URL=https://... PRIVATE_KEY=0x... npx tsx examples/01-minimal-deposit.ts
 *
 * Mainnet warning: this broadcasts real Base mainnet transactions. Test on
 * Base Sepolia first (set `chain: 'base-sepolia'` and use the Sepolia RPC).
 */
import { Divigent, evmAddress, formatUsdc, parseUsdc } from '@divigent/sdk';
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

// Optional sanity check — confirms the SDK's address registry matches on-chain.
await divigent.verifyAddresses();

// Show what's currently in Divigent for this wallet.
const position = await divigent.getPosition(evmAddress(account.address));
console.log(`Current Divigent position: ${formatUsdc(position.currentValue)} USDC`);

// Deposit 1 USDC. After this, the wallet's idle USDC drops by 1 but its
// payment-ready capacity (liquid + recallable) stays whole.
const amount = parseUsdc('1');
await divigent.approveUsdc(amount);
const txHash = await divigent.deposit({ amount });
console.log(`Deposited 1 USDC — tx: ${txHash}`);
