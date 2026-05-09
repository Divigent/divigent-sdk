import { describe, expect, it } from 'vitest';
import type { TransactionReceipt } from 'viem';
import {
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  parseAbi,
} from 'viem';
import { routerAbi } from '../../src/abis';
import { parseDepositReceipt, parseWithdrawReceipt } from '../../src/core/receipts';
import {
  ContractRevertError,
  DivigentError,
  PanicError,
  ReceiptParseError,
  RequireError,
  UserRejectedError,
  decodeDivigentError,
  runRead,
  runSign,
  runWrite,
  toDivigentError,
} from '../../src/errors';
import { HASH_1, OWNER, usdc } from './helpers';

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
  // Parses Deposited event receipts.
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

  // Parses Withdrawn event receipts.
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

  // Ignores unrelated logs and parses the first matching money event.
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

  // Throws typed receipt errors when expected events are missing.
  it('throws typed receipt errors when expected events are missing', () => {
    const empty = { transactionHash: HASH_1, logs: [] } as unknown as TransactionReceipt;
    expect(() => parseDepositReceipt(empty)).toThrow(ReceiptParseError);
    expect(() => parseWithdrawReceipt(empty)).toThrow(ReceiptParseError);
  });
});

describe('error normalization', () => {
  // Decodes Divigent custom errors from raw revert data.
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

  // Maps Solidity Error(string) reverts to RequireError.
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

  // Maps Solidity Panic reverts and user wallet rejections to typed errors.
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

  // Preserves existing DivigentError metadata and merges new context.
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

  // Marks retryable read failures based on network-like messages.
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

  // Labels write and signing failures by phase so money-movement failures are actionable.
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
