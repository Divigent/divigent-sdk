import { describe, expect, it } from 'vitest';
import type { Hex, TransactionReceipt } from 'viem';
import {
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  parseAbi,
} from 'viem';
import { dvUsdcAbi, feeCollectorAbi, oracleAbi, routerAbi } from '../../src/abis';
import { parseDepositReceipt, parseWithdrawReceipt } from '../../src/core/receipts';
import {
  ContractRevertError,
  DivigentError,
  PanicError,
  ReceiptParseError,
  RequireError,
  UserRejectedError,
  decodeDivigentError,
  extractRevertData,
  runRead,
  runSign,
  runWrite,
  toDivigentError,
} from '../../src/errors';
import { HASH_1, OWNER, usdc } from './helpers';

type AbiError = {
  type: 'error';
  name: string;
  inputs?: readonly { type: string }[];
};

const errorAbis = [
  ['router', routerAbi],
  ['feeCollector', feeCollectorAbi],
  ['oracle', oracleAbi],
  ['dvUsdc', dvUsdcAbi],
] as const;

function sampleArg(type: string): unknown {
  if (type === 'address') return OWNER;
  if (type === 'bytes32') return `0x${'11'.repeat(32)}` as Hex;
  if (type === 'string') return 'sample revert reason';
  if (type === 'uint8') return 7;
  if (type.startsWith('uint')) return 123n;
  throw new Error(`Unhandled ABI error input type ${type}`);
}

function receiptWithLog(log: {
  topics: readonly `0x${string}`[];
  data: `0x${string}`;
}): TransactionReceipt {
  return receiptWithLogs([log]);
}

function receiptWithLogs(logs: Array<{
  topics: readonly `0x${string}`[];
  data: `0x${string}`;
}>): TransactionReceipt {
  return {
    transactionHash: HASH_1,
    logs: logs.map((log, index) => ({
      ...log,
      address: `0x100000000000000000000000000000000000000${index + 1}`,
    })),
  } as unknown as TransactionReceipt;
}

describe('receipt parsing', () => {
  // Exercises: parses Deposited event receipts.
  it('parses Deposited event receipts', () => {
    const topics = encodeEventTopics({
      abi: routerAbi,
      eventName: 'Deposited',
      args: { wallet: OWNER, vaultType: 1 },
    });
    const data = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [usdc('0.001'), 990n],
    );

    expect(parseDepositReceipt(receiptWithLog({ topics: topics as `0x${string}`[], data }))).toEqual({
      txHash: HASH_1,
      sharesMinted: 990n,
    });
  });
  // Exercises: parses Withdrawn event receipts.
  it('parses Withdrawn event receipts', () => {
    const topics = encodeEventTopics({
      abi: routerAbi,
      eventName: 'Withdrawn',
      args: { wallet: OWNER },
    });
    const data = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [500n, usdc('0.000490'), usdc('0.000010'), usdc('0.000001')],
    );

    expect(parseWithdrawReceipt(receiptWithLog({ topics: topics as `0x${string}`[], data }))).toEqual({
      txHash: HASH_1,
      usdcReturned: usdc('0.000490'),
    });
  });
  // Exercises: ignores unrelated logs and parses the first matching money event.
  it('ignores unrelated logs and parses the first matching money event', () => {
    const withdrawTopics = encodeEventTopics({
      abi: routerAbi,
      eventName: 'Withdrawn',
      args: { wallet: OWNER },
    });
    const withdrawData = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [500n, usdc('0.000490'), usdc('0.000010'), usdc('0.000001')],
    );
    const depositTopics = encodeEventTopics({
      abi: routerAbi,
      eventName: 'Deposited',
      args: { wallet: OWNER, vaultType: 1 },
    });
    const depositData = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [usdc('0.001'), 990n],
    );

    expect(parseDepositReceipt(receiptWithLogs([
      { topics: withdrawTopics as `0x${string}`[], data: withdrawData },
      { topics: depositTopics as `0x${string}`[], data: depositData },
    ]))).toEqual({
      txHash: HASH_1,
      sharesMinted: 990n,
    });
  });
  // Exercises: throws typed receipt errors when expected events are missing.
  it('throws typed receipt errors when expected events are missing', () => {
    const empty = { transactionHash: HASH_1, logs: [] } as unknown as TransactionReceipt;
    expect(() => parseDepositReceipt(empty)).toThrow(ReceiptParseError);
    expect(() => parseWithdrawReceipt(empty)).toThrow(ReceiptParseError);
  });
});

