/**
 * /api/memory — iOS Memory MVP over OipLocalMemoryProvider.
 */

import { OpenAiResponsesLLMProvider } from "@alfred/provider-openai";
import { Hono } from "hono";
import { activeProfileId, oipForProfile } from "../lib/oip-memory.js";
import { requireDevice } from "../middleware/require-device.js";

export const apiMemoryRouter = new Hono();

apiMemoryRouter.use("*", requireDevice);

function serializeRevision(rev: {
  id: string;
  type: string;
  revision: string;
  name?: string;
  text?: string;
  remindAt?: string | null;
  reminderStatus?: string;
  [key: string]: unknown;
}) {
  return {
    id: rev.id,
    type: rev.type,
    revision: rev.revision,
    name: rev.name ?? null,
    text: rev.text ?? null,
    remindAt: rev.remindAt ?? null,
    reminderStatus: rev.reminderStatus ?? null,
    record: rev,
  };
}

/** POST /api/memory — text and/or multipart artifact */
apiMemoryRouter.post("/", async (c) => {
  const memory = oipForProfile();
  const contentType = c.req.header("content-type") ?? "";

  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await c.req.parseBody({ all: true });
      const text =
        typeof form.text === "string"
          ? form.text.trim()
          : typeof form.note === "string"
            ? form.note.trim()
            : "";
      const file = form.file ?? form.artifact;
      let artifactId: string | null = null;

      if (file && typeof file === "object" && "arrayBuffer" in file) {
        const f = file as File;
        const bytes = Buffer.from(await f.arrayBuffer());
        const artifact = await memory.putArtifactBytes(bytes, {
          mimeType: f.type || undefined,
          originalFilename: f.name || undefined,
          name: typeof form.name === "string" ? form.name : f.name,
          reindex: !text,
        });
        artifactId = artifact.id;
      }

      if (!text && !artifactId) {
        return c.json({ error: "text or file is required" }, 400);
      }

      let observation = null;
      if (text) {
        observation = await memory.createRecord("Observation", {
          text,
          observedAt: new Date().toISOString(),
          sourceArtifact: artifactId ?? undefined,
          provenance: {
            sourceType: artifactId ? "ios_artifact_note" : "ios_text",
            learnedAt: new Date().toISOString(),
          },
          alfred: { visibility: "private", confidence: 1, assertionType: "explicit" },
          schema: { text },
        });
      }

      return c.json({
        ok: true,
        artifactId,
        observation: observation ? serializeRevision(observation) : null,
      });
    }

    const body = await c.req.json<{
      text?: string;
      type?: "Observation" | "Assertion" | "Episode" | "Entity" | "Artifact";
      name?: string;
      remindAt?: string | null;
      reminderTimezone?: string;
      reminderReason?: string;
    }>();
    const text = body.text?.trim();
    if (!text) {
      return c.json({ error: "text is required" }, 400);
    }

    const type = body.type ?? "Observation";
    const record = await memory.createRecord(type, {
      text,
      name: body.name ?? text.slice(0, 80),
      observedAt: type === "Observation" ? new Date().toISOString() : undefined,
      remindAt: body.remindAt ?? undefined,
      reminderTimezone: body.reminderTimezone,
      reminderReason: body.reminderReason ?? (body.remindAt ? "user_requested" : undefined),
      reminderStatus: body.remindAt ? "pending" : undefined,
      provenance: {
        sourceType: "ios_text",
        learnedAt: new Date().toISOString(),
      },
      alfred: { visibility: "private", confidence: 1, assertionType: "explicit" },
      schema: { text, name: body.name },
    });

    return c.json({ ok: true, record: serializeRevision(record) });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

apiMemoryRouter.post("/search", async (c) => {
  const memory = oipForProfile();
  try {
    const body = await c.req.json<{ query?: string; text?: string; limit?: number }>();
    const text = (body.query ?? body.text ?? "").trim();
    if (!text) return c.json({ error: "query is required" }, 400);
    const result = await memory.retrieve({
      text,
      profileId: activeProfileId(),
      limit: body.limit ?? 12,
    });
    return c.json({
      providerId: result.providerId,
      retrievedAt: result.retrievedAt,
      items: result.items,
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

apiMemoryRouter.post("/ask", async (c) => {
  const memory = oipForProfile();
  try {
    const body = await c.req.json<{ query?: string; text?: string; limit?: number }>();
    const query = (body.query ?? body.text ?? "").trim();
    if (!query) return c.json({ error: "query is required" }, 400);

    const result = await memory.retrieve({
      text: query,
      profileId: activeProfileId(),
      limit: body.limit ?? 8,
    });

    const evidence = result.items
      .map(
        (item, i) =>
          `${i + 1}. ${item.content}${
            item.relevance != null ? ` (relevance=${item.relevance.toFixed(3)})` : ""
          }`,
      )
      .join("\n");

    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      return c.json({
        answer:
          result.items[0]?.content ??
          "I found no matching memories (retrieval-only mode; set OPENAI_API_KEY for synthesis).",
        answerMode: "retrieval_only" as const,
        confidence: result.items[0] ? "medium" : "low",
        items: result.items,
        providerId: result.providerId,
      });
    }

    const llm = new OpenAiResponsesLLMProvider({ apiKey });
    let answer = "";
    for await (const chunk of llm.generateStream({
      messages: [
        {
          role: "system",
          content:
            "You answer personal memory questions using only the provided evidence. If evidence is insufficient, say you do not know. Be concise.",
        },
        {
          role: "user",
          content: `Question: ${query}\n\nEvidence:\n${evidence || "(none)"}`,
        },
      ],
      modelPreset: "conversational",
    })) {
      if (chunk.type === "token" && chunk.text) answer += chunk.text;
      if (chunk.type === "error") {
        return c.json(
          {
            answer: result.items[0]?.content ?? null,
            answerMode: "retrieval_only" as const,
            confidence: "low",
            items: result.items,
            error: chunk.error,
            providerId: result.providerId,
          },
          200,
        );
      }
    }

    return c.json({
      answer: answer.trim(),
      answerMode: "synthesized" as const,
      confidence: result.items.length ? "high" : "low",
      items: result.items,
      providerId: result.providerId,
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

apiMemoryRouter.post("/correct", async (c) => {
  const memory = oipForProfile();
  try {
    const body = await c.req.json<{
      id?: string;
      text?: string;
      correction?: string;
    }>();
    const correction = (body.correction ?? body.text ?? "").trim();
    if (!correction) return c.json({ error: "correction text is required" }, 400);

    const observation = await memory.createRecord("Observation", {
      text: correction,
      observedAt: new Date().toISOString(),
      supersedes: body.id ? [body.id] : undefined,
      provenance: {
        sourceType: "ios_correction",
        learnedAt: new Date().toISOString(),
        sourceRevision: body.id,
      },
      alfred: { visibility: "private", confidence: 1, assertionType: "explicit" },
      schema: { text: correction },
    });

    let updated = null;
    if (body.id) {
      await memory.edit(body.id, correction);
      const logicalId = body.id.replace(/^did:memory:/, "").split("#")[0]!;
      updated = await memory.packages.readCurrent(logicalId);
    }

    return c.json({
      ok: true,
      observation: serializeRevision(observation),
      updated: updated ? serializeRevision(updated) : null,
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

apiMemoryRouter.get("/due", async (c) => {
  const memory = oipForProfile();
  const date = c.req.query("date") ?? undefined;
  const timezone =
    c.req.query("timezone") ?? process.env.BRIEFING_TIMEZONE ?? "America/Los_Angeles";
  try {
    const due = await memory.listDue({ date, timezone });
    return c.json({
      date: date ?? null,
      timezone,
      count: due.length,
      reminders: due.map((r) => {
        // `id` is the canonical mobile field (did:memory:…). Keep recordId/logicalId too.
        const id = r.recordId;
        const remindAt = r.remindAt;
        const dateOnly =
          typeof remindAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(remindAt);
        return {
          id,
          memoryId: id,
          recordId: id,
          logicalId: r.logicalId,
          name: r.recordName,
          text: r.revision.text ?? null,
          remindAt,
          dueAt: remindAt,
          dateOnly,
          date_only: dateOnly,
          reminderStatus: r.reminderStatus,
          reminderReason: r.reminderReason,
          reminderTimezone: r.reminderTimezone,
          reminderSnoozedUntil: r.reminderSnoozedUntil,
        };
      }),
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

apiMemoryRouter.post("/:id/reminder/surfaced", async (c) => {
  const memory = oipForProfile();
  const id = c.req.param("id");
  try {
    const rev = await memory.markReminderSurfaced(id);
    return c.json({ ok: true, record: serializeRevision(rev) });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

/**
 * POST /api/memory/:id/reminder/status
 * Body: { status: "completed" | "dismissed" | "snoozed" | "pending" | "surfaced", snoozedUntil?: string }
 */
apiMemoryRouter.post("/:id/reminder/status", async (c) => {
  const memory = oipForProfile();
  const id = c.req.param("id");
  try {
    const body = await c.req.json<{
      status?: string;
      action?: string;
      snoozedUntil?: string | null;
      reminderSnoozedUntil?: string | null;
    }>();
    const status = (body.status ?? body.action ?? "").trim().toLowerCase();
    const allowed = new Set([
      "completed",
      "dismissed",
      "snoozed",
      "pending",
      "surfaced",
    ]);
    if (!allowed.has(status)) {
      return c.json(
        {
          error:
            'status must be one of: completed, dismissed, snoozed, pending, surfaced',
        },
        400,
      );
    }

    const snoozedUntil =
      body.snoozedUntil ?? body.reminderSnoozedUntil ?? undefined;
    if (status === "snoozed" && !snoozedUntil) {
      return c.json({ error: "snoozedUntil is required when status=snoozed" }, 400);
    }

    const patch: {
      reminderStatus: string;
      reminderSnoozedUntil?: string | null;
      reminderCompletedAt?: string;
    } = { reminderStatus: status };

    if (status === "snoozed") {
      patch.reminderSnoozedUntil = snoozedUntil ?? null;
    } else if (status === "completed" || status === "dismissed") {
      patch.reminderSnoozedUntil = null;
      patch.reminderCompletedAt = new Date().toISOString();
    } else if (status === "pending" || status === "surfaced") {
      patch.reminderSnoozedUntil = null;
    }

    const rev = await memory.updateRecord(id, patch);
    return c.json({ ok: true, record: serializeRevision(rev) });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

apiMemoryRouter.delete("/:id", async (c) => {
  const memory = oipForProfile();
  const id = c.req.param("id");
  try {
    await memory.delete(id);
    return c.json({ ok: true, deleted: id });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

apiMemoryRouter.get("/:id", async (c) => {
  const memory = oipForProfile();
  const id = c.req.param("id");
  const logicalId = id.replace(/^did:memory:/, "").split("#")[0]!;
  try {
    const rev = await memory.packages.readCurrent(logicalId);
    if (!rev) return c.json({ error: "not_found" }, 404);
    return c.json(serializeRevision(rev));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});
