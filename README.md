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
- `getRecommendedRoute(amount)`
- `getOptimalVault()`
- `getAllRates()`
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
import { x402HTTPClient, type x402Client } from '@x402/core/client';
import { wrapFetchWithPayment } from '@x402/fetch';

declare const client: x402Client;

const handle = divigent.attachTo(client, {
  maxPaymentAmount: parseUsdc('5'),
  minIdleThreshold: parseUsdc('0.25'),
});

const http = new x402HTTPClient(client);
const fetchWithPayment = wrapFetchWithPayment(fetch, http);
const fetchWithDivigentYield = handle.wrapFetchWithYield(fetchWithPayment, http);

await fetchWithDivigentYield('https://api.example.com/paid');

handle.detach();
```

For a full Base Sepolia example that starts a local x402 v2 merchant endpoint
charging Divigent-managed test USDC, then covers setup, deposit, automatic
x402 recall withdrawals, post-settlement idle deposits, paid fetch, and detach, see
[`examples/x402-divigent-base-sepolia.ts`](examples/x402-divigent-base-sepolia.ts).

The fetch wrapper waits until x402 settlement succeeds, then deposits wallet
USDC above the configured idle buffer back into Divigent. Lower-level x402
helpers are not part of the public beta API yet.

If a just-in-time recall cannot make at least the payment amount liquid, the SDK
aborts before x402 signs a payment authorization and throws a `DivigentError`
with code `DIVIGENT_X402_RECALL_INSUFFICIENT_LIQUIDITY`. If the wallet can fund
the payment but cannot top up the configured reserve, the payment can still
proceed and `onBeforePayment` receives `recallError` for telemetry.

### Idle Buffer Examples

Use a fixed idle buffer when the agent should keep one predictable amount of
USDC liquid for x402 and send the rest back to Divigent after settlement.

```ts
import { x402HTTPClient, type x402Client } from '@x402/core/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { formatUsdc, parseUsdc } from '@divigent/sdk';

declare const client: x402Client;

const handle = divigent.attachTo(client, {
  minIdleThreshold: parseUsdc('0.25'),
  reserveRatio: 0,
  reserveMultiplier: 0,
  maxPaymentAmount: parseUsdc('1'),
});

const http = new x402HTTPClient(client);
const fetchWithPayment = wrapFetchWithPayment(fetch, http);
const fetchWithYield = handle.wrapFetchWithYield(fetchWithPayment, http, {
  waitForIdleDeposit: true,
  onIdleDeposit: (ctx) => {
    console.log(`deposited ${formatUsdc(ctx.idleAmount)} USDC`);
    console.log(`kept ${formatUsdc(ctx.reserveFloor)} USDC liquid`);
    console.log(`deposit tx ${ctx.txHash}`);
  },
});

await fetchWithYield('https://api.example.com/paid');
handle.detach();
```

In this setup, after the x402 settlement header is confirmed, Divigent leaves
`0.25 USDC` liquid and deposits the remaining wallet USDC back into the vault.
The wrapper also reserves the just-settled x402 payment amount while the
settlement debit propagates, so it does not sweep funds that were already paid.

Use an adaptive EMA buffer when payment sizes vary and the agent should keep a
larger liquid buffer after seeing larger recent payments.

```ts
import { x402HTTPClient, type x402Client } from '@x402/core/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { formatUsdc, parseUsdc } from '@divigent/sdk';

declare const client: x402Client;

const handle = divigent.attachTo(client, {
  minIdleThreshold: parseUsdc('0.25'),
  reserveRatio: 0.5,
  reserveMultiplier: 2,
  maxPaymentAmount: parseUsdc('25'),
  allowedOrigins: ['https://api.example.com'],
  allowedResources: ['https://api.example.com/v1/*'],
});

const http = new x402HTTPClient(client);
const fetchWithPayment = wrapFetchWithPayment(fetch, http);
const fetchWithYield = handle.wrapFetchWithYield(fetchWithPayment, http, {
  waitForIdleDeposit: false,
  onIdleDeposit: (ctx) => {
    console.log(
      `swept ${formatUsdc(ctx.idleAmount)} USDC, kept ${formatUsdc(ctx.reserveFloor)} USDC`,
    );
  },
});

await fetchWithYield('https://api.example.com/v1/report');
handle.detach();
```

The adaptive reserve is:

```text
max(minIdleThreshold, recent-payment-EMA * reserveRatio * reserveMultiplier)
```

The EMA records successful x402 payment creation, uses a 20% update weight,
and clamps each sample by `maxPaymentAmount` so one oversized request cannot
poison the buffer. In the example above, the wallet keeps at least `0.25 USDC`
liquid, and trends toward roughly one EMA-sized payment because
`reserveRatio * reserveMultiplier = 1`.

## Test Coverage

The SDK test suite is split across fast unit tests and pinned Base fork tests.
Unit tests cover address/config guards, money math, permit signing, error
decoding, receipt parsing, planning behavior, and x402 policy/settlement logic.
Fork tests run against a deterministic Base mainnet block with Anvil, validating
real protocol wiring, deposits, withdrawals, permit deposits, operator flows,
routing behavior, pause/treasury/oracle lifecycle paths, and x402 recall
behavior against deployed venue dependencies.

Before publishing a beta release, run:

```bash
npm run prepublishOnly
npm test
npm run test:fork:base
npm run test:integration:base
npm run test:x402:local
git diff --check
npm pack --dry-run --json
```
