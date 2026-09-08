/**
 * Sync plain-text prep for TTS. Stripping is intentional before any network
 * call so markdown markers never reach the synthesizer (and never delay first
 * audio waiting on a separate pass).
 */

/** Soften trailing unclosed markers so mid-stream caption reveal doesn't flash raw `**`. */
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

/**
 * Drop markdown syntax while keeping speakable words. Pure and sync — call
 * immediately before synthesize; do not await anything around it.
 */
export function stripMarkdownForSpeech(text: string): string {
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
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[*_#`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Map TTS word-alignment progress (against stripped speech) onto a markdown
 * caption prefix so the HUD can keep rendering the original reply.
 * Returns a raw prefix of `displayText` (no marker repair) so caption length
 * stays monotonic against the start payload.
 */
export function revealMarkdownBySpeechProgress(
  displayText: string,
  speechText: string,
  spokenChars: number,
): string {
  if (!displayText) return "";
  if (!speechText) return displayText;
  const ratio = Math.min(1, Math.max(0, spokenChars / speechText.length));
  const end = Math.min(displayText.length, Math.ceil(ratio * displayText.length));
  return displayText.slice(0, end);
}
