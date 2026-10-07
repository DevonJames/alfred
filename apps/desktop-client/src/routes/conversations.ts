import {
  createConversationStore,
  type ConversationStack,
  type MessageSource,
} from "@alfred/conversations";
import { Hono } from "hono";

export const conversationsRouter = new Hono();

function store() {
  return createConversationStore();
}

function parseStack(raw: unknown): ConversationStack | undefined {
  if (raw === "cascade" || raw === "live" || raw === "live2") return raw;
  return undefined;
}

function parseSource(raw: unknown): MessageSource | undefined {
  if (raw === "voice" || raw === "text") return raw;
  return undefined;
}

/** GET /api/conversations — summaries, newest first. */
conversationsRouter.get("/", async (c) => {
  const conversations = await store().list();
  const activeId = await store().getActiveId();
  return c.json({ conversations, activeId });
});

/** GET /api/conversations/:id */
conversationsRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const conversation = await store().get(id);
  if (!conversation) return c.json({ error: "Not found" }, 404);
  return c.json({ conversation });
});

/**
 * POST /api/conversations/active
 * Body: { forceNew?: boolean, stack?: ConversationStack }
 * Ensures an active conversation (idle-merge unless forceNew).
 */
conversationsRouter.post("/active", async (c) => {
  let body: { forceNew?: boolean; stack?: string } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    /* empty ok */
  }
  const conversation = await store().ensureActive({
    forceNew: body.forceNew === true,
    stack: parseStack(body.stack),
  });
  return c.json({ conversation });
});

/**
 * PUT /api/conversations/active
 * Body: { id: string } — resume a past conversation.
 */
conversationsRouter.put("/active", async (c) => {
  let body: { id?: string };
  try {
    body = (await c.req.json()) as { id?: string };
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const id = body.id?.trim();
  if (!id) return c.json({ error: "id is required" }, 400);
  const conversation = await store().setActive(id);
  if (!conversation) return c.json({ error: "Not found" }, 404);
  return c.json({ conversation });
});

/** POST /api/conversations/new — arm New chat (next ensure/append starts fresh). */
conversationsRouter.post("/new", async (c) => {
  await store().prepareNew();
  return c.json({ ok: true });
});

/**
 * POST /api/conversations/:id/messages
 * Body: { role, text, source, stack? }
 * id may be "active" to append to the idle-merged active conversation.
 */
conversationsRouter.post("/:id/messages", async (c) => {
  const idParam = c.req.param("id");
  let body: { role?: string; text?: string; source?: string; stack?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const role = body.role === "assistant" ? "assistant" : body.role === "user" ? "user" : null;
  const source = parseSource(body.source);
  const text = typeof body.text === "string" ? body.text : "";
  if (!role || !source || !text.trim()) {
    return c.json({ error: "role, source, and text are required" }, 400);
  }
  try {
    const result = await store().appendMessage({
      conversationId: idParam === "active" ? undefined : idParam,
      role,
      text,
      source,
      stack: parseStack(body.stack),
    });
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});
