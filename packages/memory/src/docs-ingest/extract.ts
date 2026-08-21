import {
  MemoryExtractionResultSchema,
  type MemoryExtractionResult,
} from "../oip-local/extraction-contract.js";
import type { DocsExtractInput } from "./types.js";

export type DocsExtractor = (input: DocsExtractInput) => Promise<MemoryExtractionResult>;

export function emptyExtraction(): MemoryExtractionResult {
  return MemoryExtractionResultSchema.parse({});
}

export const noopDocsExtractor: DocsExtractor = async () => emptyExtraction();

export function parseExtractionJson(raw: string): MemoryExtractionResult {
  const trimmed = raw.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  const slice =
    jsonStart >= 0 && jsonEnd > jsonStart ? trimmed.slice(jsonStart, jsonEnd + 1) : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return emptyExtraction();
  }
  const result = MemoryExtractionResultSchema.safeParse(parsed);
  return result.success ? result.data : emptyExtraction();
}

export function extractionPrompt(input: DocsExtractInput): string {
  return `Extract structured memory from this documentation section.
Rules:
- Only state facts that appear in the text. Do not invent architecture, APIs, or behavior.
- Each entity and assertion must include a short verbatim "quote" copied from the section.
- Use tempId strings like "e1" for entities so assertions can reference them.
- Do not paraphrase the section into observations; leave observations as [].
- If nothing is clearly stated, return empty arrays.

Folder: ${input.folderLabel}
File: ${input.fileRelPath}
Section: ${input.sectionTitle}

---
${input.sectionText}
---

Return JSON only with this shape:
{
  "entities": [{"tempId":"e1","name":"...","entityClass":"Thing","summary":"...","quote":"..."}],
  "assertions": [{"subjectTempId":"e1","predicate":"...","object":"...","quote":"..."}],
  "relationships": [],
  "episodes": [],
  "observations": [],
  "temporalReferences": [],
  "ambiguities": [],
  "needsResolution": []
}`;
}

/**
 * Default extractor: OpenAI JSON if OPENAI_API_KEY is set, otherwise empty.
 * Freeform model prose is never stored; only schema-parsed JSON.
 */
export async function defaultDocsExtractor(input: DocsExtractInput): Promise<MemoryExtractionResult> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return emptyExtraction();
  const model = process.env.OPENAI_DOCS_EXTRACT_MODEL?.trim() || "gpt-5.6-terra";
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You extract structured memory as JSON. Never invent facts. Never return prose outside JSON.",
          },
          { role: "user", content: extractionPrompt(input) },
        ],
      }),
    });
    if (!res.ok) return emptyExtraction();
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = body.choices?.[0]?.message?.content ?? "";
    return parseExtractionJson(text);
  } catch {
    return emptyExtraction();
  }
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
