import {
  captureYouTubeVideo,
  ingestXUrl,
  isYouTubeUrl,
  youtubeVideoIdFromUrl,
  type OipLocalMemoryProvider,
  type XCaptureAdapter,
  type XIngestItemResult,
  type YtDlpRunner,
} from "@alfred/memory";
import { activeProfileId, oipForProfile } from "./oip-memory.js";

/** Why a pasted string is not a single YouTube video, or undefined when it is. */
export function youtubeLinkError(rawUrl: string): string | undefined {
  const url = rawUrl.trim();
  if (!url) return "Paste a YouTube link.";
  if (isYouTubeUrl(url) && youtubeVideoIdFromUrl(url)) return undefined;
  if (isYouTubeUrl(url)) {
    return "Playlists and channel pages are not supported. Paste a single video link.";
  }
  return "Paste a YouTube video link (youtube.com or youtu.be).";
}

/**
 * Fetch captions for one video with yt-dlp and write the full transcript into
 * the same OIP memory the rest of the desktop uses.
 */
export async function ingestYouTubeLink(
  rawUrl: string,
  opts?: {
    profileId?: string;
    provider?: OipLocalMemoryProvider;
    runner?: YtDlpRunner;
    capture?: XCaptureAdapter;
  },
): Promise<XIngestItemResult> {
  const url = rawUrl.trim();
  const error = youtubeLinkError(url);
  if (error) throw new Error(error);
  const profileId = opts?.profileId ?? activeProfileId();
  const capture: XCaptureAdapter =
    opts?.capture ?? {
      capture: (target) => captureYouTubeVideo(target, opts?.runner ? { runner: opts.runner } : undefined),
    };
  return ingestXUrl({
    url,
    profileId,
    provider: opts?.provider ?? oipForProfile(profileId),
    capture,
    includeTranscript: true,
  });
}
