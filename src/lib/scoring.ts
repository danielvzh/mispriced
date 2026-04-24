import { z } from "zod";

export const llmResponseSchema = z.object({
  probability_yes: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1).optional(),
  reasons: z.array(z.string()).optional(),
  counterarguments: z.array(z.string()).optional(),
});

export type LlmResponse = z.infer<typeof llmResponseSchema>;

export function median(nums: number[]): number {
  if (nums.length === 0) return 0.5;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function stddev(nums: number[]): number {
  if (nums.length < 2) return 0;
  const m = nums.reduce((a, b) => a + b, 0) / nums.length;
  const v = nums.reduce((a, b) => a + (b - m) ** 2, 0) / (nums.length - 1);
  return Math.sqrt(v);
}

/**
 * Suggested: agreement = 1 - normalized stddev. Max spread of probs in [0,0.5] is typical; scale.
 */
export function agreementScoreFromProbs(probs: number[]): number {
  if (probs.length < 2) {
    return probs[0] != null ? 0.85 : 0;
  }
  const s = stddev(probs);
  // map std 0->1, 0.25+ ->0
  const a = 1 - Math.min(1, s / 0.22);
  return Math.max(0, Math.min(1, a));
}

/**
 * Heuristic evidence / reasoning quality: placeholder when we only have free-text density
 */
export function evidenceScoreFromRuns(
  reasonsCounts: number[],
  avgConfidence: number,
): number {
  const density = Math.min(1, reasonsCounts.reduce((a, b) => a + b, 0) / 16);
  return 0.45 + 0.55 * ((density + (avgConfidence || 0.5)) / 2);
}

/**
 * Map spread + vol + orderbook to [0,1] liquidity weight
 */
export function liquidityWeight(
  volume24h: number,
  spread: number | null,
  obDepth: number,
): number {
  const v = 1 - Math.exp(-Math.max(0, volume24h) / 1_200_000);
  const s = spread == null ? 0.5 : Math.max(0, 1 - spread * 6);
  const d = 1 - Math.exp(-(obDepth || 0) / 80_000);
  return 0.35 * v + 0.3 * s + 0.35 * d;
}

/**
 * Banded normalised radius: inner=high distortion, outer=fair. Returns [0,1] display radius.
 * Spec: inner=Reality, then Wild, then Questionable, outer=Fair
 */
export function radiusFromDistortion(
  score: number,
  jitter: number = 0,
): number {
  // score bands -> center radii; invert so higher dist is closer to center
  // inner ring: Reality
  if (score >= 0.15) return 0.18 + jitter;
  if (score >= 0.08) return 0.38 + jitter;
  if (score >= 0.03) return 0.62 + jitter;
  return 0.88 + jitter;
}

export function verdictForDistortion(
  d: number,
):
  | "reality"
  | "wild"
  | "questionable"
  | "fair" {
  if (d < 0.03) return "fair";
  if (d < 0.08) return "questionable";
  if (d < 0.15) return "wild";
  return "reality";
}

/**
 * If models disagree, pull distortion outward (closer to fair) per product note.
 * factor 0.35 means strong disagreement can nearly halve the effective band.
 */
export function adjustDistortionByAgreement(
  baseDistortion: number,
  agreement: number,
): number {
  const t = 1 - 0.65 * Math.max(0, 1 - agreement);
  return baseDistortion * t;
}

/**
 * full pipeline from model probs, market, liquidity, evidence
 */
export function computeConsensusMetrics(
  marketProb: number,
  modelProbs: number[],
  opts: { volume24h: number; spread: number | null; bookDepth: number; evidence: number },
): {
  consensusProb: number;
  edge: number;
  agreement: number;
  modelSpread: number;
  lowProb: number;
  highProb: number;
  confidence: number;
  distortionRaw: number;
} {
  const consensus = median(modelProbs);
  const edge = consensus - marketProb;
  const spread = modelProbs.length
    ? Math.max(...modelProbs) - Math.min(...modelProbs)
    : 0;
  const agreement = agreementScoreFromProbs(
    modelProbs.length ? modelProbs : [consensus, consensus * 0.99],
  );
  const lw = liquidityWeight(opts.volume24h, opts.spread, opts.bookDepth);
  const conf = Math.max(0, Math.min(1, agreement * opts.evidence * lw));
  const dRaw = Math.abs(edge) * conf;
  const d = adjustDistortionByAgreement(dRaw, agreement);
  return {
    consensusProb: consensus,
    edge,
    agreement,
    modelSpread: spread,
    lowProb: modelProbs.length ? Math.min(...modelProbs) : consensus,
    highProb: modelProbs.length ? Math.max(...modelProbs) : consensus,
    confidence: conf,
    distortionRaw: d,
  };
}

export const EDGE_LABEL = {
  underpriced: "Model-implied higher than market",
  overpriced: "Model-implied lower than market",
  mixed: "High model disagreement",
} as const;

export function edgeToLabel(
  edge: number,
  agreement: number,
  absThreshold = 0.02,
): "underpriced" | "overpriced" | "mixed" {
  if (agreement < 0.35) {
    return "mixed";
  }
  if (edge > absThreshold) {
    return "underpriced";
  }
  if (edge < -absThreshold) {
    return "overpriced";
  }
  if (agreement < 0.5) {
    return "mixed";
  }
  return "underpriced"; // default mild lean — rare if edge is tiny; UI can treat as neutral
}

/**
 * Refined: near-zero edge with ok agreement is not really under/over
 */
export function edgeToLabelMkt(
  edge: number,
  agreement: number,
  absThreshold = 0.02,
): "underpriced" | "overpriced" | "mixed" | "neutral" {
  if (agreement < 0.35) {
    return "mixed";
  }
  if (Math.abs(edge) < absThreshold) {
    return "neutral";
  }
  if (edge > 0) {
    return "underpriced";
  }
  return "overpriced";
}
