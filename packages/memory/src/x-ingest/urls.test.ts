import { describe, expect, it } from "vitest";
import {
  archiveDisplayUrl,
  canonicalizeInboxUrl,
  canonicalizeXUrl,
  canonicalizeYouTubeUrl,
  extractInboxLinkUrls,
  extractXUrls,
  extractYouTubeUrls,
  handleFromXStatusUrl,
  isYouTubePlaylistOrChannelUrl,
  isXUrl,
  slugFromTitle,
  youtubeVideoIdFromUrl,
} from "./urls.js";

describe("x-ingest urls", () => {
  it("extracts x.com and twitter.com links from HTML", () => {
    const html = `<div>see <a href="https://x.com/foo/status/1234567890?s=20">post</a> and https://twitter.com/bar/status/99</div>`;
    expect(extractXUrls(html)).toEqual([
      "https://x.com/foo/status/1234567890?s=20",
      "https://twitter.com/bar/status/99",
    ]);
  });

  it("canonicalizes status URLs and strips tracking", () => {
    expect(canonicalizeXUrl("https://twitter.com/foo/status/1234567890?s=20&t=abc")).toBe(
      "https://x.com/i/status/1234567890",
    );
    expect(canonicalizeXUrl("https://www.x.com/i/article/abc123")).toBe(
      "https://x.com/i/article/abc123",
    );
  });

  it("detects X URLs", () => {
    expect(isXUrl("https://x.com/foo/status/1")).toBe(true);
    expect(isXUrl("https://example.com/x")).toBe(false);
  });

  it("slugs note titles", () => {
    expect(slugFromTitle("Marketing X")).toBe("marketing-x");
  });

  it("canonicalizes youtu.be, shorts, and tracking params", () => {
    expect(canonicalizeYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?si=abc")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(canonicalizeYouTubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(canonicalizeYouTubeUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ&pp=0g")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(canonicalizeInboxUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(youtubeVideoIdFromUrl("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts mixed X and YouTube inbox URLs", () => {
    const html = `<div>
      <a href="https://x.com/foo/status/1">x</a>
      https://youtu.be/dQw4w9WgXcQ?si=zz
      https://www.youtube.com/playlist?list=PLxxxx
    </div>`;
    expect(extractYouTubeUrls(html)).toEqual([
      "https://youtu.be/dQw4w9WgXcQ?si=zz",
      "https://www.youtube.com/playlist?list=PLxxxx",
    ]);
    expect(extractInboxLinkUrls(html)).toHaveLength(3);
    expect(isYouTubePlaylistOrChannelUrl("https://www.youtube.com/playlist?list=PLxxxx")).toBe(true);
    expect(isYouTubePlaylistOrChannelUrl("https://www.youtube.com/@acme")).toBe(true);
    expect(isYouTubePlaylistOrChannelUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxxxx")).toBe(
      false,
    );
  });

  it("reads the handle from a status URL and drops tracking for archive lines", () => {
    expect(handleFromXStatusUrl("https://x.com/vibemarketer_/status/2089740376718610518?s=12&t=abc")).toBe(
      "vibemarketer_",
    );
    expect(handleFromXStatusUrl("https://x.com/i/status/2089740376718610518")).toBeUndefined();
    expect(
      archiveDisplayUrl(
        "https://x.com/felixrieseberg/status/2079624265528475975?s=12&t=JU3179xa-tFaV7rjXb2E3Q",
      ),
    ).toBe("https://x.com/felixrieseberg/status/2079624265528475975");
    expect(archiveDisplayUrl("https://youtu.be/dQw4w9WgXcQ?si=zz")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
  });

  it("repairs Notes-mangled &amp;t= query strings", () => {
    expect(
      extractXUrls("https://x.com/cyrilxbt/status/2088088373642539490?s=12&ampampt=JU3179xa-tFaV7rjXb2E3Q"),
    ).toEqual(["https://x.com/cyrilxbt/status/2088088373642539490?s=12&t=JU3179xa-tFaV7rjXb2E3Q"]);
    expect(
      canonicalizeXUrl("https://x.com/cyrilxbt/status/2088088373642539490?s=12&ampt=abc"),
    ).toBe("https://x.com/i/status/2088088373642539490");
  });
});
