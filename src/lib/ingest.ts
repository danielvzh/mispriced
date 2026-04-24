import { detectCategory } from "@/lib/categories";
import { prisma } from "@/lib/db";
import {
  fetchActiveMarkets,
  fetchAllActiveMarkets,
} from "@/lib/polymarket/gamma";
import { fetchOrderBook, summarizeBook } from "@/lib/polymarket/clob";
import { seedSyntheticRunsAndConsensus } from "@/lib/llm/synthetic";
import type { GammaMarket } from "@/lib/polymarket/types";
import { recomputeLlm } from "@/lib/llm/recompute";

const DEFAULT_CLOBS = 5;

function asStringArray(
  x: string | null | undefined | (string | number)[],
): string[] {
  if (x == null) {
    return [];
  }
  if (Array.isArray(x)) {
    return x.map((v) => String(v));
  }
  try {
    if (x.startsWith("[")) {
      return JSON.parse(x) as string[];
    }
    return [x];
  } catch {
    return [];
  }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const o: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    o.push(arr.slice(i, i + size));
  }
  return o;
}

export type IngestResult = {
  upserted: number;
  withBook: number;
  syntheticConsensus: number;
  recompute: number;
  marketCount: number;
  allPages: boolean;
  error?: string;
};

/**
 * Ingests markets from the Gamma API (paged) + CLOB, DB history, and consensus.
 */
export type IngestOpts = {
  /**
   * When true (default), follow Gamma /markets pagination until all active open markets are pulled.
   * When false, only one page; use with `pageLimit`.
   */
  allPages?: boolean;
  /** One-page limit (only with allPages: false) */
  pageLimit?: number;
  minVolume24h?: number;
  /** Skip markets with no order book in Gamma; default false so low-liquidity markets still appear. */
  requireOrderBook?: boolean;
  recomputeLlm?: boolean;
  maxLlm?: number;
  /** How many CLOB fetches in parallel. */
  clobConcurrency?: number;
  /** Cap total markets processed (safety; env INGEST_MAX_MARKETS overrides) */
  maxMarkets?: number;
};

function envMaxMarkets(): number | undefined {
  const v = process.env.INGEST_MAX_MARKETS;
  if (v == null || v === "") {
    return undefined;
  }
  const n = parseInt(v, 10);
  return isFinite(n) && n > 0 ? n : undefined;
}

const DEFAULT_LLM_RECOMPUTE_CAP = 30;

/**
 * Options for the in-app "Load markets" action. When `XAI_API_KEY` is set, runs
 * real Grok calls (up to `INGEST_MAX_LLM` or cap) for markets with no consensus yet.
 * Cron jobs pass `recomputeLlm: false` explicitly to avoid xAI use on a schedule.
 */
export function clientIngestLlmOptions(): Pick<IngestOpts, "recomputeLlm" | "maxLlm"> {
  if (!process.env.XAI_API_KEY) {
    return { recomputeLlm: false, maxLlm: 0 };
  }
  const raw = process.env.INGEST_MAX_LLM;
  if (raw == null || raw === "") {
    return { recomputeLlm: true, maxLlm: DEFAULT_LLM_RECOMPUTE_CAP };
  }
  const n = parseInt(raw, 10);
  return {
    recomputeLlm: true,
    maxLlm: isFinite(n) && n > 0 ? n : DEFAULT_LLM_RECOMPUTE_CAP,
  };
}

async function processOne(
  gm: GammaMarket,
  ctx: { recomputeLlm: boolean; maxLlm: number; recomputeCount: { n: number } },
): Promise<{ upserted: boolean; withBook: number; hadSynth: number; recompute: number }> {
  try {
    return await processOneInner(gm, ctx);
  } catch {
    return { upserted: false, withBook: 0, hadSynth: 0, recompute: 0 };
  }
}

