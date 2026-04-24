import { recomputeWithXai } from "./xai";
import { seedSyntheticRunsAndConsensus } from "./synthetic";

/** Grok (xAI) only; set XAI_API_KEY. Otherwise demo synthetic estimates. */
export async function recomputeLlm(marketId: string): Promise<void> {
  if (process.env.XAI_API_KEY) {
    return recomputeWithXai(marketId, { allowSyntheticFallback: false });
  }
  return seedSyntheticRunsAndConsensus(marketId);
}
