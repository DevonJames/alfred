function mimeToExtension(mimeType: string): string {
  const map: Record<string, string> = {
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/m4a": ".m4a",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/flac": ".flac",
    "audio/aac": ".m4a",
    "audio/x-caf": ".caf",
  };
  return map[mimeType] || ".m4a";
}

function localSttUrl(): string | undefined {
  const url = process.env.VOICE_STT_URL?.trim();
  if (!url) return undefined;
  return url.replace(/\/$/, "").replace("://localhost", "://127.0.0.1");
}

async function transcribeLocal(bytes: Buffer, filename: string, mimeType: string): Promise<string> {
  const base = localSttUrl();
  if (!base) throw new Error("VOICE_STT_URL not configured");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);
  form.append("language", "en");
  form.append("task", "transcribe");
  const response = await fetch(`${base}/transcribe_file`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(3 * 60 * 60 * 1000),
  });
  if (!response.ok) {
    throw new Error(`Local STT failed: ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as { text?: string };
  return (data.text ?? "").trim();
}

async function transcribeOpenAi(
  bytes: Buffer,
  filename: string,
  mimeType: string,
  model: string,
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");
  const ext = filename.includes(".") ? filename : `audio${mimeToExtension(mimeType)}`;
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType || "audio/mp4" }), ext);
  form.append("model", model);
  form.append("language", "en");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(3 * 60 * 60 * 1000),
  });
  if (!response.ok) {
    throw new Error(`OpenAI STT failed: ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as { text?: string };
  return (data.text ?? "").trim();
}

export async function transcribeAudioBuffer(opts: {
  bytes: Buffer;
  filename: string;
  mimeType: string;
}): Promise<string> {
  const errors: string[] = [];
  if (localSttUrl()) {
    try {
      const text = await transcribeLocal(opts.bytes, opts.filename, opts.mimeType);
      if (text) return text;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  try {
    const text = await transcribeOpenAi(opts.bytes, opts.filename, opts.mimeType, "gpt-4o-transcribe");
    if (text) return text;
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  try {
    const text = await transcribeOpenAi(opts.bytes, opts.filename, opts.mimeType, "whisper-1");
    if (text) return text;
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  throw new Error(errors[0] || "Transcription failed");
}

export interface TranscribeProgress {
  chunkIndex: number;
  totalChunks: number;
  combinedText: string;
  durationSeconds: number | null;
}

export async function transcribeAudioNote(opts: {
  bytes: Buffer;
  filename: string;
  mimeType: string;
  forceChunk?: boolean;
  segmentSeconds?: number;
  startChunk?: number;
  existingText?: string;
  shouldYield?: () => boolean;
  onProgress?: (progress: TranscribeProgress) => Promise<void> | void;
}): Promise<{
  text: string;
  durationSeconds: number | null;
  chunks: number;
  yielded?: boolean;
  nextChunk?: number;
}> {
  const { splitAudioForStt, joinChunkTranscripts } = await import("./audio-chunks.js");
  const split = await splitAudioForStt({
    bytes: opts.bytes,
    filename: opts.filename,
    segmentSeconds: opts.segmentSeconds,
    force: opts.forceChunk,
  });
  const start = Math.max(0, opts.startChunk ?? 0);
  const parts: string[] = [];
  if (opts.existingText?.trim()) parts.push(opts.existingText.trim());
  const errors: string[] = [];

  for (const chunk of split.chunks) {
    if (chunk.index < start) continue;
    if (opts.shouldYield?.()) {
      return {
        text: joinChunkTranscripts(parts),
        durationSeconds: split.durationSeconds,
        chunks: split.chunks.length,
        yielded: true,
        nextChunk: chunk.index,
      };
    }
    const mimeType = chunk.mimeType === "application/octet-stream" ? opts.mimeType : chunk.mimeType;
    try {
      const text = await transcribeAudioBuffer({
        bytes: chunk.bytes,
        filename: chunk.filename,
        mimeType,
      });
      if (text.trim()) parts.push(text.trim());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`chunk ${chunk.index + 1}: ${message}`);
      console.warn(`[notes] STT chunk ${chunk.index + 1}/${split.chunks.length} failed:`, message);
    }
    const combined = joinChunkTranscripts(parts);
    await opts.onProgress?.({
      chunkIndex: chunk.index,
      totalChunks: split.chunks.length,
      combinedText: combined,
      durationSeconds: split.durationSeconds,
    });
  }

  const text = joinChunkTranscripts(parts);
  if (!text) {
    throw new Error(errors[0] || "Transcription failed");
  }
  return { text, durationSeconds: split.durationSeconds, chunks: split.chunks.length };
}
