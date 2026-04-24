import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { toMarketDTO } from "@/lib/serialize";
import { CATEGORY_SLUGS } from "@/lib/categories";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const RING_LABELS = [
  { id: "reality", name: "Reality Distortion", rMin: 0, rMax: 0.28 },
  { id: "wild", name: "Wild", rMin: 0.28, rMax: 0.5 },
  { id: "questionable", name: "Questionable", rMin: 0.5, rMax: 0.75 },
  { id: "fair", name: "Fair", rMin: 0.75, rMax: 1 },
] as const;

export async function GET() {
  try {
    const rows = await prisma.market.findMany({
      where: { active: true, closed: false },
      include: { consensus: true },
      take: 20_000,
      orderBy: { lastPolymarketSyncAt: "desc" },
    });
    const items = rows.map(toMarketDTO);
    return NextResponse.json({
      rings: RING_LABELS,
      categories: CATEGORY_SLUGS,
      legend: {
        rings: "Center = stronger model-implied distortion signal (per confidence, liquidity, and agreement). Outer = model-implied fairer vs market price.",
        colors: "Color encodes how multi-model ‘fair’ compares to the market, when models agree. Wide model spread is shown as mixed (not ‘more distorted’).",
        size: "Larger = more 24h volume and approximate liquidity score.",
        disclaimer:
          "LLM estimates are not objective probabilities — they are reasoning-based model-implied ranges.",
      },
      markets: items,
      count: items.length,
    });
  } catch (e) {
    return NextResponse.json(
      { error: "database_unavailable", message: String(e) },
      { status: 503 },
    );
  }
}
