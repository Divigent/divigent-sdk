# Divigent Website Metrics Integration

This is the implementation brief for adding live Divigent protocol metrics to
the main Divigent website.

The website is HTML-based, so the browser should **not** call
`getProtocolMetrics()` directly. That function scans on-chain events and needs a
premium Base RPC. Calling it from frontend HTML would expose the RPC URL and make
page loads slow.

Use a live-but-cached server-side metrics snapshot instead.

## Goal

Show simple public traction metrics on the website:

- Wallets using Divigent logic
- Cumulative USDC deposited through Divigent
- Current TVL
- Total Divigent treasury operations
- Deposit / withdrawal / recall transaction counts
- Divigent recall / withdrawal transactions as the current x402-settlement proxy

The SDK source of truth is:

```ts
const metrics = await divigent.getProtocolMetrics();
```

This is available in `@divigent/sdk@1.0.5`.

Install/update:

```bash
npm install @divigent/sdk@1.0.5
```

Important transaction fields:

```ts
metrics.transactions.totalDivigentTransactions
metrics.transactions.totalTreasuryOperations
metrics.transactions.authorizationTransactions
metrics.transactions.depositTransactions
metrics.transactions.withdrawTransactions
metrics.transactions.recallProxyTransactions
```

Meaning:

- `totalDivigentTransactions`: all unique Divigent router transactions counted by the SDK, including wallet authorization plus treasury activity.
- `totalTreasuryOperations`: unique deposit + withdrawal/recall transactions. This is the clean website/dashboard number for "how many treasury actions happened through Divigent."
- `depositTransactions`: unique deposit transactions.
- `withdrawTransactions`: unique withdrawal transactions.
- `recallProxyTransactions`: current on-chain recall proxy. Today this equals withdrawal-style exits observed on-chain; exact x402 settlement attribution still needs SDK/backend telemetry correlation.

## Recommended Architecture

```text
Divigent infra scheduled job / server endpoint
  -> uses @divigent/sdk
  -> uses BASE_MAINNET_RPC_URL from Divigent server env
  -> calls getProtocolMetrics()
  -> caches public metrics JSON

Static HTML website
  -> fetches cached /metrics.json or /api/metrics
  -> renders numbers
```

Do not put `BASE_MAINNET_RPC_URL` in frontend JavaScript.

Eduard does not need to configure or own an RPC key if Divigent hosts the
metrics endpoint. The RPC lives only in Divigent's server/scheduled-job
environment. The website only consumes the public JSON response.

## Live But Cached

`getProtocolMetrics()` can produce live on-chain metrics, but it should not run
for every website visitor. It scans router logs and reads live accounting, so it
is too heavy for per-page-load execution.

Use this model:

```text
Background updater every 30 seconds to 5 minutes
  -> SDK getProtocolMetrics()
  -> premium Base RPC
  -> cache latest JSON snapshot

Website page load
  -> fetch cached JSON
  -> render instantly
```

This keeps the website fast while still showing fresh public metrics.
For a public dashboard, use a shorter cache such as 30-120 seconds. For a
landing page metric strip, 5-15 minutes is usually enough.

Avoid this model:

```text
Every website visitor
  -> SDK getProtocolMetrics()
  -> RPC log scan
```

That would make page loads slow, increase RPC cost, and risk provider rate
limits.

## Option A: Static JSON Snapshot

Best if the website is deployed as static HTML and Divigent wants a build-time or
scheduled-file update.

Run a scheduled script every 5-15 minutes on Divigent infra and write:

```text
public/metrics.json
```

Example output:

```json
{
  "updatedAt": "2026-05-29T16:00:00.000Z",
  "asOfBlock": "46640942",
  "walletsUsingDivigent": 8,
  "activeWalletsWithPosition": 4,
  "cumulativeDepositedUsdc": "403.026714",
  "cumulativeWithdrawnUsdc": "196.32641",
  "currentTvlUsdc": "206.700304",
  "totalDivigentTransactions": 81,
  "totalTreasuryOperations": 73,
  "depositTransactions": 26,
  "withdrawTransactions": 47,
  "recallProxyTransactions": 47,
  "x402SettledViaDivigent": null,
  "note": "totalTreasuryOperations is deposit + withdrawal/recall activity. recallProxyTransactions is the current on-chain proxy for x402 payments supported by Divigent recalls."
}
```

## Metrics Generator Script

Create something like:

