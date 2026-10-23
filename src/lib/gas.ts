/**
 * Gas estimation helpers.
 * maxFeePerGas = max(2 × latest baseFee, 21 gwei)
 * maxPriorityFeePerGas = 1 gwei
 */
import { type PublicClient, parseGwei } from 'viem';

const MIN_MAX_FEE = parseGwei('21');
const PRIORITY_FEE = parseGwei('1');

export async function getGasOverrides(client: PublicClient): Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}> {
  try {
    const block = await client.getBlock({ blockTag: 'latest' });
    const baseFee = block.baseFeePerGas ?? 0n;
    const maxFeePerGas = baseFee * 2n > MIN_MAX_FEE ? baseFee * 2n : MIN_MAX_FEE;
    return { maxFeePerGas, maxPriorityFeePerGas: PRIORITY_FEE };
  } catch {
    return { maxFeePerGas: MIN_MAX_FEE, maxPriorityFeePerGas: PRIORITY_FEE };
  }
}
