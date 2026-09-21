import { Hono } from "hono";
import { parseClaimPayload } from "../lib/claim-qr.js";
import { writeCameraFrame } from "./camera-sink.js";
import { cameraStatus, ensureCamera, getLatestJpeg, stopCamera, waitForCameraFrame } from "./rpi-camera.js";
import { CloudApiError, linkDesktop } from "./cloud.js";
import { conversationSnapshot, setTalkListen } from "./conversation.js";
import { desktopFetch, discoverServer } from "./discovery.js";
import { deviceName, identityCard, rotateSession, sessionMatches } from "./identity.js";
import { clearStore, isPaired, loadStore, patchStore, type AlfredBotStore } from "./store.js";
import { parseAudioSource, resolveAudioSource } from "./audio.js";
import { applyHeadStick, clampStick, headStatus, releaseHead, setHeadTracking } from "./head.js";
import { applyWheelStick, releaseWheels, wheelStatus } from "./wheels.js";
import { armStatus, runArmWave } from "./arm.js";
import { needsWifiSetup, wifiJoin, wifiScan, wifiStatus } from "./wifi.js";

const APP_VERSION = "0.1.0";

function screenFor(store: AlfredBotStore, wifiNeeded: boolean): "wifi" | "claim" | "pin" | "face" {
  if (wifiNeeded) return "wifi";
  if (!store.cloudToken || !store.cloudServerId) return "claim";
  if (!store.deviceToken || !store.serverUrl) return "pin";
  return "face";
}

async function bootState() {
  const [store, wifi] = await Promise.all([loadStore(), wifiStatus()]);
  const wifiNeeded = needsWifiSetup(wifi);
  return {
    screen: screenFor(store, wifiNeeded),
    wifi,
    paired: isPaired(store),
    connectionType: store.connectionType,
    desktopName: store.desktopName,
    serverUrl: store.serverUrl,
    deviceId: store.deviceId,
    audioSource: resolveAudioSource(store.audioSource),
    ...conversationSnapshot(),
  };
}

