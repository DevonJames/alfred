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
 * Fetch a headline's article and return a short spoken summary.
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
        return "I don't have a recent headline list to dig into. Ask me what's in the news first.";
      }
      return "Which headline should I dig into — say the number, or a few words from the title.";
    }
    url = headline.url?.trim() || "";
  }

  const title = (opts.title?.trim() || headline?.title || "").trim();
  if (!url) {
    return title
      ? `I have that headline — "${title}" — but the feed didn't include a link I can open.`
      : "I couldn't find a link for that headline.";
  }

  const body = await fetchArticleText(url);
  if (!body) {
    return title
      ? `I couldn't load the full article for "${title}" just now.`
      : "I couldn't load that article just now.";
  }

  if (opts.llm) {
    try {
      const drafted = await opts.llm([
        {
          role: "system",
          content:
            "You are Alfred. Summarize the news article for spoken conversation in 2-4 short sentences. " +
            "Lead with the news, not 'this article says'. No markdown, no bullet lists, no preamble.",
        },
        {
          role: "user",
          content: `Headline: ${title || "(untitled)"}\n\nArticle text:\n${body.slice(0, 12_000)}`,
        },
      ]);
      const spoken = drafted.trim();
      if (spoken) return spoken.replace(/\s+/g, " ").trim();
    } catch {
      /* fall through to extractive */
    }
  }

  return extractiveArticleSummary(body, title || undefined);
}
