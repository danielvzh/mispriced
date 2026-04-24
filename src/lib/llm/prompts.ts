export const PROMPT_VERSION = "v1";

export function buildMarketPacket(m: {
  question: string;
  description: string | null;
  endDate: Date | null;
  marketProb: number;
}): string {
  return [
    "You evaluate prediction market questions. Respond with strict JSON only (no markdown, no backticks).",
    "",
    `QUESTION: ${m.question}`,
    m.description ? `RESOLUTION / DESCRIPTION (if useful): ${m.description.slice(0, 4_000)}` : "",
    m.endDate ? `CLOSE / END (if known): ${m.endDate.toISOString()}` : "",
    `CURRENT MARKET IMPLIED PROBABILITY (YES, from Polymarket): ${(m.marketProb * 100).toFixed(1)}%`,
    "",
    "Output JSON with keys exactly:",
    '{"probability_yes":0.0-1.0,"confidence":0-1,"reasons":["3-5 short bullets"],"counterarguments":["2-3 bullets"]}',
    "",
    "This is a reasoning-based estimate, not a claim of objective ground truth. Be concise.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function systemPrompt(): string {
  return "You are a careful forecaster. Output JSON only, valid UTF-8. Never output chain-of-thought as free text; keep reasons as short bullets.";
}

