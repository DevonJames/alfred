/**
 * Turn bottle photos plus the user's plan into schedule drafts.
 * Vision request matches photo ingest: base64 image_url, Grok then gpt-4o.
 */
import {
  grokApiKey,
  openaiApiKey,
  preparePhotoForVision,
  type PhotoVisionBackend,
} from "@alfred/memory";
import { parseMedicineDrafts, type MedicineDraft, type MedicineItem } from "@alfred/briefing";

const GROK_API_URL = "https://api.x.ai/v1/chat/completions";
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const GROK_MODEL = process.env.ALFRED_PHOTO_GROK_MODEL?.trim() || "grok-2-vision-latest";
const OPENAI_MODEL = process.env.ALFRED_PHOTO_OPENAI_MODEL?.trim() || "gpt-4o";

const INSTRUCTIONS = [
  "You turn medicine and supplement bottle photos plus the user's plan into schedule items.",
  "Timing and quantity come from the user's plan. The bottle supplies the product name and printed label text.",
  "Copy readable label text into labelText. Do not invent a dose.",
  "If the plan does not give a quantity and the label does not clearly print a serving, leave quantity empty and set needsReview true.",
  "If the name or strength is unreadable, set needsReview true.",
  "period is morning, midday, or evening.",
  "instruction is a short note such as before 10am or with breakfast. Leave it empty when the plan has none.",
  'days is "daily", "weekdays", "weekends", or weekday numbers Sunday 0 through Saturday 6. Use daily unless the plan names specific days.',
  "imageIndex is the 1-based photo of that product. Omit it when you cannot tell.",
  "Return only items the user is adding or changing. Do not repeat unchanged items from the current schedule.",
  "Do not recommend a different dose. Alfred records the user's plan.",
  "Reply with JSON only, no markdown:",
  '{"items":[{"name":"","quantity":"","period":"morning","instruction":"","days":"daily","labelText":"","needsReview":false,"imageIndex":1}]}',
].join(" ");

export class MedicineLlmError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface MedicinePhoto {
  filename: string;
  bytes: Buffer;
  mimeType?: string;
}

export async function draftMedicineItems(opts: {
  plan: string;
  images: MedicinePhoto[];
  current: MedicineItem[];
}): Promise<MedicineDraft[]> {
  const grokKey = grokApiKey();
  const openaiKey = openaiApiKey();
  if (!grokKey && !openaiKey) {
    throw new MedicineLlmError(
      503,
      "Bottle photos need GROK_API_KEY (or XAI_API_KEY) or OPENAI_API_KEY.",
    );
  }

  const prepared = [];
  for (const image of opts.images) {
    prepared.push(
      await preparePhotoForVision({
        filename: image.filename,
        bytes: image.bytes,
        mimeType: image.mimeType,
      }),
    );
  }

  const prompt = [INSTRUCTIONS, "", scheduleBlock(opts.current), "", planBlock(opts.plan)].join("\n");
  const content: Array<Record<string, unknown>> = prepared.map((image) => ({
    type: "image_url",
    image_url: {
      url: `data:${image.mimeType};base64,${image.bytes.toString("base64")}`,
      detail: "high",
    },
  }));
  content.push({ type: "text", text: prompt });

  const grok = grokKey
    ? { url: GROK_API_URL, apiKey: grokKey, model: GROK_MODEL, backend: "grok" as const }
    : null;
  const openai = openaiKey
    ? { url: OPENAI_API_URL, apiKey: openaiKey, model: OPENAI_MODEL, backend: "openai" as const }
    : null;
  const first = grok ?? openai!;
  const second = grok && openai ? openai : null;

  try {
    return await complete(first, content);
  } catch (err) {
    if (!second) throw asLlmError(err);
    try {
      return await complete(second, content);
    } catch (fallback) {
      throw asLlmError(fallback);
    }
  }
}

async function complete(
  target: { url: string; apiKey: string; model: string; backend: PhotoVisionBackend },
  content: Array<Record<string, unknown>>,
): Promise<MedicineDraft[]> {
  const res = await fetch(target.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${target.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: target.model,
      temperature: 0.1,
      messages: [{ role: "user", content }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string } }>;
  };
  if (!res.ok) {
    throw new MedicineLlmError(
      502,
      payload.error?.message || `Vision request failed (${res.status}).`,
    );
  }
  const text = payload.choices?.[0]?.message?.content?.trim();
  if (!text) throw new MedicineLlmError(502, "The model returned an empty schedule.");
  const drafts = parseMedicineDrafts(text);
  if (!drafts) throw new MedicineLlmError(502, "The model did not return a schedule.");
  return drafts;
}

function scheduleBlock(items: MedicineItem[]): string {
  if (!items.length) return "Current schedule: empty.";
  const lines = items.map(
    (item) =>
      `- ${item.name} | ${item.period} | ${item.quantity || "(no quantity)"} | ${item.instruction || "(no instruction)"} | ${
        item.days === "daily" ? "daily" : item.days.join(",")
      }`,
  );
  return ["Current schedule:", ...lines].join("\n");
}

function planBlock(plan: string): string {
  const text = plan.trim();
  return text ? `Plan:\n${text}` : "Plan:\n(no written plan — use only what the bottles clearly say, and set needsReview when timing or quantity is missing)";
}

function asLlmError(err: unknown): MedicineLlmError {
  if (err instanceof MedicineLlmError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new MedicineLlmError(502, message);
}
