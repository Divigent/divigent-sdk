import type { Hex, PublicClient, WalletClient } from 'viem';
import { usdcAbi } from '../abis';
import {
  DivigentError,
  PermitUnsupportedFor7702AccountError,
  PermitUnsupportedForTokenError,
  runRead,
  runSign,
  runWrite,
} from '../errors';
import {
  type EvmAddress,
  type FeeOverrides,
  type PermitSig,
  type TxHash,
  txHash,
} from '../types';

// Reads

export function readUsdcBalance(
  client: PublicClient,
  usdc: EvmAddress,
  account: EvmAddress,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: usdc,
    abi: usdcAbi,
    functionName: 'balanceOf',
    args: [account],
  }), usdcAbi);
}

export function readUsdcAllowance(
  client: PublicClient,
  usdc: EvmAddress,
  owner: EvmAddress,
  spender: EvmAddress,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: usdc,
    abi: usdcAbi,
    functionName: 'allowance',
    args: [owner, spender],
  }), usdcAbi);
}

export function readUsdcNonce(
  client: PublicClient,
  usdc: EvmAddress,
  owner: EvmAddress,
): Promise<bigint> {
  return runRead(() => client.readContract({
    address: usdc,
    abi: usdcAbi,
    functionName: 'nonces',
    args: [owner],
  }), usdcAbi);
}

export function readUsdcDecimals(
  client: PublicClient,
  usdc: EvmAddress,
): Promise<number> {
  return runRead(() => client.readContract({
    address: usdc,
    abi: usdcAbi,
    functionName: 'decimals',
  }), usdcAbi);
}

type PermitField = 'name' | 'version' | 'nonces';

async function readRequiredPermitField<T>(params: {
  token: EvmAddress;
  owner: EvmAddress;
  field: PermitField;
  read: () => Promise<T>;
}): Promise<T> {
  try {
    return await runRead(params.read, usdcAbi);
  } catch (cause) {
    throw new PermitUnsupportedForTokenError(params.token, params.field, {
      cause,
      context: { owner: params.owner },
    });
  }
}

// Writes

/**
 * @notice Approve a spender for an exact USDC amount.
 * @remarks Allowances persist if a later deposit reverts. Circle USDC permits
 * consecutive non-zero approvals; do not reuse this helper for non-Circle
 * bridged tokens without checking approval semantics.
 * @param params viem clients, USDC address, spender, amount, and optional fees.
 * @returns Transaction hash.
 */
export async function approveUsdc(params: {
  walletClient: WalletClient;
  publicClient: PublicClient;
  usdc: EvmAddress;
  spender: EvmAddress;
  amount: bigint;
  fees?: FeeOverrides;
}): Promise<TxHash> {
  const { walletClient, publicClient, usdc, spender, amount, fees } = params;
  const account = walletClient.account;
  const chain = walletClient.chain;
  if (!account) {
    throw new DivigentError('[@divigent/sdk] walletClient has no account', {
      code: 'DIVIGENT_WALLET_ACCOUNT_REQUIRED',
      category: 'wallet',
    });
  }
  if (!chain) {
    throw new DivigentError('[@divigent/sdk] walletClient has no chain', {
      code: 'DIVIGENT_WALLET_CHAIN_REQUIRED',
      category: 'wallet',
    });
  }
  const hash = await runWrite(async () => {
    const { request } = await publicClient.simulateContract({
      address: usdc,
      abi: usdcAbi,
      functionName: 'approve',
      args: [spender, amount],
      account,
    });
    const final = fees ? { ...request, ...fees } : request;
    // viem overloads cannot preserve this simulated request shape through a helper.
    return walletClient.writeContract(final as never);
  }, usdcAbi);
  return txHash(hash);
}

// Signing

/**
 * @notice Sign an EIP-2612 permit for Circle USDC.
 * @remarks Contract-code signers are rejected so the facade can fall back to
 * `approveUsdc + deposit`. Do not point this helper at a non-Circle USDC
 * variant without verifying its permit domain and signature rules.
 * @param params viem clients, token/spender addresses, amount, deadline, and optional owner.
 * @returns Permit signature parts.
 */
export async function signUsdcPermit(params: {
  walletClient: WalletClient;
  publicClient: PublicClient;
  usdc: EvmAddress;
  spender: EvmAddress;
  value: bigint;
  deadline: bigint;
  owner?: EvmAddress;
}): Promise<PermitSig> {
  const { walletClient, publicClient, usdc, spender, value, deadline } = params;
  const account = walletClient.account;
  const chain = walletClient.chain;
  if (!account) {
    throw new DivigentError('[@divigent/sdk] walletClient has no account', {
      code: 'DIVIGENT_WALLET_ACCOUNT_REQUIRED',
      category: 'wallet',
    });
  }
  if (!chain) {
    throw new DivigentError('[@divigent/sdk] walletClient has no chain', {
      code: 'DIVIGENT_WALLET_CHAIN_REQUIRED',
      category: 'wallet',
    });
  }
  const owner = params.owner ?? (account.address as EvmAddress);

  // Contract-code owners require ERC-1271; this EOA-style permit would fail.
  const ownerCode = await runRead(() => publicClient.getCode({ address: owner }));
  if (ownerCode && ownerCode !== '0x') {
    throw new PermitUnsupportedFor7702AccountError(owner);
  }

  const name = await readRequiredPermitField({
    token: usdc,
    owner,
    field: 'name',
    read: () => publicClient.readContract({ address: usdc, abi: usdcAbi, functionName: 'name' }),
  });
  const version = await readRequiredPermitField({
    token: usdc,
    owner,
    field: 'version',
    read: () => publicClient.readContract({ address: usdc, abi: usdcAbi, functionName: 'version' }),
  });
  const nonce = await readRequiredPermitField({
    token: usdc,
    owner,
    field: 'nonces',
    read: () => publicClient.readContract({
      address: usdc,
      abi: usdcAbi,
      functionName: 'nonces',
      args: [owner],
    }),
  });

  const signature = await runSign(() => walletClient.signTypedData({
    account,
    domain: {
      name,
      version,
      chainId: chain.id,
      verifyingContract: usdc,
    },
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: { owner, spender, value, nonce, deadline },
  }));

  // Normalize high-s signatures before Circle USDC rejects them on-chain.
  const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const HALF_N = SECP256K1_N >> 1n;

  let rHex = `0x${signature.slice(2, 66)}` as Hex;
  let sHex = `0x${signature.slice(66, 130)}` as Hex;
  let vRaw = parseInt(signature.slice(130, 132), 16);
  let v = vRaw < 27 ? vRaw + 27 : vRaw;

  const sBig = BigInt(sHex);
  if (sBig > HALF_N) {
    const flippedS = SECP256K1_N - sBig;
    sHex = `0x${flippedS.toString(16).padStart(64, '0')}` as Hex;
    v = v === 27 ? 28 : 27;
  }

  if (v !== 27 && v !== 28) {
    throw new DivigentError(
      `[@divigent/sdk] unexpected v=${v} from signTypedData; expected 27 or 28`,
      {
        code: 'DIVIGENT_INVALID_SIGNATURE_V',
        category: 'wallet',
        context: { v },
      },
    );
  }

  return { r: rHex, s: sHex, v, deadline };
}
