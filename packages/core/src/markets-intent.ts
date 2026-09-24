export type MarketsIntent =
  | { kind: "crypto"; cryptoId?: string }
  | { kind: "metals"; metalSymbol: "gold" | "silver" };

const TALKING_ABOUT_TOOL =
  /\b(get[_\s-]*(crypto|bitcoin|metal)[_\s-]*price|lookup[_\s-]*live[_\s-]*(crypto|metals))\b/i;

const CRYPTO_NOUN =
  /\b(bitcoin|btc|ethereum|eth\b|solana|\bsol\b|cardano|\bada\b|ripple|\bxrp\b|dogecoin|\bdoge\b|crypto(?:currency)?)\b/i;

const METALS_NOUN = /\b(gold|silver|precious\s+metals?|metal\s+prices?)\b/i;

const PRICE_CUE =
  /\b(price|prices|trading\s+at|worth|value|how(?:'s| is)|what(?:'s| is)|check|look\s*up|quote)\b/i;

/**
 * True when the utterance is asking for a crypto or metals price.
 */
export function looksLikeMarketsTask(text: string): boolean {
  return parseMarketsIntent(text) != null;
}

/**
 * Deterministic crypto / metals ask from casual speech.
 * Uses CoinGecko + Stooq the same way the daily briefing does.
 */
export function parseMarketsIntent(text: string): MarketsIntent | null {
  const raw = text.trim();
  if (!raw || TALKING_ABOUT_TOOL.test(raw)) return null;

  const wantsCrypto = CRYPTO_NOUN.test(raw);
  const wantsMetals = METALS_NOUN.test(raw);
  if (!wantsCrypto && !wantsMetals) return null;

  // Bare asset names are enough ("how's bitcoin", "gold?"). Prefer an
  // explicit price/value cue when both crypto and metals appear, but still
  // accept "bitcoin and gold" as crypto-first when crypto is named.
  if (wantsCrypto && wantsMetals && !PRICE_CUE.test(raw)) {
    // "bitcoin and gold" → crypto; metals alone handled below.
  }

  if (wantsCrypto) {
    return { kind: "crypto", cryptoId: extractCryptoId(raw) };
  }

  if (wantsMetals) {
    return { kind: "metals", metalSymbol: extractMetalSymbol(raw) };
  }

  return null;
}

function extractCryptoId(text: string): string | undefined {
  if (/\b(bitcoin|\bbtc\b)\b/i.test(text)) return "bitcoin";
  if (/\b(ethereum|\beth\b)\b/i.test(text)) return "ethereum";
  if (/\b(solana|\bsol\b)\b/i.test(text)) return "solana";
  if (/\b(cardano|\bada\b)\b/i.test(text)) return "cardano";
  if (/\b(ripple|\bxrp\b)\b/i.test(text)) return "ripple";
  if (/\b(dogecoin|\bdoge\b)\b/i.test(text)) return "dogecoin";
  // Bare "crypto" → briefing default (caller fills from prefs).
  return undefined;
}

function extractMetalSymbol(text: string): "gold" | "silver" {
  if (/\bsilver\b/i.test(text)) return "silver";
  return "gold";
}
