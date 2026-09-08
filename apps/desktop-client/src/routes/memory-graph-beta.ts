/**
 * Memory graph (beta) — 3D WebGL UI
 *
 * GET /memory/graph-beta          — interactive 3D UI
 * GET /memory/graph-beta/app.js   — 3D graph app
 * GET /memory/graph-beta/vendor/* — vendored Three.js / 3d-force-graph / bloom
 *
 * Data APIs stay on classic /memory/graph/* (shared).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

export const memoryGraphBetaRouter = new Hono();

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../ui");
const vendorDir = path.join(uiDir, "vendor");

const VENDOR_FILES = new Set([
  "three.min.js",
  "3d-force-graph.min.js",
  "CopyShader.js",
  "LuminosityHighPassShader.js",
  "EffectComposer.js",
  "ShaderPass.js",
  "RenderPass.js",
  "UnrealBloomPass.js",
]);

memoryGraphBetaRouter.get("/", async (c) => {
  const html = await readFile(path.join(uiDir, "memory-graph-beta.html"), "utf8");
  const stamped = html.replace(
    "/memory/graph-beta/app.js",
    `/memory/graph-beta/app.js?v=${Date.now()}`,
  );
  return c.html(stamped);
});

memoryGraphBetaRouter.get("/app.js", async (c) => {
  const js = await readFile(path.join(uiDir, "memory-graph-beta.js"), "utf8");
  return c.body(js, 200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-store",
  });
});

memoryGraphBetaRouter.get("/vendor/:file", async (c) => {
  const file = c.req.param("file");
  if (!VENDOR_FILES.has(file)) {
    return c.json({ error: "not_found" }, 404);
  }
  const js = await readFile(path.join(vendorDir, file), "utf8");
  return c.body(js, 200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=86400",
  });
});