describe('error normalization', () => {
  // Exercises: decodes every %s custom error selector.
  it.each(errorAbis)('decodes every %s custom error selector', (_label, abi) => {
    const errors = (abi as readonly AbiError[]).filter((item) => item.type === 'error');
    expect(errors.length).toBeGreaterThan(0);

    for (const error of errors) {
      const args = (error.inputs ?? []).map((input) => sampleArg(input.type));
      const data = encodeErrorResult({
        abi,
        errorName: error.name,
        args,
      } as never);

      const decoded = decodeDivigentError(data);

      expect(decoded).toBeInstanceOf(ContractRevertError);
      expect(decoded).toMatchObject({
        errorName: error.name,
        code: 'DIVIGENT_CONTRACT_REVERT',
        category: 'contract',
      });
      expect((decoded as ContractRevertError).args ?? []).toHaveLength(args.length);
    }
  });
  // Exercises: decodes dvUSDC NonTransferable for raw ABI consumers.
  it('decodes dvUSDC NonTransferable for raw ABI consumers', () => {
    const data = encodeErrorResult({
      abi: dvUsdcAbi,
      errorName: 'NonTransferable',
    });

    expect(decodeDivigentError(data)).toMatchObject({
      errorName: 'NonTransferable',
      code: 'DIVIGENT_CONTRACT_REVERT',
    });
  });
  // Exercises: decodes Divigent custom errors from raw revert data.
  it('decodes Divigent custom errors from raw revert data', () => {
    const data = encodeErrorResult({
      abi: routerAbi,
      errorName: 'InvalidAmount',
    });

    const decoded = decodeDivigentError(data);
    expect(decoded).toBeInstanceOf(ContractRevertError);
    expect(decoded).toMatchObject({
      errorName: 'InvalidAmount',
      code: 'DIVIGENT_CONTRACT_REVERT',
      category: 'contract',
    });
  });
  // Exercises: extracts raw revert data from nested viem errors.
  it('extracts raw revert data from nested viem errors', () => {
    const data = encodeErrorResult({
      abi: routerAbi,
      errorName: 'InvalidAmount',
    });
    const viemError = new ContractFunctionRevertedError({
      abi: routerAbi,
      data,
      functionName: 'deposit',
    });

    expect(extractRevertData(viemError)).toBe(data);
  });
  // Exercises: maps Solidity Error(string) reverts to RequireError.
  it('maps Solidity Error(string) reverts to RequireError', () => {
    const abi = parseAbi(['error Error(string)']);
    const data = encodeErrorResult({
      abi,
      errorName: 'Error',
      args: ['ERC20: transfer amount exceeds allowance'],
    });
    const viemError = new ContractFunctionRevertedError({
      abi,
      data,
      functionName: 'deposit',
    });

    const normalized = toDivigentError(viemError);

    expect(normalized).toBeInstanceOf(RequireError);
    expect(normalized).toMatchObject({
      reason: 'ERC20: transfer amount exceeds allowance',
      code: 'DIVIGENT_REQUIRE_REVERT',
      category: 'contract',
    });
  });
  // Exercises: maps Solidity Panic reverts and user wallet rejections to typed errors.
  it('maps Solidity Panic reverts and user wallet rejections to typed errors', () => {
    const panicAbi = parseAbi(['error Panic(uint256)']);
    const panicData = encodeErrorResult({
      abi: panicAbi,
      errorName: 'Panic',
      args: [0x11n],
    });
    const panic = toDivigentError(new ContractFunctionRevertedError({
      abi: panicAbi,
      data: panicData,
      functionName: 'deposit',
    }));

    expect(panic).toBeInstanceOf(PanicError);
    expect(panic).toMatchObject({
      code: 'DIVIGENT_SOLIDITY_PANIC',
      category: 'contract',
      panicCode: 0x11,
    });

    const rejected = toDivigentError(new UserRejectedRequestError(new Error('rejected')));
    expect(rejected).toBeInstanceOf(UserRejectedError);
    expect(rejected).toMatchObject({
      code: 'DIVIGENT_USER_REJECTED',
      category: 'wallet',
    });
  });
  // Exercises: preserves existing DivigentError metadata and merges new context.
  it('preserves existing DivigentError metadata and merges new context', () => {
    const base = new DivigentError('base', {
      code: 'BASE',
      category: 'x402',
      retryable: true,
      context: { a: 1 },
    });

    const normalized = toDivigentError(base, { context: { b: 2 } });

    expect(normalized).toMatchObject({
      message: 'base',
      code: 'BASE',
      category: 'x402',
      retryable: true,
      context: { a: 1, b: 2 },
    });
  });
  // Exercises: marks retryable read failures based on network-like messages.
  it('marks retryable read failures based on network-like messages', async () => {
    await expect(
      runRead(async () => {
        throw new Error('network timeout');
      }),
    ).rejects.toMatchObject({
      code: 'DIVIGENT_READ_FAILED',
      category: 'chain',
      retryable: true,
    });
  });
  // Exercises: labels write and signing failures by phase so money-movement failures are actionable.
  it('labels write and signing failures by phase so money-movement failures are actionable', async () => {
    await expect(
      runWrite(async () => {
        throw new Error('execution reverted');
      }),
    ).rejects.toMatchObject({
      code: 'DIVIGENT_WRITE_FAILED',
      category: 'chain',
    });

    await expect(
      runSign(async () => {
        throw new Error('wallet locked');
      }),
    ).rejects.toMatchObject({
      code: 'DIVIGENT_SIGN_FAILED',
      category: 'wallet',
    });
  });
});
