import { fetchJson } from "./feed-http.js";

export interface HackerNewsQuery {
  topic?: "general" | "ai";
}

interface Story {
  title: string;
  score: number;
}

const AI_TITLE =
  /\b(a\.i\.|ai|llm|llms|gpt|openai|anthropic|claude|gemini|machine learning|neural)\b/i;

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

export function formatHackerNewsSpeech(stories: Story[], topic: "general" | "ai"): string {
  const titles = stories
    .map((story) => story.title.trim())
    .filter(Boolean)
    .slice(0, 3);
  if (!titles.length) {
    return topic === "ai"
      ? "I couldn't find AI stories on the Hacker News front page just now."
      : "I couldn't read the Hacker News front page just now.";
  }
  const list = joinAnd(titles);
  if (topic === "ai") {
    return `On Hacker News, AI stories on the front page include ${list}.`;
  }
  return `On Hacker News, developers are talking about ${list}.`;
}

export async function lookupHackerNews(query: HackerNewsQuery = {}): Promise<string> {
  const topic = query.topic === "ai" ? "ai" : "general";
  const ids = await fetchJson("https://hacker-news.firebaseio.com/v0/topstories.json");
  if (!Array.isArray(ids)) return "I couldn't reach Hacker News just now.";
  const slice = ids.filter((id) => typeof id === "number").slice(0, 20);
  const items = await Promise.all(
    slice.map((id) => fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)),
  );
  const stories: Story[] = [];
  for (const item of items) {
    const story = item as { type?: string; title?: string; score?: number } | null;
    if (!story || story.type !== "story" || typeof story.title !== "string") continue;
    stories.push({ title: story.title.trim(), score: story.score ?? 0 });
  }
  stories.sort((a, b) => b.score - a.score);
  const chosen =
    topic === "ai" ? stories.filter((story) => AI_TITLE.test(story.title)) : stories;
  if (topic === "ai" && !chosen.length && stories.length) {
    const general = formatHackerNewsSpeech(stories, "general");
    return `None of the current top Hacker News stories look like they're about AI. ${general}`;
  }
  return formatHackerNewsSpeech(chosen, topic);
}
