import type { TransactionReceipt } from 'viem';
import { parseEventLogs } from 'viem';
import { routerAbi } from '../abis';
import { ReceiptParseError } from '../errors';
import type { DepositResult, EvmAddress, WithdrawResult } from '../types';
import { txHash } from '../types';

function logsFromEmitter(receipt: TransactionReceipt, emitter: EvmAddress): TransactionReceipt['logs'] {
  const normalized = emitter.toLowerCase();
  return receipt.logs.filter((log) => log.address.toLowerCase() === normalized);
}

/**
 * @notice Parse a router `Deposited` event from a transaction receipt.
 * @param receipt Mined transaction receipt.
 * @param router Expected Divigent router emitter address.
 * @returns Deposit result with transaction hash and minted shares.
 * @throws If the receipt does not contain a `Deposited` event.
 */
export function parseDepositReceipt(receipt: TransactionReceipt, router: EvmAddress): DepositResult {
  const logs = parseEventLogs({
    abi: routerAbi,
    logs: logsFromEmitter(receipt, router),
    eventName: 'Deposited',
  });
  const event = logs[0];
  if (!event) {
    throw new ReceiptParseError('Deposited', {
      context: { txHash: receipt.transactionHash, router },
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
 * @param router Expected Divigent router emitter address.
 * @returns Withdraw result with transaction hash and returned USDC.
 * @throws If the receipt does not contain a `Withdrawn` event.
 */
export function parseWithdrawReceipt(receipt: TransactionReceipt, router: EvmAddress): WithdrawResult {
  const logs = parseEventLogs({
    abi: routerAbi,
    logs: logsFromEmitter(receipt, router),
    eventName: 'Withdrawn',
  });
  const event = logs[0];
  if (!event) {
    throw new ReceiptParseError('Withdrawn', {
      context: { txHash: receipt.transactionHash, router },
    });
  }
  return {
    txHash: txHash(receipt.transactionHash),
    usdcReturned: event.args.usdcReturned,
  };
}
