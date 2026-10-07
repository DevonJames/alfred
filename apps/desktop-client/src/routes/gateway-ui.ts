import {
  calendarPolicyPath,
  createEventKitGateway,
  isCalendarAccess,
  loadCalendarPolicy,
  mergeCalendarAccess,
  saveCalendarPolicy,
  type CalendarGrant,
} from "@alfred/calendar-gateway";
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), "../ui");

export const gatewayUiRouter = new Hono();

function profileId(): string {
  return process.env.ALFRED_PROFILE_ID ?? "profile.default";
}

function policyFile(): string {
  return calendarPolicyPath(profileId());
}

interface GrantInput {
  id?: unknown;
  access?: unknown;
  title?: unknown;
  sourceIdentifier?: unknown;
  sourceTitle?: unknown;
  ignoreOverlaps?: unknown;
}

function grantFromInput(raw: GrantInput): { id: string; grant: CalendarGrant } | null {
  if (typeof raw.id !== "string" || !raw.id.trim()) return null;
  if (!isCalendarAccess(raw.access)) return null;
  return {
    id: raw.id,
    grant: {
      access: raw.access,
      title: typeof raw.title === "string" ? raw.title : "",
      sourceIdentifier: typeof raw.sourceIdentifier === "string" ? raw.sourceIdentifier : "",
      sourceTitle: typeof raw.sourceTitle === "string" ? raw.sourceTitle : "",
      ignoreOverlaps: raw.ignoreOverlaps === true,
    },
  };
}

async function currentSources() {
  const file = policyFile();
  const gateway = createEventKitGateway(file);
  const [discovered, policy] = await Promise.all([gateway.catalog(), loadCalendarPolicy(file)]);
  return mergeCalendarAccess(discovered, policy);
}

/** GET /gateway — Context & Action Gateway settings. */
gatewayUiRouter.get("/", async (c) => {
  const html = await readFile(resolve(uiDir, "gateway.html"), "utf8");
  return c.html(html);
});

/** GET /gateway/calendars — calendars on this Mac, grouped by account. */
gatewayUiRouter.get("/calendars", async (c) => {
  try {
    const merged = await currentSources();
    return c.json({ sources: merged.sources });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ sources: [], error: message });
  }
});

/** PUT /gateway/calendars — save No Access / Read / Write for each calendar. */
gatewayUiRouter.put("/calendars", async (c) => {
  let body: { grants?: GrantInput[] };
  try {
    body = (await c.req.json()) as { grants?: GrantInput[] };
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!Array.isArray(body.grants)) return c.json({ error: "Expected grants" }, 400);

  const file = policyFile();
  const policy = await loadCalendarPolicy(file);
  for (const raw of body.grants) {
    const parsed = grantFromInput(raw);
    if (!parsed) return c.json({ error: "Each calendar needs an id and access" }, 400);
    policy.calendars[parsed.id] = parsed.grant;
  }

  try {
    const gateway = createEventKitGateway(file);
    const discovered = await gateway.catalog();
    const merged = mergeCalendarAccess(discovered, policy);
    await saveCalendarPolicy(file, { version: 1, calendars: merged.grants });
    return c.json({ sources: merged.sources, saved: true });
  } catch (err) {
    await saveCalendarPolicy(file, policy);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message, saved: true });
  }
});
