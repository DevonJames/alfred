import { describe, expect, it } from "vitest";
import { parseDuckDuckGoHtml, unwrapDuckDuckGoUrl } from "./news-search.js";

describe("unwrapDuckDuckGoUrl", () => {
  it("unwraps uddg redirect links", () => {
    const href =
      "//duckduckgo.com/l/?uddg=https%3A%2F%2Fnypost.com%2F2026%2F10%2F04%2Fstory%2F&rut=abc";
    expect(unwrapDuckDuckGoUrl(href)).toBe("https://nypost.com/2026/10/04/story/");
  });

  it("passes through direct http urls", () => {
    expect(unwrapDuckDuckGoUrl("https://example.com/a")).toBe("https://example.com/a");
  });
});

describe("parseDuckDuckGoHtml", () => {
  it("extracts title, url, and snippet from SERP markup", () => {
    const html = `
      <div class="result results_links results_links_deep web-result ">
        <h2 class="result__title">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">
            First Story Title
          </a>
        </h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">
          Concrete details about what happened and who was involved.
        </a>
      </div>
      <div class="result results_links results_links_deep web-result ">
        <h2 class="result__title">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftwo">
            Second Story Title
          </a>
        </h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftwo">
          More context from another outlet.
        </a>
      </div>`;
    const hits = parseDuckDuckGoHtml(html);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      title: "First Story Title",
      url: "https://example.com/one",
      snippet: expect.stringMatching(/Concrete details/),
    });
    expect(hits[1]?.url).toBe("https://example.com/two");
  });
});
