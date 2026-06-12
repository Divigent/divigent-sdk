import { DivigentError } from './errors';
import type { FeeOverrides } from './types';

const ALLOWED_FEE_OVERRIDE_KEYS = new Set<PropertyKey>([
  'maxFeePerGas',
  'maxPriorityFeePerGas',
]);

function assertFeeValue(field: keyof FeeOverrides, value: unknown): asserts value is bigint {
  if (value === undefined || typeof value === 'bigint') return;
  throw new DivigentError(
    `[@divigent/sdk] fee override ${field} must be a bigint when provided`,
    {
      code: 'DIVIGENT_INVALID_FEE_OVERRIDES',
      category: 'validation',
      context: { field, value },
    },
  );
}

export function sanitizeFeeOverrides(fees: FeeOverrides | undefined): FeeOverrides | undefined {
  if (fees === undefined) return undefined;
  if (fees === null || typeof fees !== 'object') {
    throw new DivigentError('[@divigent/sdk] fee overrides must be an object', {
      code: 'DIVIGENT_INVALID_FEE_OVERRIDES',
      category: 'validation',
      context: { value: fees },
    });
  }

  for (const key of Reflect.ownKeys(fees)) {
    if (!ALLOWED_FEE_OVERRIDE_KEYS.has(key)) {
      throw new DivigentError(`[@divigent/sdk] unsupported fee override field: ${String(key)}`, {
        code: 'DIVIGENT_INVALID_FEE_OVERRIDES',
        category: 'validation',
        context: { field: String(key) },
      });
    }
  }

  const sanitized: FeeOverrides = {};
  assertFeeValue('maxFeePerGas', fees.maxFeePerGas);
  assertFeeValue('maxPriorityFeePerGas', fees.maxPriorityFeePerGas);
  if (fees.maxFeePerGas !== undefined) sanitized.maxFeePerGas = fees.maxFeePerGas;
  if (fees.maxPriorityFeePerGas !== undefined) {
    sanitized.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}
