# @divigent/sdk

Viem-native TypeScript SDK for the Divigent yield router on Base mainnet and
Base Sepolia.

Current release line: `1.0.3`.

## Mainnet Notice

Mainnet support uses real Base USDC and broadcasts real transactions. Keep
launch caps small, verify the configured addresses with `verifyAddresses()`,
and test on Base Sepolia or a Base fork before moving meaningful funds.

## Install

```bash
npm install @divigent/sdk@^1.0.3 viem @x402/core
```

Requires Node.js 20.10 or newer.

## Quick Start

```ts
import { Divigent, evmAddress, formatUsdc, parseUsdc } from '@divigent/sdk';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const rpcUrl = process.env.BASE_MAINNET_RPC_URL!;
const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain: base, transport: http(rpcUrl) });

const divigent = Divigent.create({ publicClient, walletClient, chain: 'base' });
await divigent.verifyAddresses();

const position = await divigent.getPosition(evmAddress(account.address));
console.log(formatUsdc(position.currentValue));

// Warning: these broadcast real Base mainnet transactions.
const amount = parseUsdc('1');
// approveUsdc writes a deposit-safe allowance (amount plus one atomic USDC unit)
// so approve-then-deposit flows avoid exact-allowance edge cases.
await divigent.approveUsdc(amount);
const txHash = await divigent.deposit({ amount });
console.log(txHash);
```

## Public API

Import from the package root:

```ts
import { Divigent, parseUsdc, formatUsdc, evmAddress } from '@divigent/sdk';
```

`Divigent.create(config)` creates the SDK facade. The SDK supports Base mainnet
with `chain: 'base'` and Base Sepolia with `chain: 'base-sepolia'`.
If omitted, `chain` is inferred from bound viem clients when possible and then
falls back to `base-sepolia` for backwards compatibility. Production code
should still set the chain explicitly.

Built-in deployments:

- `base`: Base mainnet, Circle USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- `base-sepolia`: Base Sepolia test deployment

Common read methods:

- `getPosition(wallet)`
- `assessLiquidity(params)`
- `analyzeWalletBehavior(params)`
- `analyzeMissedYield(params)`
- `getProtocolMetrics()`
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

- `planApproveUsdc(amount)` (plans a deposit-safe approval amount)
- `planDeposit(params)`
- `planWithdraw(params)`
- `sendPlan(plan)`
- `sendPlans(plans)`
- `approveUsdc(amount)` (approves a deposit-safe allowance)
- `deposit(params)`
- `depositAndWait(params)`
- `depositWithApproval(params)`
- `depositWithApprovalAndWait(params)`
- `withdraw(params)`
- `withdrawAndWait(params)`
- `ensurePaymentReady(params)`

Planning methods return viem-ready requests without broadcasting transactions.

Helpers:

- `parseUsdc(value)`
- `formatUsdc(value)`
- `evmAddress(value)`
- `txHash(value)`

## Wallet Behavior Analysis

The SDK can analyze public Base USDC transfer history for a wallet without
signing or broadcasting anything. This is useful for agent/MCP onboarding:
first explain how the wallet behaves, then estimate how much idle USDC could
have been kept productive.

```ts
const behavior = await divigent.analyzeWalletBehavior({
  wallet: evmAddress('0x...'),
  lookbackDays: 30,
});

console.log(behavior.pattern.inferredRole);
console.log(behavior.activity.p95PaymentUsdc);

const missedYield = await divigent.analyzeMissedYield({
  wallet: evmAddress('0x...'),
  lookbackDays: 30,
  assumedApy: 0.045,
  minOperatingBalance: '0.25',
});

console.log(missedYield.headline.primary);
console.log(missedYield.headline.secondary);
```

`analyzeWalletBehavior(...)` returns current/average USDC balance, incoming and
outgoing transfer counts, payment distribution stats, cadence, inferred role,
and an EIP-3009/x402 signal when USDC moves out while the wallet nonce remains
zero.

`analyzeMissedYield(...)` replays a deterministic reserve over the same
historical window and reports deployable USDC-days, estimated missed yield,
capital efficiency, and short headline strings an agent can quote directly.

These analysis helpers scan ERC-20 logs through the configured RPC. For longer
windows, use a reliable Base RPC provider.

`getProtocolMetrics()` returns protocol-level traction metrics from on-chain
router events and live accounting:

