/**
 * /api/memory — iOS Memory MVP over OipLocalMemoryProvider.
 */

import { OpenAiResponsesLLMProvider } from "@alfred/provider-openai";
import { Hono } from "hono";
import {
  isConversationTurn,
  parseCategory,
  revisionToCard,
  type MemoryCardCategory,
} from "../lib/memory-cards.js";
import { loadMemoryGraph, loadMemoryRecordDetail } from "../lib/memory-graph.js";
import {
  artifactRefFromRevision,
  revisionToPhoneMemory,
  sourceArtifactIdFromRevision,
  phoneAskSource,
  phoneKindMatches,
  toPhoneAskConfidence,
} from "../lib/phone-memory.js";
import { activeProfileId, oipForProfile } from "../lib/oip-memory.js";
import { requireSidecarOrDevice } from "../middleware/sidecar-or-device.js";

export const apiMemoryRouter = new Hono();

apiMemoryRouter.use("*", requireSidecarOrDevice);

function profileFromRequest(c: { req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined } }): string {
  return (
    c.req.query("householdId")?.trim() ||
    c.req.query("profileId")?.trim() ||
    c.req.header("x-household-id")?.trim() ||
    activeProfileId()
  );
}

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
  const memory = oipForProfile(profileFromRequest(c));
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
        durable: true,
        artifactId,
        createdEntities: [],
        observation: observation ? serializeRevision(observation) : null,
        memory: observation ? revisionToPhoneMemory(observation) : null,
      });
    }

    const body = await c.req.json<{
      text?: string;
      content?: string;
      title?: string;
      category?: string;
      type?: "Observation" | "Assertion" | "Episode" | "Entity" | "Artifact";
      name?: string;
      remindAt?: string | null;
      reminderTimezone?: string;
      reminderReason?: string;
      householdId?: string;
    }>();
    const text = (body.text ?? body.content ?? "").trim();
    if (!text) {
      return c.json({ error: "text is required" }, 400);
    }

    const type = body.type ?? "Observation";
    const category = parseCategory(body.category);
    const record = await memory.createRecord(type, {
      text,
      name: body.name ?? body.title ?? text.slice(0, 80),
      observedAt: type === "Observation" ? new Date().toISOString() : undefined,
      remindAt: body.remindAt ?? undefined,
      reminderTimezone: body.reminderTimezone,
      reminderReason: body.reminderReason ?? (body.remindAt ? "user_requested" : undefined),
      reminderStatus: body.remindAt ? "pending" : undefined,
      provenance: {
        sourceType: category ? "alfred_home_card" : "ios_text",
        alfredHomeCategory: category,
        learnedAt: new Date().toISOString(),
      },
      alfred: { visibility: "private", confidence: 1, assertionType: "explicit" },
      schema: { text, name: body.name ?? body.title },
    });

    return c.json({
      ok: true,
      durable: true,
      createdEntities: [],
      record: serializeRevision(record),
      memory: revisionToPhoneMemory(record),
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

apiMemoryRouter.post("/search", async (c) => {
  const memory = oipForProfile(profileFromRequest(c));
  try {
    const body = await c.req.json<{
      query?: string;
      text?: string;
      limit?: number;
      kinds?: string[];
    }>();
    const text = (body.query ?? body.text ?? "").trim();
    if (!text) return c.json({ error: "query is required" }, 400);
    const limit = body.limit ?? 20;
    const result = await memory.retrieve({
      text,
      profileId: activeProfileId(),
      limit: Math.max(limit * 2, 24),
    });

    const results = [];
    for (const item of result.items) {
      const logicalId = item.id.replace(/^did:memory:/, "").split("#")[0]!;
      const rev = await memory.packages.readCurrent(logicalId);
      if (!rev || rev.type === "Artifact" || isConversationTurn(rev)) continue;
      const phone = revisionToPhoneMemory(rev, {
        score: item.relevance ?? 0,
        via: "semantic",
      });
      if (!phoneKindMatches(phone.kind, body.kinds)) continue;
      results.push(phone);
      if (results.length >= limit) break;
    }

    return c.json({
      interpretedAs: `meaning close to “${text}”`,
      results,
      providerId: result.providerId,
      retrievedAt: result.retrievedAt,
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

apiMemoryRouter.post("/ask", async (c) => {
  const memory = oipForProfile(profileFromRequest(c));
  try {
    const body = await c.req.json<{ query?: string; text?: string; limit?: number }>();
    const query = (body.query ?? body.text ?? "").trim();
    if (!query) return c.json({ error: "query is required" }, 400);

    const result = await memory.retrieve({
      text: query,
      profileId: activeProfileId(),
      limit: body.limit ?? 8,
    });

    const sources = [];
    for (const item of result.items) {
      const logicalId = item.id.replace(/^did:memory:/, "").split("#")[0]!;
      const rev = await memory.packages.readCurrent(logicalId);
      if (!rev || rev.type === "Artifact" || isConversationTurn(rev)) continue;
      const phone = revisionToPhoneMemory(rev, {
        score: item.relevance ?? 0,
        via: "semantic",
      });
      sources.push(phoneAskSource(phone, item.relevance ?? 0, "semantic"));
    }

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
      const fallback =
        result.items[0]?.content ??
        "I found no matching memories yet.";
      return c.json({
        answer: fallback,
        confidence: toPhoneAskConfidence(result.items[0] ? "medium" : "low"),
        interpretedAs: query,
        sources,
        answerMode: "retrieval_only" as const,
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
        return c.json({
          answer: result.items[0]?.content ?? "I couldn't form an answer from what I have.",
          confidence: toPhoneAskConfidence("low"),
          interpretedAs: query,
          sources,
          answerMode: "retrieval_only" as const,
          error: chunk.error,
          providerId: result.providerId,
        });
      }
    }

    return c.json({
      answer: answer.trim() || "I don't know from what you've told me.",
      confidence: toPhoneAskConfidence(result.items.length ? "high" : "low"),
      interpretedAs: query,
      sources,
      answerMode: "synthesized" as const,
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
  const memory = oipForProfile(profileFromRequest(c));
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
  const memory = oipForProfile(profileFromRequest(c));
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
  const memory = oipForProfile(profileFromRequest(c));
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
  const memory = oipForProfile(profileFromRequest(c));
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

apiMemoryRouter.get("/cards", async (c) => {
  const memory = oipForProfile(profileFromRequest(c));
  const category = parseCategory(c.req.query("category"));
  const limit = Number(c.req.query("limit") ?? "500") || 500;
  try {
    const cards = [];
    for await (const rev of memory.packages.iterateCurrentRevisions()) {
      if (isConversationTurn(rev)) continue;
      const card = revisionToCard(rev);
      if (category && card.category !== category) continue;
      cards.push(card);
      if (cards.length >= limit) break;
    }
    cards.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return c.json({ items: cards, count: cards.length });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

apiMemoryRouter.get("/cards/:id", async (c) => {
  const memory = oipForProfile(profileFromRequest(c));
  const id = c.req.param("id");
  const logicalId = id.replace(/^did:memory:/, "").split("#")[0]!;
  try {
    const rev = await memory.packages.readCurrent(logicalId);
    if (!rev) return c.json({ error: "not_found" }, 404);
    return c.json(revisionToCard(rev));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

apiMemoryRouter.post("/cards", async (c) => {
  const memory = oipForProfile(profileFromRequest(c));
  try {
    const body = await c.req.json<{
      category?: string;
      title?: string;
      content?: string;
      metadata?: Record<string, unknown>;
    }>();
    const content = (body.content ?? "").trim();
    const title = (body.title ?? "").trim();
    if (!title && !content) return c.json({ error: "title or content is required" }, 400);
    const category = (parseCategory(body.category) ?? "preferences") as MemoryCardCategory;
    const now = new Date().toISOString();
    const record = await memory.createRecord("Observation", {
      text: content || title,
      name: title || content.slice(0, 80),
      observedAt: now,
      provenance: {
        sourceType: "alfred_home_card",
        alfredHomeCategory: category,
        learnedAt: now,
        ...(body.metadata ?? {}),
      },
      alfred: { visibility: "private", confidence: 1, assertionType: "explicit" },
      schema: { text: content || title, name: title },
    });
    return c.json({ ok: true, ...revisionToCard(record), created: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

apiMemoryRouter.patch("/cards/:id", async (c) => {
  const memory = oipForProfile(profileFromRequest(c));
  const id = c.req.param("id");
  try {
    const body = await c.req.json<{
      category?: string;
      title?: string;
      content?: string;
      metadata?: Record<string, unknown>;
    }>();
    const logicalId = id.replace(/^did:memory:/, "").split("#")[0]!;
    const current = await memory.packages.readCurrent(logicalId);
    if (!current) return c.json({ error: "not_found" }, 404);
    const category = parseCategory(body.category);
    const rev = await memory.updateRecord(id, {
      text: body.content ?? current.text,
      name: body.title ?? current.name,
      provenance: {
        ...(current.provenance ?? {}),
        ...(body.metadata ?? {}),
        ...(category ? { alfredHomeCategory: category } : {}),
        sourceType: current.provenance?.sourceType ?? "alfred_home_card",
      },
    });
    return c.json({ ok: true, ...revisionToCard(rev), updated: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

apiMemoryRouter.delete("/cards/:id", async (c) => {
  const memory = oipForProfile(profileFromRequest(c));
  const id = c.req.param("id");
  try {
    await memory.delete(id);
    return c.json({ ok: true, deleted: id });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/** GET /api/memory/graph — force-sim snapshot for the iOS / desktop graph UIs. */
apiMemoryRouter.get("/graph", async (c) => {
  try {
    const artifacts = c.req.query("artifacts") === "1";
    const forceRebuild = c.req.query("rebuild") === "1";
    const snapshot = await loadMemoryGraph({
      profileId: profileFromRequest(c),
      hideArtifacts: !artifacts,
      hideProvenanceEdges: true,
      forceRebuild,
    });
    return c.json(snapshot);
  } catch (err) {
    return c.json(
      {
        error: "graph_load_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

/** GET /api/memory/graph/node/:id — record + neighbors for the graph detail sheet. */
apiMemoryRouter.get("/graph/node/:id", async (c) => {
  try {
    const id = decodeURIComponent(c.req.param("id"));
    const detail = await loadMemoryRecordDetail(id, profileFromRequest(c));
    if (!detail) {
      return c.json({ error: "not_found", message: `No record ${id}` }, 404);
    }
    return c.json(detail);
  } catch (err) {
    return c.json(
      {
        error: "node_load_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

/** Resolve a package id (DID or logical) into the phone Memory card shape. */
async function loadPhoneMemory(profileId: string, rawId: string) {
  const memory = oipForProfile(profileId);
  memory.sqlite.open();
  const index = memory.sqlite.getRecord(rawId);
  const logicalId =
    index?.logical_id ??
    rawId.replace(/^did:memory:/, "").split("#")[0]!;
  const rev = await memory.packages.readCurrent(logicalId);
  if (!rev) return null;

  const detail = await loadMemoryRecordDetail(index?.id ?? rev.id, profileId);
  const related =
    detail?.neighbors.slice(0, 40).map((n) => ({
      id: n.id,
      title: n.label,
      kind:
        n.type === "Entity" ? ("entity" as const) : n.type === "Episode" ? ("episode" as const) : ("note" as const),
      entityType: n.type === "Entity" ? "Thing" : null,
      relation: `${n.direction === "out" ? "→" : "←"} ${n.predicate}`,
    })) ?? [];

  let artifactId =
    sourceArtifactIdFromRevision(rev) ||
    detail?.file?.artifactId ||
    null;
  if (!artifactId && typeof rev.drefs?.recording === "string") {
    const recording = await memory.resolveRef(rev.drefs.recording);
    artifactId = sourceArtifactIdFromRevision(recording);
  }
  const artifactRev = artifactId ? await memory.resolveRef(artifactId) : null;
  const artifact = artifactRefFromRevision(artifactRev);

  return revisionToPhoneMemory(rev, {
    related,
    artifacts: artifact ? [artifact] : [],
  });
}

/** GET /api/memory/recent — newest packages for the Memory tab list. */
apiMemoryRouter.get("/recent", async (c) => {
  const memory = oipForProfile(profileFromRequest(c));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? "30") || 30));
  try {
    const collected = [];
    for await (const rev of memory.packages.iterateCurrentRevisions()) {
      if (rev.type === "Artifact" || isConversationTurn(rev)) continue;
      collected.push(rev);
    }
    collected.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    const memories = collected.slice(0, limit).map((rev) => revisionToPhoneMemory(rev));
    return c.json({ memories });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

apiMemoryRouter.get("/episode/:id", async (c) => {
  try {
    const memory = await loadPhoneMemory(profileFromRequest(c), decodeURIComponent(c.req.param("id")));
    if (!memory) return c.json({ error: "not_found" }, 404);
    return c.json({ memory });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

apiMemoryRouter.get("/entity/:id", async (c) => {
  try {
    const memory = await loadPhoneMemory(profileFromRequest(c), decodeURIComponent(c.req.param("id")));
    if (!memory) return c.json({ error: "not_found" }, 404);
    return c.json({ memory });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

apiMemoryRouter.delete("/:id", async (c) => {
  const memory = oipForProfile(profileFromRequest(c));
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
  const memory = oipForProfile(profileFromRequest(c));
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
