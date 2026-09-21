const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const BOT_QR_VERSION = 1;
export const BOT_URI_SCHEME = "alfred";
export const BOT_URI_HOST = "bot";

export interface BotClaimPayload {
  botId: string;
  session: string;
  hosts: string[];
  name?: string;
}

function isUuid(value: string): boolean {
  return UUID.test(value.trim());
}

function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? "" : pair.slice(eq + 1);
    try {
      out[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue.replace(/\+/g, " "));
    } catch {
      out[rawKey] = rawValue;
    }
  }
  return out;
}

function parseHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^https?:\/\//i.test(item));
}

export function buildBotUri(payload: BotClaimPayload): string {
  const params = new URLSearchParams({
    v: String(BOT_QR_VERSION),
    botId: payload.botId,
    session: payload.session,
    hosts: payload.hosts.join(","),
  });
  if (payload.name) params.set("name", payload.name);
  return `${BOT_URI_SCHEME}://${BOT_URI_HOST}?${params.toString()}`;
}

export function parseBotPayload(raw: string): BotClaimPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed) as Record<string, unknown>;
      if (json.type && json.type !== "alfred.bot.claim") return null;
      const botId = typeof json.botId === "string" ? json.botId : "";
      const session = typeof json.session === "string" ? json.session : "";
      const hosts = Array.isArray(json.hosts)
        ? json.hosts.filter((h): h is string => typeof h === "string")
        : parseHosts(typeof json.hosts === "string" ? json.hosts : undefined);
      const name = typeof json.name === "string" ? json.name : undefined;
      return build(botId, session, hosts, name);
    } catch {
      return null;
    }
  }
  const q = trimmed.indexOf("?");
  if (q === -1) return null;
  const head = trimmed.slice(0, q).toLowerCase();
  if (!/(^|[:/])bot\/?$/.test(head)) return null;
  const params = parseQuery(trimmed.slice(q + 1));
  return build(params.botId ?? "", params.session ?? "", parseHosts(params.hosts), params.name);
}

function build(botId: string, session: string, hosts: string[], name?: string): BotClaimPayload | null {
  const id = botId.trim();
  const nonce = session.trim();
  if (!isUuid(id) || !isUuid(nonce) || hosts.length === 0) return null;
  return { botId: id, session: nonce, hosts, name: name?.trim() || undefined };
}
