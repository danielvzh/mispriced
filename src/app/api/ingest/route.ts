import { NextRequest, NextResponse } from "next/server";
import { ingestFromGamma } from "@/lib/ingest";

export const maxDuration = 300;

function authPass(req: NextRequest): boolean {
  const t = process.env.INGEST_SECRET || process.env.CRON_SECRET;
  if (!t) {
    return process.env.NODE_ENV === "development";
  }
  return (
    req.headers.get("x-admin-secret") === t || req.nextUrl.searchParams.get("key") === t
  );
}

export async function POST(req: NextRequest) {
  if (!authPass(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    allPages?: boolean;
    pageLimit?: number;
    minVolume24h?: number;
    recomputeLlm?: boolean;
    maxLlm?: number;
    maxMarkets?: number;
    clobConcurrency?: number;
    requireOrderBook?: boolean;
    /** @deprecated use pageLimit with allPages: false */
    limit?: number;
  };
  const r = await ingestFromGamma({
    allPages: body.allPages,
    pageLimit: body.pageLimit ?? body.limit,
    minVolume24h: body.minVolume24h,
    recomputeLlm: body.recomputeLlm,
    maxLlm: body.maxLlm,
    maxMarkets: body.maxMarkets,
    clobConcurrency: body.clobConcurrency,
    requireOrderBook: body.requireOrderBook,
  });
  return NextResponse.json(r);
}

export async function GET() {
  return NextResponse.json({
    usage:
      "POST with x-admin-secret. Body optional: { allPages (default true, full Gamma pagination), pageLimit, minVolume24h, recomputeLlm, maxLlm, maxMarkets, clobConcurrency, requireOrderBook }. Cap long runs: INGEST_MAX_MARKETS env.",
  });
}
