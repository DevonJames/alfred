/**
 * Vision + OCR for photo ingest.
 * Same request shape as document-analysis-tool's Grok backend:
 * base64 data URL, detail=high, structured JSON transcription.
 * Prefers GROK_API_KEY / XAI_API_KEY, then OPENAI_API_KEY (gpt-4o).
 * HEIC/HEIF (iPhone) is converted to JPEG before the API call.
 */

import { preparePhotoForVision } from "./photo-heic.js";

export type PhotoVisionBackend = "grok" | "openai";

export interface PhotoAnalysis {
  backend: PhotoVisionBackend;
  model: string;
  summary: string;
  fullText: string;
  handwrittenNotes: Array<{ content: string; location?: string } | string>;
  names: string[];
  dates: string[];
  places: string[];
  objects: string[];
  documentType?: string;
}

const GROK_API_URL = "https://api.x.ai/v1/chat/completions";
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const GROK_MODEL = process.env.ALFRED_PHOTO_GROK_MODEL?.trim() || "grok-2-vision-latest";
const OPENAI_MODEL = process.env.ALFRED_PHOTO_OPENAI_MODEL?.trim() || "gpt-4o";

export const PHOTO_VISION_PROMPT = `Analyze this photo carefully. Transcribe every readable word (printed and handwritten) and describe what you see.

This may be a document, receipt, screenshot, whiteboard, handwritten note, or everyday photo.

Please provide:
1. A detailed summary of the scene and what the image is
2. A complete transcription of all readable text
3. Handwritten notes and their locations
4. Names of people or organizations
5. Dates
6. Places (cities, buildings, addresses)
7. Notable objects or documents
8. The kind of image (receipt, screenshot, handwritten note, photo, id, other)

After your analysis, provide a structured JSON object with this format:
{
  "summary": "brief description of what the photo shows",
  "fullText": "complete transcription of all readable text",
  "documentType": "receipt | screenshot | handwritten note | photo | other",
  "handwrittenNotes": [{"content": "text of note", "location": "approximate location"}],
  "names": [],
  "dates": [],
  "places": [],
  "objects": []
}`;

export function grokApiKey(): string | undefined {
  return process.env.GROK_API_KEY?.trim() || process.env.XAI_API_KEY?.trim() || undefined;
}

export function openaiApiKey(): string | undefined {
  return process.env.OPENAI_API_KEY?.trim() || undefined;
}

export function photoMimeFromFilename(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "bmp") return "image/bmp";
  if (ext === "tif" || ext === "tiff") return "image/tiff";
  if (ext === "heic") return "image/heic";
  if (ext === "heif") return "image/heif";
  return "image/jpeg";
}

export function isPhotoFilename(filename: string): boolean {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return (
    ext === "jpg" ||
    ext === "jpeg" ||
    ext === "png" ||
    ext === "gif" ||
    ext === "webp" ||
    ext === "bmp" ||
    ext === "tif" ||
    ext === "tiff" ||
    ext === "heic" ||
    ext === "heif"
  );
}

export function parseJsonFromResponse(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced =
    trimmed.match(/```json\s*([\s\S]*?)\s*```/i) || trimmed.match(/```\s*([\s\S]*?)\s*```/);
  const candidate = fenced?.[1]?.trim() || trimmed;
  try {
    return JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        /* fall through */
      }
    }
    return { rawAnalysis: text, parseError: "Could not parse structured JSON from response" };
  }
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object" && "content" in item) {
        return String((item as { content?: unknown }).content ?? "").trim();
      }
      return String(item ?? "").trim();
    })
    .filter(Boolean);
}

function asNoteList(value: unknown): PhotoAnalysis["handwrittenNotes"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") {
        const rec = item as { content?: unknown; location?: unknown };
        const content = String(rec.content ?? "").trim();
        if (!content) return "";
        const location = String(rec.location ?? "").trim();
        return location ? { content, location } : { content };
      }
      return "";
    })
    .filter((item) => item !== "");
}

