/** Shapes we read from Polymarket public APIs (not exhaustive) */

export type GammaMarket = {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  description?: string;
  endDate?: string;
  active: boolean;
  closed: boolean;
  outcomePrices: string; // json string
  outcomes: string; // json string
  clobTokenIds: string; // json string
  enableOrderBook?: boolean;
  volume24hr?: number;
  volume24hrClob?: number;
  liquidityClob?: number;
  liquidityNum?: number;
  updatedAt?: string;
  events?: Array<{
    id: string;
    title: string;
    tags?: Array<{ id: string; slug: string; label: string }>;
  }>;
  /** From /markets/keyset with include_tag=true */
  tags?: Array<{ id: string; slug: string; label: string }>;
};
