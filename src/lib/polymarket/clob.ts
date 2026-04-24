const CLOB = "https://clob.polymarket.com";

export type ClobBook = {
  market?: string;
  asset_id: string;
  timestamp?: string;
  bids: { price: string; size: string }[];
  asks: { price: string; size: string }[];
};

function bestBid(bids: ClobBook["bids"]): number | null {
  if (!bids.length) return null;
  return Math.max(...bids.map((b) => parseFloat(b.price)));
}

function bestAsk(asks: ClobBook["asks"]): number | null {
  if (!asks.length) return null;
  return Math.min(...asks.map((a) => parseFloat(a.price)));
}

/**
 * Notional "depth" near the top of book: sum of top 5 level sizes
 */
function depthN(levels: { size: string }[], n: number): number {
  return levels.slice(0, n).reduce((s, l) => s + parseFloat(l.size || "0"), 0);
}

export function summarizeBook(book: ClobBook): {
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
  spread: number | null;
  depth: number;
} {
  const bb = bestBid(book.bids);
  const ba = bestAsk(book.asks);
  if (bb == null || ba == null) {
    return {
      bestBid: bb,
      bestAsk: ba,
      midpoint: null,
      spread: null,
      depth: depthN(book.bids, 5) + depthN(book.asks, 5),
    };
  }
  const mid = (bb + ba) / 2;
  return {
    bestBid: bb,
    bestAsk: ba,
    midpoint: mid,
    spread: Math.max(0, ba - bb),
    depth: depthN(book.bids, 5) + depthN(book.asks, 5),
  };
}

export async function fetchOrderBook(
  tokenId: string,
): Promise<ClobBook | null> {
  const u = new URL(`${CLOB}/book`);
  u.searchParams.set("token_id", tokenId);
  const r = await fetch(u.toString(), { next: { revalidate: 0 } });
  if (!r.ok) return null;
  return (await r.json()) as ClobBook;
}
