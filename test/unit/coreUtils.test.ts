import { describe, expect, it } from 'vitest';
import {
  applyBps,
  applyFee,
  applySlippageDown,
  convertToAssets,
  convertToShares,
  formatUsdc,
  parseUsdc,
  rescaleDecimals,
  toDisplayString,
} from '../../src/core/utils';
import { DivigentError } from '../../src/errors';
import { evmAddress, txHash } from '../../src/types';

describe('core utils', () => {
  // Parses and formats USDC with 6 decimals.
  it('parses and formats USDC with 6 decimals', () => {
    expect(parseUsdc('12.345678')).toBe(12_345_678n);
    expect(formatUsdc(12_345_678n)).toBe('12.345678');
    expect(formatUsdc(parseUsdc('1.230000'))).toBe('1.23');
  });

  // Rejects USDC precision beyond 6 decimals before money math runs.
  it('rejects USDC precision beyond 6 decimals before money math runs', () => {
    expect(() => parseUsdc('0.0000001')).toThrow();
    expect(() => parseUsdc('1.1234567')).toThrow();
  });

  // Rejects malformed USDC strings instead of guessing user intent.
  it('rejects malformed USDC strings instead of guessing user intent', () => {
    for (const invalid of ['', ' ', '-1', '+1', '1.', '.1', '1e6', '1,000', '0x1']) {
      expect(() => parseUsdc(invalid)).toThrow(DivigentError);
    }
  });

  // Parses very large valid USDC strings exactly.
  it('parses very large valid USDC strings exactly', () => {
    expect(parseUsdc('12345678901234567890.123456')).toBe(
      12_345_678_901_234_567_890_123_456n,
    );
  });

  // Applies basis points with floor rounding.
  it('applies basis points with floor rounding', () => {
    expect(applyBps(101n, 100n)).toBe(1n);
    expect(applyBps(10_000n, 25)).toBe(25n);
  });

  // Applies basis-point boundaries consistently for number and bigint inputs.
  it('applies basis-point boundaries consistently for number and bigint inputs', () => {
    const amount = 123_456_789n;

    for (const bps of [0, 1, 9_999, 10_000]) {
      expect(applyBps(amount, bps)).toBe(applyBps(amount, BigInt(bps)));
      expect(applySlippageDown(amount, bps)).toBe(
        (amount * BigInt(10_000 - bps)) / 10_000n,
      );
    }

    expect(applyBps(amount, 0)).toBe(0n);
    expect(applyBps(amount, 10_000)).toBe(amount);
    expect(applySlippageDown(amount, 0)).toBe(amount);
    expect(applySlippageDown(amount, 10_000)).toBe(0n);
  });

  // Derives slippage guards and rejects invalid bps.
  it('derives slippage guards and rejects invalid bps', () => {
    expect(applySlippageDown(1_000_000n, 0)).toBe(1_000_000n);
    expect(applySlippageDown(1_000_000n, 10)).toBe(999_000n);
    expect(applySlippageDown(1_000_000n, 10_000)).toBe(0n);
    expect(() => applySlippageDown(1_000_000n, -1)).toThrow(DivigentError);
    expect(() => applySlippageDown(1_000_000n, 10_001)).toThrow(DivigentError);
  });

  // Never rounds slippage protection upward on tiny amounts.
  it('never rounds slippage protection upward on tiny amounts', () => {
    expect(applySlippageDown(1n, 1)).toBe(0n);
    expect(applySlippageDown(9_999n, 1)).toBe(9_998n);
    expect(applySlippageDown(10_001n, 1)).toBe(9_999n);
  });

  // Calculates fee and rejects invalid fee bps.
  it('calculates fee and rejects invalid fee bps', () => {
    expect(applyFee(1_000_000n)).toBe(100_000n);
    expect(applyFee(1_000_000n, 250n)).toBe(25_000n);
    expect(() => applyFee(1_000_000n, -1n)).toThrow(DivigentError);
    expect(() => applyFee(1_000_000n, 10_001n)).toThrow(DivigentError);
  });

  // Rescales decimals with floor and ceil rounding.
  it('rescales decimals with floor and ceil rounding', () => {
    expect(rescaleDecimals(123n, 6, 18)).toBe(123_000_000_000_000n);
    expect(rescaleDecimals(123_456_789n, 8, 6, 'floor')).toBe(1_234_567n);
    expect(rescaleDecimals(123_456_789n, 8, 6, 'ceil')).toBe(1_234_568n);
  });

  // Matches the router virtual-offset share math.
  it('matches the router virtual-offset share math', () => {
    expect(convertToShares(1_000n, 10_000n, 20_000n)).toBe(
      (1_000n * 10_001n) / 20_001n,
    );
    expect(convertToAssets(500n, 10_000n, 20_000n)).toBe(
      (500n * 20_001n) / 10_001n,
    );
  });

  // Formats display strings with trimming and truncation.
  it('formats display strings with trimming and truncation', () => {
    expect(toDisplayString(123_456_789n, 6, { maxFractionDigits: 2 })).toBe('123.45');
    expect(toDisplayString(123_400_000n, 6)).toBe('123.4');
    expect(toDisplayString(123_000_000n, 6)).toBe('123');
  });

  // Validates branded address and transaction hash inputs.
  it('validates branded address and transaction hash inputs', () => {
    expect(evmAddress('0x1111111111111111111111111111111111111111')).toBe(
      '0x1111111111111111111111111111111111111111',
    );
    expect(() => evmAddress('0x123')).toThrow(DivigentError);
    expect(txHash('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(() => txHash('0x1234')).toThrow(DivigentError);
  });
});
