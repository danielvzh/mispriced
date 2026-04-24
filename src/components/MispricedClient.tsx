"use client";

import Image from "next/image";
import Link from "next/link";
import { RadarChart } from "./RadarChart";
import { MarketTable } from "./MarketTable";
import { MarketDetail } from "./MarketDetail";
import type { MarketDTO } from "@/lib/serialize";
import { CATEGORY_SLUGS } from "@/lib/categories";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePolymarketWs, type LiveTrade } from "@/hooks/usePolymarketWs";

type View = "radar" | "table" | "latest" | "settings";

const LS_KEY = "mispriced_filters_v2";
const HIDDEN_KEY = "mispriced_hidden_markets";
const PAGE_SIZE = 500;
const TRADE_RECOMPUTE_COOLDOWN_MS = 20_000;
const AUTO_REFRESH_MS = 15_000;

type Filters = {
  category: string;
  minLiq: string;
  under: string;
  horizon: string;
  minConfidence: "all" | "low" | "med" | "high";
  hideClosed: boolean;
  verdict: string;
};

type Pagination = {
  page: number;
  limit: number;
  total: number;
  grokCheckedTotal?: number;
  totalPages: number;
  hasMore: boolean;
};

type LatestRun = {
  marketId: string;
  slug: string;
  question: string;
  verdict: string | null;
  modelName: string;
  probability: number;
  confidence: number;
  ranAt: string;
};

type LatestTx = {
  at: Date;
  notional: number;
  price: number;
  size: number;
  side?: string;
  slug: string;
  question: string;
};

function mispricingPill(v: string | null): { label: string; cls: string } {
  if (v === "reality") {
    return { label: "Reality Distortion", cls: "border-[#ef4444] bg-[#fff1f2] text-[#b91c1c]" };
  }
  if (v === "wild") {
    return { label: "Wild", cls: "border-[#f97316] bg-[#fff7ed] text-[#c2410c]" };
  }
  if (v === "questionable") {
    return { label: "Questionable", cls: "border-[#fbbf24] bg-[#fffbeb] text-[#a16207]" };
  }
  if (v === "fair") {
    return { label: "Fair", cls: "border-[#16a34a] bg-[#f0fdf4] text-[#166534]" };
  }
  return { label: "—", cls: "border-[#e8e8e8] bg-white text-[#5c5c5c]" };
}

const defaultF: Filters = {
  category: "all",
  minLiq: "0",
  under: "all",
  horizon: "all",
  minConfidence: "all",
  hideClosed: true,
  verdict: "all",
};

