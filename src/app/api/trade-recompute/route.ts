import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { recomputeWithXai } from "@/lib/llm/xai";

const IGNORE_SLUG = "btc-updown-5m";
const DEFAULT_NOTIONAL_USD = 100;

type Body = {
  marketId?: string;
  slug?: string;
  notionalUsd?: number;
};

export async function POST(req: NextRequest) {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_CLIENT_TRADE_RECOMPUTE !== "1"
  ) {
    return NextResponse.json(
      { ok: false, error: "disabled_in_production" },
      { status: 403 },
    );
  }
  if (!process.env.XAI_API_KEY) {
    return NextResponse.json({ ok: false, skipped: "xai_not_configured" });
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  const marketId = body.marketId;
  const slug = body.slug;
  const notionalUsd = Number(body.notionalUsd ?? 0);

  if (!marketId || !slug) {
    return NextResponse.json({ ok: false, error: "missing_market" }, { status: 400 });
  }
  if (slug === IGNORE_SLUG) {
    return NextResponse.json({ ok: true, skipped: "ignored_slug" });
  }

  const m = await prisma.market.findUnique({
    where: { id: marketId },
    select: { id: true, slug: true },
  });
  if (!m || m.slug !== slug) {
    return NextResponse.json({ ok: false, error: "market_not_found" }, { status: 404 });
  }

  const hasXaiRun = await prisma.llmRun.findFirst({
    where: {
      marketId,
      modelName: { startsWith: "xai/" },
    },
    select: { id: true },
  });

  const shouldRun =
    notionalUsd > DEFAULT_NOTIONAL_USD || !hasXaiRun;

  if (!shouldRun) {
    return NextResponse.json({
      ok: true,
      skipped: "below_threshold_already_ran",
    });
  }

  try {
    await recomputeWithXai(marketId, { allowSyntheticFallback: false });
    return NextResponse.json({
      ok: true,
      recomputed: true,
      reason: notionalUsd > DEFAULT_NOTIONAL_USD ? "trade_gt_100" : "first_run",
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String(e) },
      { status: 500 },
    );
  }
}

