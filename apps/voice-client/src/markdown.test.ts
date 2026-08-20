import { describe, expect, it } from "vitest";
import {
  closeIncompleteMarkdown,
  markdownToHtml,
  stripMarkdown,
} from "./markdown.js";

describe("markdownToHtml", () => {
  it("renders bold and escapes raw HTML", () => {
    const html = markdownToHtml('Focus on a **small pilot** <script>x</script>');
    expect(html).toContain("<strong>small pilot</strong>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders list markers without leaving markdown dashes bare", () => {
    const html = markdownToHtml("- What happened?\n- What worked?");
    expect(html).toContain('<span class="md-li">• </span>What happened?');
    expect(html).not.toMatch(/(^|>)- /);
  });

  it("does not leave raw ** in complete bold spans", () => {
    const html = markdownToHtml("**Action item:** Build a lightweight system");
    expect(html).toContain("<strong>Action item:</strong>");
    expect(html).not.toContain("**");
  });

  it("renders ATX headings without leaving ### markers", () => {
    const html = markdownToHtml("Intro\n### Action item\nBuild the pilot");
    expect(html).toContain('<strong class="md-h">Action item</strong>');
    expect(html).not.toContain("###");
  });
});

describe("stripMarkdown / closeIncompleteMarkdown", () => {
  it("strips emphasis for plain ghost text", () => {
    expect(stripMarkdown("a **bold** step")).toBe("a bold step");
  });

  it("closes trailing unclosed bold for mid-stream render", () => {
    expect(closeIncompleteMarkdown("Focus on a **small")).toBe("Focus on a **small**");
  });
});
