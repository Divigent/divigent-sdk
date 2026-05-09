import { formatUnits, parseUnits } from 'viem';
import { DivigentError } from '../errors';

// Constants

export const USDC_DECIMALS = 6;

/** @notice Basis-points denominator: 10_000 bps = 100%. */
export const BPS_DENOMINATOR: bigint = 10_000n;

// USDC amount helpers

/**
 * @notice Parse a human USDC amount like `"12.34"` into 6-decimal atomic units.
 * @param value Decimal USDC string.
 * @returns USDC amount in atomic units.
 */
export function parseUsdc(value: string): bigint {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) {
    throw new DivigentError(`[@divigent/sdk] invalid USDC amount: ${value}`, {
      code: 'DIVIGENT_INVALID_USDC_AMOUNT',
      category: 'validation',
      context: { value },
    });
  }
  return parseUnits(value, USDC_DECIMALS);
}

/**
 * @notice Format 6-decimal USDC atomic units into a decimal string.
 * @param value USDC amount in atomic units.
 * @returns Decimal USDC string.
 */
export function formatUsdc(value: bigint): string {
  return formatUnits(value, USDC_DECIMALS);
}

// Bigint helpers

/**
 * @notice Return the smaller of two bigint values.
 * @param a First value.
 * @param b Second value.
 * @returns The minimum value.
 */
export function bigintMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * @notice Return the larger of two bigint values.
 * @param a First value.
 * @param b Second value.
 * @returns The maximum value.
 */
export function bigintMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * @notice Return the absolute value of a bigint.
 * @param a Value to normalize.
 * @returns Absolute value.
 */
export function bigintAbs(a: bigint): bigint {
  return a < 0n ? -a : a;
}

// BPS helpers

/**
 * @notice Apply a basis-points rate to an amount using floor division.
 * @param amount Base amount.
 * @param bps Basis-points rate.
 * @returns `amount * bps / 10_000`.
 */
export function applyBps(amount: bigint, bps: number | bigint): bigint {
  const bpsBI = typeof bps === 'bigint' ? bps : BigInt(bps);
  return (amount * bpsBI) / BPS_DENOMINATOR;
}

/**
 * @notice Reduce an amount by slippage bps.
 * @param amount Base amount.
 * @param bps Slippage basis points.
 * @returns Amount after slippage.
 * @throws If `bps` is outside 0..10_000.
 */
export function applySlippageDown(amount: bigint, bps: number | bigint): bigint {
  const bpsBI = typeof bps === 'bigint' ? bps : BigInt(bps);
  if (bpsBI < 0n || bpsBI > BPS_DENOMINATOR) {
    throw new DivigentError(`[@divigent/sdk] invalid slippage bps: ${bpsBI}`, {
      code: 'DIVIGENT_INVALID_SLIPPAGE_BPS',
      category: 'validation',
      context: { bps: bpsBI },
    });
  }
  return (amount * (BPS_DENOMINATOR - bpsBI)) / BPS_DENOMINATOR;
}

/** @notice Default Divigent protocol fee on earned yield: 1_000 bps = 10%. */
export const DIVIGENT_FEE_BPS: bigint = 1_000n; // 10%

/**
 * @notice Calculate the protocol fee charged on earned yield.
 * @param yieldEarned Yield amount in USDC atomic units.
 * @param feeBps Fee rate in basis points.
 * @returns Fee amount in USDC atomic units.
 * @throws If `feeBps` is outside 0..10_000.
 */
export function applyFee(yieldEarned: bigint, feeBps: bigint = DIVIGENT_FEE_BPS): bigint {
  if (feeBps < 0n || feeBps > BPS_DENOMINATOR) {
    throw new DivigentError(`[@divigent/sdk] invalid fee bps: ${feeBps}`, {
      code: 'DIVIGENT_INVALID_FEE_BPS',
      category: 'validation',
      context: { feeBps },
    });
  }
  return (yieldEarned * feeBps) / BPS_DENOMINATOR;
}

// Decimal rescaling

/** @notice Rounding mode used when reducing token decimal precision. */
export type Rounding = 'floor' | 'ceil';

/**
 * @notice Rescale atomic token units between decimal precisions.
 * @param amount Amount in source token atomic units.
 * @param fromDecimals Source token decimals.
 * @param toDecimals Target token decimals.
 * @param rounding Rounding mode used when precision is reduced.
 * @returns Amount in target token atomic units.
 */
export function rescaleDecimals(
  amount: bigint,
  fromDecimals: number,
  toDecimals: number,
  rounding: Rounding = 'floor',
): bigint {
  if (fromDecimals === toDecimals) return amount;
  if (fromDecimals < toDecimals) {
    return amount * 10n ** BigInt(toDecimals - fromDecimals);
  }
  const divisor = 10n ** BigInt(fromDecimals - toDecimals);
  const quotient = amount / divisor;
  if (rounding === 'ceil' && amount % divisor !== 0n) return quotient + 1n;
  return quotient;
}

// ERC-4626 virtual-offset share math

/**
 * @notice Preview shares minted for an asset amount using the router's virtual-offset math.
 * @param assets Asset amount.
 * @param totalSupply Current share supply.
 * @param totalAssets Current total assets.
 * @returns Share amount.
 */
export function convertToShares(
  assets: bigint,
  totalSupply: bigint,
  totalAssets: bigint,
): bigint {
  return (assets * (totalSupply + 1n)) / (totalAssets + 1n);
}

/**
 * @notice Preview assets returned for a share amount using the router's virtual-offset math.
 * @param shares Share amount.
 * @param totalSupply Current share supply.
 * @param totalAssets Current total assets.
 * @returns Asset amount.
 */
export function convertToAssets(
  shares: bigint,
  totalSupply: bigint,
  totalAssets: bigint,
): bigint {
  return (shares * (totalAssets + 1n)) / (totalSupply + 1n);
}

// Display formatter

/**
 * @notice Format arbitrary token units for UI display with optional fraction trimming.
 * @param amount Amount in atomic units.
 * @param decimals Token decimals.
 * @param opts Display options.
 * @returns Decimal display string.
 */
export function toDisplayString(
  amount: bigint,
  decimals: number,
  opts: { maxFractionDigits?: number; trimTrailingZeros?: boolean } = {},
): string {
  const { maxFractionDigits, trimTrailingZeros = true } = opts;
  const raw = formatUnits(amount, decimals);
  const [whole, frac = ''] = raw.split('.');

  let fraction = frac;
  if (maxFractionDigits !== undefined && fraction.length > maxFractionDigits) {
    fraction = fraction.slice(0, maxFractionDigits);
  }
  if (trimTrailingZeros) {
    fraction = fraction.replace(/0+$/, '');
  }

  return fraction.length > 0 ? `${whole}.${fraction}` : (whole ?? '0');
}
