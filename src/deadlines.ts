import type { PublicClient } from 'viem';
import { DivigentError, runRead } from './errors';

export const SIGNATURE_DEADLINE_SAFETY_MARGIN_SECONDS = 60n;

export async function assertSignatureDeadline(
  publicClient: PublicClient,
  deadline: bigint,
  label: string,
): Promise<void> {
  const { timestamp } = await runRead(() => publicClient.getBlock());
  const minDeadline = timestamp + SIGNATURE_DEADLINE_SAFETY_MARGIN_SECONDS;
  if (deadline > minDeadline) return;

  throw new DivigentError(
    `[@divigent/sdk] ${label} deadline is expired or too close to expiry`,
    {
      code: 'DIVIGENT_SIGNATURE_DEADLINE_TOO_SOON',
      category: 'validation',
      context: {
        label,
        deadline,
        currentTimestamp: timestamp,
        minDeadline,
        safetyMarginSeconds: SIGNATURE_DEADLINE_SAFETY_MARGIN_SECONDS,
      },
    },
  );
}
