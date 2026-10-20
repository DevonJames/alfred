import {
  createRemindersGateway,
  isReminderAccess,
  loadReminderPolicy,
  mergeReminderAccess,
  remindersPolicyPath,
  saveReminderPolicy,
  type ReminderGrant,
} from "@alfred/reminders-gateway";
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  approveProposal,
  completeReminder,
  dismissProposal,
  renameReminder,
  rescheduleReminder,
  listOpenReminders,
  listProposals,
  proposalContext,
  renameProposal,
} from "../lib/message-commitments.js";

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), "../ui");

export const remindersUiRouter = new Hono();

function profileId(): string {
  return process.env.ALFRED_PROFILE_ID ?? "profile.default";
}

function policyFile(): string {
  return remindersPolicyPath(profileId());
}

remindersUiRouter.get("/", async (c) => {
  const html = await readFile(resolve(uiDir, "reminders.html"), "utf8");
  return c.html(html);
});

remindersUiRouter.get("/board", async (c) => {
  try {
    const gateway = createRemindersGateway(policyFile());
    const discovered = await gateway.lists();
    const policy = await loadReminderPolicy(policyFile());
    const merged = mergeReminderAccess(discovered, policy);
    const items = await listOpenReminders();
    const proposals = await listProposals();
    return c.json({ sources: merged.sources, items, proposals });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ sources: [], items: [], proposals: [], error: message }, 200);
  }
});

remindersUiRouter.put("/lists", async (c) => {
  let body: { grants?: Array<Record<string, unknown>> };
  try {
    body = (await c.req.json()) as { grants?: Array<Record<string, unknown>> };
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!Array.isArray(body.grants)) return c.json({ error: "Expected grants" }, 400);
  const file = policyFile();
  const policy = await loadReminderPolicy(file);
  for (const raw of body.grants) {
    if (typeof raw.id !== "string" || !raw.id.trim() || !isReminderAccess(raw.access)) {
      return c.json({ error: "Each list needs an id and access" }, 400);
    }
    const grant: ReminderGrant = {
      access: raw.access,
      title: typeof raw.title === "string" ? raw.title : "",
      sourceIdentifier: typeof raw.sourceIdentifier === "string" ? raw.sourceIdentifier : "",
      sourceTitle: typeof raw.sourceTitle === "string" ? raw.sourceTitle : "",
    };
    policy.lists[raw.id] = grant;
  }
  try {
    const discovered = await createRemindersGateway(file).lists();
    const merged = mergeReminderAccess(discovered, policy);
    await saveReminderPolicy(file, { version: 1, lists: merged.grants });
    return c.json({ sources: merged.sources, saved: true });
  } catch (err) {
    await saveReminderPolicy(file, policy);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message, saved: true });
  }
});

remindersUiRouter.post("/due", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { id?: unknown; due?: unknown };
  if (typeof body.id !== "string" || !body.id.trim()) return c.json({ error: "Missing id" }, 400);
  const due = typeof body.due === "string" ? body.due.trim() : "";
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return c.json({ error: "Choose a day" }, 400);
  try {
    const reminder = await rescheduleReminder(body.id, due || null);
    return c.json({ ok: true, reminder });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

remindersUiRouter.post("/title", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { id?: unknown; title?: unknown };
  if (typeof body.id !== "string" || !body.id.trim()) return c.json({ error: "Missing id" }, 400);
  if (typeof body.title !== "string" || !body.title.trim()) return c.json({ error: "A reminder needs a name." }, 400);
  try {
    const reminder = await renameReminder(body.id, body.title);
    return c.json({ ok: true, reminder });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

remindersUiRouter.post("/complete", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { id?: unknown };
  if (typeof body.id !== "string" || !body.id.trim()) return c.json({ error: "Missing id" }, 400);
  try {
    await completeReminder(body.id);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

remindersUiRouter.post("/proposals/:id/approve", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { listId?: unknown; due?: unknown; title?: unknown };
  if (typeof body.listId !== "string" || typeof body.due !== "string") {
    return c.json({ error: "Choose a list and a day" }, 400);
  }
  try {
    const reminder = await approveProposal(
      c.req.param("id"),
      body.listId,
      body.due,
      typeof body.title === "string" ? body.title : undefined,
    );
    return c.json({ ok: true, reminder });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

remindersUiRouter.get("/proposals/:id/context", async (c) => {
  const proposal = (await listProposals()).find((item) => item.id === c.req.param("id"));
  if (!proposal) return c.json({ error: "That proposal is no longer waiting." }, 404);
  const lines = proposalContext(proposal.messageId);
  if (lines == null) return c.json({ error: "Messages is not readable from here." }, 400);
  return c.json({ lines });
});

remindersUiRouter.post("/proposals/:id/title", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { title?: unknown };
  if (typeof body.title !== "string") return c.json({ error: "Missing title" }, 400);
  await renameProposal(c.req.param("id"), body.title);
  return c.json({ ok: true });
});

remindersUiRouter.post("/proposals/:id/dismiss", async (c) => {
  await dismissProposal(c.req.param("id"));
  return c.json({ ok: true });
});
