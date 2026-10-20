/**
 * Device-auth Medicine API for iOS (and other remotes).
 * Same schedule/log/photo-analyze surface as the local /medicine HTML UI.
 */
import { Hono } from "hono";
import {
  medicineAnalyzeFromForm,
  medicineDeleteItem,
  medicineHttpError,
  medicineImagePayload,
  medicineLog,
  medicinePatchItem,
  medicineSchedulePayload,
} from "../lib/medicine-api.js";
import { requireSidecarOrDevice } from "../middleware/sidecar-or-device.js";

export const apiMedicineRouter = new Hono();

apiMedicineRouter.use("*", requireSidecarOrDevice);

/** GET /api/medicine/schedule */
apiMedicineRouter.get("/schedule", async (c) => {
  try {
    return c.json(await medicineSchedulePayload());
  } catch (err) {
    const { message, status } = medicineHttpError(err);
    return c.json({ error: message }, status as 500);
  }
});

/** GET /api/medicine/images/:id */
apiMedicineRouter.get("/images/:id", async (c) => {
  const image = await medicineImagePayload(c.req.param("id"));
  if (!image) return c.json({ error: "Image not found" }, 404);
  return c.body(new Uint8Array(image.bytes), 200, {
    "content-type": image.mimeType,
    "cache-control": "private, max-age=86400",
  });
});

/** POST /api/medicine/analyze — multipart photos + plan note → LLM merge into schedule. */
apiMedicineRouter.post("/analyze", async (c) => {
  try {
    const body = await c.req.parseBody({ all: true });
    return c.json(await medicineAnalyzeFromForm(body as Record<string, unknown>));
  } catch (err) {
    const { message, status } = medicineHttpError(err);
    return c.json({ error: message }, status as 400);
  }
});

/** PATCH /api/medicine/items/:id */
apiMedicineRouter.patch("/items/:id", async (c) => {
  try {
    return c.json(await medicinePatchItem(c.req.param("id"), await c.req.json()));
  } catch (err) {
    const { message, status } = medicineHttpError(err);
    return c.json({ error: message }, status as 400);
  }
});

/** DELETE /api/medicine/items/:id */
apiMedicineRouter.delete("/items/:id", async (c) => {
  try {
    return c.json(await medicineDeleteItem(c.req.param("id")));
  } catch (err) {
    const { message, status } = medicineHttpError(err);
    return c.json({ error: message }, status as 400);
  }
});

/** POST /api/medicine/log */
apiMedicineRouter.post("/log", async (c) => {
  try {
    return c.json(await medicineLog(await c.req.json()));
  } catch (err) {
    const { message, status } = medicineHttpError(err);
    return c.json({ error: message }, status as 400);
  }
});