export function normalizePhotoAnalysis(
  data: Record<string, unknown>,
  rawText: string,
  backend: PhotoVisionBackend,
  model: string,
): PhotoAnalysis {
  const raw = typeof data.rawAnalysis === "string" ? data.rawAnalysis : rawText;
  const summary =
    (typeof data.summary === "string" && data.summary.trim()) ||
    raw.slice(0, 500) ||
    "No summary available";
  const fullText =
    (typeof data.fullText === "string" && data.fullText.trim()) ||
    (typeof data.rawAnalysis === "string" && data.rawAnalysis.trim()) ||
    rawText.trim();
  return {
    backend,
    model,
    summary,
    fullText,
    handwrittenNotes: asNoteList(data.handwrittenNotes),
    names: asStringList(data.names),
    dates: asStringList(data.dates),
    places: asStringList(data.places),
    objects: asStringList(data.objects),
    documentType: typeof data.documentType === "string" ? data.documentType.trim() : undefined,
  };
}

export function formatPhotoMarkdown(filename: string, analysis: PhotoAnalysis): string {
  const notes = analysis.handwrittenNotes
    .map((note) =>
      typeof note === "string"
        ? `- ${note}`
        : `- ${note.content}${note.location ? ` (${note.location})` : ""}`,
    )
    .join("\n");
  const list = (items: string[]) => items.map((item) => `- ${item}`).join("\n");
  return [
    `# Photo: ${filename}`,
    analysis.documentType ? `Type: ${analysis.documentType}` : "",
    "",
    "## What I see",
    analysis.summary,
    "",
    "## Text in the image",
    analysis.fullText || "(no readable text)",
    notes ? `\n## Handwritten notes\n${notes}` : "",
    analysis.names.length ? `\n## People and organizations\n${list(analysis.names)}` : "",
    analysis.dates.length ? `\n## Dates\n${list(analysis.dates)}` : "",
    analysis.places.length ? `\n## Places\n${list(analysis.places)}` : "",
    analysis.objects.length ? `\n## Objects\n${list(analysis.objects)}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

async function completeVision(opts: {
  url: string;
  apiKey: string;
  model: string;
  mimeType: string;
  bytes: Buffer;
}): Promise<string> {
  const dataUrl = `data:${opts.mimeType};base64,${opts.bytes.toString("base64")}`;
  const res = await fetch(opts.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: dataUrl, detail: "high" },
            },
            { type: "text", text: PHOTO_VISION_PROMPT },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string } }>;
  };
  if (!res.ok) {
    throw new Error(
      `Vision API error: ${res.status} — ${payload.error?.message || res.statusText || "Unknown error"}`,
    );
  }
  const text = payload.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Vision API returned an empty response");
  return text;
}

function visionError(filename: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`Vision failed for ${filename}: ${message}`);
}

export async function analyzePhoto(opts: {
  filename: string;
  bytes: Buffer;
  mimeType?: string;
}): Promise<PhotoAnalysis> {
  const prepared = await preparePhotoForVision({
    filename: opts.filename,
    bytes: opts.bytes,
    mimeType: opts.mimeType || photoMimeFromFilename(opts.filename),
  });
  const mimeType = prepared.mimeType;
  const bytes = prepared.bytes;
  const grokKey = grokApiKey();
  const openaiKey = openaiApiKey();
  if (!grokKey && !openaiKey) {
    throw new Error(
      "Photo ingest needs GROK_API_KEY (or XAI_API_KEY) or OPENAI_API_KEY for vision + OCR",
    );
  }

  let backend: PhotoVisionBackend = grokKey ? "grok" : "openai";
  let model = grokKey ? GROK_MODEL : OPENAI_MODEL;
  let raw: string;
  try {
    raw = await completeVision({
      url: grokKey ? GROK_API_URL : OPENAI_API_URL,
      apiKey: grokKey || openaiKey!,
      model,
      mimeType,
      bytes,
    });
  } catch (err) {
    if (grokKey && openaiKey) {
      backend = "openai";
      model = OPENAI_MODEL;
      try {
        raw = await completeVision({
          url: OPENAI_API_URL,
          apiKey: openaiKey,
          model,
          mimeType,
          bytes,
        });
      } catch (fallbackErr) {
        throw visionError(opts.filename, fallbackErr);
      }
    } else {
      throw visionError(opts.filename, err);
    }
  }

  return normalizePhotoAnalysis(parseJsonFromResponse(raw), raw, backend, model);
}
