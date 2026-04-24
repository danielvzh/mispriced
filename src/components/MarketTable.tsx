"use client";

import type { MarketDTO } from "@/lib/serialize";

const AG = (a: number | null) =>
  a == null ? "—" : a > 0.65 ? "High" : a > 0.4 ? "Med" : "Low";

const VR = (v: string | null) => {
  if (v == null) {
    return "—";
  }
  if (v === "reality") {
    return "Reality dist.";
  }
  if (v === "wild") {
    return "Wild";
  }
  if (v === "questionable") {
    return "Questionable";
  }
  return "Fair";
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

type Props = {
  rows: MarketDTO[];
  onSelect: (m: MarketDTO) => void;
};

export function MarketTable({ rows, onSelect }: Props) {
  return (
    <div className="w-full overflow-x-auto rounded-lg border border-[#e8e8e8] bg-white">
      <table className="w-full min-w-[930px] border-separate border-spacing-0 text-left text-xs text-[#1a1a1a]">
        <thead>
          <tr className="text-[#5c5c5c]">
            <th className="border-b border-[#e8e8e8] py-2.5 pl-3 pr-1 text-[11px] font-medium">
              Market
            </th>
            <th className="border-b border-[#e8e8e8] py-2.5 px-1 text-[11px] font-medium">Category</th>
            <th className="border-b border-[#e8e8e8] py-2.5 px-1 text-[11px] font-medium">Mkt</th>
            <th className="border-b border-[#e8e8e8] py-2.5 px-1 text-[11px] font-medium">Grok</th>
            <th className="border-b border-[#e8e8e8] py-2.5 px-1 text-[11px] font-medium">Edge</th>
            <th className="border-b border-[#e8e8e8] py-2.5 px-1 text-[11px] font-medium">Agree</th>
            <th className="border-b border-[#e8e8e8] py-2.5 px-1 text-[11px] font-medium">Conf</th>
            <th className="border-b border-[#e8e8e8] py-2.5 px-1 text-[11px] font-medium">Vol</th>
            <th className="border-b border-[#e8e8e8] py-2.5 px-1 text-[11px] font-medium">Mispricing</th>
            <th className="border-b border-[#e8e8e8] py-2.5 pl-1 pr-3 text-right text-[11px] font-medium">Verdict</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr
              key={m.id}
              className="border-b border-[#f0f0f0] hover:bg-[#fafafa]"
            >
              <td className="max-w-[44vw] py-2 pl-3 pr-1 align-top">
                <button
                  type="button"
                  onClick={() => {
                    onSelect(m);
                  }}
                  className="w-full line-clamp-2 text-left text-[#1a1a1a] underline-offset-2 hover:underline"
                >
                  {m.question}
                </button>
              </td>
              <td className="text-[#5c5c5c]">{m.category}</td>
              <td className="tabular-nums">{(m.marketProb * 100).toFixed(0)}%</td>
              <td className="tabular-nums">
                {m.consensusProb == null
                  ? "—"
                  : `${(m.consensusProb * 100).toFixed(0)}%`}
              </td>
              <td
                className={
                  m.edge == null
                    ? "text-[#5c5c5c]"
                    : m.edge > 0
                      ? "text-[#16a34a] tabular-nums"
                      : m.edge < 0
                        ? "text-[#db0007] tabular-nums"
                        : "text-[#1a1a1a] tabular-nums"
                }
              >
                {m.edge == null
                  ? "—"
                  : `${(m.edge * 100) >= 0 ? "+" : ""}${(m.edge * 100).toFixed(1)}pp`}
              </td>
              <td className="text-[#5c5c5c]">{AG(m.agreement)}</td>
              <td className="tabular-nums text-[#5c5c5c]">
                {m.confidence == null ? "—" : m.confidence.toFixed(2)}
              </td>
              <td className="whitespace-nowrap text-[#5c5c5c]">
                {Math.round(m.volume24h).toLocaleString()}
              </td>
              <td className="py-2 px-1">
                {(() => {
                  const p = mispricingPill(m.verdict);
                  return (
                    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${p.cls}`}>
                      {p.label}
                    </span>
                  );
                })()}
              </td>
              <td className="pl-1 pr-3 text-right text-[#5c5c5c]">{VR(m.verdict)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
