import { vi } from 'vitest';
import type { Hex, PublicClient, WalletClient } from 'viem';
import { baseSepolia } from 'viem/chains';
import { Divigent, type DivigentConfig } from '../../src/divigent';
import { type ContractAddresses } from '../../src/core/chains';
import { parseUsdc } from '../../src/core/utils';
import { evmAddress, type EvmAddress, type TxHash, txHash } from '../../src/types';

export const OWNER = evmAddress('0x1111111111111111111111111111111111111111');
export const SECOND_OWNER = evmAddress('0x2222222222222222222222222222222222222222');
export const OPERATOR = evmAddress('0x3333333333333333333333333333333333333333');
export const SELLER = evmAddress('0x4444444444444444444444444444444444444444');

export const USDC = 10n ** 6n;
export const usdc = (amount: string): bigint => parseUsdc(amount);

export const HASH_1 = txHash(
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
);
export const HASH_2 = txHash(
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
);
export const HASH_3 = txHash(
  '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
);

export const addresses: ContractAddresses = {
  router: evmAddress('0x1000000000000000000000000000000000000001'),
  oracle: evmAddress('0x1000000000000000000000000000000000000002'),
  feeCollector: evmAddress('0x1000000000000000000000000000000000000003'),
  dvUsdc: evmAddress('0x1000000000000000000000000000000000000004'),
  usdc: evmAddress('0x1000000000000000000000000000000000000005'),
  aavePool: evmAddress('0x1000000000000000000000000000000000000006'),
  aToken: evmAddress('0x1000000000000000000000000000000000000007'),
  steakhouseUSDCPrimeVault: evmAddress('0x1000000000000000000000000000000000000008'),
};

export type MockClientOptions = {
  account?: EvmAddress | undefined;
  includeWalletAccount?: boolean | undefined;
  includeWalletChain?: boolean | undefined;
  publicChainId?: number | undefined;
  walletChainId?: number | undefined;
  previewDeposit?: bigint | undefined;
  previewRedeem?: bigint | undefined;
  previewWithdrawNet?: bigint | undefined;
  allowance?: bigint | undefined;
  usdcBalance?: bigint | undefined;
  dvUsdcBalance?: bigint | undefined;
  simulatedApproveResult?: boolean | undefined;
  simulatedDepositResult?: bigint | undefined;
  simulatedWithdrawResult?: bigint | undefined;
  blockTimestamp?: bigint | undefined;
  getCode?: Hex | undefined;
  readContract?: ((request: Record<string, unknown>) => unknown | Promise<unknown>) | undefined;
  simulateContract?: ((request: Record<string, unknown>) => unknown | Promise<unknown>) | undefined;
  signTypedData?: ((request: Record<string, unknown>) => Hex | Promise<Hex>) | undefined;
  writeHashes?: readonly TxHash[] | undefined;
};

export type MockClients = {
  publicClient: PublicClient;
  walletClient: WalletClient;
  readContract: ReturnType<typeof vi.fn>;
  simulateContract: ReturnType<typeof vi.fn>;
  writeContract: ReturnType<typeof vi.fn>;
  signTypedData: ReturnType<typeof vi.fn>;
  getCode: ReturnType<typeof vi.fn>;
  getBlock: ReturnType<typeof vi.fn>;
  waitForTransactionReceipt: ReturnType<typeof vi.fn>;
};

