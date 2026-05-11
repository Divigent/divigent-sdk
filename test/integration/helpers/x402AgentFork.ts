import { expect } from 'vitest';
import {
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { base } from 'viem/chains';
import { routerAbi, usdcAbi } from '../../../src/abis';
import { parseDepositReceipt, parseWithdrawReceipt } from '../../../src/core/receipts';
import { applyFee } from '../../../src/core/utils';
import { parseUsdc } from '../../../src/core/utils';
import { Divigent, type DepositPlan, type WithdrawPlan } from '../../../src/divigent';
import { ContractRevertError } from '../../../src/errors';
import type { EvmAddress, VaultType } from '../../../src/types';
import {
  createForkSdkForPrivateKey,
  rpcRequest,
  withForkSnapshot,
} from '../../fork/setup';

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

export type AgentBalances = {
  liquidUsdc: bigint;
  dvUsdc: bigint;
};

type X402Hook = (ctx: unknown) => Promise<void> | void;

export type PreparedAgentParams = {
  privateKey: Hex;
  rpcUrl: string;
  publicClient: PublicClient;
  addresses: Divigent['addresses'];
  fundingAmount?: bigint | undefined;
  initialize?: boolean | undefined;
};

export async function sendAndExpectSuccess(
  publicClient: PublicClient,
  tx: Hex | Promise<Hex>,
): Promise<TransactionReceipt> {
  const hash = await tx;
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe('success');
  return receipt;
}

export function fundWalletEth(rpcUrl: string, wallet: EvmAddress): Promise<unknown> {
  return rpcRequest(rpcUrl, 'anvil_setBalance', [wallet, X402_TEST_ETH_BALANCE]);
}

export async function readAgentBalances(
  agent: X402Agent,
  wallet: EvmAddress = agent.wallet,
): Promise<AgentBalances> {
  const [liquidUsdc, dvUsdc] = await Promise.all([
    agent.sdk.usdcBalance(wallet),
    agent.sdk.dvUsdcBalance(wallet),
  ]);
  return { liquidUsdc, dvUsdc };
}

export async function expectAgentBalances(
  agent: X402Agent,
  expected: Partial<AgentBalances>,
  wallet: EvmAddress = agent.wallet,
): Promise<void> {
  const balances = await readAgentBalances(agent, wallet);
  if (expected.liquidUsdc !== undefined) {
    expect(balances.liquidUsdc).toBe(expected.liquidUsdc);
  }
  if (expected.dvUsdc !== undefined) {
    expect(balances.dvUsdc).toBe(expected.dvUsdc);
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
  await fundWalletEth(rpcUrl, agentWallet);
  await fundWalletEth(rpcUrl, donor);
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
    await sendAndExpectSuccess(publicClient, hash);
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
  const { sdk, wallet } = createForkSdkForPrivateKey({
    privateKey: params.privateKey,
    rpcUrl: params.rpcUrl,
    publicClient: params.publicClient,
    addresses: params.addresses,
    chain: base,
    divigentChain: 'base',
  });
  return { sdk, wallet };
}

export async function initializeAndExpectAuthorized(
  agent: X402Agent,
  publicClient: PublicClient,
): Promise<void> {
  await sendAndExpectSuccess(publicClient, agent.sdk.initialize());
  await expect(agent.sdk.isAuthorized(agent.wallet)).resolves.toBe(true);
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
    await initializeAndExpectAuthorized(params.agent, params.publicClient);
  }
}

export async function createPreparedAgent(params: PreparedAgentParams): Promise<X402Agent> {
  const agent = createX402AgentForPrivateKey({
    privateKey: params.privateKey,
    rpcUrl: params.rpcUrl,
    publicClient: params.publicClient,
    addresses: params.addresses,
  });
  await prepareX402Agent({
    agent,
    rpcUrl: params.rpcUrl,
    publicClient: params.publicClient,
    ...(params.fundingAmount === undefined ? {} : { fundingAmount: params.fundingAmount }),
    ...(params.initialize === undefined ? {} : { initialize: params.initialize }),
  });
  return agent;
}

export function createInitializedAgent(
  params: Omit<PreparedAgentParams, 'initialize'>,
): Promise<X402Agent> {
  return createPreparedAgent({ ...params, initialize: true });
}

export async function withPreparedAgent(
  params: PreparedAgentParams,
  fn: (agent: X402Agent) => Promise<void>,
): Promise<void> {
  await withForkSnapshot(params.rpcUrl, async () => {
    const agent = await createPreparedAgent(params);
    await fn(agent);
  });
}

export function approveUsdcAndWait(
  agent: X402Agent,
  publicClient: PublicClient,
  amount: bigint,
): Promise<TransactionReceipt> {
  return sendAndExpectSuccess(publicClient, agent.sdk.approveUsdc(amount));
}

export type DepositAssertionResult = {
  txHash: Hex;
  sharesMinted: bigint;
  receipt: TransactionReceipt;
  event: DepositedEventArgs;
};

export type WithdrawAssertionResult = {
  txHash: Hex;
  usdcReturned: bigint;
  receipt: TransactionReceipt;
  event: WithdrawnEventArgs;
};

type SlippageOptions = {
  slippageBps?: number | undefined;
};

type DepositOptions = SlippageOptions & {
  vaultType?: VaultType | 0 | 1 | undefined;
};

type WithdrawOptions = SlippageOptions & {
  wallet?: EvmAddress | undefined;
};

export async function depositAndAssert(
  agent: X402Agent,
  publicClient: PublicClient,
  amount: bigint,
  options: DepositOptions = {},
): Promise<DepositAssertionResult> {
  const deposit = await agent.sdk.depositAndWait({
    amount,
    slippageBps: options.slippageBps ?? 25,
  });
  const receipt = await publicClient.getTransactionReceipt({ hash: deposit.txHash });
  const event = expectDepositedEvent(receipt, {
    wallet: agent.wallet,
    usdcAmount: amount,
    sharesMinted: deposit.sharesMinted,
    ...(options.vaultType === undefined ? {} : { vaultType: options.vaultType }),
  });
  expect(deposit.sharesMinted).toBeGreaterThan(0n);
  return { ...deposit, receipt, event };
}

export async function approveAndDepositAndAssert(
  agent: X402Agent,
  publicClient: PublicClient,
  amount: bigint,
  options: DepositOptions = {},
): Promise<DepositAssertionResult> {
  await approveUsdcAndWait(agent, publicClient, amount);
  return depositAndAssert(agent, publicClient, amount, options);
}

export async function depositWithPermitAndAssert(
  agent: X402Agent,
  publicClient: PublicClient,
  params: {
    amount: bigint;
    deadline: bigint;
    slippageBps?: number | undefined;
  },
): Promise<DepositAssertionResult> {
  const deposit = await agent.sdk.depositWithPermitAndWait({
    amount: params.amount,
    deadline: params.deadline,
    slippageBps: params.slippageBps ?? 25,
  });
  const receipt = await publicClient.getTransactionReceipt({ hash: deposit.txHash });
  const event = expectDepositedEvent(receipt, {
    wallet: agent.wallet,
    usdcAmount: params.amount,
    sharesMinted: deposit.sharesMinted,
  });
  expect(deposit.sharesMinted).toBeGreaterThan(0n);
  return { ...deposit, receipt, event };
}

export async function sendDepositPlanAndAssert(
  agent: X402Agent,
  publicClient: PublicClient,
  plan: DepositPlan,
): Promise<DepositAssertionResult> {
  const hash = await agent.sdk.sendPlan(plan);
  const receipt = await sendAndExpectSuccess(publicClient, hash);
  const deposit = parseDepositReceipt(receipt);
  const event = expectDepositedEvent(receipt, {
    wallet: agent.wallet,
    usdcAmount: plan.amount,
    sharesMinted: deposit.sharesMinted,
  });
  expect(deposit.txHash).toBe(hash);
  expect(deposit.sharesMinted).toBeGreaterThanOrEqual(plan.minSharesOut);
  return { ...deposit, receipt, event };
}

export function seedDeposit(
  agent: X402Agent,
  publicClient: PublicClient,
  amount: bigint,
  options: DepositOptions = {},
): Promise<DepositAssertionResult> {
  return approveAndDepositAndAssert(agent, publicClient, amount, options);
}

export function approveAndDepositIdleUsdc(
  agent: X402Agent,
  publicClient: PublicClient,
  amount: bigint,
): Promise<DepositAssertionResult> {
  return seedDeposit(agent, publicClient, amount);
}

export async function withdrawAndAssert(
  agent: X402Agent,
  publicClient: PublicClient,
  shares: bigint,
  options: WithdrawOptions = {},
): Promise<WithdrawAssertionResult> {
  const wallet = options.wallet ?? agent.wallet;
  const withdraw = await agent.sdk.withdrawAndWait({
    shares,
    wallet,
    slippageBps: options.slippageBps ?? 25,
  });
  const receipt = await publicClient.getTransactionReceipt({ hash: withdraw.txHash });
  const event = expectWithdrawnEvent(receipt, {
    wallet,
    sharesBurned: shares,
    usdcReturned: withdraw.usdcReturned,
  });
  expect(event.feePaid).toBe(applyFee(event.yieldEarned));
  return { ...withdraw, receipt, event };
}

export async function sendWithdrawPlanAndAssert(
  agent: X402Agent,
  publicClient: PublicClient,
  plan: WithdrawPlan,
): Promise<WithdrawAssertionResult> {
  const hash = await agent.sdk.sendPlan(plan);
  const receipt = await sendAndExpectSuccess(publicClient, hash);
  const withdraw = parseWithdrawReceipt(receipt);
  const event = expectWithdrawnEvent(receipt, {
    wallet: agent.wallet,
    sharesBurned: plan.shares,
    usdcReturned: withdraw.usdcReturned,
  });
  expect(withdraw.txHash).toBe(hash);
  expect(withdraw.usdcReturned).toBeGreaterThanOrEqual(plan.minUsdcOut);
  expect(event.feePaid).toBe(applyFee(event.yieldEarned));
  return { ...withdraw, receipt, event };
}

export async function expectDepositApplied(
  agent: X402Agent,
  expected: {
    amount: bigint;
    sharesMinted: bigint;
    liquidUsdc?: bigint | undefined;
    allowance?: bigint | undefined;
  },
): Promise<void> {
  await expectAgentBalances(agent, {
    ...(expected.liquidUsdc === undefined ? {} : { liquidUsdc: expected.liquidUsdc }),
    dvUsdc: expected.sharesMinted,
  });
  if (expected.allowance !== undefined) {
    await expect(agent.sdk.usdcAllowance(agent.wallet)).resolves.toBe(expected.allowance);
  }
  const position = await agent.sdk.getPosition(agent.wallet);
  expect(position.depositedUSDC).toBe(expected.amount);
  expect(position.currentValue).toBeGreaterThan(0n);
  await expect(agent.sdk.costBasis(agent.wallet)).resolves.toBe(expected.amount);
  await expect(agent.sdk.convertToAssets(expected.sharesMinted)).resolves.toBeGreaterThan(0n);
}

export async function expectPartialWithdrawApplied(
  agent: X402Agent,
  expected: {
    liquidBeforeWithdraw: bigint;
    sharesBeforeWithdraw: bigint;
    sharesBurned: bigint;
    usdcReturned: bigint;
    remainingCostBasis: bigint;
  },
): Promise<void> {
  await expectAgentBalances(agent, {
    liquidUsdc: expected.liquidBeforeWithdraw + expected.usdcReturned,
    dvUsdc: expected.sharesBeforeWithdraw - expected.sharesBurned,
  });
  await expect(agent.sdk.costBasis(agent.wallet)).resolves.toBe(expected.remainingCostBasis);
  const remainingPosition = await agent.sdk.getPosition(agent.wallet);
  expect(remainingPosition.depositedUSDC).toBe(expected.remainingCostBasis);
  expect(remainingPosition.currentValue).toBeGreaterThan(0n);
}

export async function expectFullExit(agent: X402Agent): Promise<void> {
  await expect(agent.sdk.dvUsdcBalance(agent.wallet)).resolves.toBe(0n);
  await expect(agent.sdk.costBasis(agent.wallet)).resolves.toBe(0n);
  const position = await agent.sdk.getPosition(agent.wallet);
  expect(position.depositedUSDC).toBe(0n);
  expect(position.currentValue).toBe(0n);
}

export function vaultTypeId(vaultType: VaultType): 0 | 1 {
  return vaultType === 'AAVE' ? 0 : 1;
}

export type DepositedEventArgs = {
  wallet: EvmAddress;
  usdcAmount: bigint;
  dvUsdcMinted: bigint;
  vaultType: 0 | 1;
};

export type WithdrawnEventArgs = {
  wallet: EvmAddress;
  dvUsdcBurned: bigint;
  usdcReturned: bigint;
  yieldEarned: bigint;
  feePaid: bigint;
};

export function expectDepositedEvent(
  receipt: TransactionReceipt,
  expected: {
    wallet: EvmAddress;
    usdcAmount: bigint;
    sharesMinted?: bigint | undefined;
    vaultType?: VaultType | 0 | 1 | undefined;
  },
): DepositedEventArgs {
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
  if (expected.vaultType !== undefined) {
    const expectedVaultType = typeof expected.vaultType === 'string'
      ? vaultTypeId(expected.vaultType)
      : expected.vaultType;
    expect(event?.args.vaultType).toBe(expectedVaultType);
  }
  return {
    wallet: event?.args.wallet as EvmAddress,
    usdcAmount: event?.args.usdcAmount ?? 0n,
    dvUsdcMinted: event?.args.dvUsdcMinted ?? 0n,
    vaultType: event?.args.vaultType as 0 | 1,
  };
}

export function expectWithdrawnEvent(
  receipt: TransactionReceipt,
  expected: {
    wallet: EvmAddress;
    sharesBurned: bigint;
    usdcReturned?: bigint | undefined;
  },
): WithdrawnEventArgs {
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
  return {
    wallet: event?.args.wallet as EvmAddress,
    dvUsdcBurned: event?.args.dvUsdcBurned ?? 0n,
    usdcReturned: event?.args.usdcReturned ?? 0n,
    yieldEarned: event?.args.yieldEarned ?? 0n,
    feePaid: event?.args.feePaid ?? 0n,
  };
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
