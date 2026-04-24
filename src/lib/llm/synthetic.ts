import { prisma } from "@/lib/db";
import {
  adjustDistortionByAgreement,
  computeConsensusMetrics,
  edgeToLabelMkt,
  verdictForDistortion,
} from "@/lib/scoring";

const DEMO_PREFIX = "reasoning-estimate";

function u01(s: string, salt: string): number {
  let h = 0;
  const t = s + salt;
  for (let i = 0; i < t.length; i++) h = (h * 33 + t.charCodeAt(i)) >>> 0;
  return (h % 10_000) / 10_000;
}

const N_DEMO = 5;

/**
 * Deterministic "demo" model outputs when no LLM API keys: shows UI without external spend
 */
export async function seedSyntheticRunsAndConsensus(
  marketId: string,
): Promise<void> {
  const m = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
  const p = m.marketProb;
  const base = p + (u01(m.slug, "e") - 0.5) * 0.12;
  const modelProbs = Array.from({ length: N_DEMO }, (_, i) =>
    Math.max(0.01, Math.min(0.99, base + (u01(m.slug, `m${i}`) - 0.5) * 0.14)),
  );

  await prisma.llmRun.deleteMany({ where: { marketId } });

  const avConf = 0.45 + u01(m.slug, "c") * 0.4;
  for (let i = 0; i < N_DEMO; i++) {
    const prob = modelProbs[i] ?? p;
    await prisma.llmRun.create({
      data: {
        marketId,
        modelName: `Demo: ${DEMO_PREFIX}-${i + 1}`,
        promptVersion: "synthetic",
        probability: prob,
        confidence: avConf,
        reasoningSummary:
          "Reasoning-based demo estimate. Set XAI_API_KEY or OPENROUTER_API_KEY for real model output.",
        evidenceJson: [],
      },
    });
  }

  const spread = m.spread;
  const bookDepth = 1;
  const evidence = 0.65;
  const metrics = computeConsensusMetrics(
    p,
    modelProbs,
    { volume24h: m.volume24h, spread, bookDepth, evidence },
  );
  const dFinal = adjustDistortionByAgreement(
    metrics.distortionRaw,
    metrics.agreement,
  );
  const verdict = verdictForDistortion(dFinal);
  const label = edgeToLabelMkt(metrics.edge, metrics.agreement, 0.02);

  await prisma.marketConsensus.upsert({
    where: { marketId },
    create: {
      marketId,
      consensusProb: metrics.consensusProb,
      agreementScore: metrics.agreement,
      confidenceScore: metrics.confidence,
      edge: metrics.edge,
      distortionScore: dFinal,
      verdict: verdict,
      isSynthetic: true,
      lastComputedAt: new Date(),
      modelSpread: metrics.modelSpread,
      lowProb: metrics.lowProb,
      highProb: metrics.highProb,
      underpricedLabel:
        label === "mixed"
          ? "LLM fair range: mixed (high disagreement among models)"
          : label,
    },
    update: {
      consensusProb: metrics.consensusProb,
      agreementScore: metrics.agreement,
      confidenceScore: metrics.confidence,
      edge: metrics.edge,
      distortionScore: dFinal,
      verdict,
      isSynthetic: true,
      lastComputedAt: new Date(),
      modelSpread: metrics.modelSpread,
      lowProb: metrics.lowProb,
      highProb: metrics.highProb,
      underpricedLabel:
        label === "mixed"
          ? "LLM fair range: mixed (high disagreement among models)"
          : label,
    },
  });
}
