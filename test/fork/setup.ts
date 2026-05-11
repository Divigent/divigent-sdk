import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test as baseTest } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  getContractAddress,
  http,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { oracleAbi, routerAbi } from '../../src/abis';
import { Divigent } from '../../src/divigent';
import { getAddresses, type ContractAddresses, type DivigentChain } from '../../src/core/chains';
import { evmAddress, type EvmAddress } from '../../src/types';

// Foundry/Anvil's public deterministic dev key. This must only ever be used
// against a local fork RPC; never fund it or use it on a live network.
const ANVIL_DEFAULT_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const DEFAULT_BASE_FORK_BLOCK_NUMBER = 45_734_171n;
const FORK_DEPLOY_GAS_LIMIT = 8_000_000n;
const FORK_TREASURY = evmAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
const FORK_EMERGENCY_MULTISIG = evmAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');

export const BASE_FORK_POLICY = {
  blockNumber: DEFAULT_BASE_FORK_BLOCK_NUMBER,
  reason: 'Pinned with live Base venue state for deterministic fork tests.',
} as const;

export const REAL_BASE_FORK_DEPENDENCIES = {
  chainId: base.id,
  usdc:       evmAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
  aavePool:   evmAddress('0xA238Dd80C259a72e81d7e4664a9801593F98d1c5'),
  aaveAToken: evmAddress('0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB'),
  morphoVault: evmAddress('0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183'),
} as const;

export const BASE_LOCAL_FORK_PROTOCOL_ADDRESSES = {
  router:       evmAddress('0x1e79FAc6B154B49101252C447E0e68a0a20fc3c0'),
  oracle:       evmAddress('0x05fa1e1EE3249C26db881930F0bF2cb1fe05da98'),
  feeCollector: evmAddress('0x1157c1D6027A5f4Cd62682A7F0d1da426A4b65E3'),
  dvUsdc:       evmAddress('0x5D343ee475E8960229136e03ebe1153D8605aD56'),
} as const;

type ForkArgs = {
  rpcUrl?: string | undefined;
  forkUrl?: string | undefined;
  forkBlockNumber?: number | bigint | undefined;
  forkChainId?: number | undefined;
  stepsTracing?: boolean | undefined;
  blockBaseFeePerGas?: number | bigint | undefined;
  gasPrice?: number | bigint | undefined;
  port?: number | undefined;
};

type ForkContext = {
  rpcUrl: `http://127.0.0.1:${number}`;
  account: PrivateKeyAccount;
  publicClient: PublicClient;
  walletClient: WalletClient;
  divigent: Divigent;
};

type ProtocolAddresses = Pick<ContractAddresses, 'router' | 'oracle' | 'feeCollector' | 'dvUsdc'>;

type ForkSdkForPrivateKeyParams = {
  privateKey: Hex;
  rpcUrl: string;
  publicClient: PublicClient;
  addresses: ContractAddresses;
  chain?: Chain | undefined;
  divigentChain?: DivigentChain | undefined;
};

type ForkSdkForPrivateKey = {
  account: PrivateKeyAccount;
  wallet: EvmAddress;
  walletClient: WalletClient;
  sdk: Divigent;
};

type ForgeArtifact = {
  abi: Abi;
  bytecode: {
    object?: string;
  };
};

const baseDependencies = getAddresses('base');
const defaultBaseForkProtocolAddresses = BASE_LOCAL_FORK_PROTOCOL_ADDRESSES;

