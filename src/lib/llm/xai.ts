import { OpenAI } from "openai";
import { buildMarketPacket, systemPrompt, PROMPT_VERSION } from "./prompts";
import {
  adjustDistortionByAgreement,
  computeConsensusMetrics,
  edgeToLabelMkt,
  evidenceScoreFromRuns,
  llmResponseSchema,
  verdictForDistortion,
} from "@/lib/scoring";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { fetchOrderBook, summarizeBook } from "@/lib/polymarket/clob";

const XAI_BASE = "https://api.x.ai/v1";

/** @see https://docs.x.ai/docs – override with XAI_MODELS (comma-separated). */
const DEFAULT_XAI_MODELS = ["grok-4-fast-non-reasoning"] as const;

const xaiClient = () =>
  new OpenAI({
    apiKey: process.env.XAI_API_KEY,
    baseURL: process.env.XAI_BASE_URL || XAI_BASE,
  });

function xaiModelList(): string[] {
  const v = process.env.XAI_MODELS;
  if (v?.length) {
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [...DEFAULT_XAI_MODELS];
}

async function oneGrok(
  model: string,
  user: string,
): Promise<{
  name: string;
  r: {
    probability_yes: number;
    confidence?: number;
    reasons?: string[];
    counterarguments?: string[];
  };
}> {
  const c = xaiClient();
  const r = await c.chat.completions.create({
    model,
    temperature: 0.2,
    max_tokens: 500,
    messages: [
      { role: "system", content: systemPrompt() },
      { role: "user", content: user },
    ],
  });
  const text = r.choices[0]?.message?.content;
  if (!text) {
    throw new Error("empty");
  }
  const jsonStr = text.replace(/^```[a-z]*\n?|```$/g, "").trim();
  const j = JSON.parse(jsonStr) as unknown;
  const p = llmResponseSchema.parse(j);
  return { name: `xai/${model}`, r: p };
}

/**
 * xAI (Grok) recompute. Requires `XAI_API_KEY`.
 */
export async function recomputeWithXai(
  marketId: string,
  opts: { allowSyntheticFallback?: boolean } = {},
): Promise<void> {
  const allowSyntheticFallback = opts.allowSyntheticFallback !== false;
  if (!process.env.XAI_API_KEY) {
    if (!allowSyntheticFallback) {
      throw new Error("xai_not_configured");
    }
    const { seedSyntheticRunsAndConsensus } = await import("./synthetic");
    return seedSyntheticRunsAndConsensus(marketId);
  }

  const mkt = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
  const book = mkt.yesAssetId ? await fetchOrderBook(mkt.yesAssetId) : null;
  const s = book ? summarizeBook(book) : { spread: mkt.spread, depth: 0 };

  const user = buildMarketPacket({
    question: mkt.question,
    description: mkt.description,
    endDate: mkt.endDate,
    marketProb: mkt.marketProb,
  });

  const models = xaiModelList();
  const results: { name: string; r: ReturnType<typeof llmResponseSchema.parse> }[] = [];

  for (const mod of models) {
    try {
      const o = await oneGrok(mod, user);
      results.push({ name: o.name, r: o.r });
    } catch {
      /* try next */
    }
  }
  if (results.length < 1) {
    if (!allowSyntheticFallback) {
      throw new Error("xai_no_model_result");
    }
    const { seedSyntheticRunsAndConsensus } = await import("./synthetic");
    return seedSyntheticRunsAndConsensus(marketId);
  }

  await prisma.llmRun.deleteMany({ where: { marketId } });

  const probs: number[] = [];
  for (const row of results) {
    const conf = row.r.confidence ?? 0.5;
    const text = `Reasons: ${(row.r.reasons || []).join(" | ")}. Counter: ${(row.r.counterarguments || []).join(" | ")}.`;
    await prisma.llmRun.create({
      data: {
        marketId,
        modelName: row.name,
        promptVersion: PROMPT_VERSION,
        probability: row.r.probability_yes,
        confidence: conf,
        reasoningSummary: text.slice(0, 2_000),
        evidenceJson: (row.r.reasons || []) as unknown as Prisma.InputJsonValue,
      },
    });
    probs.push(row.r.probability_yes);
  }

  const ev = evidenceScoreFromRuns(
    results.map(
      (r) =>
        (r.r.reasons?.length ?? 0) + (r.r.counterarguments?.length ?? 0),
    ),
    results
      .map((r) => r.r.confidence ?? 0.5)
      .reduce((a, b) => a + b, 0) / results.length,
  );
  const bookDepth = "depth" in s && typeof s.depth === "number" ? s.depth : 0;
  const metrics = computeConsensusMetrics(
    mkt.marketProb,
    probs,
    {
      volume24h: mkt.volume24h,
      spread: mkt.spread,
      bookDepth: bookDepth,
      evidence: ev,
    },
  );
  const d = adjustDistortionByAgreement(
    metrics.distortionRaw,
    metrics.agreement,
  );
  const vKey = verdictForDistortion(d);
  const label = edgeToLabelMkt(metrics.edge, metrics.agreement, 0.02);
  const labelText =
    label === "mixed"
      ? "LLM fair range: mixed (high disagreement among models)"
      : label;

  await prisma.marketConsensus.upsert({
    where: { marketId },
    create: {
      marketId,
      consensusProb: metrics.consensusProb,
      agreementScore: metrics.agreement,
      confidenceScore: metrics.confidence,
      edge: metrics.edge,
      distortionScore: d,
      verdict: vKey,
      isSynthetic: false,
      lastComputedAt: new Date(),
      modelSpread: metrics.modelSpread,
      lowProb: metrics.lowProb,
      highProb: metrics.highProb,
      underpricedLabel: labelText,
    },
    update: {
      consensusProb: metrics.consensusProb,
      agreementScore: metrics.agreement,
      confidenceScore: metrics.confidence,
      edge: metrics.edge,
      distortionScore: d,
      verdict: vKey,
      isSynthetic: false,
      lastComputedAt: new Date(),
      modelSpread: metrics.modelSpread,
      lowProb: metrics.lowProb,
      highProb: metrics.highProb,
      underpricedLabel: labelText,
    },
  });
}
