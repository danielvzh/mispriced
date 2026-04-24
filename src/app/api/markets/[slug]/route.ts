import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { toMarketDTO } from "@/lib/serialize";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  try {
    const m = await prisma.market.findUnique({
      where: { slug },
      include: { consensus: true },
    });
    if (!m) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const [history, runs] = await Promise.all([
      prisma.marketHistory.findMany({
        where: { marketId: m.id },
        orderBy: { timestamp: "asc" },
        take: 96,
        select: { timestamp: true, marketProb: true, volume24h: true },
      }),
      prisma.llmRun.findMany({
        where: {
          marketId: m.id,
          NOT: {
            modelName: { startsWith: "Demo: reasoning-estimate" },
          },
        },
        orderBy: { ranAt: "desc" },
        take: 20,
        select: {
          modelName: true,
          probability: true,
          confidence: true,
          reasoningSummary: true,
          ranAt: true,
        },
      }),
    ]);
    return NextResponse.json({
      market: toMarketDTO(
        m as import("@/lib/serialize").MWithConsensus,
      ),
      modelEstimates: runs,
      history,
    });
  } catch (e) {
    return NextResponse.json(
      { error: "database_unavailable", message: String(e) },
      { status: 503 },
    );
  }
}
