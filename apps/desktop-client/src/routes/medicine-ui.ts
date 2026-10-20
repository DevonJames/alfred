/**
 * Local browser Medicine UI (HTML) + same schedule endpoints under /medicine/*.
 */
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  medicineAnalyzeFromForm,
  medicineDeleteItem,
  medicineHttpError,
  medicineImagePayload,
  medicineLog,
  medicinePatchItem,
  medicineSchedulePayload,
} from "../lib/medicine-api.js";

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), "../ui");

export const medicineUiRouter = new Hono();

medicineUiRouter.get("/", async (c) => {
  const html = await readFile(resolve(uiDir, "medicine.html"), "utf8");
  return c.html(html);
});

medicineUiRouter.get("/schedule", async (c) => {
  return c.json(await medicineSchedulePayload());
});

medicineUiRouter.get("/images/:id", async (c) => {
  const image = await medicineImagePayload(c.req.param("id"));
  if (!image) return c.json({ error: "Image not found" }, 404);
  return c.body(new Uint8Array(image.bytes), 200, {
    "content-type": image.mimeType,
    "cache-control": "private, max-age=86400",
  });
});

medicineUiRouter.post("/analyze", async (c) => {
  try {
    const body = await c.req.parseBody({ all: true });
    return c.json(await medicineAnalyzeFromForm(body as Record<string, unknown>));
  } catch (err) {
    const { message, status } = medicineHttpError(err);
    return c.json({ error: message }, status as 400);
  }
});

medicineUiRouter.patch("/items/:id", async (c) => {
  try {
    return c.json(await medicinePatchItem(c.req.param("id"), await c.req.json()));
  } catch (err) {
    const { message, status } = medicineHttpError(err);
    return c.json({ error: message }, status as 400);
  }
});

medicineUiRouter.delete("/items/:id", async (c) => {
  try {
    return c.json(await medicineDeleteItem(c.req.param("id")));
  } catch (err) {
    const { message, status } = medicineHttpError(err);
    return c.json({ error: message }, status as 400);
  }
});

medicineUiRouter.post("/log", async (c) => {
  try {
    return c.json(await medicineLog(await c.req.json()));
  } catch (err) {
    const { message, status } = medicineHttpError(err);
    return c.json({ error: message }, status as 400);
  }
});
