# @divigent/sdk

Divigent Protocol SDK beta for the Base Sepolia testnet.

## Beta Notice

This package is in beta and is still under security review and testing. It is
published for Base Sepolia testnet integration only. Do not use this beta SDK
with mainnet funds.

## Install

```bash
npm install @divigent/sdk@beta viem @x402/core
```

Requires Node.js 20.10 or newer.

## Quick Start

```ts
import { Divigent, evmAddress, formatUsdc, parseUsdc } from '@divigent/sdk';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL!;
const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });

const divigent = Divigent.create({ publicClient, walletClient });

const position = await divigent.getPosition(evmAddress(account.address));
console.log(formatUsdc(position.currentValue));

// Warning: these broadcast real Base Sepolia transactions.
const amount = parseUsdc('1');
await divigent.approveUsdc(amount);
const txHash = await divigent.deposit({ amount });
console.log(txHash);
```

## Public API

Import from the package root:

```ts
import { Divigent, parseUsdc, formatUsdc, evmAddress } from '@divigent/sdk';
```

`Divigent.create(config)` creates the SDK facade. The beta supports Base
Sepolia only and defaults to `base-sepolia`.

Common read methods:

- `getPosition(wallet)`
- `withdrawCapacity()`
- `getCurrentAllocation()`
- `pricePerShare()`
- `previewDeposit(amount)`
- `previewRedeem(shares, wallet)`
- `usdcBalance(account)`
- `usdcAllowance(owner)`

Common write methods:

- `planApproveUsdc(amount)`
- `planDeposit(params)`
- `planWithdraw(params)`
- `sendPlan(plan)`
- `approveUsdc(amount)`
- `deposit(params)`
- `depositAndWait(params)`
- `withdraw(params)`
- `withdrawAndWait(params)`

Planning methods return viem-ready requests without broadcasting transactions.

Helpers:

- `parseUsdc(value)`
- `formatUsdc(value)`
- `evmAddress(value)`
- `txHash(value)`

## x402

Use the facade method for x402 integration in this beta:

```ts
import type { x402Client } from '@x402/core/client';

declare const client: x402Client;

const handle = divigent.attachTo(client, {
  maxPaymentAmount: parseUsdc('5'),
});

handle.detach();
```

Lower-level x402 helpers are not part of the public beta API yet.
