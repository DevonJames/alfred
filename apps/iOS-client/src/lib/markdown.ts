/**
 * Minimal markdown helpers for Talk captions (mirrors voice-client).
 */

/** Soften trailing unclosed markers so mid-stream reveal doesn't flash raw `**`. */
export function closeIncompleteMarkdown(text: string): string {
  let s = text;
  const ticks = (s.match(/`/g) ?? []).length;
  if (ticks % 2 === 1) s += "`";
  const boldStars = (s.match(/\*\*/g) ?? []).length;
  if (boldStars % 2 === 1) s += "**";
  const singles = (s.replace(/\*\*/g, "").match(/\*/g) ?? []).length;
  if (singles % 2 === 1) s += "*";
  return s;
}

/** Drop emphasis markers for plain progressive ghost text. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, "").trim())
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2")
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "• ")
    .replace(/^\s*\d+\.\s+/gm, (m) => m.trimStart());
}
