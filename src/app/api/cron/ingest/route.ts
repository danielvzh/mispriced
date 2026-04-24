import { NextRequest, NextResponse } from "next/server";
import { ingestFromGamma } from "@/lib/ingest";

export const maxDuration = 300;

/**
 * Vercel Cron: compare Authorization: Bearer to CRON_SECRET
 * @see https://vercel.com/docs/cron-jobs
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  const r = await ingestFromGamma({
    recomputeLlm: false,
    maxLlm: 0,
    // full Gamma pagination; use INGEST_MAX_MARKETS to cap for serverless time limits
  });
  return NextResponse.json(r);
}
