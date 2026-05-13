import { DivigentError } from '../errors';
import type { VaultType } from '../types';

export function vaultTypeFromId(id: number | bigint): VaultType {
  const value = Number(id);
  if (value === 0) return 'AAVE';
  if (value === 1) return 'MORPHO';
  throw new DivigentError(`[@divigent/sdk] unknown VaultType id: ${value}`, {
    code: 'DIVIGENT_UNKNOWN_VAULT_TYPE',
    category: 'validation',
    context: { id: value },
  });
}

export function vaultTypeToId(vaultType: VaultType): 0 | 1 {
  return vaultType === 'AAVE' ? 0 : 1;
}
