import type { XCaptureAdapter } from "./types.js";
import { isYouTubeUrl } from "./urls.js";
import { captureYouTubeVideo, type YtDlpRunner } from "./youtube-capture.js";

/** Route YouTube URLs to yt-dlp; everything else to the web (Playwright) adapter. */
export function composeNotesCaptureAdapter(
  web: XCaptureAdapter,
  youtube?: { runner?: YtDlpRunner },
): XCaptureAdapter {
  return {
    capture(url) {
      if (isYouTubeUrl(url)) return captureYouTubeVideo(url, youtube);
      return web.capture(url);
    },
    close: () => web.close?.() ?? Promise.resolve(),
  };
}