```ts
const metrics = await divigent.getProtocolMetrics();

console.log(metrics.wallets.uniqueWalletsUsingDivigent);
console.log(metrics.volume.cumulativeDepositedUsdc);
console.log(metrics.tvl.currentTvlUsdc);
console.log(metrics.transactions.totalTreasuryOperations);
console.log(metrics.transactions.recallProxyTransactions);
```

The x402-specific transaction count is reported as a recall proxy. Router
events can prove Divigent withdrawals/recalls on-chain, but cannot prove that
the recalled USDC was later settled through x402 unless an SDK/backend telemetry
layer correlates those flows.

## Liquidity Intelligence

`assessLiquidity(...)` is the read-only intelligence layer for agent wallets,
seller treasuries, and policy engines. It answers whether a wallet can pay,
whether liquidity should be recalled from Divigent, how much idle USDC is
deployable, and which Divigent venue would be used.

```ts
const assessment = await divigent.assessLiquidity({
  wallet: evmAddress(account.address),
  pendingPaymentAmount: parseUsdc('2.50'),
  policyContext: {
    minOperatingBalance: parseUsdc('0.25'),
    upcomingKnownPayouts: parseUsdc('1'),
    maxDeployablePercent: 75,
    riskPreference: 'balanced',
  },
  includeVenueHealth: true,
});

console.log(assessment.paymentReady);
console.log(assessment.requiredReserve);
console.log(assessment.deployableExcess);
console.log(assessment.recommendedActions);
```

`ensurePaymentReady(...)` is the execution layer. It recalls USDC only when the
wallet needs liquidity for the pending payment by default; reserve-only top-ups
are opt-in with `reserveTopUp: 'opportunistic'`.

```ts
const result = await divigent.ensurePaymentReady({
  pendingPaymentAmount: parseUsdc('2.50'),
  minOperatingBalance: parseUsdc('0.25'),
});

if (result.recallTxHash) {
  console.log(`recall tx: ${result.recallTxHash}`);
}
```

Risk preferences tune the reserve posture, not the protocol venue set. Divigent
still routes only through its approved Base venues, currently Aave V3 and
Morpho Steakhouse USDC.

## Smart Accounts

The SDK can route writes through a pluggable executor. Without an executor,
`sendPlans(...)` broadcasts EOA transactions sequentially. With an executor,
plans are converted into raw calls and submitted as one batched operation.

```ts
import { Divigent, createEip5792Executor } from '@divigent/sdk';

const executor = createEip5792Executor({
  walletClient,
  experimentalFallback: true,
});

const smartDivigent = Divigent.create({
  publicClient,
  walletClient,
  chain: 'base',
  executor,
});

await smartDivigent.depositWithApprovalAndWait({
  amount: parseUsdc('10'),
});
```

`createEip5792Executor(...)` is viem-native and uses wallet call bundles where
available. ERC-4337, Safe, or vendor bundlers can be integrated by providing a
custom `DivigentCallExecutor`.

## x402

Use the facade method for x402 integration:

```ts
import { x402HTTPClient, type x402Client } from '@x402/core/client';
import { wrapFetchWithPayment } from '@x402/fetch';

declare const client: x402Client;
declare const merchantPayTo: `0x${string}`;

const handle = divigent.attachTo(client, {
  maxPaymentAmount: parseUsdc('5'),
  maxSessionPaymentAmount: parseUsdc('25'),
  minIdleThreshold: parseUsdc('0.25'),
  allowedPayTo: [merchantPayTo],
  requireAllowedPayTo: true,
  allowedOrigins: ['https://api.example.com'],
  allowedResources: ['https://api.example.com/paid'],
});

const http = new x402HTTPClient(client);
const fetchWithPayment = wrapFetchWithPayment(fetch, http);
const fetchWithDivigentYield = handle.wrapFetchWithYield(fetchWithPayment, http);

await fetchWithDivigentYield('https://api.example.com/paid');

handle.detach();
```

For full buyer and seller integration examples, use the GitBook integration
guide.

The buyer fetch wrapper waits until x402 settlement succeeds, then deposits
wallet USDC above the configured idle buffer back into Divigent. Seller
integrations can attach `divigent.attachToResourceServer(resourceServer, config)`
to sweep merchant income into Divigent after x402 settlement.

Both x402 handles expose `assessLiquidity(...)`, so callers can inspect the same
adaptive reserve state that the hooks learned from recent payments:

```ts
const assessment = await handle.assessLiquidity({
  pendingPaymentAmount: parseUsdc('1'),
});
```

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
behavior against deployed venue dependencies. The integration fork suite also
covers liquidity intelligence, `ensurePaymentReady`, x402 buyer/seller hooks,
and executor-backed approval deposits.
