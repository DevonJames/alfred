/**
 * Minimal safe markdown → HTML for voice HUD captions / chat bubbles.
 * Escapes first, then applies a small set of inline transforms.
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Drop emphasis markers for plain progressive reveal / ghost text. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, "").trim())
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2")
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "• ")
    .replace(/^\s*\d+\.\s+/gm, (m) => m.trimStart());
}

/**
 * Soften trailing unclosed markers so mid-stream reveal doesn't flash raw `**`.
 */
export function closeIncompleteMarkdown(text: string): string {
  let s = text;
  const ticks = (s.match(/`/g) ?? []).length;
  if (ticks % 2 === 1) s += "`";
  const boldStars = (s.match(/\*\*/g) ?? []).length;
  if (boldStars % 2 === 1) s += "**";
  // Odd single-* after bold pairs removed — count remaining singles
  const singles = (s.replace(/\*\*/g, "").match(/\*/g) ?? []).length;
  if (singles % 2 === 1) s += "*";
  return s;
}

/** Escape + render common markdown used in Alfred replies. */
export function markdownToHtml(text: string): string {
  if (!text) return "";
  let s = escapeHtml(closeIncompleteMarkdown(text));

  // Fenced code (rare in speech captions; keep plain)
  s = s.replace(/```([\s\S]*?)```/g, (_m, body: string) => {
    return `<code class="md-block">${body.trim()}</code>`;
  });

  // Inline code
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");

  // Italic (avoid matching inside already-converted tags by using single *)
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");

  // Headings → strong line
  s = s.replace(/(^|<br>)#{1,6}\s+(.+?)(?=<br>|$)/g, "$1<strong class=\"md-h\">$2</strong>");

  // Newlines before list handling
  s = s.replace(/\r\n/g, "\n").replace(/\n/g, "<br>");

  // Unordered / ordered list markers at line starts
  s = s.replace(/(^|<br>)\s*[-*•]\s+/g, '$1<span class="md-li">• </span>');
  s = s.replace(/(^|<br>)\s*(\d+)\.\s+/g, '$1<span class="md-li">$2. </span>');

  return s;
}
