const RSS_URLS: Record<string, string> = {
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

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

export async function fetchNewsHeadlines(sources: string[]): Promise<string[]> {
  const headlines: string[] = [];
  for (const source of sources.slice(0, 3)) {
    const url = RSS_URLS[source];
    if (!url) continue;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const text = await res.text();
      const titleMatches =
        text.match(/<title>(?:<!\[CDATA\[)?([^\]<]+)(?:\]\]>)?<\/title>/g) ?? [];
      for (const match of titleMatches.slice(1, 5)) {
        let title = match
          .replace(/<\/?title>/g, "")
          .replace(/<!\[CDATA\[/g, "")
          .replace(/\]\]>/g, "");
        title = decodeEntities(title).trim();
        if (title && !headlines.includes(title)) headlines.push(title);
        if (headlines.length >= 8) return headlines;
      }
    } catch {
      // skip source
    }
  }
  return headlines;
}

export function formatNewsSpeech(headlines: string[]): string {
  if (!headlines.length) return "";
  const top = headlines.slice(0, 3).map((h) =>
    h
      .replace(/[_*#`]/g, "")
      .replace(/\s+/g, " ")
      .replace(/[.!?]+$/g, "")
      .trim(),
  );
  return `Top headlines: ${top.join(". ")}.`;
}

export function formatNewsMarkdown(headlines: string[]): string {
  if (!headlines.length) return "";
  return `**News**\n\n${headlines
    .slice(0, 6)
    .map((h) => `- ${h}`)
    .join("\n")}`;
}