```ts
// scripts/generate-metrics.ts
import { writeFile } from "node:fs/promises";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { Divigent } from "@divigent/sdk";

const rpcUrl = process.env.BASE_MAINNET_RPC_URL ?? process.env.BASE_RPC_URL;

if (!rpcUrl) {
  throw new Error("BASE_MAINNET_RPC_URL or BASE_RPC_URL is required");
}

const publicClient = createPublicClient({
  chain: base,
  transport: http(rpcUrl),
});

const divigent = Divigent.create({
  publicClient,
  chain: "base",
});

const metrics = await divigent.getProtocolMetrics();

const payload = {
  updatedAt: new Date().toISOString(),
  asOfBlock: metrics.asOfBlock.toString(),
  asOfTimestamp: metrics.asOfTimestamp,
  walletsUsingDivigent: metrics.wallets.uniqueWalletsUsingDivigent,
  activeWalletsWithPosition: metrics.wallets.activeWalletsWithPosition,
  cumulativeDepositedUsdc: metrics.volume.cumulativeDepositedUsdc,
  cumulativeWithdrawnUsdc: metrics.volume.cumulativeWithdrawnUsdc,
  currentTvlUsdc: metrics.tvl.currentTvlUsdc,
  totalDivigentTransactions: metrics.transactions.totalDivigentTransactions,
  totalTreasuryOperations: metrics.transactions.totalTreasuryOperations,
  depositTransactions: metrics.transactions.depositTransactions,
  withdrawTransactions: metrics.transactions.withdrawTransactions,
  recallProxyTransactions: metrics.transactions.recallProxyTransactions,
  x402SettledViaDivigent: metrics.transactions.x402SettledViaDivigent,
  note: metrics.transactions.x402SettledViaDivigentNote,
};

await writeFile("public/metrics.json", JSON.stringify(payload, null, 2));
```

Run it with:

```bash
BASE_MAINNET_RPC_URL=... npx tsx scripts/generate-metrics.ts
```

## Frontend HTML Integration

Example HTML:

```html
<section id="protocol-metrics">
  <div>
    <span>Wallets using Divigent</span>
    <strong data-metric="walletsUsingDivigent">--</strong>
  </div>

  <div>
    <span>USDC deployed through Divigent</span>
    <strong data-metric="currentTvlUsdc">--</strong>
  </div>

  <div>
    <span>Cumulative USDC deposited</span>
    <strong data-metric="cumulativeDepositedUsdc">--</strong>
  </div>

  <div>
    <span>Divigent recall transactions</span>
    <strong data-metric="recallProxyTransactions">--</strong>
  </div>

  <div>
    <span>Treasury operations processed</span>
    <strong data-metric="totalTreasuryOperations">--</strong>
  </div>
</section>

<script>
  const usdc = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const integer = new Intl.NumberFormat("en-US");

  async function loadDivigentMetrics() {
    const response = await fetch("/metrics.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Failed to load Divigent metrics");

    const metrics = await response.json();

    document.querySelector('[data-metric="walletsUsingDivigent"]').textContent =
      integer.format(metrics.walletsUsingDivigent);

    document.querySelector('[data-metric="currentTvlUsdc"]').textContent =
      "$" + usdc.format(Number(metrics.currentTvlUsdc));

    document.querySelector('[data-metric="cumulativeDepositedUsdc"]').textContent =
      "$" + usdc.format(Number(metrics.cumulativeDepositedUsdc));

    document.querySelector('[data-metric="recallProxyTransactions"]').textContent =
      integer.format(metrics.recallProxyTransactions);

    document.querySelector('[data-metric="totalTreasuryOperations"]').textContent =
      integer.format(metrics.totalTreasuryOperations);
  }

  loadDivigentMetrics().catch(() => {
    document.querySelectorAll("[data-metric]").forEach((node) => {
      node.textContent = "--";
    });
  });
</script>
```

## Copy Recommendations

Use conservative public labels:

```text
Wallets using Divigent
USDC currently deployed
Cumulative USDC deposited
Divigent recall transactions
Treasury operations processed
```

Avoid saying:

```text
x402 payments settled through Divigent
```

until we add explicit SDK/backend telemetry correlation. On-chain router events
prove Divigent withdrawals/recalls, but they do not prove the recalled USDC was
later used for x402 settlement.

For now, `recallProxyTransactions` is the honest public metric.
For total transaction traction, use `totalTreasuryOperations`. It is cleaner
than `totalDivigentTransactions` for investor-facing copy because it excludes
wallet authorization and focuses on capital movement: deposits and exits.

## Option B: API Endpoint

If Divigent has a backend or edge function, expose:

```text
GET /api/divigent-metrics
```

The endpoint should:

- Run server-side only.
- Read `BASE_MAINNET_RPC_URL` from Divigent server environment.
- Call `divigent.getProtocolMetrics()`.
- Cache the response for 30 seconds to 5 minutes.
- Return the same JSON payload shown above.

Do not call the SDK on every page load without caching. The metric function scans
router logs and live accounting reads, so it is not intended to be hot-path
frontend code.

With this option, the website only needs:

```html
fetch("https://api.divigent.ai/api/divigent-metrics")
```

or whatever public endpoint Divigent chooses. Eduard does not need an RPC env var
in the website deployment.

## Environment Variables

Required on the Divigent server or scheduled job:

```bash
BASE_MAINNET_RPC_URL=...
```

Optional fallback:

```bash
BASE_RPC_URL=...
```

Never expose either value in browser-side JavaScript. If Divigent hosts the
metrics endpoint, the website deployment does not need these env vars at all.

## Validation Checklist

- `@divigent/sdk@1.0.5` is installed.
- The generator script runs successfully with premium RPC.
- The JSON includes `totalTreasuryOperations`.
- `metrics.json` is generated without secrets.
- Website loads metrics from JSON, not directly from RPC.
- Website gracefully shows placeholders if metrics are unavailable.
- Public copy says `recall transactions` or `recall proxy`, not exact x402 settled count.
