export interface MarketQuote {
  price: number;
  change24h: number;
}

export async function fetchCrypto(cryptoId: string): Promise<MarketQuote | null> {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(cryptoId)}&vs_currencies=usd&include_24hr_change=true`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, { usd?: number; usd_24h_change?: number }>;
    const row = data[cryptoId];
    if (!row) return null;
    return { price: row.usd ?? 0, change24h: row.usd_24h_change ?? 0 };
  } catch {
    return null;
  }
}

async function fetchStooq(symbol: string): Promise<MarketQuote | null> {
  try {
    const res = await fetch(`https://stooq.com/q/l/?s=${symbol}&f=sd2t2ohlcv&h&e=csv`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const lines = text.trim().split("\n");
    if (lines.length < 2) return null;
    const values = lines[1]!.split(",");
    const close = parseFloat(values[6]!);
    const open = parseFloat(values[3]!);
    if (Number.isNaN(close) || Number.isNaN(open) || open === 0) return null;
    return { price: close, change24h: ((close - open) / open) * 100 };
  } catch {
    return null;
  }
}

export async function fetchIndex(indexSymbol: "sp500" | "dow"): Promise<MarketQuote | null> {
  const symbol = indexSymbol === "sp500" ? "spy.us" : "^DJI";
  return fetchStooq(symbol);
}

export async function fetchMetals(metalSymbol: "gold" | "silver"): Promise<MarketQuote | null> {
  const symbol = metalSymbol === "gold" ? "XAUUSD" : "XAGUSD";
  return fetchStooq(symbol);
}

function pct(n: number): string {
  const abs = Math.abs(n).toFixed(1);
  return `${n >= 0 ? "+" : "-"}${abs}%`;
}

export function formatMarketsSpeech(parts: string[]): string {
  if (!parts.length) return "";
  return `Markets: ${parts.join("; ")}.`;
}

export function formatCryptoSpeech(q: MarketQuote, cryptoId: string): string {
  const name = cryptoId.charAt(0).toUpperCase() + cryptoId.slice(1);
  const price = Math.round(q.price / 100) * 100;
  return `${name} is about $${price.toLocaleString()} (${pct(q.change24h)})`;
}

export function formatIndexSpeech(q: MarketQuote, indexSymbol: "sp500" | "dow"): string {
  const name = indexSymbol === "sp500" ? "S&P 500" : "Dow Jones";
  return `${name} ${pct(q.change24h)}`;
}

export function formatMetalsSpeech(q: MarketQuote, metalSymbol: "gold" | "silver"): string {
  const name = metalSymbol === "gold" ? "Gold" : "Silver";
  return `${name} ${pct(q.change24h)}`;
}

export function formatMarketsMarkdown(lines: string[]): string {
  if (!lines.length) return "";
  return `**Markets**\n\n${lines.map((l) => `- ${l}`).join("\n")}`;
}
