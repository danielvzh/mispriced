/** Map market text to a stable category bucket; angle = index / n * 2π */

export const CATEGORY_SLUGS = [
  "politics",
  "crypto",
  "sports",
  "science",
  "pop-culture",
  "other",
] as const;

export type CategorySlug = (typeof CATEGORY_SLUGS)[number];

const KEYWORDS: { keys: string[]; slug: CategorySlug }[] = [
  { slug: "politics", keys: ["trump", "biden", "election", "governor", "congress", "senate", "gop", "democrat", "republican", "president", "potus", "harris", "pope", "nato", "russia", "putin", "israel", "gaza", "ukraine", "zelenskyy", "macro"] },
  { slug: "crypto", keys: ["bitcoin", "btc", "eth", "ethereum", "crypto", "solana", "microstrategy", "mstr", "tether", "usdt", "defi", "coinbase", "a16z"] },
  { slug: "sports", keys: ["nfl", "nba", "mlb", "nhl", "super bowl", "world cup", "f1", "lakers", "nascar", "ufc", "wimbledon", "heisman", "march madness"] },
  { slug: "science", keys: ["ai", "llm", "nasa", "spacex", "climate", "pandemic", "fda", "health", "covid", "cancer", "nuclear", "openai", "neural"] },
  { slug: "pop-culture", keys: ["oscar", "gta", "taylor", "bey", "kanye", "billboard", "emmy", "grammy", "spotify", "met gala", "movie", "hbo", "netflix", "kardashian", "dune"] },
];

const DEFAULT_CAT: CategorySlug = "other";

function normalize(s: string): string {
  return s.toLowerCase();
}

export function detectCategory(
  question: string,
  eventTitle?: string | null,
  tagText?: string | null,
): CategorySlug {
  const blob = normalize(`${tagText || ""} ${eventTitle || ""} ${question}`);
  let best: CategorySlug = DEFAULT_CAT;
  let bestScore = 0;
  for (const { slug, keys } of KEYWORDS) {
    const score = keys.reduce(
      (acc, k) => (blob.includes(k) ? acc + 1 : acc),
      0,
    );
    if (score > bestScore) {
      bestScore = score;
      best = slug;
    }
  }
  if (bestScore > 0) {
    return best;
  }
  if (tagText) {
    const t = tagText.toLowerCase();
    for (const slug of CATEGORY_SLUGS) {
      if (t.includes(slug) || t.includes(slug.replace("-", " "))) {
        return slug;
      }
    }
  }
  return "other";
}

/** 5 radar wedges (UI – matches reference layout) */
export const RADAR_WEDGES = [
  { id: "politics-econ", label: "POLITICS & ECONOMY" },
  { id: "crypto", label: "CRYPTO & MARKETS" },
  { id: "society", label: "SOCIETY & CULTURE" },
  { id: "geopolitics", label: "GEOPOLITICS" },
  { id: "science", label: "SCIENCE & TECH" },
] as const;

/**
 * Map stored category + question text to wedge 0..4
 */
export function categoryToWedgeIndex(category: string, question: string): number {
  const q = question.toLowerCase();
  if (
    /(ukraine|gaza|israel|nato|iran|taiwan|putin|zelensky|ceasefire|nuclear|syria|rafah|houthi|china|xi jinping)/.test(
      q,
    )
  ) {
    return 3;
  }
  if (category === "crypto") {
    return 1;
  }
  if (category === "science") {
    return 4;
  }
  if (category === "sports" || category === "pop-culture") {
    return 2;
  }
  if (category === "politics") {
    return 0;
  }
  if (category === "other") {
    return 2;
  }
  return 0;
}

export function categoryTheta(
  category: string,
  idSalt: string,
  question = "",
  jitter = 0.2,
): number {
  const wedge = categoryToWedgeIndex(category, question);
  const n = 5;
  const sector = (2 * Math.PI) / n;
  const j = (stableUnit(idSalt) - 0.5) * jitter;
  // center of wedge, starting at top (-π/2)
  return -Math.PI / 2 + sector * (wedge + 0.5) + j;
}

function stableUnit(s: string): number {
  const x = [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return (x % 1000) / 1000;
}

/** horizon bucket for filter UI */
export function horizonForEnd(
  end: Date | null,
): "short" | "medium" | "long" {
  if (!end) return "medium";
  const days = (end.getTime() - Date.now()) / 864e5;
  if (days < 30) return "short";
  if (days < 120) return "medium";
  return "long";
}
