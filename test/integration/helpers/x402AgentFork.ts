import { expect } from 'vitest';
import {
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { routerAbi, usdcAbi } from '../../../src/abis';
import { parseUsdc } from '../../../src/core/utils';
import { Divigent } from '../../../src/divigent';
import { ContractRevertError } from '../../../src/errors';
import type { EvmAddress } from '../../../src/types';

// Local-only x402 agent keys. test/fork/setup.ts refuses non-127.0.0.1 RPCs
// before any local fixture key can be used.
export const X402_AGENT_READ_PRIVATE_KEY =
  '0x2222222222222222222222222222222222222222222222222222222222222222';
export const X402_AGENT_DEPOSIT_PRIVATE_KEY =
  '0x3333333333333333333333333333333333333333333333333333333333333333';
export const X402_AGENT_WITHDRAW_PRIVATE_KEY =
  '0x4444444444444444444444444444444444444444444444444444444444444444';
export const X402_AGENT_FULL_EXIT_PRIVATE_KEY =
  '0x5555555555555555555555555555555555555555555555555555555555555555';
export const X402_AGENT_PLAN_PRIVATE_KEY =
  '0x6666666666666666666666666666666666666666666666666666666666666666';
export const X402_AGENT_PERMIT_PRIVATE_KEY =
  '0xfeed000000000000000000000000000000000000000000000000000000000001';
export const X402_AGENT_RECALL_PRIVATE_KEY =
  '0x7777777777777777777777777777777777777777777777777777777777777777';
export const X402_AGENT_POLICY_PRIVATE_KEY =
  '0x8888888888888888888888888888888888888888888888888888888888888888';
export const X402_AGENT_GUARD_PRIVATE_KEY =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const X402_AGENT_OWNER_PRIVATE_KEY =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
export const X402_PAYMENT_OPERATOR_PRIVATE_KEY =
  '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
export const X402_AGENT_INITIALIZE_OWNER_PRIVATE_KEY =
  '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
export const X402_AGENT_INITIALIZE_RELAYER_PRIVATE_KEY =
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

export const X402_SELLER = '0xC15b6392FFa1964012dC8F3dF87B09258E86c60D' as const;
export const X402_SAFE_RESOURCE = 'https://merchant.divigent.test/paid/quote';
export const X402_TEST_ETH_BALANCE = '0x56BC75E2D63100000'; // 100 ETH

export type X402Agent = {
  sdk: Divigent;
  wallet: EvmAddress;
};

type X402Hook = (ctx: unknown) => Promise<void> | void;

export async function rpcRequest<T>(
  rpcUrl: string,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const payload = await response.json() as { result?: T; error?: { message?: string } };
  if (payload.error) {
    throw new Error(payload.error.message ?? JSON.stringify(payload.error));
  }
  return payload.result as T;
}

export async function withSnapshot(rpcUrl: string, fn: () => Promise<void>): Promise<void> {
  const snapshotId = await rpcRequest<Hex>(rpcUrl, 'evm_snapshot');
  try {
    await fn();
  } finally {
    await rpcRequest<boolean>(rpcUrl, 'evm_revert', [snapshotId]);
  }
}

export async function fundX402Agent(params: {
  rpcUrl: string;
  publicClient: PublicClient;
  usdc: EvmAddress;
  donor: EvmAddress;
  agentWallet: EvmAddress;
  amount: bigint;
}): Promise<void> {
  const { rpcUrl, publicClient, usdc, donor, agentWallet, amount } = params;
  await rpcRequest(rpcUrl, 'anvil_setBalance', [agentWallet, X402_TEST_ETH_BALANCE]);
  await rpcRequest(rpcUrl, 'anvil_setBalance', [donor, X402_TEST_ETH_BALANCE]);
  await rpcRequest(rpcUrl, 'anvil_impersonateAccount', [donor]);

  try {
    const donorClient = createWalletClient({
      account: donor as Address,
      chain: base,
      transport: http(rpcUrl),
    });
    const hash = await donorClient.writeContract({
      address: usdc,
      abi: usdcAbi,
      functionName: 'transfer',
      args: [agentWallet, amount],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
  } finally {
    await rpcRequest(rpcUrl, 'anvil_stopImpersonatingAccount', [donor]);
  }
}

export function createX402AgentForPrivateKey(params: {
  privateKey: Hex;
  rpcUrl: string;
  publicClient: PublicClient;
  addresses: Divigent['addresses'];
}): X402Agent {
  const account = privateKeyToAccount(params.privateKey);
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(params.rpcUrl),
  });
  const sdk = Divigent.create({
    publicClient: params.publicClient as unknown as PublicClient,
    walletClient: walletClient as unknown as WalletClient,
    chain: 'base',
    addresses: params.addresses,
  });
  return { sdk, wallet: account.address as EvmAddress };
}

export async function prepareX402Agent(params: {
  agent: X402Agent;
  rpcUrl: string;
  publicClient: PublicClient;
  fundingAmount?: bigint;
  initialize?: boolean;
}): Promise<void> {
  await fundX402Agent({
    rpcUrl: params.rpcUrl,
    publicClient: params.publicClient,
    usdc: params.agent.sdk.addresses.usdc,
    donor: params.agent.sdk.addresses.aToken,
    agentWallet: params.agent.wallet,
    amount: params.fundingAmount ?? parseUsdc('25'),
  });

  if (params.initialize === true) {
    const initializeHash = await params.agent.sdk.initialize();
    const initializeReceipt = await params.publicClient.waitForTransactionReceipt({
      hash: initializeHash,
    });
    expect(initializeReceipt.status).toBe('success');
    await expect(params.agent.sdk.isAuthorized(params.agent.wallet)).resolves.toBe(true);
  }
}

export async function approveAndDepositIdleUsdc(
  agent: X402Agent,
  publicClient: PublicClient,
  amount: bigint,
): Promise<{ txHash: Hex; sharesMinted: bigint }> {
  const approveHash = await agent.sdk.approveUsdc(amount);
  const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
  expect(approveReceipt.status).toBe('success');

  const depositResult = await agent.sdk.depositAndWait({ amount, slippageBps: 25 });
  expect(depositResult.sharesMinted).toBeGreaterThan(0n);
  return depositResult;
}

export function expectDepositedEvent(
  receipt: TransactionReceipt,
  expected: {
    wallet: EvmAddress;
    usdcAmount: bigint;
    sharesMinted?: bigint | undefined;
  },
): void {
  const [event] = parseEventLogs({
    abi: routerAbi,
    logs: receipt.logs,
    eventName: 'Deposited',
  });
  expect(event).toBeDefined();
  expect(event?.args.wallet).toBe(expected.wallet);
  expect(event?.args.usdcAmount).toBe(expected.usdcAmount);
  if (expected.sharesMinted !== undefined) {
    expect(event?.args.dvUsdcMinted).toBe(expected.sharesMinted);
  }
  expect([0, 1]).toContain(event?.args.vaultType);
}

export function expectWithdrawnEvent(
  receipt: TransactionReceipt,
  expected: {
    wallet: EvmAddress;
    sharesBurned: bigint;
    usdcReturned?: bigint | undefined;
  },
): void {
  const [event] = parseEventLogs({
    abi: routerAbi,
    logs: receipt.logs,
    eventName: 'Withdrawn',
  });
  expect(event).toBeDefined();
  expect(event?.args.wallet).toBe(expected.wallet);
  expect(event?.args.dvUsdcBurned).toBe(expected.sharesBurned);
  if (expected.usdcReturned !== undefined) {
    expect(event?.args.usdcReturned).toBe(expected.usdcReturned);
  }
  expect(event?.args.yieldEarned).toBeGreaterThanOrEqual(0n);
  expect(event?.args.feePaid).toBeGreaterThanOrEqual(0n);
}

export async function expectContractRevert(
  promise: Promise<unknown>,
  errorName: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ContractRevertError);
    expect(error).toMatchObject({ errorName });
    return;
  }
  throw new Error(`Expected Divigent contract revert ${errorName}`);
}

