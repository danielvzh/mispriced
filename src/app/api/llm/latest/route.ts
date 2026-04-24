import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(req: NextRequest) {
  const raw = parseInt(req.nextUrl.searchParams.get("limit") || String(DEFAULT_LIMIT), 10);
  const limit = isFinite(raw) && raw > 0 ? Math.min(MAX_LIMIT, raw) : DEFAULT_LIMIT;

  try {
    const runs = await prisma.llmRun.findMany({
      where: { modelName: { startsWith: "xai/" } },
      orderBy: { ranAt: "desc" },
      take: limit,
      select: {
        marketId: true,
        modelName: true,
        probability: true,
        confidence: true,
        ranAt: true,
        market: {
          select: {
            slug: true,
            question: true,
          },
        },
      },
    });

    return NextResponse.json({
      runs: runs.map((r) => ({
        marketId: r.marketId,
        slug: r.market.slug,
        question: r.market.question,
        modelName: r.modelName,
        probability: r.probability,
        confidence: r.confidence,
        ranAt: r.ranAt,
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: "database_unavailable", message: String(e) },
      { status: 503 },
    );
  }
}

