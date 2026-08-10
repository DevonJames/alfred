import { createBriefingController } from "@alfred/briefing";
import { Hono } from "hono";
import { oipForProfile } from "../lib/oip-memory.js";
import { requireDevice } from "../middleware/require-device.js";

export const briefingRouter = new Hono();

briefingRouter.use("*", requireDevice);

/** GET /api/briefing?refresh=1 */
briefingRouter.get("/briefing", async (c) => {
  const refresh = c.req.query("refresh") === "1" || c.req.query("refresh") === "true";
  const memory = oipForProfile();
  const controller = createBriefingController({ memory });
  try {
    const payload = await controller.generate({ refresh, markSurfaced: false });
    return c.json(payload);
  } catch (err) {
    return c.json(
      {
        error: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});
