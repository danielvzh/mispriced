import { NextRequest, NextResponse } from "next/server";
import { recomputeLlm } from "@/lib/llm/recompute";

export const maxDuration = 300;

function authPass(req: NextRequest): boolean {
  const t = process.env.RECOMPUTE_SECRET || process.env.CRON_SECRET;
  if (!t) {
    return process.env.NODE_ENV === "development";
  }
  return req.headers.get("x-admin-secret") === t;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ marketId: string }> },
) {
  if (!authPass(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { marketId } = await ctx.params;
  try {
    await recomputeLlm(marketId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
