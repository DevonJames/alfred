/**
 * FitnessAlly bridge. Device bearer required.
 *
 * PUT/GET/DELETE /api/fitness/day-plan
 * PUT/DELETE /api/fitness/focus
 */

import {
  clearFitnessDayPlan,
  clearFitnessFocus,
  createBriefingController,
  FitnessStoreError,
  formatFitnessFocusPrompt,
  readFitnessDayPlan,
  readFitnessFocus,
  saveFitnessDayPlan,
  saveFitnessFocus,
} from "@alfred/briefing";
import { Hono } from "hono";
import { requireDevice, type DeviceVariables } from "../middleware/require-device.js";

export const fitnessRouter = new Hono<{ Variables: DeviceVariables }>();

fitnessRouter.use("*", requireDevice);

fitnessRouter.get("/day-plan", async (c) => {
  const plan = await readFitnessDayPlan();
  return c.json({ plan });
});

fitnessRouter.put("/day-plan", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    const plan = await saveFitnessDayPlan(body);
    await invalidateBriefing();
    return c.json({ plan });
  } catch (err) {
    return fitnessError(c, err);
  }
});

fitnessRouter.delete("/day-plan", async (c) => {
  await clearFitnessDayPlan();
  await invalidateBriefing();
  return c.json({ ok: true });
});

fitnessRouter.put("/focus", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    const saved = await saveFitnessFocus(c.get("device").id, body);
    return c.json({ ok: true, updatedAt: saved.updatedAt, prompt: formatFitnessFocusPrompt(saved.card) });
  } catch (err) {
    return fitnessError(c, err);
  }
});

fitnessRouter.delete("/focus", async (c) => {
  await clearFitnessFocus(c.get("device").id);
  return c.json({ ok: true });
});

fitnessRouter.get("/focus", async (c) => {
  const focus = await readFitnessFocus(c.get("device").id);
  if (!focus) return c.json({ card: null });
  return c.json({ card: focus.card, updatedAt: focus.updatedAt });
});

function fitnessError(c: { json: (body: unknown, status?: number) => Response }, err: unknown): Response {
  if (err instanceof FitnessStoreError) {
    return c.json({ error: err.message }, err.status);
  }
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
}

async function invalidateBriefing(): Promise<void> {
  try {
    await createBriefingController({}).invalidateTodayCache();
  } catch (err) {
    console.warn("[fitness] briefing cache", err instanceof Error ? err.message : err);
  }
}
