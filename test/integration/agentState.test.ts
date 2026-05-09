import { expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { parseUsdc } from '../../src/core/utils';
import type { EvmAddress } from '../../src/types';
import { divigentBaseMainnetForkTest as test } from '../fork/setup';
import { X402_AGENT_READ_PRIVATE_KEY } from './helpers/x402AgentFork';

// Verifies the agent can read deployed protocol state before moving funds.
test.sequential(
  'x402 agent reads protocol and account state before liquidity actions',
  async ({ divigent }) => {
    const agentWallet = privateKeyToAccount(X402_AGENT_READ_PRIVATE_KEY).address as EvmAddress;
    const amount = parseUsdc('10');

    await expect(divigent.verifyAddresses()).resolves.toBeUndefined();

    const [
      position,
      withdrawCapacity,
      allocation,
      pricePerShare,
      totalVaultAssets,
      tvlCap,
      costBasis,
      previewShares,
      convertedShares,
      depositsPaused,
      optimalVault,
      allRates,
      aaveSafe,
      morphoSafe,
      oracleFresh,
      oracleStatus,
      observationAge,
      treasuryStatus,
      feeOnOneUsdc,
      dvUsdcSupply,
      liquidUsdc,
      routerAllowance,
      authorized,
      nonce,
    ] = await Promise.all([
      divigent.getPosition(agentWallet),
      divigent.withdrawCapacity(),
      divigent.getCurrentAllocation(),
      divigent.pricePerShare(),
      divigent.totalVaultAssets(),
      divigent.currentTVLCap(),
      divigent.costBasis(agentWallet),
      divigent.previewDeposit(amount),
      divigent.convertToShares(amount),
      divigent.depositsPaused(),
      divigent.getOptimalVault(),
      divigent.getAllRates(),
      divigent.isVaultSafe('AAVE'),
      divigent.isVaultSafe('MORPHO'),
      divigent.isFresh(),
      divigent.oracleStatus(),
      divigent.lastGoodObservationAge(),
      divigent.treasuryStatus(),
      divigent.calculateFee(parseUsdc('1')),
      divigent.dvUsdcTotalSupply(),
      divigent.usdcBalance(agentWallet),
      divigent.usdcAllowance(agentWallet),
      divigent.isAuthorized(agentWallet),
      divigent.nonce(agentWallet),
    ]);

    expect(position).toEqual({
      depositedUSDC: 0n,
      currentValue: 0n,
      accruedYield: 0n,
    });
    expect(costBasis).toBe(0n);
    expect(liquidUsdc).toBeGreaterThanOrEqual(0n);
    expect(routerAllowance).toBeGreaterThanOrEqual(0n);
    expect(authorized).toBe(false);
    expect(nonce).toBeGreaterThanOrEqual(0n);
    expect(withdrawCapacity.totalWithdrawCap).toBeGreaterThanOrEqual(0n);
    expect(allocation.aaveAssets + allocation.morphoAssets).toBeGreaterThanOrEqual(0n);
    expect(pricePerShare).toBeGreaterThan(0n);
    expect(totalVaultAssets).toBeGreaterThanOrEqual(0n);
    expect(tvlCap).toBeGreaterThan(0n);
    expect(previewShares).toBeGreaterThan(0n);
    expect(convertedShares).toBe(previewShares);
    expect(typeof depositsPaused).toBe('boolean');
    expect(['AAVE', 'MORPHO']).toContain(optimalVault.vaultType);
    expect(optimalVault.twarRate).toBeGreaterThanOrEqual(0n);
    expect(allRates.length).toBeGreaterThanOrEqual(2);
    expect(typeof aaveSafe).toBe('boolean');
    expect(typeof morphoSafe).toBe('boolean');
    expect(typeof oracleFresh).toBe('boolean');
    expect(typeof oracleStatus.fresh).toBe('boolean');
    expect(oracleStatus.lastObservationTime).toBeGreaterThanOrEqual(0n);
    expect(observationAge).toBeGreaterThanOrEqual(0n);
    expect(treasuryStatus.current).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(feeOnOneUsdc).toBeGreaterThanOrEqual(0n);
    expect(dvUsdcSupply).toBeGreaterThanOrEqual(0n);
  },
);
