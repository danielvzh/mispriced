import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { toMarketDTO, type MWithConsensus } from "@/lib/serialize";
import { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

type Sort = "distortion" | "edge" | "volume" | "updated";
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const category = p.get("category");
  const verdict = p.get("verdict");
  const sort = (p.get("sort") || "distortion") as Sort;
  const minConfidence = p.get("minConfidence");
  const minLiquidity = p.get("minLiquidity");
  const grokOnly = p.get("grokOnly") === "1";
  const pageRaw = parseInt(p.get("page") || "1", 10);
  const limitRaw = parseInt(p.get("limit") || String(DEFAULT_LIMIT), 10);
  const page = isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const limit =
    isFinite(limitRaw) && limitRaw > 0
      ? Math.min(MAX_LIMIT, limitRaw)
      : DEFAULT_LIMIT;

  const consensusFilter: Prisma.MarketConsensusWhereInput = {};
  if (grokOnly) {
    consensusFilter.isSynthetic = false;
  }
  if (verdict) {
    consensusFilter.verdict = verdict;
  }
  if (minConfidence) {
    const mc = parseFloat(minConfidence);
    if (isFinite(mc)) {
      consensusFilter.confidenceScore = { gte: mc };
    }
  }

  const wh: Prisma.MarketWhereInput = {
    active: true,
    closed: false,
  };
  if (category) {
    wh.category = category;
  }
  if (Object.keys(consensusFilter).length) {
    wh.consensus = { is: consensusFilter };
  }
  if (grokOnly) {
    wh.llmRuns = {
      some: {
        modelName: { startsWith: "xai/" },
      },
    };
  }
  if (minLiquidity) {
    const v = parseFloat(minLiquidity);
    if (isFinite(v)) {
      wh.volume24h = { gte: v };
    }
  }

  try {
    const total = await prisma.market.count({ where: wh });
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(page, totalPages);
    const skip = (safePage - 1) * limit;

    const orderBy: Prisma.MarketOrderByWithRelationInput[] = (() => {
      switch (sort) {
        case "edge":
          return [{ consensus: { edge: "desc" } }, { id: "asc" }];
        case "volume":
          return [{ volume24h: "desc" }, { id: "asc" }];
        case "updated":
          return [{ lastPolymarketSyncAt: "desc" }, { polUpdatedAt: "desc" }, { id: "asc" }];
        case "distortion":
        default:
          return [{ consensus: { distortionScore: "desc" } }, { id: "asc" }];
      }
    })();

    const rows: MWithConsensus[] = (await prisma.market.findMany({
      where: wh,
      include: { consensus: true },
      orderBy,
      skip,
      take: limit,
    })) as MWithConsensus[];
    return NextResponse.json({
      markets: rows.map(toMarketDTO),
      pagination: {
        page: safePage,
        limit,
        total,
        totalPages,
        hasMore: safePage < totalPages,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: "database_unavailable", message: String(e) },
      { status: 503 },
    );
  }
}
