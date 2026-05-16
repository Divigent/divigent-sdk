import { getAddresses, type DivigentChain } from '../core/chains';
import type { EvmAddress, Prettify } from '../types';

export type X402AssetTransferMethod = 'eip3009' | 'permit2';

/** @notice x402 token metadata required by common USDC settlement paths. */
export type X402UsdcExtra = Prettify<{
  /** @notice EIP-712 token name, required for Circle USDC EIP-3009. */
  readonly name?: string;
  /** @notice EIP-712 token version, required for Circle USDC EIP-3009. */
  readonly version?: string;
  /** @notice Transfer method advertised in x402 payment requirements. */
  readonly assetTransferMethod: X402AssetTransferMethod;
}>;

/** @notice x402 price object for a Divigent-supported USDC asset. */
export type X402UsdcPrice = Prettify<{
  readonly amount: string;
  readonly asset: EvmAddress;
  readonly extra: X402UsdcExtra;
}>;

/** @notice Default x402 USDC metadata for Divigent-supported chains. */
export const X402_USDC_EXTRA_BY_CHAIN = {
  base: {
    name: 'USD Coin',
    version: '2',
    assetTransferMethod: 'eip3009',
  },
  'base-sepolia': {
    assetTransferMethod: 'permit2',
  },
} as const satisfies Record<DivigentChain, X402UsdcExtra>;

/**
 * @notice Return x402 USDC metadata for a supported Divigent chain.
 * @param chain Supported Divigent chain.
 * @returns Metadata suitable for the `accepts.price.extra` field.
 */
export function x402UsdcExtra(chain: DivigentChain): X402UsdcExtra {
  return X402_USDC_EXTRA_BY_CHAIN[chain];
}

/**
 * @notice Build a complete x402 USDC price object for a Divigent-supported chain.
 * @param params Chain, atomic USDC amount, and optional asset override.
 * @returns Price object suitable for x402 seller payment requirements.
 */
export function x402UsdcPrice(params: {
  chain: DivigentChain;
  amount: bigint | string;
  asset?: EvmAddress;
}): X402UsdcPrice {
  return {
    amount: params.amount.toString(),
    asset: params.asset ?? getAddresses(params.chain).usdc,
    extra: x402UsdcExtra(params.chain),
  };
}
