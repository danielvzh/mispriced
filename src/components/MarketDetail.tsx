"use client";

import { useCallback, useEffect, useState } from "react";
import type { MarketDTO } from "@/lib/serialize";

type D = {
  modelEstimates: {
    modelName: string;
    probability: number;
    confidence: number;
    reasoningSummary: string;
    ranAt: string;
  }[];
  history: { timestamp: string; marketProb: number; volume24h: number | null }[];
};

function verdictChip(verdict: string | null): { label: string; className: string } {
  if (verdict === "reality") {
    return { label: "REALITY DISTORTION", className: "bg-[#db0007] text-white" };
  }
  if (verdict === "wild") {
    return { label: "WILD", className: "bg-[#ea580c] text-white" };
  }
  if (verdict === "questionable") {
    return { label: "QUESTIONABLE", className: "bg-[#ca8a04] text-white" };
  }
  return { label: "FAIR", className: "bg-[#16a34a] text-white" };
}

function bigVerdict(m: MarketDTO): { text: string; className: string } {
  if (m.dotLabel === "underpriced" && m.edge != null && m.edge > 0.08) {
    return { text: "SEVERELY UNDERPRICED", className: "text-[#db0007]" };
  }
  if (m.dotLabel === "underpriced") {
    return { text: "UNDERPRICED (VS MKT)", className: "text-[#16a34a]" };
  }
  if (m.dotLabel === "overpriced") {
    return { text: "OVERPRICED (VS MKT)", className: "text-[#db0007]" };
  }
  if (m.dotLabel === "mixed") {
    return { text: "MIXED SIGNALS", className: "text-[#64748b]" };
  }
  return { text: "NEAR NEUTRAL", className: "text-[#64748b]" };
}

function confBars(conf: number | null): "high" | "med" | "low" {
  if (conf == null) {
    return "med";
  }
  if (conf > 0.6) {
    return "high";
  }
  if (conf > 0.35) {
    return "med";
  }
  return "low";
}

function disagreeLabel(a: number | null): string {
  if (a == null) {
    return "—";
  }
  if (a > 0.6) {
    return "Low";
  }
  if (a > 0.35) {
    return "Med";
  }
  return "High";
}

function tenKScenario(m: MarketDTO): {
  side: "Buy YES" | "Buy NO";
  profit: number;
  roi: number;
  apy: number | null;
} | null {
  if (m.consensusProb == null) {
    return null;
  }
  const clamp = (x: number) => Math.min(0.99, Math.max(0.01, x));
  const marketYes = clamp(m.marketProb);
  const fairYes = clamp(m.consensusProb);
  const stake = 10_000;

  const buyYes = fairYes >= marketYes;
  const entry = buyYes ? marketYes : 1 - marketYes;
  const fair = buyYes ? fairYes : 1 - fairYes;
  const shares = stake / entry;
  const profit = (fair - entry) * shares;
  const roi = profit / stake;

  let apy: number | null = null;
  if (m.endDate) {
    const days = (new Date(m.endDate).getTime() - Date.now()) / 864e5;
    if (days > 0.25 && roi > -0.999) {
      apy = Math.pow(1 + roi, 365 / days) - 1;
    }
  }

  return {
    side: buyYes ? "Buy YES" : "Buy NO",
    profit,
    roi,
    apy,
  };
}

