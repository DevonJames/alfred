import type { BriefingConfig } from "./config.js";
import {
  fetchCrypto,
  fetchMetals,
  formatCryptoSpeech,
  formatMetalsSpeech,
} from "./markets.js";
import { resolveBriefingConfig } from "./prefs.js";

const KNOWN_CRYPTO: Record<string, string> = {
  bitcoin: "bitcoin",
  btc: "bitcoin",
  ethereum: "ethereum",
  eth: "ethereum",
  solana: "solana",
  sol: "solana",
  cardano: "cardano",
  ada: "cardano",
  ripple: "ripple",
  xrp: "ripple",
  dogecoin: "dogecoin",
  doge: "dogecoin",
};

/**
 * Live crypto quote for conversational asks (same CoinGecko path as the daily briefing).
 */
export async function lookupLiveCryptoPrice(
  opts: { cryptoId?: string | null } = {},
  configOverrides: Partial<BriefingConfig> = {},
): Promise<string> {
  const config = await resolveBriefingConfig(configOverrides);
  const requested = opts.cryptoId?.trim().toLowerCase() || "";
  const cryptoId =
    (requested && KNOWN_CRYPTO[requested]) ||
    requested ||
    config.cryptoId ||
    "bitcoin";
  const quote = await fetchCrypto(cryptoId);
  if (!quote) {
    return `I couldn't get a price for ${cryptoId} just now.`;
  }
  return formatCryptoSpeech(quote, cryptoId);
}

/**
 * Live gold/silver quote for conversational asks (same Stooq path as the daily briefing).
 */
export async function lookupLiveMetalsPrice(
  opts: { metalSymbol?: "gold" | "silver" | null } = {},
  configOverrides: Partial<BriefingConfig> = {},
): Promise<string> {
  const config = await resolveBriefingConfig(configOverrides);
  const metal =
    opts.metalSymbol === "gold" || opts.metalSymbol === "silver"
      ? opts.metalSymbol
      : config.metalSymbol === "silver"
        ? "silver"
        : "gold";
  const quote = await fetchMetals(metal);
  if (!quote) {
    return `I couldn't get a ${metal} price just now.`;
  }
  return formatMetalsSpeech(quote, metal);
}

export { KNOWN_CRYPTO };