function ago(d: Date): string {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 5) {
    return "just now";
  }
  if (s < 60) {
    return `${s}s ago`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m ago`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `${h}h ago`;
  }
  return `${Math.floor(h / 24)}d ago`;
}

function minConfToNum(m: Filters["minConfidence"]): number | null {
  if (m === "all") {
    return null;
  }
  if (m === "high") {
    return 0.55;
  }
  if (m === "med") {
    return 0.3;
  }
  return 0;
}

function applyConf(m: MarketDTO, f: Filters): boolean {
  const t = minConfToNum(f.minConfidence);
  if (t == null) {
    return true;
  }
  return m.confidence != null && m.confidence >= t;
}

function applyHorizon(m: MarketDTO, h: string): boolean {
  if (h === "all") {
    return true;
  }
  return m.horizon === h;
}

function applyUnder(
  m: MarketDTO,
  u: string,
): boolean {
  if (u === "all") {
    return true;
  }
  if (u === "mixed") {
    return m.dotLabel === "mixed";
  }
  if (u === "under") {
    return m.dotLabel === "underpriced";
  }
  if (u === "over") {
    return m.dotLabel === "overpriced";
  }
  return true;
}

function applyVerdict(m: MarketDTO, v: string): boolean {
  if (v === "all") {
    return true;
  }
  return (m.verdict || "") === v;
}

function filterRows(
  rows: MarketDTO[],
  f: Filters,
  hidden: Set<string>,
): MarketDTO[] {
  return rows.filter(
    (m) =>
      !hidden.has(m.id) &&
      applyHorizon(m, f.horizon) &&
      applyUnder(m, f.under) &&
      applyConf(m, f) &&
      (f.hideClosed ? !m.closed : true) &&
      applyVerdict(m, f.verdict),
  );
}

export function MispricedClient() {
  const [view, setView] = useState<View>("radar");
  const [list, setList] = useState<MarketDTO[] | null>(null);
  const [latestRuns, setLatestRuns] = useState<LatestRun[] | null>(null);
  const [latestErr, setLatestErr] = useState<string | null>(null);
  const [bootErr, setBoot] = useState<string | null>(null);
  const [selected, setSel] = useState<MarketDTO | null>(null);
  const [live, setLive] = useState<Map<string, number>>(() => new Map());
  const [f, setF] = useState<Filters>(defaultF);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const [latestTx, setLatestTx] = useState<LatestTx | null>(null);
  const [nowTick, setNowTick] = useState(0);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [radarLoadingMore, setRadarLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [pg, setPg] = useState<Pagination>({
    page: 1,
    limit: PAGE_SIZE,
    total: 0,
    grokCheckedTotal: 0,
    totalPages: 1,
    hasMore: false,
  });

  useEffect(() => {
    try {
      const w = localStorage.getItem(HIDDEN_KEY) || localStorage.getItem("mispriced_watch");
      if (w) {
        setHidden(new Set(JSON.parse(w) as string[]));
      }
    } catch {
      /* */
    }
  }, []);

  useEffect(() => {
    try {
      const j = localStorage.getItem(LS_KEY);
      if (j) {
        const saved = JSON.parse(j) as Partial<Filters>;
        const next: Filters = { ...defaultF, ...saved, minConfidence: "all" };
        if (!CATEGORY_SLUGS.includes(next.category as (typeof CATEGORY_SLUGS)[number])) {
          next.category = "all";
        }
        if (next.category === "sports") {
          next.category = "all";
        }
        if (!["all", "reality", "wild", "questionable", "fair"].includes(next.verdict)) {
          next.verdict = "all";
        }
        setF(next);
      }
    } catch {
      /* */
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(f));
  }, [f]);
  useEffect(() => {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
  }, [hidden]);
  useEffect(() => {
    setPage(1);
  }, [f]);

  const buildMarketsQuery = useCallback((pageNum: number, mode: View) => {
    const q = new URLSearchParams();
    if (f.category && f.category !== "all") {
      q.set("category", f.category);
    }
    if (f.minLiq) {
      const v = parseFloat(f.minLiq);
      if (isFinite(v) && v > 0) {
        q.set("minLiquidity", String(v));
      }
    }
    if (f.minConfidence !== "all" && f.minConfidence !== "low") {
      const mc = minConfToNum(f.minConfidence);
      if (mc != null) {
        q.set("minConfidence", String(mc));
      }
    }
    if (f.verdict !== "all") {
      q.set("verdict", f.verdict);
    }
    q.set("sort", "distortion");
    if (mode === "radar") {
      q.set("grokOnly", "1");
    }
    q.set("page", String(pageNum));
    q.set("limit", String(PAGE_SIZE));
    return q;
  }, [f]);
  const fetchMarketsPage = useCallback(async (pageNum: number, mode: View) => {
    const q = buildMarketsQuery(pageNum, mode);
    const r = await fetch(`/api/markets?${q}`);
    if (!r.ok) {
      throw new Error(await r.text().catch(() => "fetch_failed"));
    }
    return (await r.json()) as { markets: MarketDTO[]; pagination?: Pagination };
  }, [buildMarketsQuery]);
  const refetchPage = useCallback(async (pageNum: number, mode: View) => {
    setBoot(null);
    const j = await fetchMarketsPage(pageNum, mode);
    setList(j.markets);
    if (j.pagination) {
      setPg(j.pagination);
      if (j.pagination.page !== pageNum) {
        setPage(j.pagination.page);
      }
    } else {
      setPg({
        page: pageNum,
        limit: PAGE_SIZE,
        total: j.markets.length,
        grokCheckedTotal: j.markets.filter((m) => !m.isSynthetic).length,
        totalPages: 1,
        hasMore: false,
      });
    }
    setLastFetch(new Date());
  }, [fetchMarketsPage]);
  const radarReqRef = useRef(0);
  const refetchRadarAll = useCallback(async () => {
    setBoot(null);
    setRadarLoadingMore(true);
    radarReqRef.current += 1;
    const reqId = radarReqRef.current;
    try {
      let pNum = 1;
      let all: MarketDTO[] = [];
      while (true) {
        const j = await fetchMarketsPage(pNum, "radar");
        if (reqId !== radarReqRef.current) {
          return;
        }
        all = all.concat(j.markets);
        const seen = new Set<string>();
        all = all.filter((m) => {
          if (seen.has(m.id)) {
            return false;
          }
          seen.add(m.id);
          return true;
        });
        setList([...all]);
        if (j.pagination) {
          setPg(j.pagination);
          if (!j.pagination.hasMore) {
            break;
          }
        } else {
          break;
        }
        pNum += 1;
      }
      setLastFetch(new Date());
    } catch (e) {
      setBoot(String(e));
    } finally {
      if (reqId === radarReqRef.current) {
        setRadarLoadingMore(false);
      }
    }
  }, [fetchMarketsPage]);
  const fetchLatestRuns = useCallback(async () => {
    setLatestErr(null);
    const r = await fetch("/api/llm/latest?limit=120");
    if (!r.ok) {
      setLatestErr(await r.text().catch(() => "failed"));
      return;
    }
    const j = (await r.json()) as { runs: LatestRun[] };
    setLatestRuns(j.runs || []);
  }, []);
  const refetchBusy = useRef(false);
  const refetchPending = useRef(false);
  const safeRefetch = useCallback(async () => {
    if (refetchBusy.current) {
      refetchPending.current = true;
      return;
    }
    refetchBusy.current = true;
    try {
      if (view === "radar") {
        await refetchRadarAll();
      } else {
        await refetchPage(page, view);
      }
    } finally {
      refetchBusy.current = false;
      if (refetchPending.current) {
        refetchPending.current = false;
        queueMicrotask(() => {
          void safeRefetch();
        });
      }
    }
  }, [view, refetchRadarAll, refetchPage, page]);

  useEffect(() => {
    void safeRefetch();
  }, [safeRefetch]);
  useEffect(() => {
    if (view !== "radar") {
      // Cancel any in-progress radar aggregation when leaving radar view.
      radarReqRef.current += 1;
      setRadarLoadingMore(false);
    }
  }, [view]);
  useEffect(() => {
    if (view === "latest") {
      void fetchLatestRuns();
    }
  }, [view, fetchLatestRuns]);
  useEffect(() => {
    const t = setInterval(() => {
      void safeRefetch();
    }, AUTO_REFRESH_MS);
    if (view === "radar") {
      return () => {
        clearInterval(t);
      };
    }
    return () => {
      clearInterval(t);
    };
  }, [safeRefetch, view]);

  const filtered = useMemo(
    () => (list ? filterRows(list, f, hidden) : []),
    [list, f, hidden],
  );
  const hiddenRows = useMemo(
    () => (list ? list.filter((m) => hidden.has(m.id)) : []),
    [list, hidden],
  );

  const tokens = useMemo(
    () => (list ? list.map((m) => m.yesAssetId) : []),
    [list],
  );
  const tokenToMarket = useMemo(() => {
    const m = new Map<string, { marketId: string; slug: string; question: string }>();
    for (const row of list || []) {
      m.set(row.yesAssetId, { marketId: row.id, slug: row.slug, question: row.question });
    }
    return m;
  }, [list]);
  const tradeBusy = useRef<Set<string>>(new Set());
  const tradeLastRunAt = useRef<Map<string, number>>(new Map());
  const onTrade = useCallback(
    async (t: LiveTrade) => {
      const m = tokenToMarket.get(t.assetId);
      if (!m) {
        return;
      }
      const key = m.marketId;
      setLatestTx({
        at: new Date(),
        notional: t.notional,
        price: t.price,
        size: t.size,
        side: t.side,
        slug: m.slug,
        question: m.question,
      });
      if (tradeBusy.current.has(key)) {
        return;
      }
      const last = tradeLastRunAt.current.get(key);
      if (last != null && Date.now() - last < TRADE_RECOMPUTE_COOLDOWN_MS) {
        return;
      }
      tradeBusy.current.add(key);
      try {
        const r = await fetch("/api/trade-recompute", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            marketId: m.marketId,
            slug: m.slug,
            notionalUsd: t.notional,
          }),
        });
        const j = (await r.json().catch(() => ({}))) as {
          ok?: boolean;
          recomputed?: boolean;
        };
        if (j.ok && j.recomputed) {
          void safeRefetch();
        }
        tradeLastRunAt.current.set(key, Date.now());
      } catch {
        /* keep UI resilient on feed hiccups */
      } finally {
        tradeBusy.current.delete(key);
      }
    },
    [tokenToMarket, safeRefetch],
  );
  usePolymarketWs(tokens, setLive, onTrade);
  useEffect(() => {
    if (selected && hidden.has(selected.id)) {
      setSel(null);
    }
  }, [selected, hidden]);

  const hideMarket = useCallback((id: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const unhideMarket = useCallback((id: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      setNowTick((k) => k + 1);
    }, 30_000);
    return () => {
      clearInterval(t);
    };
  }, []);
  void nowTick;

  const stats = useMemo(() => {
    const n = filtered.length;
    if (!n) {
      return { avg: 0, top: null as MarketDTO | null, scanned: pg.grokCheckedTotal ?? 0 };
    }
    const edges = filtered
      .map((m) => m.edge)
      .filter((e): e is number => e != null);
    const avg = edges.length
      ? edges.reduce((a, b) => a + Math.abs(b) * 100, 0) / edges.length
      : 0;
    const top = [...filtered].sort(
      (a, b) => (b.distortion ?? 0) - (a.distortion ?? 0),
    )[0] ?? null;
    return { avg, top, scanned: pg.grokCheckedTotal ?? 0 };
  }, [filtered, pg.grokCheckedTotal]);

  const empty = !list || list.length === 0;
  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col text-[#1a1a1a]">
      <header className="z-20 flex w-full min-w-0 flex-nowrap items-stretch gap-2 border-b border-[#e8e8e8] bg-white px-2 py-2 sm:gap-3 sm:px-4">
        <Link
          href="/"
          className="flex shrink-0 items-center self-center no-underline"
          aria-label="Mispriced home"
        >
          <Image
            src="/logo.png"
            alt=""
            width={280}
            height={84}
            className="h-9 w-auto object-contain sm:h-12 md:h-14"
            priority
          />
        </Link>
        <nav className="flex min-w-0 flex-1 items-center justify-center gap-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {(
            [
              { id: "radar", label: "radar" },
              { id: "table", label: "table" },
              { id: "latest", label: "latest grok computes" },
              { id: "settings", label: "settings" },
            ] as const
          ).map((it) => (
            <button
              key={it.id}
              type="button"
              onClick={() => {
                setView(it.id);
              }}
              className={`relative shrink-0 px-1.5 py-1.5 text-[10px] font-medium capitalize sm:px-2.5 sm:text-sm ${
                view === it.id
                  ? "text-[#db0007] after:absolute after:bottom-0 after:left-1 after:right-1 after:h-0.5 after:bg-[#db0007] sm:after:left-2 sm:after:right-2"
                  : "text-[#5c5c5c] hover:text-[#1a1a1a]"
              } `}
            >
              {it.label}
            </button>
          ))}
        </nav>
        <div className="flex shrink-0 items-center gap-1 text-[#5c5c5c] sm:gap-2">
          <button
            type="button"
            onClick={() => {
              void safeRefetch();
            }}
            className="rounded p-0.5 text-xs hover:bg-[#f5f5f5] sm:p-1"
            title="Refresh"
          >
            ↻
          </button>
          {lastFetch && (
            <span className="max-w-[5rem] shrink truncate text-[9px] whitespace-nowrap sm:max-w-none sm:text-xs">
              <span className="hidden sm:inline">Updated </span>
              {ago(lastFetch)}
            </span>
          )}
        </div>
      </header>
      <div className="mx-auto flex min-h-0 w-full min-w-0 max-w-[1600px] flex-1 flex-col md:flex-row">
      <aside className="order-2 w-full min-w-0 max-w-xs shrink-0 space-y-3 p-3 md:order-1">
        <div className="rounded-lg border border-[#e8e8e8] bg-white p-3">
          <h3 className="text-[9px] font-bold uppercase tracking-widest text-[#5c5c5c]">How to read</h3>
          <ul className="mt-2 space-y-1.5 text-[10px] text-[#1a1a1a]">
            <li className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[#db0007]" /> Overpriced vs Grok
            </li>
            <li className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[#16a34a]" /> Underpriced vs Grok
            </li>
            <li className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[#94a3b8]" /> Fair / mixed
            </li>
          </ul>
        </div>
        <div className="rounded-lg border border-[#e8e8e8] bg-white p-3 text-[10px] text-[#5c5c5c]">
          <h3 className="text-[9px] font-bold uppercase tracking-widest">Rings = mispricing</h3>
          <ul className="mt-2 space-y-1.5">
            <li className="flex items-start gap-2">
              <span className="mt-0.5 h-3.5 w-3.5 rounded-full border-2 border-[#ef4444]" />
              <span>
                <strong className="text-[#1a1a1a]">Reality Distortion</strong>
                <br />
                <span>(30+ pts)</span>
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 h-3.5 w-3.5 rounded-full border-2 border-[#f97316]" />
              <span>
                <strong className="text-[#1a1a1a]">Wild</strong>
                <br />
                <span>(15-30 pts)</span>
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 h-3.5 w-3.5 rounded-full border-2 border-[#fbbf24]" />
              <span>
                <strong className="text-[#1a1a1a]">Questionable</strong>
                <br />
                <span>(5-15 pts)</span>
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 h-3.5 w-3.5 rounded-full border-2 border-[#16a34a]" />
              <span>
                <strong className="text-[#1a1a1a]">Fair</strong>
                <br />
                <span>(0-5 pts)</span>
              </span>
            </li>
          </ul>
        </div>
        <div className="rounded-lg border border-[#e8e8e8] bg-white p-3 text-[10px]">
          <h3 className="text-[9px] font-bold uppercase tracking-widest text-[#5c5c5c]">Dot size = liquidity</h3>
          <div className="mt-2 flex items-end gap-2">
            <div className="h-1.5 w-1.5 rounded-full bg-black" />
            <div className="h-2.5 w-2.5 rounded-full bg-black" />
            <div className="h-3.5 w-3.5 rounded-full bg-black" />
            <span className="ml-1 text-[#5c5c5c]">low → high volume</span>
          </div>
        </div>
        <div className="space-y-2.5 rounded-lg border border-[#e8e8e8] bg-white p-3 text-[10px]">
          <h3 className="text-[9px] font-bold uppercase tracking-widest text-[#5c5c5c]">Filters</h3>
          <label className="block text-[#5c5c5c]">
            <span>Category</span>
            <select
              className="mt-0.5 w-full rounded border border-[#e8e8e8] bg-white py-1 pl-1 text-[#1a1a1a]"
              value={f.category}
              onChange={(e) => {
                setF((x) => ({ ...x, category: e.target.value }));
              }}
            >
              <option value="all">All categories</option>
              {CATEGORY_SLUGS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-[#5c5c5c]">
            <span>Verdict</span>
            <select
              className="mt-0.5 w-full rounded border border-[#e8e8e8] bg-white py-1"
              value={f.verdict}
              onChange={(e) => {
                setF((x) => ({ ...x, verdict: e.target.value }));
              }}
            >
              <option value="all">All verdicts</option>
              <option value="reality">Reality dist.</option>
              <option value="wild">Wild</option>
              <option value="questionable">Questionable</option>
              <option value="fair">Fair</option>
            </select>
          </label>
          <label className="block text-[#5c5c5c]">
            <span>Min confidence</span>
            <select
              className="mt-0.5 w-full rounded border border-[#e8e8e8] bg-white py-1"
              value={f.minConfidence}
              onChange={(e) => {
                setF((x) => ({
                  ...x,
                  minConfidence: e.target.value as Filters["minConfidence"],
                }));
              }}
            >
              <option value="all">All</option>
              <option value="low">Low+</option>
              <option value="med">Medium+</option>
              <option value="high">High+</option>
            </select>
          </label>
          <label className="mt-1 flex items-center gap-2 text-[#1a1a1a]">
            <input
              type="checkbox"
              checked={f.hideClosed}
              onChange={(e) => {
                setF((x) => ({ ...x, hideClosed: e.target.checked }));
              }}
            />
            Hide closed markets
          </label>
          <label className="block text-[#5c5c5c]">
            <span>Min 24h volume (USD)</span>
            <input
              className="mt-0.5 w-full rounded border border-[#e8e8e8] py-1"
              value={f.minLiq}
              onChange={(e) => {
                setF((x) => ({ ...x, minLiq: e.target.value }));
              }}
            />
          </label>
        </div>
      </aside>

      <div className="order-1 flex w-full min-w-0 min-h-0 flex-1 flex-col border-[#e8e8e8] md:order-2">
        {bootErr && (
          <p className="m-2 rounded border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-800">
            {bootErr}
          </p>
        )}

        {view === "settings" && (
          <div className="m-3 flex min-h-0 flex-1 flex-col rounded-lg border border-[#e8e8e8] bg-white p-4 text-sm text-[#5c5c5c]">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[#1a1a1a]">Settings</h2>
              <button
                type="button"
                onClick={() => {
                  setHidden(new Set());
                }}
                disabled={hiddenRows.length === 0}
                className="rounded border border-[#e8e8e8] px-2 py-1 text-xs text-[#1a1a1a] hover:bg-[#fafafa] disabled:opacity-50"
              >
                Unhide all
              </button>
            </div>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[#5c5c5c]">
              Hidden markets ({hiddenRows.length})
            </h3>
            {hiddenRows.length === 0 ? (
              <p>No hidden markets yet. Hide one from the market detail panel.</p>
            ) : (
              <ul className="space-y-2 overflow-y-auto pr-1">
                {hiddenRows.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-start justify-between gap-2 rounded border border-[#e8e8e8] p-2"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSel(m);
                      }}
                      className="line-clamp-2 text-left text-xs text-[#1a1a1a] hover:underline"
                    >
                      {m.question}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        unhideMarket(m.id);
                      }}
                      className="shrink-0 rounded border border-[#e8e8e8] px-2 py-0.5 text-xs text-[#1a1a1a] hover:bg-[#fafafa]"
                    >
                      Unhide
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {view === "latest" && (
          <div className="m-3 min-h-0 flex-1 rounded-lg border border-[#e8e8e8] bg-white p-3 text-xs text-[#5c5c5c]">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[#1a1a1a]">Latest Grok computes</h2>
              <button
                type="button"
                onClick={() => {
                  void fetchLatestRuns();
                }}
                className="rounded border border-[#e8e8e8] px-2 py-1 text-xs text-[#1a1a1a] hover:bg-[#fafafa]"
              >
                Refresh
              </button>
            </div>
            {latestErr && (
              <p className="mb-2 rounded border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-800">
                {latestErr}
              </p>
            )}
            {!latestRuns ? (
              <p>Loading latest runs…</p>
            ) : latestRuns.length === 0 ? (
              <p>No Grok runs yet.</p>
            ) : (
              <div className="h-[min(64vh,560px)] overflow-y-auto rounded border border-[#e8e8e8]">
                <table className="w-full min-w-[760px] border-separate border-spacing-0 text-left text-[11px] text-[#1a1a1a]">
                  <thead>
                    <tr className="text-[#5c5c5c]">
                      <th className="border-b border-[#e8e8e8] py-2 pl-2 pr-1">When</th>
                      <th className="border-b border-[#e8e8e8] py-2 px-1">Market</th>
                      <th className="border-b border-[#e8e8e8] py-2 px-1">Model</th>
                      <th className="border-b border-[#e8e8e8] py-2 px-1">Prob</th>
                      <th className="border-b border-[#e8e8e8] py-2 px-1">Conf</th>
                      <th className="border-b border-[#e8e8e8] py-2 px-1">Mispricing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {latestRuns.map((r) => (
                      <tr key={`${r.marketId}-${r.ranAt}-${r.modelName}`} className="hover:bg-[#fafafa]">
                        <td className="py-2 pl-2 pr-1 align-top text-[#5c5c5c]">{ago(new Date(r.ranAt))}</td>
                        <td className="max-w-[440px] py-2 px-1 align-top">
                          <a
                            href={`https://polymarket.com/market/${r.slug}`}
                            target="_blank"
                            rel="noreferrer"
                            className="line-clamp-2 text-[#1a1a1a] hover:underline"
                            title={r.question}
                          >
                            {r.question}
                          </a>
                        </td>
                        <td className="py-2 px-1 text-[#5c5c5c]">{r.modelName.replace("xai/", "Grok ")}</td>
                        <td className="py-2 px-1 tabular-nums">{(r.probability * 100).toFixed(0)}%</td>
                        <td className="py-2 px-1 tabular-nums">{r.confidence.toFixed(2)}</td>
                        <td className="py-2 px-1">
                          {(() => {
                            const p = mispricingPill(r.verdict);
                            return (
                              <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${p.cls}`}>
                                {p.label}
                              </span>
                            );
                          })()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {(view === "radar" || view === "table") && (
          <>
            <div className="min-h-0 flex-1 overflow-hidden p-2 sm:p-3">
              {list && view === "radar" && (
                <div className="h-[min(64vh,520px)] w-full max-w-3xl mx-auto">
                  <RadarChart
                    items={filtered}
                    live={live}
                    onPick={setSel}
                    selected={selected?.id ?? null}
                  />
                  {radarLoadingMore && (
                    <p className="mt-1 text-center text-[11px] text-[#5c5c5c]">
                      Loading more dots… ({filtered.length.toLocaleString()} / {pg.total.toLocaleString()})
                    </p>
                  )}
                </div>
              )}
              {list && view === "table" && (
                <div className="h-[min(64vh,560px)] overflow-y-auto pr-0.5">
                  <MarketTable
                    rows={filtered}
                    onSelect={(m) => {
                      setSel(m);
                    }}
                  />
                </div>
              )}
            </div>
            {list && view === "table" && (
              <div className="flex items-center justify-between border-t border-[#e8e8e8] bg-white px-3 py-2 text-xs text-[#5c5c5c]">
                <button
                  type="button"
                  onClick={() => {
                    setPage((x) => Math.max(1, x - 1));
                  }}
                  disabled={pg.page <= 1}
                  className="rounded border border-[#e8e8e8] px-2 py-1 text-[#1a1a1a] hover:bg-[#fafafa] disabled:opacity-50"
                >
                  Prev
                </button>
                <span>
                  Page {pg.page} / {pg.totalPages} · {pg.total.toLocaleString()} markets
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setPage((x) => (pg.hasMore ? x + 1 : x));
                  }}
                  disabled={!pg.hasMore}
                  className="rounded border border-[#e8e8e8] px-2 py-1 text-[#1a1a1a] hover:bg-[#fafafa] disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            )}
            {list && (view === "radar" || view === "table") && (
              <div className="grid grid-cols-2 gap-2 border-t border-[#e8e8e8] bg-[#F8F8F8] p-3 sm:grid-cols-5">
                <div className="rounded-lg border border-[#e8e8e8] bg-white p-2.5 text-center text-[10px] text-[#5c5c5c]">
                  <div>Markets scanned</div>
                  <div className="mt-1 text-xl font-bold text-[#1a1a1a]">
                    {stats.scanned}
                  </div>
                </div>
                <div className="rounded-lg border border-[#e8e8e8] bg-white p-2.5 text-center text-[10px] text-[#5c5c5c]">
                  <div>Latest tx</div>
                  {latestTx ? (
                    <div className="mt-1 space-y-0.5 text-[9px] leading-tight text-[#1a1a1a]">
                      <div className="font-semibold">{ago(latestTx.at)}</div>
                      <div className="line-clamp-1" title={latestTx.question}>
                        {latestTx.question}
                      </div>
                      <div className="text-[#5c5c5c]">
                        {latestTx.side ? `${latestTx.side.toUpperCase()} · ` : ""}
                        ${latestTx.price.toFixed(3)} x {latestTx.size.toFixed(2)}
                      </div>
                      <div className="font-medium text-[#1a1a1a]">
                        ${Math.round(latestTx.notional).toLocaleString()}
                      </div>
                    </div>
                  ) : (
                    <div className="mt-1 text-sm font-bold text-[#1a1a1a]">—</div>
                  )}
                </div>
                <div className="rounded-lg border border-[#e8e8e8] bg-white p-2.5 text-center text-[10px] text-[#5c5c5c]">
                  <div>Avg. mispricing</div>
                  <div className="mt-1 text-xl font-bold text-[#16a34a]">
                    +{stats.avg.toFixed(0)} pts
                  </div>
                </div>
                <div className="rounded-lg border border-[#e8e8e8] bg-white p-2.5 text-center text-[10px] text-[#5c5c5c]">
                  <div>Most distorted</div>
                  <div className="mt-1 line-clamp-2 min-h-10 text-[9px] font-medium text-[#db0007]">
                    {stats.top?.question ?? "—"}
                  </div>
                </div>
                <div className="rounded-lg border border-[#e8e8e8] bg-white p-2.5 text-center text-[10px] text-[#5c5c5c]">
                  <div>Models (Grok)</div>
                  <div className="mt-1 text-lg font-bold text-[#1a1a1a]">xAI</div>
                </div>
              </div>
            )}
            {empty && !bootErr && (
              <p className="p-3 text-center text-sm text-[#5c5c5c]">
                No data for current filters. Try refresh (↻), reset category to All, or hard-reload the page.
              </p>
            )}
          </>
        )}
      </div>

      {selected && (view === "radar" || view === "table" || view === "settings") && (
        <div className="order-3 min-h-0 w-full min-w-0 max-w-sm shrink-0 border-t border-[#e8e8e8] md:order-3 md:w-auto md:border-t-0 md:border-l">
          <MarketDetail
            m={selected}
            onHide={() => {
              hideMarket(selected.id);
            }}
            onClose={() => {
              setSel(null);
            }}
          />
        </div>
      )}
      </div>
    </div>
  );
}
