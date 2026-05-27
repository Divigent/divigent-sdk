# Divigent SDK — Examples

Runnable integration patterns for `@divigent/sdk`. Each example is a single TypeScript file that demonstrates one canonical use case. Use them as starting points; copy into your project and adapt.

## Quick reference

| File | Pattern | When to use |
|------|---------|-------------|
| `01-minimal-deposit.ts` | Direct deposit | You want to make a funded wallet payment-ready in 5 lines of actual SDK code. |
| `02-x402-buyer-agent.ts` | x402 buyer + auto-yield | Your agent makes frequent paid x402 calls. Divigent recalls before each spend, sweeps idle USDC into venues after settlement. |
| `03-x402-seller-sweep.ts` | x402 seller + auto-sweep | You run an x402-paid HTTP service. Incoming settlements auto-deposit into Divigent above a configured liquid floor. |

## Prerequisites

- Node.js 20.10 or newer
- A funded wallet on Base mainnet (or Base Sepolia for testing)
- Access to a Base RPC endpoint (Alchemy, QuickNode, Coinbase Cloud, etc.)
- `npm install @divigent/sdk viem @x402/core` (plus `@x402/fetch`, `@x402/express` for x402 examples)

## Running

Set environment variables in your shell or a `.env` file:

```bash
export BASE_MAINNET_RPC_URL='https://...'
export PRIVATE_KEY='0x...'

# Run any example
npx tsx examples/01-minimal-deposit.ts
```

## Mainnet warning

Examples 01 and 03 broadcast real Base mainnet transactions. Test on Base Sepolia first by setting `chain: 'base-sepolia'` in the `Divigent.create()` call and using a Sepolia RPC URL. Use small amounts during your first run.

## Adapting to your stack

- **React (Wagmi)**: replace `createWalletClient` with `useWalletClient()` from Wagmi; everything else carries over directly.
- **Privy / Dynamic / Coinbase Smart Wallet**: use the wallet provider's exported viem wallet client; the `Divigent.create()` signature is unchanged.
- **No private keys in env**: in production, fetch the key from a secrets manager (AWS Secrets Manager, Doppler, 1Password Connect) at startup. Never commit `.env` files containing real keys.

## See also

- [SDK README](../README.md) — Full API surface and configuration options
- [Divigent docs (GitBook)](https://divigent.gitbook.io/divigent-docs) — Architecture, contracts, integration guides
- [`x402` integration deep-dive](../README.md#x402) — All `attachTo` config options including adaptive reserve tuning
