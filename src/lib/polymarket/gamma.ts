import type { GammaMarket } from "./types";

const BASE = "https://gamma-api.polymarket.com";

/**
 * Polymarket keyset /markets/keyset: max 1000 per request (keyset, not offset)
 * @see List markets (keyset pagination) in Polymarket API docs
 */
const KEYSET_MAX = 1000;

export type MarketFilters = {
  minVolume24h?: number;
  requireOrderBook?: boolean;
  requireClobTokenIds?: boolean;
  /** Include sports markets; default false (exclude sports). */
  includeSports?: boolean;
};

type KeysetResponse = {
  markets: GammaMarket[];
  next_cursor?: string;
};

function passes(
  m: GammaMarket,
  f: {
    min: number;
    requireOrderBook: boolean;
    requireClob: boolean;
    includeSports: boolean;
  },
): boolean {
  if (m.active === false || m.closed) {
    return false;
  }
  if (!f.includeSports && isSportsMarket(m)) {
    return false;
  }
  const v = m.volume24hrClob ?? m.volume24hr ?? 0;
  if (v < f.min) {
    return false;
  }
  if (f.requireClob && !m.clobTokenIds) {
    return false;
  }
  if (f.requireOrderBook && m.enableOrderBook === false) {
    return false;
  }
  return true;
}

const SPORTS_TAG_WORDS = [
  "sports",
  "sport",
  "nba",
  "nfl",
  "mlb",
  "nhl",
  "soccer",
  "football",
  "tennis",
  "golf",
  "cricket",
  "ufc",
  "mma",
  "boxing",
  "f1",
  "formula 1",
  "motorsport",
] as const;

function containsSportsWord(v: string | null | undefined): boolean {
  if (!v) {
    return false;
  }
  const s = v.toLowerCase();
  return SPORTS_TAG_WORDS.some((w) => s.includes(w));
}

function isSportsMarket(m: GammaMarket): boolean {
  const tags = [
    ...(m.tags || []),
    ...((m.events || []).flatMap((e) => e.tags || [])),
  ];
  if (
    tags.some((t) => containsSportsWord(t.slug) || containsSportsWord(t.label))
  ) {
    return true;
  }
  // Fallback if tags are sparse.
  return containsSportsWord(m.question);
}

function makeKeysetUrl(
  requestLimit: number,
  afterCursor: string | null,
): URL {
  const u = new URL(`${BASE}/markets/keyset`);
  u.searchParams.set("closed", "false");
  u.searchParams.set("limit", String(requestLimit));
  u.searchParams.set("order", "volume24hr");
  u.searchParams.set("ascending", "false");
  u.searchParams.set("include_tag", "true");
  if (afterCursor) {
    u.searchParams.set("after_cursor", afterCursor);
  }
  return u;
}

/**
 * Fetches a single keyset page (cursor-based, stable for large result sets; offset is not used).
 */
async function fetchKeysetPage(
  requestLimit: number,
  afterCursor: string | null,
): Promise<KeysetResponse> {
  const u = makeKeysetUrl(
    Math.min(KEYSET_MAX, Math.max(1, requestLimit)),
    afterCursor,
  );
  const r = await fetch(u.toString(), { next: { revalidate: 0 } });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(
      `Gamma /markets/keyset: ${r.status} ${r.statusText} ${t.slice(0, 200)}`,
    );
  }
  return (await r.json()) as KeysetResponse;
}

/**
 * One page of active, open markets.
 */
export async function fetchActiveMarkets(
  limit = 200,
  _legacyOffset: number | void = void 0,
  options: MarketFilters = {},
): Promise<GammaMarket[]> {
  void _legacyOffset;
  const min = options.minVolume24h ?? 0;
  const requireOrderBook = options.requireOrderBook ?? false;
  const requireClob = options.requireClobTokenIds !== false;
  const includeSports = options.includeSports ?? false;
  const { markets } = await fetchKeysetPage(
    Math.min(KEYSET_MAX, limit),
    null,
  );
  return markets.filter((m) =>
    passes(m, {
      min,
      requireOrderBook,
      requireClob: requireClob,
      includeSports,
    }),
  );
}

export type FetchAllOptions = MarketFilters & {
  maxPages?: number;
  maxMarkets?: number;
};

/**
 * Keyset through **all** open (closed=false) markets. Uses `next_cursor` / `after_cursor`
 * until the last page (no next_cursor) or a limit is hit.
 */
export async function fetchAllActiveMarkets(
  options: FetchAllOptions = {},
): Promise<GammaMarket[]> {
  const {
    minVolume24h = 0,
    requireOrderBook = false,
    requireClobTokenIds = true,
    includeSports = false,
    maxPages = Number.POSITIVE_INFINITY,
    maxMarkets: maxTotal,
  } = options;
  const out: GammaMarket[] = [];
  let afterCursor: string | null = null;
  let pages = 0;

  while (true) {
    if (pages >= maxPages) {
      break;
    }
    if (maxTotal != null && out.length >= maxTotal) {
      break;
    }
    const remaining = maxTotal != null ? maxTotal - out.length : KEYSET_MAX;
    const thisLimit = Math.min(KEYSET_MAX, Math.max(1, remaining));
    const { markets, next_cursor } = await fetchKeysetPage(
      thisLimit,
      afterCursor,
    );
    for (const m of markets) {
      if (maxTotal != null && out.length >= maxTotal) {
        return out;
      }
      if (
        passes(m, {
          min: minVolume24h,
          requireOrderBook,
          requireClob: requireClobTokenIds,
          includeSports,
        })
      ) {
        out.push(m);
      }
    }
    pages += 1;
    if (markets.length === 0) {
      break;
    }
    if (!next_cursor) {
      break;
    }
    afterCursor = next_cursor;
  }
  return out;
}

/**
 * One market by slug from the legacy /markets list (or keyset in future)
 */
export async function fetchMarketBySlug(
  slug: string,
): Promise<GammaMarket | null> {
  const u = new URL(`${BASE}/markets`);
  u.searchParams.set("slug", slug);
  u.searchParams.set("limit", "1");
  const r = await fetch(u.toString(), { next: { revalidate: 0 } });
  if (!r.ok) {
    return null;
  }
  const j = (await r.json()) as GammaMarket[];
  return j[0] ?? null;
}
