import { base, baseSepolia, type Chain } from 'viem/chains';
import { DivigentError } from '../errors';
import { type EvmAddress, evmAddress } from '../types';

export type DivigentChain = 'base' | 'base-sepolia';

/** @notice Contract addresses needed to operate one Divigent deployment. */
export type ContractAddresses = {
  router:                   EvmAddress;
  oracle:                   EvmAddress;
  feeCollector:             EvmAddress;
  dvUsdc:                   EvmAddress;
  usdc:                     EvmAddress;
  aavePool:                 EvmAddress;
  aToken:                   EvmAddress;
  steakhouseUSDCPrimeVault: EvmAddress;
};

/** @notice Chain metadata plus the default address registry for that chain. */
export type ChainConfig = {
  id: number;
  name: DivigentChain;
  viemChain: Chain;
  addresses: ContractAddresses;
};

/** @notice Canonical zero address used for not-yet-deployed protocol contracts. */
export const ZERO_ADDRESS: EvmAddress = evmAddress('0x0000000000000000000000000000000000000000');

/** @notice Built-in chain registry for supported Base deployments. */
export const CHAINS = {
  base: {
    id: base.id,
    name: 'base',
    viemChain: base,
    addresses: {
      router:                   evmAddress('0xE958A89c2CCa697d4896990685800cc1D5AF2A01'),
      oracle:                   evmAddress('0x3Ba775E8fAE60E72c99dE10C720fC44ab38BF71A'),
      feeCollector:             evmAddress('0x1a2eF76E6E323D95f836917f812f6D159c3A0960'),
      dvUsdc:                   evmAddress('0x1497f7F3b156e110b1d90BC7F1759F40fb48Ea4F'),
      usdc:                     evmAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
      aavePool:                 evmAddress('0xA238Dd80C259a72e81d7e4664a9801593F98d1c5'),
      aToken:                   evmAddress('0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB'),
      steakhouseUSDCPrimeVault: evmAddress('0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183'),
    },
  },
  'base-sepolia': {
    id: baseSepolia.id,
    name: 'base-sepolia',
    viemChain: baseSepolia,
    addresses: {
      router:                   evmAddress('0x17180C48f904D2b675bBa67519b7879F6b036053'),
      oracle:                   evmAddress('0xEA191c9B25464975A46Cb482dCfD7964F44a4246'),
      feeCollector:             evmAddress('0x60cB437995551d19C59BEa25c045A739ed6A0f54'),
      dvUsdc:                   evmAddress('0xD518B1329d0EC47EeC45775A988a18f93C37862A'),
      usdc:                     evmAddress('0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f'),
      aavePool:                 evmAddress('0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27'),
      aToken:                   evmAddress('0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC'),
      steakhouseUSDCPrimeVault: evmAddress('0x7d646Ac22d219507f02D9154a321f34c6F0f3b08'),
    },
  },
} as const satisfies Record<DivigentChain, ChainConfig>;

/**
 * @notice Return chain metadata for a supported Divigent chain.
 * @param chain Supported Divigent chain id.
 * @returns Chain metadata and default addresses.
 */
export function getChainConfig(chain: DivigentChain): ChainConfig {
  const config = CHAINS[chain];
  if (!config) {
    throw new DivigentError(`[@divigent/sdk] unknown chain: "${chain}"`, {
      code: 'DIVIGENT_UNKNOWN_CHAIN',
      category: 'config',
      context: { chain },
    });
  }
  return config;
}

/**
 * @notice Return the default contract address set for a supported chain.
 * @param chain Supported Divigent chain id.
 * @returns Contract address registry for the chain.
 */
export function getAddresses(chain: DivigentChain): ContractAddresses {
  return getChainConfig(chain).addresses;
}

/**
 * @notice Resolve a Divigent chain name from an EVM chain id.
 * @param chainId EVM chain id.
 * @returns Supported Divigent chain name, or undefined for unsupported ids.
 */
export function chainFromId(chainId: number): DivigentChain | undefined {
  const entries = Object.entries(CHAINS) as Array<[DivigentChain, ChainConfig]>;
  return entries.find(([, config]) => config.id === chainId)?.[0];
}

/**
 * @notice Check whether an address is the canonical zero address.
 * @param address Address to check.
 * @returns True when `address` is zero.
 */
export function isZeroAddress(address: EvmAddress): boolean {
  return address === ZERO_ADDRESS;
}

/**
 * @notice Throw if the selected chain still has placeholder protocol addresses.
 * @param chain Supported Divigent chain id.
 * @throws If router/oracle/feeCollector/dvUsdc are not deployed in the registry.
 */
export function assertProtocolDeployed(chain: DivigentChain): void {
  const addr = getAddresses(chain);
  const missing: string[] = [];
  if (isZeroAddress(addr.router))       missing.push('router');
  if (isZeroAddress(addr.oracle))       missing.push('oracle');
  if (isZeroAddress(addr.feeCollector)) missing.push('feeCollector');
  if (isZeroAddress(addr.dvUsdc))       missing.push('dvUsdc');
  if (missing.length > 0) {
    throw new DivigentError(
      `[@divigent/sdk] Divigent protocol not deployed on "${chain}": missing [${missing.join(', ')}]`,
      {
        code: 'DIVIGENT_PROTOCOL_NOT_DEPLOYED',
        category: 'config',
        context: { chain, missing },
      },
    );
  }
}
