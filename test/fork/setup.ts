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
import { Divigent } from '../../src/divigent';
import { getAddresses, type ContractAddresses } from '../../src/core/chains';
import { evmAddress, type EvmAddress } from '../../src/types';

// Foundry/Anvil's public deterministic dev key. This must only ever be used
// against a local fork RPC; never fund it or use it on a live network.
const ANVIL_DEFAULT_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const DEFAULT_BASE_FORK_BLOCK_NUMBER = 45_734_171n;
const FORK_TREASURY = evmAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
const FORK_EMERGENCY_MULTISIG = evmAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');

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

type ForgeArtifact = {
  abi: Abi;
  bytecode: {
    object?: string;
  };
};

const baseDependencies = getAddresses('base');
const defaultBaseForkProtocolAddresses = {
  router:       evmAddress('0x1e79FAc6B154B49101252C447E0e68a0a20fc3c0'),
  oracle:       evmAddress('0x05fa1e1EE3249C26db881930F0bF2cb1fe05da98'),
  feeCollector: evmAddress('0x1157c1D6027A5f4Cd62682A7F0d1da426A4b65E3'),
  dvUsdc:       evmAddress('0x5D343ee475E8960229136e03ebe1153D8605aD56'),
} as const;

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
      if (!started && /error|failed/i.test(stderr)) {
        clearTimeout(failTimer);
        subprocess.kill('SIGINT');
        reject(new Error(stderr));
      }
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
  } as never);
  const receipt = await params.publicClient.waitForTransactionReceipt({ hash });
  const contractAddress = receipt.contractAddress;
  if (receipt.status !== 'success' || contractAddress == null) {
    throw new Error(`Failed to deploy ${params.label}`);
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

function createDivigentForkTest(
  chain: Chain,
  args: ForkArgs,
  addresses: ContractAddresses | undefined,
) {
  return baseTest.extend<ForkContext & { fork: ForkContext }>({
    fork: async ({ task: _task }, use) => {
      const { rpcUrl, spawned, stop } = await spawnAnvilFork({
        rpcUrl: args.rpcUrl,
        forkUrl: args.forkUrl ?? chain.rpcUrls.default.http[0],
        forkBlockNumber: args.forkBlockNumber,
        forkChainId:
          args.forkBlockNumber === undefined ? undefined : (args.forkChainId ?? chain.id),
        stepsTracing: args.stepsTracing,
      });

      try {
        assertLocalForkRpcUrl(rpcUrl);
        const account = privateKeyToAccount(ANVIL_DEFAULT_PRIVATE_KEY);
        const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
        const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
        const contractAddresses = addresses ?? (spawned
          ? await deployDivigentStackOnFork({
            publicClient: publicClient as unknown as PublicClient,
            walletClient: walletClient as unknown as WalletClient,
            account,
          })
          : baseMainnetForkAddressesFromEnv());
        const divigent = Divigent.create({
          publicClient: publicClient as unknown as PublicClient,
          walletClient: walletClient as unknown as WalletClient,
          chain: 'base',
          addresses: contractAddresses,
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
    },
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
