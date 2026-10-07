import type { BriefingConfig } from "./config.js";
import type { GreetingLlm } from "./greeting.js";
import {
  extractiveArticleSummary,
  fetchArticleText,
  fetchNewsHeadlines,
  formatNewsSpeech,
  matchNewsHeadline,
  type NewsHeadline,
} from "./news.js";
import {
  DIG_SYSTEM_PROMPT,
  researchNewsWithOpenAiWebSearch,
  searchNewsWeb,
  type NewsSearchHit,
} from "./news-search.js";
import { resolveBriefingConfig } from "./prefs.js";

export interface LiveNewsLookupResult {
  speech: string;
  headlines: NewsHeadline[];
}

/**
 * Live headlines for conversational "what's in the news" asks.
 * Uses the same RSS sources as the daily briefing prefs.
 */
export async function lookupLiveNewsHeadlines(
  configOverrides: Partial<BriefingConfig> = {},
): Promise<LiveNewsLookupResult> {
  const config = await resolveBriefingConfig(configOverrides);
  const sources = config.newsSources?.length
    ? config.newsSources
    : ["AP News", "BBC News", "TechCrunch"];
  const headlines = await fetchNewsHeadlines(sources);
  if (!headlines.length) {
    return {
      speech: "I couldn't pull any headlines just now. Try again in a moment.",
      headlines: [],
    };
  }
  return { speech: formatNewsSpeech(headlines), headlines };
}

export interface SummarizeNewsArticleOpts {
  /** 1-based index into the last headline rundown. */
  index?: number | null;
  /** Fragment of the headline title. */
  match?: string | null;
  /** Direct article URL when known. */
  url?: string | null;
  /** Title when summarizing a direct URL. */
  title?: string | null;
  /** Last headlines spoken this conversation. */
  recent?: NewsHeadline[];
  /** Optional LLM for a tighter spoken summary. */
  llm?: GreetingLlm | null;
}

/**
 * Dig into a headline: web-search the story, read coverage, then speak a
 * detailed rundown — not a one-line paraphrase of the title.
 */
export async function summarizeNewsArticle(
  opts: SummarizeNewsArticleOpts = {},
): Promise<string> {
  const recent = opts.recent ?? [];
  let headline: NewsHeadline | null = null;
  let url = opts.url?.trim() || "";

  if (!url) {
    headline = matchNewsHeadline(recent, { index: opts.index, match: opts.match });
    if (!headline) {
      if (!recent.length) {
        return "I don't have a recent headline list to dig into. Ask for the news, or play the daily briefing first.";
      }
      return "Which headline should I dig into — say the number, or a few words from the title.";
    }
    url = headline.url?.trim() || "";
  }

  const title = (opts.title?.trim() || headline?.title || "").trim();
  if (!title && !url) {
    return "Which headline should I dig into — say the number, or a few words from the title.";
  }

  // 1) OpenAI Responses + web_search — best when keyed.
  const viaOpenAi = await researchNewsWithOpenAiWebSearch({
    title: title || "this headline",
    url: url || undefined,
  });
  if (viaOpenAi) return viaOpenAi;

  // 2) DuckDuckGo search + fetch top articles + LLM (or extractive).
  const viaSearch = await digViaWebSearch({
    title: title || "this headline",
    url: url || undefined,
    llm: opts.llm,
  });
  if (viaSearch) return viaSearch;

  // 3) Last resort: original feed URL alone.
  if (!url) {
    return title
      ? `I searched for "${title}" but couldn't pull enough coverage just now.`
      : "I couldn't dig into that headline just now.";
  }

  const body = await fetchArticleText(url);
  if (!body) {
    return title
      ? `I couldn't load coverage for "${title}" just now.`
      : "I couldn't load that article just now.";
  }

  if (opts.llm) {
    const drafted = await draftDigFromSources(opts.llm, title || "(untitled)", [
      { label: "Feed article", text: body },
    ]);
    if (drafted) return drafted;
  }

  return extractiveArticleSummary(body, title || undefined, { maxSentences: 8, maxChars: 1400 });
}

async function digViaWebSearch(opts: {
  title: string;
  url?: string;
  llm?: GreetingLlm | null;
}): Promise<string | null> {
  const hits = await searchNewsWeb(opts.title);
  const urls: string[] = [];
  const seen = new Set<string>();
  if (opts.url) {
    seen.add(opts.url);
    urls.push(opts.url);
  }
  for (const hit of hits) {
    if (seen.has(hit.url)) continue;
    seen.add(hit.url);
    urls.push(hit.url);
    if (urls.length >= 4) break;
  }

  const snippets = formatSearchSnippets(hits);
  const bodies = await Promise.all(
    urls.slice(0, 3).map(async (articleUrl) => {
      const text = await fetchArticleText(articleUrl);
      return text ? { label: articleUrl, text } : null;
    }),
  );
  const sources = bodies.filter((b): b is { label: string; text: string } => Boolean(b));

  if (!sources.length && !snippets) return null;

  if (opts.llm) {
    const drafted = await draftDigFromSources(opts.llm, opts.title, sources, snippets);
    if (drafted) return drafted;
  }

  if (sources[0]) {
    return extractiveArticleSummary(sources[0].text, opts.title, {
      maxSentences: 8,
      maxChars: 1400,
    });
  }
  if (snippets) {
    return `On "${opts.title}": ${snippets.slice(0, 900)}`;
  }
  return null;
}

async function draftDigFromSources(
  llm: GreetingLlm,
  title: string,
  sources: Array<{ label: string; text: string }>,
  snippets?: string,
): Promise<string | null> {
  const chunks: string[] = [];
  if (snippets?.trim()) {
    chunks.push(`Search snippets:\n${snippets.trim().slice(0, 4_000)}`);
  }
  let used = 0;
  for (const source of sources) {
    const room = 14_000 - used;
    if (room < 500) break;
    const slice = source.text.slice(0, room);
    used += slice.length;
    chunks.push(`Source (${source.label}):\n${slice}`);
  }
  if (!chunks.length) return null;

  try {
    const drafted = await llm([
      { role: "system", content: DIG_SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `Headline: ${title}\n\n` +
          "Using the search results and article text below, tell the full story with concrete detail.\n\n" +
          chunks.join("\n\n---\n\n"),
      },
    ]);
    const spoken = drafted.trim().replace(/\s+/g, " ").trim();
    return spoken || null;
  } catch {
    return null;
  }
}

function formatSearchSnippets(hits: NewsSearchHit[]): string {
  return hits
    .slice(0, 6)
    .map((hit, i) => {
      const bit = hit.snippet || hit.title;
      return `${i + 1}. ${hit.title}${bit && bit !== hit.title ? ` — ${bit}` : ""} (${hit.url})`;
    })
    .join("\n");
}