const morphoVaultAssetAbi = [
  {
    type: 'function',
    name: 'asset',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

function maybeAddress(value: string | undefined) {
  return value === undefined || value.length === 0 ? undefined : evmAddress(value);
}

function baseMainnetForkAddressesFromEnv(): ContractAddresses {
  return {
    ...baseDependencies,
    router:       maybeAddress(process.env.DIVIGENT_BASE_ROUTER) ?? defaultBaseForkProtocolAddresses.router,
    oracle:       maybeAddress(process.env.DIVIGENT_BASE_ORACLE) ?? defaultBaseForkProtocolAddresses.oracle,
    feeCollector: maybeAddress(process.env.DIVIGENT_BASE_FEE_COLLECTOR) ??
      defaultBaseForkProtocolAddresses.feeCollector,
    dvUsdc:       maybeAddress(process.env.DIVIGENT_BASE_DV_USDC) ??
      defaultBaseForkProtocolAddresses.dvUsdc,
  };
}

function toKebab(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function anvilArgs(args: ForkArgs): string[] {
  return Object.entries(args).flatMap(([key, value]) => {
    if (value === undefined || value === false) return [];
    const flag = `--${toKebab(key)}`;
    if (value === true) return [flag];
    return [flag, value.toString()];
  });
}

function assertLocalForkRpcUrl(rpcUrl: string): asserts rpcUrl is `http://127.0.0.1:${number}` {
  if (/^http:\/\/127\.0\.0\.1:\d+$/.test(rpcUrl)) return;
  throw new Error(
    `Fork tests must run against a local Anvil RPC, got '${rpcUrl}'. ` +
      'Refusing to use the public Anvil dev private key against a non-local endpoint.',
  );
}

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

export async function withForkSnapshot(rpcUrl: string, fn: () => Promise<void>): Promise<void> {
  const snapshotId = await rpcRequest<Hex>(rpcUrl, 'evm_snapshot');
  try {
    await fn();
  } finally {
    await rpcRequest<boolean>(rpcUrl, 'evm_revert', [snapshotId]);
  }
}

export function createForkSdkForPrivateKey(
  params: ForkSdkForPrivateKeyParams,
): ForkSdkForPrivateKey {
  const chain = params.chain ?? base;
  const account = privateKeyToAccount(params.privateKey);
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(params.rpcUrl),
  });
  const sdk = Divigent.create({
    publicClient: params.publicClient as unknown as PublicClient,
    walletClient: walletClient as unknown as WalletClient,
    chain: params.divigentChain ?? 'base',
    addresses: params.addresses,
  });
  return {
    account,
    wallet: account.address as EvmAddress,
    walletClient: walletClient as unknown as WalletClient,
    sdk,
  };
}

async function spawnAnvilFork(args: ForkArgs): Promise<{
  rpcUrl: `http://127.0.0.1:${number}`;
  spawned: boolean;
  stop: () => void;
}> {
  if (args.rpcUrl !== undefined && args.rpcUrl.length > 0) {
    assertLocalForkRpcUrl(args.rpcUrl);
    return {
      rpcUrl: args.rpcUrl,
      spawned: false,
      stop: () => undefined,
    };
  }

  let started = false;
  let stderr = '';
  let stdout = '';

  return new Promise((resolve, reject) => {
    const subprocess = spawn('anvil', anvilArgs({
      ...args,
      port: args.port ?? 0,
      forkChainId: args.forkChainId,
      gasPrice: 0n,
      blockBaseFeePerGas: 0n,
      stepsTracing: args.stepsTracing ?? false,
    }));

    const failTimer = setTimeout(() => {
      subprocess.kill('SIGINT');
      reject(
        new Error(
          `Timed out waiting for Anvil fork to start.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, 30_000);

    const onData = (chunk: Buffer): void => {
      const text = chunk.toString();
      stdout += text;
      const match = text.match(/Listening on 127\.0\.0\.1:(\d+)/);
      if (!match) return;

      started = true;
      clearTimeout(failTimer);
      const matchedPort = match[1];
      if (matchedPort === undefined) return;
      const port = Number.parseInt(matchedPort, 10);
      resolve({
        rpcUrl: `http://127.0.0.1:${port}`,
        spawned: true,
        stop: () => {
          subprocess.kill('SIGINT');
        },
      });
    };

    subprocess.stdout.on('data', onData);
    subprocess.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    subprocess.on('error', (error) => {
      clearTimeout(failTimer);
      reject(error);
    });
    subprocess.on('exit', (code) => {
      if (!started) {
        clearTimeout(failTimer);
        reject(
          new Error(
            `Anvil exited before listening, code=${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
      }
    });
  });
}

function resolveBaseForkConfig(chain: Chain, args: ForkArgs): ForkArgs {
  return {
    rpcUrl: args.rpcUrl,
    forkUrl: args.forkUrl ?? chain.rpcUrls.default.http[0],
    forkBlockNumber: args.forkBlockNumber,
    forkChainId: args.forkBlockNumber === undefined ? undefined : (args.forkChainId ?? chain.id),
    stepsTracing: args.stepsTracing,
  };
}

function startBaseFork(chain: Chain, args: ForkArgs): Promise<{
  rpcUrl: `http://127.0.0.1:${number}`;
  spawned: boolean;
  stop: () => void;
}> {
  return spawnAnvilFork(resolveBaseForkConfig(chain, args));
}

function findContractsOutDir(): string {
  const configured = process.env.DIVIGENT_CONTRACTS_OUT;
  const candidates = [
    configured,
    resolve(process.cwd(), '../../divigent-protocol/contracts/out'),
    resolve(process.cwd(), '../divigent-protocol/contracts/out'),
    resolve(process.cwd(), '../contracts/out'),
  ].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);

  const outDir = candidates.find((candidate) =>
    existsSync(resolve(candidate, 'DivigentVaultRouter.sol/DivigentVaultRouter.json')),
  );
  if (outDir === undefined) {
    throw new Error(
      'Could not find Divigent Foundry artifacts. Set DIVIGENT_CONTRACTS_OUT to the contracts/out directory before running fork tests.',
    );
  }
  return outDir;
}

function readForgeArtifact(outDir: string, relativePath: string): ForgeArtifact {
  const artifactPath = resolve(outDir, relativePath);
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as ForgeArtifact;
  if (!Array.isArray(artifact.abi)) {
    throw new Error(`Invalid ABI in artifact ${artifactPath}`);
  }
  if (!artifact.bytecode.object?.startsWith('0x')) {
    throw new Error(`Invalid bytecode in artifact ${artifactPath}`);
  }
  return artifact;
}

async function deployContract(params: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: PrivateKeyAccount;
  artifact: ForgeArtifact;
  args: readonly unknown[];
  label: string;
}): Promise<EvmAddress> {
  const hash = await params.walletClient.deployContract({
    abi: params.artifact.abi,
    bytecode: params.artifact.bytecode.object as Hex,
    args: params.args,
    account: params.account,
    chain: base,
    gas: FORK_DEPLOY_GAS_LIMIT,
  } as never);
  const receipt = await params.publicClient.waitForTransactionReceipt({ hash });
  const contractAddress = receipt.contractAddress;
  if (receipt.status !== 'success' || contractAddress == null) {
    throw new Error(
      `Failed to deploy ${params.label}: tx=${hash}, status=${receipt.status}, ` +
        `gasUsed=${receipt.gasUsed.toString()}`,
    );
  }
  return evmAddress(contractAddress);
}

async function deployDivigentStackOnFork(params: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: PrivateKeyAccount;
}): Promise<ContractAddresses> {
  const outDir = findContractsOutDir();
  const oracleArtifact = readForgeArtifact(
    outDir,
    'DivigentYieldOracle.sol/DivigentYieldOracle.json',
  );
  const feeCollectorArtifact = readForgeArtifact(
    outDir,
    'DivigentFeeCollector.sol/DivigentFeeCollector.json',
  );
  const dvUsdcArtifact = readForgeArtifact(outDir, 'dvUSDC.sol/DvUSDC.json');
  const routerArtifact = readForgeArtifact(
    outDir,
    'DivigentVaultRouter.sol/DivigentVaultRouter.json',
  );

  const initialNonce = await params.publicClient.getTransactionCount({
    address: params.account.address,
  });
  const predictedRouter = evmAddress(
    getContractAddress({
      from: params.account.address as Address,
      nonce: BigInt(initialNonce) + 3n,
    }),
  );

  const oracle = await deployContract({
    ...params,
    artifact: oracleArtifact,
    args: [
      baseDependencies.aavePool,
      baseDependencies.aToken,
      baseDependencies.usdc,
      baseDependencies.steakhouseUSDCPrimeVault,
    ],
    label: 'DivigentYieldOracle',
  });
  const feeCollector = await deployContract({
    ...params,
    artifact: feeCollectorArtifact,
    args: [baseDependencies.usdc, FORK_TREASURY, predictedRouter],
    label: 'DivigentFeeCollector',
  });
  const dvUsdc = await deployContract({
    ...params,
    artifact: dvUsdcArtifact,
    args: [predictedRouter],
    label: 'DvUSDC',
  });
  const router = await deployContract({
    ...params,
    artifact: routerArtifact,
    args: [
      baseDependencies.usdc,
      baseDependencies.aavePool,
      baseDependencies.aToken,
      baseDependencies.steakhouseUSDCPrimeVault,
      oracle,
      feeCollector,
      dvUsdc,
      FORK_EMERGENCY_MULTISIG,
    ],
    label: 'DivigentVaultRouter',
  });

  if (router !== predictedRouter) {
    throw new Error(`Predicted router ${predictedRouter} but deployed ${router}`);
  }

  return {
    ...baseDependencies,
    router,
    oracle,
    feeCollector,
    dvUsdc,
  };
}

async function assertBytecode(params: {
  publicClient: PublicClient;
  label: string;
  address: EvmAddress;
}): Promise<void> {
  const code = await params.publicClient.getBytecode({ address: params.address });
  if (code === undefined || code === '0x') {
    throw new Error(`Base fork address ${params.label} has no bytecode at ${params.address}`);
  }
}

function assertAddress(label: string, actual: unknown, expected: EvmAddress): void {
  if (String(actual).toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Expected ${label} ${expected}, got ${String(actual)}`);
  }
}

export async function assertBaseForkDependencyWiring(params: {
  publicClient: PublicClient;
  addresses: ContractAddresses;
  expectedProtocolAddresses?: ProtocolAddresses | undefined;
}): Promise<void> {
  const { publicClient, addresses } = params;
  const chainId = await publicClient.getChainId();
  if (chainId !== REAL_BASE_FORK_DEPENDENCIES.chainId) {
    throw new Error(`Expected Base fork chain id ${REAL_BASE_FORK_DEPENDENCIES.chainId}, got ${chainId}`);
  }
  if (params.expectedProtocolAddresses !== undefined) {
    assertAddress('Divigent router', addresses.router, params.expectedProtocolAddresses.router);
    assertAddress('Divigent oracle', addresses.oracle, params.expectedProtocolAddresses.oracle);
    assertAddress(
      'Divigent fee collector',
      addresses.feeCollector,
      params.expectedProtocolAddresses.feeCollector,
    );
    assertAddress('Divigent dvUSDC', addresses.dvUsdc, params.expectedProtocolAddresses.dvUsdc);
  }

  const expected = {
    usdc: addresses.usdc,
    aavePool: addresses.aavePool,
    aaveAToken: addresses.aToken,
    morphoVault: addresses.steakhouseUSDCPrimeVault,
  };
  assertAddress('Base USDC', expected.usdc, REAL_BASE_FORK_DEPENDENCIES.usdc);
  assertAddress('Base Aave pool', expected.aavePool, REAL_BASE_FORK_DEPENDENCIES.aavePool);
  assertAddress('Base aBasUSDC', expected.aaveAToken, REAL_BASE_FORK_DEPENDENCIES.aaveAToken);
  assertAddress('Base Morpho vault', expected.morphoVault, REAL_BASE_FORK_DEPENDENCIES.morphoVault);

  const [
    routerUsdc,
    routerAavePool,
    routerAToken,
    routerMorphoVault,
    oracleAavePool,
    oracleAToken,
    oracleUsdc,
    oracleMorphoVault,
    morphoAsset,
  ] = await Promise.all([
    publicClient.readContract({
      address: addresses.router,
      abi: routerAbi,
      functionName: 'USDC',
    }),
    publicClient.readContract({
      address: addresses.router,
      abi: routerAbi,
      functionName: 'AAVE_POOL',
    }),
    publicClient.readContract({
      address: addresses.router,
      abi: routerAbi,
      functionName: 'A_TOKEN',
    }),
    publicClient.readContract({
      address: addresses.router,
      abi: routerAbi,
      functionName: 'MORPHO_VAULT',
    }),
    publicClient.readContract({
      address: addresses.oracle,
      abi: oracleAbi,
      functionName: 'AAVE_POOL',
    }),
    publicClient.readContract({
      address: addresses.oracle,
      abi: oracleAbi,
      functionName: 'A_TOKEN',
    }),
    publicClient.readContract({
      address: addresses.oracle,
      abi: oracleAbi,
      functionName: 'USDC',
    }),
    publicClient.readContract({
      address: addresses.oracle,
      abi: oracleAbi,
      functionName: 'MORPHO_VAULT',
    }),
    publicClient.readContract({
      address: addresses.steakhouseUSDCPrimeVault,
      abi: morphoVaultAssetAbi,
      functionName: 'asset',
    }),
  ]);
  const checks: Array<[string, unknown, EvmAddress]> = [
    ['router.USDC', routerUsdc, REAL_BASE_FORK_DEPENDENCIES.usdc],
    ['router.AAVE_POOL', routerAavePool, REAL_BASE_FORK_DEPENDENCIES.aavePool],
    ['router.A_TOKEN', routerAToken, REAL_BASE_FORK_DEPENDENCIES.aaveAToken],
    ['router.MORPHO_VAULT', routerMorphoVault, REAL_BASE_FORK_DEPENDENCIES.morphoVault],
    ['oracle.USDC', oracleUsdc, REAL_BASE_FORK_DEPENDENCIES.usdc],
    ['oracle.AAVE_POOL', oracleAavePool, REAL_BASE_FORK_DEPENDENCIES.aavePool],
    ['oracle.A_TOKEN', oracleAToken, REAL_BASE_FORK_DEPENDENCIES.aaveAToken],
    ['oracle.MORPHO_VAULT', oracleMorphoVault, REAL_BASE_FORK_DEPENDENCIES.morphoVault],
    ['morphoVault.asset', morphoAsset, REAL_BASE_FORK_DEPENDENCIES.usdc],
  ];
  for (const [label, actual, expectedAddress] of checks) {
    assertAddress(label, actual, expectedAddress);
  }

  await Promise.all([
    assertBytecode({ publicClient, label: 'Divigent router', address: addresses.router }),
    assertBytecode({ publicClient, label: 'Divigent oracle', address: addresses.oracle }),
    assertBytecode({ publicClient, label: 'Divigent fee collector', address: addresses.feeCollector }),
    assertBytecode({ publicClient, label: 'Divigent dvUSDC', address: addresses.dvUsdc }),
    assertBytecode({ publicClient, label: 'USDC', address: REAL_BASE_FORK_DEPENDENCIES.usdc }),
    assertBytecode({ publicClient, label: 'Aave V3 Pool', address: REAL_BASE_FORK_DEPENDENCIES.aavePool }),
    assertBytecode({ publicClient, label: 'aBasUSDC', address: REAL_BASE_FORK_DEPENDENCIES.aaveAToken }),
    assertBytecode({ publicClient, label: 'Morpho Steakhouse USDC vault', address: REAL_BASE_FORK_DEPENDENCIES.morphoVault }),
  ]);
}

export async function assertBaseForkAssumptions(params: {
  divigent: Divigent;
}): Promise<void> {
  const [oracleFresh, rates, capacity] = await Promise.all([
    params.divigent.isFresh(),
    params.divigent.getAllRates(),
    params.divigent.withdrawCapacity(),
  ]);

  if (!oracleFresh) {
    throw new Error(`Base fork block ${BASE_FORK_POLICY.blockNumber} starts with a stale oracle.`);
  }
  if (rates.length < 2) {
    throw new Error('Base fork must expose at least two routable venue rates.');
  }
  if (!rates.some((rate) => rate.isSafe)) {
    throw new Error('Base fork must expose at least one safe venue.');
  }
  if (typeof capacity.totalWithdrawCap !== 'bigint') {
    throw new Error('Base fork withdraw capacity returned an invalid shape.');
  }
}

async function deployOrLoadDivigentStack(params: {
  addresses: ContractAddresses | undefined;
  spawned: boolean;
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: PrivateKeyAccount;
}): Promise<{
  contractAddresses: ContractAddresses;
  expectedProtocolAddresses: ProtocolAddresses;
}> {
  if (params.addresses !== undefined) {
    return {
      contractAddresses: params.addresses,
      expectedProtocolAddresses: params.addresses,
    };
  }
  if (!params.spawned) {
    const envAddresses = baseMainnetForkAddressesFromEnv();
    return {
      contractAddresses: envAddresses,
      expectedProtocolAddresses: envAddresses,
    };
  }
  return {
    contractAddresses: await deployDivigentStackOnFork({
      publicClient: params.publicClient,
      walletClient: params.walletClient,
      account: params.account,
    }),
    expectedProtocolAddresses: BASE_LOCAL_FORK_PROTOCOL_ADDRESSES,
  };
}

async function assertBaseForkPreflight(params: {
  rpcUrl: string;
  divigent: Divigent;
  publicClient: PublicClient;
  addresses: ContractAddresses;
  expectedProtocolAddresses: ProtocolAddresses;
}): Promise<void> {
  assertLocalForkRpcUrl(params.rpcUrl);
  await params.divigent.verifyAddresses();
  await assertBaseForkDependencyWiring({
    publicClient: params.publicClient,
    addresses: params.addresses,
    expectedProtocolAddresses: params.expectedProtocolAddresses,
  });
  await assertBaseForkAssumptions(params);
}

function createDivigentForkTest(
  chain: Chain,
  args: ForkArgs,
  addresses: ContractAddresses | undefined,
) {
  return baseTest.extend<ForkContext & { fork: ForkContext }>({
    fork: [async ({}, use) => {
      const { rpcUrl, spawned, stop } = await startBaseFork(chain, args);

      try {
        const account = privateKeyToAccount(ANVIL_DEFAULT_PRIVATE_KEY);
        const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
        const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
        const { contractAddresses, expectedProtocolAddresses } = await deployOrLoadDivigentStack({
          addresses,
          spawned,
          publicClient: publicClient as unknown as PublicClient,
          walletClient: walletClient as unknown as WalletClient,
          account,
        });
        const divigent = Divigent.create({
          publicClient: publicClient as unknown as PublicClient,
          walletClient: walletClient as unknown as WalletClient,
          chain: 'base',
          addresses: contractAddresses,
        });
        await assertBaseForkPreflight({
          rpcUrl,
          divigent,
          publicClient: publicClient as unknown as PublicClient,
          addresses: contractAddresses,
          expectedProtocolAddresses,
        });

        await use({
          rpcUrl,
          account,
          publicClient: publicClient as unknown as PublicClient,
          walletClient: walletClient as unknown as WalletClient,
          divigent,
        });
      } finally {
        stop();
      }
    }, { scope: 'worker' }],
    rpcUrl: async ({ fork }, use) => {
      await use(fork.rpcUrl);
    },
    account: async ({ fork }, use) => {
      await use(fork.account);
    },
    publicClient: async ({ fork }, use) => {
      await use(fork.publicClient);
    },
    walletClient: async ({ fork }, use) => {
      await use(fork.walletClient);
    },
    divigent: async ({ fork }, use) => {
      await use(fork.divigent);
    },
  });
}

const forkBlockNumber = process.env.BASE_FORK_BLOCK
  ? BigInt(process.env.BASE_FORK_BLOCK)
  : DEFAULT_BASE_FORK_BLOCK_NUMBER;

export const divigentBaseMainnetForkTest = createDivigentForkTest(
  base,
  {
    rpcUrl: process.env.BASE_FORK_RPC_URL,
    forkUrl: process.env.BASE_RPC_URL ?? 'https://mainnet.base.org',
    forkBlockNumber,
    stepsTracing: false,
  },
  undefined,
);