export function createLocalX402Client() {
  const hooks: {
    before?: X402Hook;
    after?: X402Hook;
    failure?: X402Hook;
  } = {};

  const client = {
    onBeforePaymentCreation(hook: X402Hook) {
      hooks.before = hook;
      return client;
    },
    onAfterPaymentCreation(hook: X402Hook) {
      hooks.after = hook;
      return client;
    },
    onPaymentCreationFailure(hook: X402Hook) {
      hooks.failure = hook;
      return client;
    },
  };

  return { client, hooks };
}

export function x402AgentPaymentContext(params: {
  sdk: Divigent;
  amount: bigint;
  network?: string | undefined;
  asset?: string | undefined;
  scheme?: string | undefined;
  payTo?: string | undefined;
  resource?: string | undefined;
  error?: unknown;
}) {
  const resource = params.resource ?? X402_SAFE_RESOURCE;
  return {
    paymentRequired: {
      x402Version: 2,
      resource: { url: resource },
    },
    selectedRequirements: {
      amount: String(params.amount),
      network: params.network ?? `eip155:${base.id}`,
      asset: params.asset ?? params.sdk.addresses.usdc,
      scheme: params.scheme ?? 'exact',
      payTo: params.payTo ?? X402_SELLER,
      resource,
    },
    error: params.error ?? new Error('x402 payment creation failed'),
  };
}