async function processOneInner(
  gm: GammaMarket,
  ctx: { recomputeLlm: boolean; maxLlm: number; recomputeCount: { n: number } },
): Promise<{ upserted: boolean; withBook: number; hadSynth: number; recompute: number }> {
  const oNames = asStringArray(gm.outcomes);
  const oPrices = asStringArray(gm.outcomePrices);
  const toks = asStringArray(gm.clobTokenIds);
  if (oNames.length < 2 || toks.length < 2) {
    return { upserted: false, withBook: 0, hadSynth: 0, recompute: 0 };
  }
  const yIdx = 0;
  const yesP = oPrices[yIdx] != null ? parseFloat(oPrices[yIdx]!) : 0.5;
  const yes = isFinite(yesP) ? yesP : 0.5;
  const yesT = toks[0]!;

  const event = gm.events?.[0];
  const tagFromKeyset =
    gm.tags?.find((t) => t.slug && t.slug !== "all")?.label ?? gm.tags?.[0]?.label;
  const tag = tagFromKeyset ?? event?.tags?.[0]?.label;
  const cat = detectCategory(
    gm.question,
    event?.title,
    tag,
  );
  const vol = gm.volume24hrClob ?? gm.volume24hr ?? 0;
  const liq = gm.liquidityClob ?? gm.liquidityNum ?? 0;

  let bestBid: number | null = null;
  let bestAsk: number | null = null;
  let mid: number | null = null;
  let sp: number | null = null;
  let clobError: string | null = null;
  let gotBook = 0;
  if (yesT) {
    const b = await fetchOrderBook(yesT);
    if (b) {
      gotBook = 1;
      const sum = summarizeBook(b);
      bestBid = sum.bestBid;
      bestAsk = sum.bestAsk;
      mid = sum.midpoint;
      sp = sum.spread;
    } else {
      clobError = "book_fetch_failed";
    }
  }
  if (mid == null) {
    mid = yes;
  }
  if (sp == null && bestBid != null && bestAsk != null) {
    sp = bestAsk - bestBid;
  }

  const mProb = mid;
  const endD = gm.endDate ? new Date(gm.endDate) : null;

  await prisma.market.upsert({
    where: { id: gm.id },
    create: {
      id: gm.id,
      eventId: event?.id || gm.id,
      conditionId: gm.conditionId,
      slug: gm.slug,
      question: gm.question,
      description: gm.description || null,
      category: cat,
      subCategory: null,
      outcomesJson: JSON.stringify(
        oNames.map((n, i) => ({ name: n, price: oPrices[i] })),
      ),
      yesAssetId: yesT,
      noAssetId: toks[1]!,
      marketProb: mProb,
      bestBid,
      bestAsk,
      midpoint: mid,
      spread: sp,
      volume24h: vol,
      liquidityScore: liq,
      active: !!gm.active && !gm.closed,
      closed: !!gm.closed,
      endDate: endD,
      lastPolymarketSyncAt: new Date(),
      polUpdatedAt: gm.updatedAt ? new Date(gm.updatedAt) : null,
      clobError,
    },
    update: {
      question: gm.question,
      description: gm.description || null,
      category: cat,
      marketProb: mProb,
      bestBid,
      bestAsk,
      midpoint: mid,
      spread: sp,
      volume24h: vol,
      liquidityScore: liq,
      active: !!gm.active && !gm.closed,
      closed: !!gm.closed,
      endDate: endD,
      lastPolymarketSyncAt: new Date(),
      polUpdatedAt: gm.updatedAt ? new Date(gm.updatedAt) : null,
      clobError,
    },
  });

  await prisma.marketHistory.create({
    data: {
      marketId: gm.id,
      marketProb: mProb,
      bestBid,
      bestAsk,
      volume24h: vol,
    },
  });

  let recomputeN = 0;
  let hadSynth = 0;
  const ex = await prisma.marketConsensus.findUnique({ where: { marketId: gm.id } });
  if (!ex) {
    if (
      process.env.XAI_API_KEY &&
      ctx.recomputeLlm &&
      ctx.recomputeCount.n < ctx.maxLlm
    ) {
      try {
        await recomputeLlm(gm.id);
        ctx.recomputeCount.n += 1;
        recomputeN = 1;
      } catch {
        await seedSyntheticRunsAndConsensus(gm.id);
        hadSynth = 1;
      }
    } else {
      await seedSyntheticRunsAndConsensus(gm.id);
      hadSynth = 1;
    }
  }

  return { upserted: true, withBook: gotBook, hadSynth, recompute: recomputeN };
}

export async function ingestFromGamma(opts: IngestOpts = {}): Promise<IngestResult> {
  const envCap = envMaxMarkets();
  const o = {
    allPages: true,
    pageLimit: 500,
    minVolume24h: 0,
    requireOrderBook: false,
    recomputeLlm: false,
    maxLlm: 0,
    clobConcurrency: DEFAULT_CLOBS,
    maxMarkets: envCap ?? undefined,
    ...opts,
  } as IngestOpts & { maxMarkets: number | undefined; pageLimit: number; allPages: boolean };

  if (opts.maxMarkets != null) {
    o.maxMarkets = opts.maxMarkets;
  }

  let allPagesFlag = o.allPages !== false;
  let markets: GammaMarket[];

  try {
    if (allPagesFlag) {
      markets = await fetchAllActiveMarkets({
        minVolume24h: o.minVolume24h,
        requireOrderBook: o.requireOrderBook,
        maxMarkets: o.maxMarkets,
      });
    } else {
      const page = await fetchActiveMarkets(
        o.pageLimit ?? 500,
        0,
        {
          minVolume24h: o.minVolume24h,
          requireOrderBook: o.requireOrderBook,
        },
      );
      markets = o.maxMarkets != null ? page.slice(0, o.maxMarkets) : page;
      allPagesFlag = false;
    }
  } catch (e) {
    return {
      upserted: 0,
      withBook: 0,
      syntheticConsensus: 0,
      recompute: 0,
      marketCount: 0,
      allPages: o.allPages !== false,
      error: String(e),
    };
  }

  const recomputeCount = { n: 0 };
  const oProc = { recomputeLlm: o.recomputeLlm ?? false, maxLlm: o.maxLlm ?? 0, recomputeCount };

  let upserted = 0;
  let withBook = 0;
  let syntheticConsensus = 0;
  let recompute = 0;

  const conc = Math.max(1, Math.min(20, o.clobConcurrency ?? DEFAULT_CLOBS));
  for (const batch of chunkArray(markets, conc)) {
    const settled = await Promise.all(
      batch.map((gm) => processOne(gm, oProc)),
    );
    for (const s of settled) {
      if (s.upserted) {
        upserted++;
        withBook += s.withBook;
        syntheticConsensus += s.hadSynth;
        recompute += s.recompute;
      }
    }
  }

  return {
    upserted,
    withBook,
    syntheticConsensus,
    recompute,
    marketCount: markets.length,
    allPages: allPagesFlag,
  };
}
