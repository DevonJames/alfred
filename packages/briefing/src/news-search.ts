/** One hit from a headline dig web search. */
export type NewsSearchHit = {
  title: string;
  url: string;
  snippet: string;
};

const SEARCH_UA =
  "Mozilla/5.0 (compatible; AlfredBriefing/1.0; +https://alfrd.net)";

/**
 * Decode DuckDuckGo redirect links (`/l/?uddg=…`) into the real article URL.
 */
export function unwrapDuckDuckGoUrl(href: string): string | null {
  const raw = href.trim();
  if (!raw) return null;
  try {
    const absolute = raw.startsWith("//")
      ? `https:${raw}`
      : raw.startsWith("http")
        ? raw
        : `https://duckduckgo.com${raw.startsWith("/") ? "" : "/"}${raw}`;
    const parsed = new URL(absolute);
    const uddg = parsed.searchParams.get("uddg");
    if (uddg?.startsWith("http")) return uddg;
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      if (!/duckduckgo\.com$/i.test(parsed.hostname)) return parsed.toString();
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Parse DuckDuckGo HTML SERP markup into title/url/snippet hits. */
export function parseDuckDuckGoHtml(html: string): NewsSearchHit[] {
  const hits: NewsSearchHit[] = [];
  const seen = new Set<string>();

  // Prefer splitting on web-result cards when present; otherwise scan whole page.
  const blocks = html.includes("web-result")
    ? html.split(/(?=<div[^>]*\bweb-result\b)/i).slice(1)
    : [html];

  for (const block of blocks) {
    const linkMatch =
      block.match(/<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ??
      block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = unwrapDuckDuckGoUrl(decodeHtmlEntities(linkMatch[1] ?? ""));
    if (!url || seen.has(url)) continue;
    const title = cleanText(linkMatch[2] ?? "");
    if (!title) continue;
    const snippetRaw =
      block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/i)?.[1] ?? "";
    const snippet = cleanText(snippetRaw);
    seen.add(url);
    hits.push({ title, url, snippet });
    if (hits.length >= 8) break;
  }
  return hits;
}

/**
 * Search the open web for a headline (DuckDuckGo HTML — no API key).
 */
export async function searchNewsWeb(query: string): Promise<NewsSearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        "user-agent": SEARCH_UA,
        accept: "text/html",
      },
    });
    if (!res.ok) return [];
    return parseDuckDuckGoHtml(await res.text());
  } catch {
    return [];
  }
}

/**
 * Prefer OpenAI Responses + web_search when keyed — the model searches and
 * writes the spoken dig itself. Returns null when unavailable.
 */
export async function researchNewsWithOpenAiWebSearch(opts: {
  title: string;
  url?: string;
  apiKey?: string;
  model?: string;
}): Promise<string | null> {
  const apiKey = (opts.apiKey ?? process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) return null;
  const title = opts.title.trim();
  if (!title) return null;

  const model =
    opts.model?.trim() ||
    process.env.ALFRED_NEWS_DIG_MODEL?.trim() ||
    "gpt-4.1";

  const feedNote = opts.url?.trim()
    ? `The briefing linked this story at: ${opts.url.trim()}`
    : "The briefing did not include a reliable article link.";

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: AbortSignal.timeout(55_000),
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        tools: [{ type: "web_search" }],
        tool_choice: "auto",
        input: [
          {
            role: "system",
            content: DIG_SYSTEM_PROMPT,
          },
          {
            role: "user",
            content:
              `Headline: ${title}\n${feedNote}\n\n` +
              "Search the web for this story (do not just rephrase the headline). " +
              "Read enough coverage to tell what happened with concrete detail.",
          },
        ],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn(
        `[briefing] openai web dig failed (${res.status}): ${errText.slice(0, 200)}`,
      );
      return null;
    }
    const data = (await res.json()) as {
      output_text?: string;
      output?: Array<{
        type?: string;
        content?: Array<{ type?: string; text?: string }>;
      }>;
    };
    const direct = data.output_text?.trim();
    if (direct) return cleanSpoken(direct);
    const parts: string[] = [];
    for (const item of data.output ?? []) {
      if (item.type !== "message") continue;
      for (const part of item.content ?? []) {
        if ((part.type === "output_text" || part.type === "text") && part.text?.trim()) {
          parts.push(part.text.trim());
        }
      }
    }
    const joined = parts.join(" ").trim();
    return joined ? cleanSpoken(joined) : null;
  } catch (err) {
    console.warn(
      "[briefing] openai web dig error:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export const DIG_SYSTEM_PROMPT =
  "You are Alfred. The user wants the real story behind a news headline — not a " +
  "one-line paraphrase of the title. Search and synthesize. Speak aloud in clear " +
  "conversational English for about 45 to 90 seconds (roughly 8 to 14 sentences). " +
  "Cover what happened, who is involved, the important specifics (names, places, " +
  "numbers, quotes when they matter), why it is news, and any notable reaction or " +
  "next step. Lead with the news itself. No markdown, no bullet lists, no preamble " +
  "like 'here's what I found' or 'according to my search', no citation brackets.";

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#(\d+);/g, (_, num: string) => {
      const code = Number(num);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}

function cleanText(s: string): string {
  return decodeHtmlEntities(s.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSpoken(s: string): string {
  return s
    .replace(/\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[[^\]]+\]/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
