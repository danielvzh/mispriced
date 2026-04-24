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

const DEFAULT_MODELS = [
  "openai/gpt-4o-mini",
  "openai/gpt-4.1",
  "anthropic/claude-3.5-haiku",
  "google/gemini-2.0-flash-001",
] as const;

const orClient = () =>
  new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultHeaders: {
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://mispriced.markets",
      "X-Title": "Mispriced.markets",
    },
  });

function parseListEnv(key: string): string[] {
  const v = process.env[key];
  if (!v) {
    return [];
  }
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function effectiveModels(): string[] {
  const fromEnv = parseListEnv("OPENROUTER_MODELS");
  if (fromEnv.length) {
    return fromEnv;
  }
  return [...DEFAULT_MODELS];
}

async function oneModel(
  model: string,
  user: string,
): Promise<{
  name: string;
  r: { probability_yes: number; confidence?: number; reasons?: string[]; counterarguments?: string[] };
}> {
  const c = orClient();
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
  return { name: model, r: p };
}

export async function recomputeWithOpenRouter(marketId: string): Promise<void> {
  const mkt = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
  const book = mkt.yesAssetId ? await fetchOrderBook(mkt.yesAssetId) : null;
  const s = book ? summarizeBook(book) : { spread: mkt.spread, depth: 0 };

  const user = buildMarketPacket({
    question: mkt.question,
    description: mkt.description,
    endDate: mkt.endDate,
    marketProb: mkt.marketProb,
  });

  const models = effectiveModels();
  const results: { name: string; r: ReturnType<typeof llmResponseSchema.parse> }[] = [];

  for (const mod of models) {
    try {
      const o = await oneModel(mod, user);
      results.push({ name: o.name, r: o.r });
    } catch {
      /* skip failed model */
    }
  }
  if (results.length < 1) {
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
