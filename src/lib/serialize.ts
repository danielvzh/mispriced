import type { Market, MarketConsensus } from "@prisma/client";
import { categoryTheta, horizonForEnd } from "@/lib/categories";
import { edgeToLabelMkt, radiusFromDistortion } from "@/lib/scoring";

export type MWithConsensus = Market & { consensus: MarketConsensus | null };

function jitter(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return ((h % 1000) / 1_000) * 0.04 - 0.02;
}

export type MarketDTO = {
  id: string;
  slug: string;
  question: string;
  category: string;
  endDate: string | null;
  marketProb: number;
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
  spread: number | null;
  volume24h: number;
  liquidityScore: number;
  updated: string;
  consensusProb: number | null;
  edge: number | null;
  agreement: number | null;
  confidence: number | null;
  distortion: number | null;
  verdict: string | null;
  lowProb: number | null;
  highProb: number | null;
  isSynthetic: boolean;
  rNorm: number;
  theta: number;
  dotLabel: "underpriced" | "overpriced" | "mixed" | "neutral";
  horizon: "short" | "medium" | "long";
  yesAssetId: string;
  closed: boolean;
};

export function toMarketDTO(m: MWithConsensus): MarketDTO {
  const c = m.consensus;
  const d = c?.distortionScore ?? 0.02;
  const r0 = c ? radiusFromDistortion(d, jitter(m.id)) : 0.88;
  const theta = categoryTheta(m.category, m.slug, m.question);
  const ag = c?.agreementScore ?? 0.5;
  const ed = c?.edge ?? 0;
  const label: MarketDTO["dotLabel"] = c ? edgeToLabelMkt(ed, ag, 0.02) : "neutral";
  return {
    id: m.id,
    slug: m.slug,
    question: m.question,
    category: m.category,
    endDate: m.endDate ? m.endDate.toISOString() : null,
    marketProb: m.marketProb,
    bestBid: m.bestBid,
    bestAsk: m.bestAsk,
    midpoint: m.midpoint,
    spread: m.spread,
    volume24h: m.volume24h,
    liquidityScore: m.liquidityScore,
    updated: (m.lastPolymarketSyncAt ?? m.polUpdatedAt ?? new Date()).toISOString(),
    consensusProb: c?.consensusProb ?? null,
    edge: c?.edge ?? null,
    agreement: c?.agreementScore ?? null,
    confidence: c?.confidenceScore ?? null,
    distortion: c?.distortionScore ?? null,
    verdict: c?.verdict ?? null,
    lowProb: c?.lowProb ?? null,
    highProb: c?.highProb ?? null,
    isSynthetic: c?.isSynthetic ?? false,
    rNorm: r0,
    theta,
    dotLabel: label,
    horizon: horizonForEnd(m.endDate),
    yesAssetId: m.yesAssetId,
    closed: m.closed,
  };
}
