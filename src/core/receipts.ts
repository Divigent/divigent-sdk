import type { TransactionReceipt } from 'viem';
import { parseEventLogs } from 'viem';
import { routerAbi } from '../abis';
import { ReceiptParseError } from '../errors';
import type { DepositResult, WithdrawResult } from '../types';
import { txHash } from '../types';

/**
 * @notice Parse a router `Deposited` event from a transaction receipt.
 * @param receipt Mined transaction receipt.
 * @returns Deposit result with transaction hash and minted shares.
 * @throws If the receipt does not contain a `Deposited` event.
 */
export function parseDepositReceipt(receipt: TransactionReceipt): DepositResult {
  const logs = parseEventLogs({
    abi: routerAbi,
    logs: receipt.logs,
    eventName: 'Deposited',
  });
  const event = logs[0];
  if (!event) {
    throw new ReceiptParseError('Deposited', {
      context: { txHash: receipt.transactionHash },
    });
  }
  return {
    txHash: txHash(receipt.transactionHash),
    sharesMinted: event.args.dvUsdcMinted,
  };
}

/**
 * @notice Parse a router `Withdrawn` event from a transaction receipt.
 * @param receipt Mined transaction receipt.
 * @returns Withdraw result with transaction hash and returned USDC.
 * @throws If the receipt does not contain a `Withdrawn` event.
 */
export function parseWithdrawReceipt(receipt: TransactionReceipt): WithdrawResult {
  const logs = parseEventLogs({
    abi: routerAbi,
    logs: receipt.logs,
    eventName: 'Withdrawn',
  });
  const event = logs[0];
  if (!event) {
    throw new ReceiptParseError('Withdrawn', {
      context: { txHash: receipt.transactionHash },
    });
  }
  return {
    txHash: txHash(receipt.transactionHash),
    usdcReturned: event.args.usdcReturned,
  };
}