export function createMockClients(opts: MockClientOptions = {}): MockClients {
  const account = opts.account ?? OWNER;
  const writeHashes = [...(opts.writeHashes ?? [HASH_1, HASH_2, HASH_3])];

  const readContract = vi.fn(async (request: Record<string, unknown>) => {
    if (opts.readContract) return opts.readContract(request);

    const functionName = request.functionName;
    if (functionName === 'previewDeposit') return opts.previewDeposit ?? 1_000_000n;
    if (functionName === 'previewRedeem') return opts.previewRedeem ?? usdc('2');
    if (functionName === 'previewWithdrawNet') return opts.previewWithdrawNet ?? 500_000n;
    if (functionName === 'allowance') return opts.allowance ?? 0n;
    if (functionName === 'balanceOf') {
      const reqAddress = String(request.address).toLowerCase();
      if (reqAddress === addresses.dvUsdc.toLowerCase()) return opts.dvUsdcBalance ?? 0n;
      return opts.usdcBalance ?? 0n;
    }
    if (functionName === 'name') return 'USD Coin';
    if (functionName === 'version') return '2';
    if (functionName === 'nonces') return 7n;
    if (functionName === 'USDC') return addresses.usdc;
    if (functionName === 'DV_USDC') return addresses.dvUsdc;
    if (functionName === 'FEE_COLLECTOR') return addresses.feeCollector;
    if (functionName === 'ORACLE') return addresses.oracle;
    if (functionName === 'VAULT_ROUTER') return addresses.router;
    throw new Error(`Unhandled readContract function ${String(functionName)}`);
  });

  const simulateContract = vi.fn(async (request: Record<string, unknown>) => {
    if (opts.simulateContract) return opts.simulateContract(request);

    const functionName = request.functionName;
    if (functionName === 'approve') {
      return { request: { ...request, gas: 111n }, result: opts.simulatedApproveResult ?? true };
    }
    if (functionName === 'deposit' || functionName === 'depositWithPermit') {
      return { request: { ...request, gas: 222n }, result: opts.simulatedDepositResult ?? 900_000n };
    }
    if (functionName === 'withdraw') {
      return { request: { ...request, gas: 333n }, result: opts.simulatedWithdrawResult ?? usdc('1.9') };
    }
    if (functionName === 'setOperator') {
      return { request: { ...request, gas: 444n }, result: undefined };
    }
    throw new Error(`Unhandled simulateContract function ${String(functionName)}`);
  });

  const writeContract = vi.fn(async () => {
    const next = writeHashes.shift();
    return next ?? HASH_1;
  });

  const signTypedData = vi.fn(async (request: Record<string, unknown>) => {
    if (opts.signTypedData) return opts.signTypedData(request);
    return lowSSignature();
  });

  const getCode = vi.fn(async () => opts.getCode ?? '0x');
  const getBlock = vi.fn(async () => ({ timestamp: opts.blockTimestamp ?? 1_000n }));
  const waitForTransactionReceipt = vi.fn(async ({ hash }: { hash: TxHash }) => ({
    transactionHash: hash,
    logs: [],
  }));

  const publicClient = {
    chain: opts.publicChainId === undefined
      ? baseSepolia
      : { ...baseSepolia, id: opts.publicChainId },
    readContract,
    simulateContract,
    getCode,
    getBlock,
    waitForTransactionReceipt,
  } as unknown as PublicClient;

  const wallet: Record<string, unknown> = {
    writeContract,
    signTypedData,
  };
  if (opts.includeWalletAccount !== false) {
    wallet.account = { address: account, type: 'json-rpc' };
  }
  if (opts.includeWalletChain !== false) {
    wallet.chain = opts.walletChainId === undefined
      ? baseSepolia
      : { ...baseSepolia, id: opts.walletChainId };
  }

  return {
    publicClient,
    walletClient: wallet as unknown as WalletClient,
    readContract,
    simulateContract,
    writeContract,
    signTypedData,
    getCode,
    getBlock,
    waitForTransactionReceipt,
  };
}

export function createDivigent(opts: MockClientOptions = {}): Divigent {
  const { publicClient, walletClient } = createMockClients(opts);
  return Divigent.create({
    publicClient,
    walletClient,
    chain: 'base-sepolia',
    addresses,
  });
}

export function createDivigentWithClients(
  opts: MockClientOptions = {},
): { divigent: Divigent } & MockClients {
  const clients = createMockClients(opts);
  const config: DivigentConfig = {
    publicClient: clients.publicClient,
    walletClient: clients.walletClient,
    chain: 'base-sepolia',
    addresses,
  };
  return { divigent: Divigent.create(config), ...clients };
}

export function lowSSignature(v: number = 27): Hex {
  return signatureWithParts(1n, 2n, v);
}

export function highSSignature(v: number = 27): Hex {
  const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  return signatureWithParts(1n, n - 1n, v);
}

export function signatureWithParts(r: bigint, s: bigint, v: number): Hex {
  return `0x${r.toString(16).padStart(64, '0')}${s
    .toString(16)
    .padStart(64, '0')}${v.toString(16).padStart(2, '0')}` as Hex;
}

export function createX402Client() {
  type Hook = (ctx: unknown) => Promise<void> | void;
  const hooks: {
    before?: Hook;
    after?: Hook;
    failure?: Hook;
  } = {};

  const client = {
    onBeforePaymentCreation: vi.fn((hook: Hook) => {
      hooks.before = hook;
      return client;
    }),
    onAfterPaymentCreation: vi.fn((hook: Hook) => {
      hooks.after = hook;
      return client;
    }),
    onPaymentCreationFailure: vi.fn((hook: Hook) => {
      hooks.failure = hook;
      return client;
    }),
  };

  return { client, hooks };
}

export function x402PaymentContext(opts: {
  amount?: bigint | undefined;
  network?: string | undefined;
  asset?: string | undefined;
  scheme?: string | undefined;
  payTo?: string | undefined;
  resource?: string | undefined;
  paymentRequired?: Record<string, unknown> | undefined;
  error?: unknown;
} = {}) {
  const resource = opts.resource ?? 'https://api.example.com/paid';
  const paymentRequired = opts.paymentRequired ?? {
    x402Version: 2,
    resource: { url: resource },
  };
  return {
    paymentRequired,
    selectedRequirements: {
      amount: String(opts.amount ?? usdc('0.01')),
      network: opts.network ?? `eip155:${baseSepolia.id}`,
      asset: opts.asset ?? addresses.usdc,
      scheme: opts.scheme ?? 'exact',
      payTo: opts.payTo ?? SELLER,
      resource,
    },
    error: opts.error ?? new Error('payment failed'),
  };
}
