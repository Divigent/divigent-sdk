import { DivigentError } from './errors';
import type { FeeOverrides } from './types';

const FEE_OVERRIDE_KEYS = ['maxFeePerGas', 'maxPriorityFeePerGas'] as const satisfies
  ReadonlyArray<keyof FeeOverrides>;

const FEE_OVERRIDE_KEY_SET = new Set<string>(FEE_OVERRIDE_KEYS);

/**
 * Runtime boundary for fee overrides accepted from JS callers.
 *
 * FeeOverrides is a TypeScript-only shape, so untyped callers can otherwise
 * smuggle transaction identity fields into spreads over simulated requests.
 */
export function sanitizeFeeOverrides(fees: FeeOverrides | undefined): FeeOverrides | undefined {
  if (fees === undefined) return undefined;
  if (fees === null || typeof fees !== 'object') {
    throw new DivigentError('[@divigent/sdk] fees must be an object', {
      code: 'DIVIGENT_INVALID_FEE_OVERRIDES',
      category: 'validation',
      context: { value: fees },
    });
  }

  const out: FeeOverrides = {};
  const unknownKeys: string[] = [];

  for (const [key, value] of Object.entries(fees)) {
    if (!FEE_OVERRIDE_KEY_SET.has(key)) {
      unknownKeys.push(key);
      continue;
    }
    if (value === undefined) continue;
    if (typeof value !== 'bigint') {
      throw new DivigentError(`[@divigent/sdk] fees.${key} must be a bigint`, {
        code: 'DIVIGENT_INVALID_FEE_OVERRIDES',
        category: 'validation',
        context: { field: key, value },
      });
    }
    if (value < 0n) {
      throw new DivigentError(`[@divigent/sdk] fees.${key} must be non-negative`, {
        code: 'DIVIGENT_INVALID_FEE_OVERRIDES',
        category: 'validation',
        context: { field: key, value },
      });
    }

    if (key === 'maxFeePerGas') {
      out.maxFeePerGas = value;
    } else {
      out.maxPriorityFeePerGas = value;
    }
  }

  if (unknownKeys.length > 0) {
    throw new DivigentError(
      `[@divigent/sdk] unknown keys in fees: ${unknownKeys.join(', ')}. ` +
        `Only ${FEE_OVERRIDE_KEYS.join(', ')} are allowed.`,
      {
        code: 'DIVIGENT_INVALID_FEE_OVERRIDES',
        category: 'validation',
        context: { unknownKeys },
      },
    );
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
