"use client";

import { useEffect, useRef, useState } from "react";

const WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

const SEP = "\n";

type BestBidAsk = { asset_id: string; best_bid?: string; best_ask?: string };

type Msg = { event_type?: string; asset_id?: string } & Record<string, unknown>;
type TradeMsg = Msg & {
  price?: string | number;
  last_trade_price?: string | number;
  size?: string | number;
  amount?: string | number;
  quantity?: string | number;
  trade_size?: string | number;
  side?: string;
};

export type LiveTrade = {
  assetId: string;
  price: number;
  size: number;
  notional: number;
  side?: string;
};

function parseMid(msg: unknown): { id: string; mid: number } | null {
  const o = msg as BestBidAsk & { bid?: string; ask?: string };
  const id = o.asset_id;
  if (!id) {
    return null;
  }
  const b = o.best_bid != null
    ? parseFloat(o.best_bid)
    : o.bid != null
      ? parseFloat(String(o.bid))
      : NaN;
  const a = o.best_ask != null
    ? parseFloat(o.best_ask)
    : o.ask != null
      ? parseFloat(String(o.ask))
      : NaN;
  if (isFinite(b) && isFinite(a)) {
    return { id, mid: (a + b) / 2 };
  }
  return null;
}

function num(x: unknown): number | null {
  if (typeof x === "number") {
    return isFinite(x) ? x : null;
  }
  if (typeof x === "string") {
    const n = parseFloat(x);
    return isFinite(n) ? n : null;
  }
  return null;
}

function parseTrade(msg: unknown): LiveTrade | null {
  if (!msg || typeof msg !== "object") {
    return null;
  }
  const o = msg as TradeMsg;
  const assetId = typeof o.asset_id === "string" ? o.asset_id : null;
  if (!assetId) {
    return null;
  }
  const ev = typeof o.event_type === "string" ? o.event_type.toLowerCase() : "";
  const price = num(o.price) ?? num(o.last_trade_price);
  const size =
    num(o.size) ??
    num(o.amount) ??
    num(o.quantity) ??
    num(o.trade_size);
  if (price == null || size == null) {
    return null;
  }
  if (
    ev &&
    !ev.includes("trade") &&
    !ev.includes("fill") &&
    !ev.includes("last")
  ) {
    return null;
  }
  return {
    assetId,
    price,
    size,
    notional: Math.abs(price * size),
    side: o.side,
  };
}

function idSignature(tokenIds: string[] | null): string {
  return (tokenIds ?? [])
    .slice(0, 100)
    .map((s) => String(s))
    .join(SEP);
}

/**
 * Browser connects to Polymarket CLOB (read-only) and maps asset_id -> midpoint for live nudges.
 * Reconnects only when the token id *set* changes, not on parent array ref churn.
 */
export function usePolymarketWs(
  tokenIds: string[] | null,
  onUpdate: (map: Map<string, number>) => void,
  onTrade?: (trade: LiveTrade) => void,
) {
  const cb = useRef(onUpdate);
  const tradeCb = useRef(onTrade);
  const [st, setSt] = useState<"off" | "open" | "reconnecting">("off");
  /** Recomputed every render: stable string for identical token sets. */
  const idKey = idSignature(tokenIds);

  useEffect(() => {
    cb.current = onUpdate;
  }, [onUpdate]);
  useEffect(() => {
    tradeCb.current = onTrade;
  }, [onTrade]);

  useEffect(() => {
    if (!idKey) {
      return;
    }
    const limited = idKey.split(SEP);
    if (!limited.length) {
      return;
    }

    const socket = new WebSocket(WS);
    const local = new Map<string, number>();

    socket.addEventListener("open", () => {
      setSt("open");
      const payload = {
        assets_ids: limited,
        type: "market",
        custom_feature_enabled: true,
      };
      socket.send(JSON.stringify(payload));
    });

    socket.addEventListener("message", (ev) => {
      let data: unknown;
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (Array.isArray(data)) {
        for (const m of data) {
          const p = parseMid(m);
          if (p) {
            local.set(p.id, p.mid);
          }
          const t = parseTrade(m);
          if (t && tradeCb.current) {
            tradeCb.current(t);
          }
        }
        cb.current(new Map(local));
        return;
      }
      if (data && typeof data === "object") {
        const msgField = (data as { message?: string }).message;
        if (typeof msgField === "string") {
          const inner = (() => {
            try {
              return JSON.parse(msgField) as unknown;
            } catch {
              return data;
            }
          })();
          if (Array.isArray(inner)) {
            for (const it of inner) {
              const p = parseMid(it);
              if (p) {
                local.set(p.id, p.mid);
              }
              const t = parseTrade(it);
              if (t && tradeCb.current) {
                tradeCb.current(t);
              }
            }
            cb.current(new Map(local));
            return;
          }
        }
        const p = parseMid((data as Msg) && data);
        if (p) {
          local.set(p.id, p.mid);
          cb.current(new Map(local));
        }
        const t = parseTrade(data);
        if (t && tradeCb.current) {
          tradeCb.current(t);
        }
      }
    });

    socket.addEventListener("close", () => {
      setSt("reconnecting");
    });

    return () => {
      socket.close();
    };
  }, [idKey]);

  return { status: st };
}
