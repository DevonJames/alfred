export const RSS_URLS: Record<string, string> = {
  "AP News": "https://apnews.com/index.rss",
  "BBC News": "https://feeds.bbci.co.uk/news/rss.xml",
  CNN: "http://rss.cnn.com/rss/cnn_topstories.rss",
  "Fox News": "http://feeds.foxnews.com/foxnews/latest",
  Bloomberg: "https://feeds.bloomberg.com/markets/news.rss",
  Reuters: "https://www.reutersagency.com/feed/",
  TechCrunch: "https://techcrunch.com/feed/",
  "Ars Technica": "https://feeds.arstechnica.com/arstechnica/index",
  "The Verge": "https://www.theverge.com/rss/index.xml",
  "Hacker News": "https://hnrss.org/frontpage",
  NPR: "https://feeds.npr.org/1001/rss.xml",
  "The Guardian": "https://www.theguardian.com/world/rss",
};

export const NEWS_SOURCE_OPTIONS = Object.keys(RSS_URLS);

/** One headline from a briefing news feed. */
export interface NewsHeadline {
  title: string;
  /** Article link when the feed included one. */
  url?: string;
  source: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function isFeedOrSourceTitle(title: string, source: string): boolean {
  const t = title.trim().toLowerCase();
  const s = source.trim().toLowerCase();
  if (!t || t.length < 12) return true; // too short to be a real headline
  if (t === s) return true;
  if (t === `${s} news` || t.startsWith(`${s} -`) || t.startsWith(`${s}:`)) return true;
  if (/^(bbc news|ap news|cnn|npr|reuters|techcrunch|the verge|ars technica)$/i.test(t)) {
    return true;
  }
  return false;
}

function headlineTitle(item: string | NewsHeadline): string {
  return typeof item === "string" ? item : item.title;
}

function cleanHeadlineTitle(title: string): string {
  return title
    .replace(/[_*#`]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();
}

/** Pull <item>/<entry> blocks and read title + link from each. */
function parseFeedItems(xml: string, source: string): NewsHeadline[] {
  const blocks =
    xml.match(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  const out: NewsHeadline[] = [];
  for (const block of blocks.slice(0, 10)) {
    const titleRaw =
      block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1] ?? "";
    const title = cleanHeadlineTitle(decodeEntities(titleRaw.replace(/<[^>]+>/g, "")));
    if (!title || isFeedOrSourceTitle(title, source)) continue;

    const link =
      block.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] ??
      block.match(/<link[^>]*>\s*([^<\s]+)\s*<\/link>/i)?.[1] ??
      block.match(/<guid[^>]*>(?:<!\[CDATA\[)?([^\]<\s]+)(?:\]\]>)?<\/guid>/i)?.[1];
    const url = link ? decodeEntities(link.trim()) : undefined;
    out.push({
      title,
      source,
      ...(url?.startsWith("http") ? { url } : {}),
    });
  }
  return out;
}

export async function fetchNewsHeadlines(sources: string[]): Promise<NewsHeadline[]> {
  const headlines: NewsHeadline[] = [];
  const seen = new Set<string>();
  for (const source of sources.slice(0, 3)) {
    const url = RSS_URLS[source];
    if (!url) continue;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const text = await res.text();
      for (const item of parseFeedItems(text, source)) {
        const key = item.title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        headlines.push(item);
        if (headlines.length >= 8) return headlines;
      }
    } catch {
      // skip source
    }
  }
  return headlines;
}

/** Spoken rundown. Numbers make "the second one" easy to follow up. */
export function formatNewsSpeech(
  headlines: Array<string | NewsHeadline>,
  opts: { inviteFollowUp?: boolean } = {},
): string {
  if (!headlines.length) return "";
  const ordinals = ["First", "Second", "Third", "Fourth", "Fifth"];
  const top = headlines.slice(0, 5).map((item, i) => {
    const title = cleanHeadlineTitle(headlineTitle(item));
    const ordinal = ordinals[i] ?? `${i + 1}.`;
    return `${ordinal}: ${title}`;
  });
  const body = `Here are today's top headlines. ${top.join(". ")}.`;
  return opts.inviteFollowUp === false
    ? body
    : `${body} Want me to dig into any of them?`;
}

export function formatNewsMarkdown(headlines: Array<string | NewsHeadline>): string {
  if (!headlines.length) return "";
  return `**News**\n\n${headlines
    .slice(0, 6)
    .map((item, i) => {
      const title = headlineTitle(item);
      const url = typeof item === "string" ? undefined : item.url;
      return url ? `${i + 1}. [${title}](${url})` : `${i + 1}. ${title}`;
    })
    .join("\n")}`;
}

/**
 * Pick a headline from the last rundown by 1-based index or title fragment.
 */
export function matchNewsHeadline(
  headlines: NewsHeadline[],
  opts: { index?: number | null; match?: string | null },
): NewsHeadline | null {
  if (!headlines.length) return null;
  if (opts.index != null && Number.isFinite(opts.index)) {
    const i = Math.floor(Number(opts.index));
    if (i >= 1 && i <= headlines.length) return headlines[i - 1] ?? null;
  }
  const needle = opts.match?.trim().toLowerCase();
  if (!needle) return null;
  const exact = headlines.find((h) => h.title.toLowerCase() === needle);
  if (exact) return exact;
  const partial = headlines.find(
    (h) =>
      h.title.toLowerCase().includes(needle) ||
      needle.includes(h.title.toLowerCase().slice(0, 40)),
  );
  return partial ?? null;
}

/** Strip HTML to readable plain text for summarization. */
export function extractArticleTextFromHtml(html: string): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const article =
    withoutNoise.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ??
    withoutNoise.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ??
    withoutNoise;
  const paras = [...article.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) =>
      decodeEntities(m[1]!.replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((p) => p.length >= 40);
  if (paras.length) return paras.join("\n\n");
  return decodeEntities(article.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchArticleText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; AlfredBriefing/1.0; +https://alfrd.net)",
        accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ctype = res.headers.get("content-type") ?? "";
    if (!/html|xml|text\/plain/i.test(ctype) && ctype) return null;
    const html = await res.text();
    const text = extractArticleTextFromHtml(html);
    return text.length >= 120 ? text : null;
  } catch {
    return null;
  }
}

/** Short extractive summary when no LLM is available. */
export function extractiveArticleSummary(text: string, title?: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40);
  const picked = (sentences.length ? sentences : [cleaned]).slice(0, 3).join(" ");
  const body = picked.length > 520 ? `${picked.slice(0, 500).trim()}…` : picked;
  const lead = title?.trim() ? `About "${cleanHeadlineTitle(title)}": ` : "";
  return `${lead}${body}`;
}