export function createAlfredBotRouter(): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      });
    }
    await next();
    c.header("Access-Control-Allow-Origin", "*");
  });

  let kioskBeatAt = 0;
  app.post("/api/kiosk/heartbeat", (c) => {
    kioskBeatAt = Date.now();
    return c.json({ ok: true });
  });
  app.get("/api/kiosk/heartbeat", (c) => {
    const age = kioskBeatAt ? Date.now() - kioskBeatAt : Number.POSITIVE_INFINITY;
    if (age < 12_000) return c.json({ ok: true, age });
    return c.json({ ok: false, age: Number.isFinite(age) ? age : null }, 503);
  });

  app.get("/api/status", async (c) => c.json(await bootState()));
  app.get("/api/identity", async (c) => c.json(await identityCard()));

  app.post("/api/provision", async (c) => {
    let body: {
      session?: string;
      cloudToken?: string;
      cloudServerId?: string;
      serverUrl?: string;
      connectionType?: AlfredBotStore["connectionType"];
      desktopName?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    if (!sessionMatches(body.session)) {
      return c.json({ error: "That AlfredBot code is no longer valid. Refresh the robot screen." }, 403);
    }
    if (!body.cloudToken || !body.cloudServerId || !body.serverUrl) {
      return c.json({ error: "Link this phone to a Mac first, then scan again." }, 400);
    }
    const store = await patchStore({
      cloudToken: body.cloudToken,
      cloudServerId: body.cloudServerId,
      serverUrl: body.serverUrl,
      connectionType: body.connectionType ?? "lan",
      desktopName: body.desktopName ?? null,
      deviceToken: null,
      deviceId: null,
    });
    return c.json({ ok: true, screen: screenFor(store, false), desktopName: store.desktopName });
  });

  app.post("/api/provision-pair", async (c) => {
    let body: { session?: string; deviceToken?: string; deviceId?: string; desktopName?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    if (!sessionMatches(body.session)) {
      return c.json({ error: "That AlfredBot code is no longer valid. Refresh the robot screen." }, 403);
    }
    if (!body.deviceToken || !body.deviceId) {
      return c.json({ error: "Pairing did not return a device key." }, 400);
    }
    const store = await patchStore({
      deviceToken: body.deviceToken,
      deviceId: body.deviceId,
      desktopName: body.desktopName ?? (await loadStore()).desktopName,
    });
    rotateSession();
    return c.json({ ok: true, screen: screenFor(store, false), desktopName: store.desktopName });
  });

  app.post("/api/camera/start", (c) => c.json(ensureCamera()));
  app.post("/api/camera/preview", async (c) => {
    let body: { enabled?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    if (body.enabled === false) return c.json(stopCamera());
    ensureCamera({ preview: true });
    return c.json(await waitForCameraFrame(1800));
  });
  app.get("/api/camera/status", (c) => c.json(cameraStatus()));
  app.get("/api/camera/latest.jpg", (c) => {
    const frame = getLatestJpeg();
    if (!frame) return c.body(null, 204);
    return new Response(Uint8Array.from(frame), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
    });
  });

  app.get("/api/wifi", async (c) => c.json(await wifiStatus()));

  app.post("/api/wifi/scan", async (c) => {
    try {
      return c.json({ networks: await wifiScan() });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/wifi/join", async (c) => {
    let body: { ssid?: string; password?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    try {
      const wifi = await wifiJoin(body.ssid ?? "", body.password ?? "");
      return c.json({ wifi, screen: (await bootState()).screen });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/claim", async (c) => {
    let body: { raw?: string; serverId?: string; claimSecret?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const parsed = body.raw
      ? parseClaimPayload(body.raw)
      : body.serverId && body.claimSecret
        ? parseClaimPayload(
            `alfred://claim?serverId=${encodeURIComponent(body.serverId)}&claimSecret=${encodeURIComponent(body.claimSecret)}`,
          )
        : null;
    if (!parsed) {
      return c.json({ error: "That is not an Alfred claim code." }, 400);
    }
    try {
      const linked = await linkDesktop(parsed.serverId, parsed.claimSecret);
      const found = await discoverServer(linked.serverId, linked.token, linked.connectionCandidates);
      const store = await patchStore({
        cloudToken: linked.token,
        cloudServerId: linked.serverId,
        desktopName: linked.name,
        serverUrl: found.url,
        connectionType: found.mode,
        deviceToken: null,
        deviceId: null,
      });
      return c.json({
        ok: true,
        screen: screenFor(store, false),
        desktopName: linked.name,
        connectionType: found.mode,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof CloudApiError && err.status === 401) return c.json({ error: message }, 401);
      if (err instanceof CloudApiError && err.status === 404) return c.json({ error: message }, 404);
      if (err instanceof CloudApiError && err.status === 409) return c.json({ error: message }, 409);
      return c.json({ error: message }, 502);
    }
  });

  app.post("/api/pair/request", async (c) => {
    const store = await loadStore();
    if (!store.serverUrl || !store.cloudToken) {
      return c.json({ error: "Claim a desktop first." }, 400);
    }
    const res = await desktopFetch(store.serverUrl, store.cloudToken, null, "/pair/request", {
      method: "POST",
      body: JSON.stringify({
        device: { name: deviceName(), device_type: "robot", app_version: APP_VERSION },
      }),
    });
    const raw = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      parsed = { detail: raw };
    }
    if (!res.ok) {
      return c.json({ error: parsed.detail ?? parsed.error ?? raw ?? "Pair request failed" }, 400);
    }
    const deviceId = typeof parsed.device_id === "string" ? parsed.device_id : "";
    await patchStore({ deviceId });
    return c.json({
      device_id: deviceId,
      expires_in_seconds: parsed.expires_in_seconds ?? 300,
    });
  });

  app.post("/api/pair/confirm", async (c) => {
    let body: { pin?: string; device_id?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const store = await loadStore();
    const deviceId = (body.device_id ?? store.deviceId ?? "").trim();
    const pin = (body.pin ?? "").replace(/\D/g, "");
    if (!store.serverUrl || !store.cloudToken) {
      return c.json({ error: "Claim a desktop first." }, 400);
    }
    if (!deviceId || pin.length !== 6) {
      return c.json({ error: "Enter the 6-digit code from the Mac." }, 400);
    }
    const res = await desktopFetch(store.serverUrl, store.cloudToken, null, "/pair/confirm", {
      method: "POST",
      body: JSON.stringify({ device_id: deviceId, pin }),
    });
    const raw = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      parsed = { detail: raw };
    }
    if (!res.ok) {
      return c.json({ error: parsed.detail ?? parsed.error ?? "That PIN did not match." }, 400);
    }
    const token = typeof parsed.token === "string" ? parsed.token : "";
    if (!token) return c.json({ error: "Desktop paired but returned no token." }, 502);
    const next = await patchStore({
      deviceToken: token,
      deviceId: typeof parsed.device_id === "string" ? parsed.device_id : deviceId,
      desktopName: typeof parsed.server_name === "string" ? parsed.server_name : store.desktopName,
    });
    return c.json({ ok: true, screen: screenFor(next, false), desktopName: next.desktopName });
  });

  app.post("/api/unpair", async (c) => {
    const store = await loadStore();
    if (store.serverUrl && store.deviceId && store.deviceToken) {
      await desktopFetch(
        store.serverUrl,
        store.cloudToken,
        store.deviceToken,
        `/pair/${encodeURIComponent(store.deviceId)}`,
        { method: "DELETE" },
      ).catch(() => undefined);
    }
    await clearStore();
    return c.json(await bootState());
  });

  app.get("/api/talk/status", async (c) => {
    const store = await loadStore();
    if (!store.serverUrl || !store.deviceToken) {
      return c.json({ error: "Not paired." }, 401);
    }
    const res = await desktopFetch(
      store.serverUrl,
      store.cloudToken,
      store.deviceToken,
      "/api/session/status",
    );
    const raw = await res.text();
    return c.body(raw, res.status as 200, { "Content-Type": "application/json" });
  });

  app.post("/api/camera-frame", async (c) => {
    const jpeg = new Uint8Array(await c.req.arrayBuffer());
    const written = writeCameraFrame(jpeg);
    if (!written.ok) return c.json({ error: "Ignored camera frame." }, 400);
    return c.json({ ok: true, path: written.path });
  });

  app.post("/api/talk/listen", (c) => {
    setTalkListen(true);
    return c.json({ ok: true, conversation: true });
  });

  app.post("/api/talk/hangup", (c) => {
    setTalkListen(false);
    return c.json({ ok: true, conversation: false });
  });

  app.post("/api/talk/stop", async (c) => {
    setTalkListen(false);
    const store = await loadStore();
    if (store.serverUrl && store.deviceToken) {
      await desktopFetch(
        store.serverUrl,
        store.cloudToken,
        store.deviceToken,
        "/api/session/end",
        { method: "POST", body: "{}", timeoutMs: 5_000 },
      ).catch(() => undefined);
    }
    return c.json({ ok: true, conversation: false });
  });

  app.post("/api/talk/start", async (c) => {
    const store = await loadStore();
    if (!store.serverUrl || !store.deviceToken) {
      return c.json({ error: "Not paired." }, 401);
    }
    setTalkListen(true);
    const res = await desktopFetch(
      store.serverUrl,
      store.cloudToken,
      store.deviceToken,
      "/api/session/token",
      { method: "POST", body: JSON.stringify({ client: "ios", join: "robot" }), timeoutMs: 8_000 },
    );
    if (!res.ok) {
      setTalkListen(false);
      const raw = await res.text();
      return c.body(raw, res.status as 400, { "Content-Type": "application/json" });
    }
    return c.json({ ok: true, conversation: true });
  });

  app.post("/api/audio/source", async (c) => {
    let body: { source?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const source = parseAudioSource(body.source);
    if (!source) return c.json({ error: "source must be phone or local." }, 400);
    const store = await patchStore({ audioSource: source });
    console.log(`[alfredbot] audio source → ${source}`);
    return c.json({ ok: true, audioSource: resolveAudioSource(store.audioSource) });
  });

  app.post("/api/talk/token", async (c) => {
    const store = await loadStore();
    if (!store.serverUrl || !store.deviceToken) {
      return c.json({ error: "Not paired." }, 401);
    }
    const res = await desktopFetch(
      store.serverUrl,
      store.cloudToken,
      store.deviceToken,
      "/api/session/token",
      { method: "POST", body: JSON.stringify({ client: "robot" }), timeoutMs: 8_000 },
    );
    const raw = await res.text();
    return c.body(raw, res.status as 200, { "Content-Type": "application/json" });
  });

  app.get("/api/head/status", (c) => c.json(headStatus()));

  app.post("/api/head/stick", async (c) => {
    let body: { neck?: unknown; tilt?: unknown; roll?: unknown; dtMs?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const dtMs = typeof body.dtMs === "number" && Number.isFinite(body.dtMs) ? body.dtMs : 80;
    const result = await applyHeadStick(
      {
        neck: clampStick(body.neck),
        tilt: clampStick(body.tilt),
        roll: clampStick(body.roll),
      },
      dtMs / 1000,
    );
    if (!result.ok) return c.json({ error: result.error ?? "Head move failed." }, 500);
    return c.json({ ok: true, deltas: result.deltas });
  });

  app.post("/api/head/release", async (c) => {
    const result = await releaseHead();
    if (!result.ok) return c.json({ error: result.error ?? "Couldn't release the neck." }, 500);
    return c.json({ ok: true });
  });

  app.post("/api/head/tracking", async (c) => {
    let body: { enabled?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled must be true or false" }, 400);
    }
    const result = await setHeadTracking(body.enabled);
    if (!result.ok) return c.json({ error: result.error ?? "Couldn't change tracking." }, 500);
    return c.json({ ok: true, tracking: result.tracking });
  });

  app.get("/api/wheels/status", (c) => c.json(wheelStatus()));

  app.post("/api/wheels/stick", async (c) => {
    let body: { left?: unknown; right?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const result = await applyWheelStick({
      left: clampStick(body.left),
      right: clampStick(body.right),
    });
    if (!result.ok) return c.json({ error: result.error ?? "Wheel move failed." }, 500);
    return c.json({ ok: true, bytes: result.bytes });
  });

  app.post("/api/wheels/release", async (c) => {
    const result = await releaseWheels();
    if (!result.ok) return c.json({ error: result.error ?? "Couldn't stop the wheels." }, 500);
    return c.json({ ok: true, bytes: result.bytes });
  });

  app.get("/api/arm/status", (c) => c.json(armStatus()));

  app.post("/api/arm/wave", async (c) => {
    const result = await runArmWave();
    if (!result.ok) return c.json({ error: result.error ?? "Arm wave failed." }, 500);
    return c.json({ ok: true });
  });

  return app;
}
