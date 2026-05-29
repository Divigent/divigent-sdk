import type { WalletBehaviorReport, AnalyzeWalletBehaviorInput, WalletAnalysisClientInput } from './types';
import {
  chainConfigForAnalysis,
  collectWalletBehaviorSeries,
  createAnalysisPublicClient,
} from './shared';

/** Analyze a wallet's recent Base USDC behavior without making a recommendation. */
export async function analyzeWalletBehavior(
  input: AnalyzeWalletBehaviorInput,
): Promise<WalletBehaviorReport> {
  const config = chainConfigForAnalysis(input.chainId);
  return analyzeWalletBehaviorWithClient({
    publicClient: createAnalysisPublicClient(config.id, input.rpcUrl),
    usdcAddress: config.addresses.usdc,
    internalAddresses: [config.addresses.router],
    wallet: input.wallet,
    chainId: config.id,
    ...(input.lookbackDays !== undefined && { lookbackDays: input.lookbackDays }),
  });
}

export async function analyzeWalletBehaviorWithClient(
  input: WalletAnalysisClientInput,
): Promise<WalletBehaviorReport> {
  return (await collectWalletBehaviorSeries(input)).report;
}