export function MarketDetail({
  m,
  onHide,
  onRepriceComplete,
  onClose,
}: {
  m: MarketDTO;
  onHide: () => void;
  onRepriceComplete?: () => void;
  onClose: () => void;
}) {
  const [d, setD] = useState<D | null>(null);
  const [err, setE] = useState<string | null>(null);
  const [showFull, setShowFull] = useState(false);
  const [repricing, setRepricing] = useState(false);
  const [repriceMsg, setRepriceMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    setE(null);
    try {
      const r = await fetch(`/api/markets/${m.slug}`);
      if (!r.ok) {
        throw new Error("fetch");
      }
      const j = (await r.json()) as {
        modelEstimates: D["modelEstimates"];
        history: D["history"];
      };
      setD({ modelEstimates: j.modelEstimates, history: j.history });
    } catch {
      setE("Could not load detail");
    }
  }, [m.slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const reprice = useCallback(async () => {
    setRepricing(true);
    setRepriceMsg(null);
    try {
      const r = await fetch("/api/trade-recompute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          marketId: m.id,
          slug: m.slug,
          notionalUsd: 1_000_000,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        recomputed?: boolean;
        skipped?: string;
        error?: string;
      };
      if (!r.ok || !j.ok) {
        throw new Error(j.error || "reprice_failed");
      }
      if (j.recomputed) {
        setRepriceMsg("Re-priced with Grok.");
        await load();
        onRepriceComplete?.();
      } else if (j.skipped) {
        setRepriceMsg(`Skipped: ${j.skipped}`);
      } else {
        setRepriceMsg("No update.");
      }
    } catch (e) {
      setRepriceMsg(`Failed: ${String(e)}`);
    } finally {
      setRepricing(false);
    }
  }, [m.id, m.slug, load, onRepriceComplete]);

  const rLow = m.lowProb != null ? m.lowProb : 0;
  const rHigh = m.highProb != null ? m.highProb : 1;
  const pm = `https://polymarket.com/market/${m.slug}`;
  const vChip = verdictChip(m.verdict);
  const vBig = bigVerdict(m);
  const nModels = d?.modelEstimates.length ?? 1;
  const scenario = tenKScenario(m);

  return (
    <aside className="flex h-full w-full min-w-0 max-w-sm flex-col border-l border-[#e8e8e8] bg-white">
      <div className="flex items-start gap-2 border-b border-[#e8e8e8] p-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold leading-tight text-[#1a1a1a]">
            {m.question}
          </h2>
          <span
            className={`mt-2 inline-block rounded-full px-2.5 py-0.5 text-[10px] font-bold ${vChip.className}`}
          >
            {vChip.label}
          </span>
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          <button
            type="button"
            onClick={onHide}
            className="rounded border border-[#e8e8e8] px-2 py-1 text-[11px] text-[#1a1a1a] hover:bg-[#f5f5f5]"
          >
            Hide
          </button>
          <button
            type="button"
            onClick={() => {
              void reprice();
            }}
            disabled={repricing}
            className="rounded border border-[#e8e8e8] px-2 py-1 text-[11px] text-[#1a1a1a] hover:bg-[#f5f5f5] disabled:opacity-50"
          >
            {repricing ? "Re-pricing…" : "Re-price"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded text-[#5c5c5c] hover:bg-[#f5f5f5] hover:text-[#1a1a1a]"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-xs">
        {repriceMsg && (
          <p className="mb-2 rounded border border-[#e8e8e8] bg-[#fafafa] px-2 py-1.5 text-[10px] text-[#1a1a1a]">
            {repriceMsg}
          </p>
        )}
        {err && <p className="text-[#db0007]">{err}</p>}

        <div className="mt-1 grid grid-cols-3 gap-2 text-center text-[#1a1a1a]">
          <div>
            <div className="text-[9px] uppercase text-[#5c5c5c]">Polymarket</div>
            <div className="text-lg font-bold tabular-nums">
              {(m.marketProb * 100).toFixed(0)}%
            </div>
          </div>
          <div>
            <div className="text-[9px] uppercase text-[#5c5c5c]">Grok cons.</div>
            <div className="text-lg font-bold tabular-nums text-[#db0007]">
              {m.consensusProb == null
                ? "—"
                : `${(m.consensusProb * 100).toFixed(0)}%`}
            </div>
          </div>
          <div>
            <div className="text-[9px] uppercase text-[#5c5c5c]">Edge</div>
            <div
              className={`text-lg font-bold tabular-nums ${
                m.edge != null && m.edge > 0 ? "text-[#16a34a]" : m.edge != null && m.edge < 0
                  ? "text-[#db0007]"
                  : "text-[#1a1a1a]"
              }`}
            >
              {m.edge == null
                ? "—"
                : `${(m.edge * 100) >= 0 ? "+" : ""}${(m.edge * 100).toFixed(0)}${m.edge != null ? "pp" : ""}`}
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between text-[#5c5c5c]">
          <span>Consensus range</span>
          <span className="tabular-nums text-[#1a1a1a]">
            {Math.round(rLow * 100)}% – {Math.round(rHigh * 100)}%
          </span>
        </div>
        <div className="mt-2 flex items-center justify-between text-[#5c5c5c]">
          <span>Confidence</span>
          <span
            className={confBars(m.confidence) === "high" ? "text-[#16a34a] font-medium" : "text-[#1a1a1a]"}
          >
            {m.confidence == null
              ? "—"
              : m.confidence > 0.55
                ? "High"
                : m.confidence > 0.3
                  ? "Medium"
                  : "Low"}
          </span>
        </div>

        <div className="mt-4 rounded-lg border border-rose-100 bg-rose-50 p-3 text-center">
          <p className={`text-sm font-extrabold tracking-wide ${vBig.className}`}>{vBig.text}</p>
        </div>
        <div className="mt-3 rounded-lg border border-[#e8e8e8] bg-white p-3">
          <h3 className="text-[9px] font-bold uppercase tracking-wider text-[#5c5c5c]">
            $10k bet scenario
          </h3>
          {scenario ? (
            <div className="mt-1.5 space-y-1 text-[11px]">
              <div className="flex items-center justify-between text-[#5c5c5c]">
                <span>Action</span>
                <span className="font-medium text-[#1a1a1a]">{scenario.side}</span>
              </div>
              <div className="flex items-center justify-between text-[#5c5c5c]">
                <span>Est. profit to fair value</span>
                <span className={scenario.profit >= 0 ? "font-medium text-[#16a34a]" : "font-medium text-[#db0007]"}>
                  {scenario.profit >= 0 ? "+" : "-"}${Math.abs(scenario.profit).toFixed(0)}
                </span>
              </div>
              <div className="flex items-center justify-between text-[#5c5c5c]">
                <span>ROI</span>
                <span className={scenario.roi >= 0 ? "font-medium text-[#16a34a]" : "font-medium text-[#db0007]"}>
                  {scenario.roi >= 0 ? "+" : ""}{(scenario.roi * 100).toFixed(1)}%
                </span>
              </div>
              <div className="flex items-center justify-between text-[#5c5c5c]">
                <span>Annualized APY</span>
                <span className="font-medium text-[#1a1a1a]">
                  {scenario.apy == null
                    ? "—"
                    : `${scenario.apy >= 0 ? "+" : ""}${(scenario.apy * 100).toFixed(1)}%`}
                </span>
              </div>
            </div>
          ) : (
            <p className="mt-1.5 text-[10px] text-[#5c5c5c]">
              Not available until Grok consensus is computed.
            </p>
          )}
        </div>

        {d && d.modelEstimates.length > 0 && (
          <div className="mt-4">
            <h3 className="mb-2 text-[9px] font-bold uppercase tracking-wider text-[#5c5c5c]">
              Model estimates
            </h3>
            <ul className="space-y-2.5">
              {d.modelEstimates.map((e) => {
                const pct = Math.max(0, Math.min(100, e.probability * 100));
                return (
                  <li key={`${e.modelName}-${e.ranAt}`}>
                    <div className="mb-0.5 flex items-center justify-between text-[10px] text-[#1a1a1a]">
                      <span className="line-clamp-1 pr-1">
                        {e.modelName.startsWith("xai/")
                          ? e.modelName.replace("xai/", "Grok ")
                          : "Grok"}
                      </span>
                      <span className="shrink-0 tabular-nums text-[#16a34a]">
                        {pct.toFixed(0)}%
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded bg-[#e8e8e8]">
                      <div
                        className="h-full rounded bg-[#16a34a] transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="mt-3 flex items-center justify-between border-t border-[#f0f0f0] pt-2 text-[10px] text-[#5c5c5c]">
              <span>Median {m.consensusProb != null ? `${(m.consensusProb * 100).toFixed(0)}%` : "—"}</span>
              <span>
                Range {Math.round(rLow * 100)}–{Math.round(rHigh * 100)}%
              </span>
              <span>Disag. {disagreeLabel(m.agreement)}</span>
            </div>
          </div>
        )}

        {d && d.modelEstimates[0] && (
          <div className="mt-3 text-[10px] leading-relaxed text-[#5c5c5c]">
            <h3 className="mb-0.5 text-[9px] font-bold uppercase text-[#5c5c5c]">Grok note</h3>
            <p className="text-[#1a1a1a]">
              {showFull
                ? d.modelEstimates[0]!.reasoningSummary
                : `${d.modelEstimates[0]!.reasoningSummary.slice(0, 320)}${d.modelEstimates[0]!.reasoningSummary.length > 320 ? "…" : ""}`}
            </p>
            {d.modelEstimates[0]!.reasoningSummary.length > 320 && (
              <button
                type="button"
                onClick={() => {
                  setShowFull((s) => !s);
                }}
                className="mt-1 text-[10px] font-medium text-[#db0007] underline"
              >
                {showFull ? "Show less" : "View full reasoning"}
              </button>
            )}
          </div>
        )}

        <a
          className="mt-3 flex w-full items-center justify-center border border-[#e8e8e8] py-2.5 text-xs font-medium text-[#db0007] no-underline hover:bg-[#fff5f5]"
          href={pm}
          target="_blank"
          rel="noreferrer"
        >
          Open on Polymarket
        </a>
        <p className="mt-2 text-center text-[9px] text-[#9a9a9a]">Estimates from {nModels} Grok run(s), not from Polymarket.</p>
      </div>
    </aside>
  );
}
