"use client";

import { RADAR_WEDGES } from "@/lib/categories";
import type { MarketDTO } from "@/lib/serialize";
import { useMemo, useState } from "react";

const CX = 250;
const CY = 250;
const R_OUT = 210;
const BANDS = [0.25, 0.42, 0.6, 0.82];
const BAND_COLORS = ["#ef4444", "#f97316", "#fbbf24", "#16a34a"] as const;

function labelForR(rn: number): "fair" | "questionable" | "wild" | "reality" {
  if (rn < 0.3) {
    return "reality";
  }
  if (rn < 0.46) {
    return "wild";
  }
  if (rn < 0.72) {
    return "questionable";
  }
  return "fair";
}

const DOT = {
  underpriced: "#16a34a",
  overpriced: "#db0007",
  mixed: "#94a3b8",
  neutral: "#64748b",
} as const;

type Props = {
  items: MarketDTO[];
  onPick: (m: MarketDTO) => void;
  live: Map<string, number>;
  selected: string | null;
};

function dotR(vol: number): number {
  const t = Math.min(1, Math.log10(20 + vol) / 5);
  return 3.5 + t * 6.5;
}

type PlacedDot = {
  m: MarketDTO;
  x: number;
  y: number;
  dr: number;
  band: "fair" | "questionable" | "wild" | "reality";
  fill: string;
  baseX: number;
  baseY: number;
};

function resolveOverlaps(dots: PlacedDot[]): PlacedDot[] {
  const out = dots.map((d) => ({ ...d }));
  const pad = 1.5;
  for (let iter = 0; iter < 28; iter++) {
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!;
        const b = out[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.0001;
        const minDist = a.dr + b.dr + pad;
        if (dist >= minDist) {
          continue;
        }
        const overlap = (minDist - dist) / 2;
        const ux = dx / dist;
        const uy = dy / dist;
        a.x -= ux * overlap;
        a.y -= uy * overlap;
        b.x += ux * overlap;
        b.y += uy * overlap;
      }
    }
    for (const p of out) {
      // Light spring toward original location so points remain in their wedge/band.
      p.x += (p.baseX - p.x) * 0.08;
      p.y += (p.baseY - p.y) * 0.08;
      const vx = p.x - CX;
      const vy = p.y - CY;
      const dist = Math.hypot(vx, vy) || 0.0001;
      const maxR = R_OUT - p.dr - 1;
      if (dist > maxR) {
        const k = maxR / dist;
        p.x = CX + vx * k;
        p.y = CY + vy * k;
      }
    }
  }
  return out;
}

export function RadarChart({ items, onPick, live, selected }: Props) {
  const [tt, setT] = useState<MarketDTO | null>(null);
  const wedgeLines = useMemo(
    () =>
      RADAR_WEDGES.map((w, i) => ({
        id: w.id,
        t: (-Math.PI / 2) + (i * 2 * Math.PI) / RADAR_WEDGES.length,
      })),
    [],
  );
  const placed = useMemo(() => {
    const seeded = items.map((m) => {
      const mp = live.get(m.yesAssetId) != null
        ? live.get(m.yesAssetId)!
        : m.marketProb;
      const mAdj = { ...m, marketProb: mp } as MarketDTO;
      const r = m.rNorm * R_OUT;
      const band = labelForR(m.rNorm);
      const baseX = CX + r * Math.cos(m.theta);
      const baseY = CY + r * Math.sin(m.theta);
      return {
        m: mAdj,
        x: baseX,
        y: baseY,
        dr: dotR(m.volume24h),
        band,
        fill: DOT[mAdj.dotLabel] ?? DOT.neutral,
        baseX,
        baseY,
      };
    });
    return resolveOverlaps(seeded);
  }, [items, live]);

  return (
    <svg
      className="h-full w-full max-w-[min(100%,640px)]"
      viewBox="0 0 500 500"
      onMouseLeave={() => {
        setT(null);
      }}
    >
      <rect width="100%" height="100%" fill="#f8f8f8" />
      {BANDS.map((b, i) => (
        <circle
          key={i}
          cx={CX}
          cy={CY}
          r={b * R_OUT}
          fill="none"
          stroke={BAND_COLORS[i]}
          strokeOpacity={0.65}
          strokeWidth={1.2}
        />
      ))}
      {wedgeLines.map((w) => {
        const rLine = R_OUT;
        return (
          <line
            key={w.id}
            x1={CX}
            y1={CY}
            x2={CX + rLine * Math.cos(w.t)}
            y2={CY + rLine * Math.sin(w.t)}
            stroke="rgba(0,0,0,0.12)"
            strokeWidth={1}
          />
        );
      })}
      <circle
        cx={CX}
        cy={CY}
        r={R_OUT}
        fill="none"
        stroke="rgba(0,0,0,0.15)"
        strokeWidth={1.2}
      />
      {RADAR_WEDGES.map((w, i) => {
        const t = (-Math.PI / 2) + (i * 2 * Math.PI) / RADAR_WEDGES.length;
        const mid = t + Math.PI / RADAR_WEDGES.length;
        const r = 228;
        const x = CX + r * 0.92 * Math.cos(mid);
        const y = CY + r * 0.92 * Math.sin(mid) + 4;
        return (
          <text
            key={w.id}
            x={x}
            y={y}
            fill="#5c5c5c"
            className="text-[6px] font-medium uppercase"
            textAnchor="middle"
          >
            {w.label}
          </text>
        );
      })}
      {placed.map((p) => {
        return (
        <g key={p.m.id} className="pointer-events-auto">
          <g
            onMouseEnter={() => {
              setT(p.m);
            }}
            onClick={() => {
              onPick(p.m);
            }}
            className="cursor-pointer"
            opacity={selected === p.m.id ? 1 : 0.95}
          >
            <circle
              cx={p.x}
              cy={p.y}
              r={p.dr}
              fill={p.fill}
              fillOpacity={p.band === "fair" ? 0.5 : 0.95}
              stroke={selected === p.m.id ? "#db0007" : "#fff"}
              strokeWidth={selected === p.m.id ? 2.5 : 1.2}
            />
          </g>
        </g>
        );
        },
      )}
      {tt && (
        <foreignObject
          x={8}
          y={8}
          width="200"
          height="100"
        >
          <div className="pointer-events-none rounded border border-[#e8e8e8] bg-white/95 p-2 text-[10px] text-[#1a1a1a]">
            <div className="line-clamp-2 font-medium leading-tight">{tt.question}</div>
            <div className="mt-1 text-[#5c5c5c]">
              Mkt {(tt.marketProb * 100).toFixed(0)}% ·
              {tt.consensusProb != null
                ? ` LLM ${(tt.consensusProb * 100).toFixed(0)}%`
                : " —"}{" "}
              {tt.edge != null && `| ${(tt.edge * 100) >= 0 ? "+" : ""}${(tt.edge * 100).toFixed(0)} pp`}
            </div>
          </div>
        </foreignObject>
      )}
    </svg>
  );
}
