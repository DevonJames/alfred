import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MISSING_PCA =
  "The PCA9685 neck board isn't answering on I2C (nothing at 0x40–0x47). Face tracking is down for the same reason.";

export type HeadStick = { neck: number; tilt: number; roll: number };

/** PCA9685 channels from alfred-home alfred_cli.py / face_tracker.py. */
export const HEAD_CHANNELS = { body: 0, neck: 1, tilt: 2, roll: 3 } as const;

const DEADZONE = 0.08;
const MAX_DPS = { neck: 42, tilt: 32, roll: 36 } as const;

/** Stick X +right / Y +up → ServoKit degree deltas (alfred_cli signs). */
export function stickToDeltas(stick: HeadStick, dtSec: number): HeadStick {
  const dt = Math.max(0.02, Math.max(0, Math.min(0.25, dtSec)));
  const axis = (value: number, dps: number, sign: number) => {
    const n = Math.max(-1, Math.min(1, value));
    if (Math.abs(n) < DEADZONE) return 0;
    return n * dps * dt * sign;
  };
  return {
    neck: axis(stick.neck, MAX_DPS.neck, 1),
    tilt: axis(stick.tilt, MAX_DPS.tilt, 1),
    roll: axis(stick.roll, MAX_DPS.roll, 1),
  };
}

export function clampStick(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
}

function pythonBin(): string {
  const override = process.env.ALFREDBOT_PYTHON;
  if (override) return override;
  const candidates = ["/home/alfred/alfred_env/bin/python", "/home/alfred/alfred_env/bin/python3"];
  return candidates.find((p) => existsSync(p)) ?? "python3";
}

function scriptPath(): string {
  const override = process.env.ALFREDBOT_HEAD_STICK;
  if (override) return resolve(override);
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "deploy/head-stick.py"),
    resolve(process.cwd(), "deploy/head-stick.py"),
    resolve(here, "../../deploy/head-stick.py"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

function stickFilePath(): string {
  return process.env.ALFREDBOT_HEAD_STICK_PATH ?? "/tmp/alfred-head-stick.json";
}

function trackerIsLive(): boolean {
  try {
    const raw = readFileSync("/tmp/alfred-tracker.json", "utf8");
    const parsed = JSON.parse(raw) as { ts?: unknown; paused?: unknown };
    const ts = typeof parsed.ts === "number" ? parsed.ts : Number(parsed.ts);
    return Number.isFinite(ts) && Date.now() / 1000 - ts < 2.5;
  } catch {
    return false;
  }
}

function writeStickFile(stick: HeadStick): void {
  writeFileSync(
    stickFilePath(),
    JSON.stringify({
      ts: Date.now() / 1000,
      neck: clampStick(stick.neck),
      tilt: clampStick(stick.tilt),
      roll: clampStick(stick.roll),
    }),
  );
}

function clearStickFile(): void {
  try {
    unlinkSync(stickFilePath());
  } catch {
    // already gone
  }
}

function mocked(): boolean {
  if (process.env.ALFREDBOT_HEAD_MOCK === "1") return true;
  if (process.env.ALFREDBOT_HEAD_MOCK === "0") return false;
  return process.platform === "darwin";
}

const PAUSE_PATH = process.env.ALFRED_TRACK_PAUSE_PATH ?? "/tmp/alfred-tracker-pause.json";
const MODE_PATH = process.env.ALFRED_CLI_MODE_PATH ?? "/tmp/alfred-cli-mode.json";
const FOREVER_S = 10 * 365 * 24 * 3600;
const TRACKER_UNIT = process.env.ALFREDBOT_TRACKER_UNIT ?? "alfred-face-tracker.service";

export type HeadPrefs = { tracking: boolean };

function prefsPath(): string {
  if (process.env.ALFREDBOT_HEAD_PREFS) return resolve(process.env.ALFREDBOT_HEAD_PREFS);
  if (mocked()) return resolve("/tmp/alfredbot-head-prefs.json");
  return "/var/lib/alfredbot/head-prefs.json";
}

export function loadHeadPrefs(): HeadPrefs {
  try {
    const parsed = JSON.parse(readFileSync(prefsPath(), "utf8")) as { tracking?: unknown };
    return { tracking: parsed.tracking === true };
  } catch {
    return { tracking: false };
  }
}

function saveHeadPrefs(prefs: HeadPrefs) {
  const path = prefsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(prefs)}\n`);
}

function writeJson(path: string, payload: Record<string, unknown>) {
  writeFileSync(path, JSON.stringify(payload));
}

function setTrackerService(enabled: boolean) {
  if (mocked()) return;
  const action = enabled ? ["enable", "--now", TRACKER_UNIT] : ["disable", "--now", TRACKER_UNIT];
  spawnSync("sudo", ["-n", "systemctl", ...action], { timeout: 8000, encoding: "utf8" });
}

/** Face + voice head-follow. Off unless the phone turned it on. */
export function trackingEnabled(): boolean {
  return loadHeadPrefs().tracking;
}

export async function setHeadTracking(enabled: boolean): Promise<{ ok: boolean; tracking: boolean; error?: string }> {
  saveHeadPrefs({ tracking: enabled });
  clearStickFile();
  engaged = false;
  if (mocked()) return { ok: true, tracking: enabled };
  if (enabled) {
    writeJson(MODE_PATH, { mode: "on", ts: Date.now() / 1000 });
    writeJson(PAUSE_PATH, { until_ts: 0, reason: "ios-remote-on" });
    if (child) {
      await rpc({ cmd: "release" });
      detachChild();
    }
    setTrackerService(true);
    return { ok: true, tracking: true };
  }
  writeJson(MODE_PATH, { mode: "off", ts: Date.now() / 1000 });
  writeJson(PAUSE_PATH, {
    until_ts: Date.now() / 1000 + FOREVER_S,
    reason: "ios-remote",
  });
  if (child) detachChild();
  setTrackerService(false);
  return { ok: true, tracking: false };
}

/** Call once at host boot so a reboot cannot start face/voice tracking. */
export function applyHeadPrefsOnBoot(): void {
  const prefs = loadHeadPrefs();
  saveHeadPrefs(prefs);
  if (prefs.tracking) return;
  void setHeadTracking(false);
}

export type PcaProbe = { present: boolean; acks: string[]; error?: string };

let probeCache: { at: number; value: PcaProbe } | null = null;

export function probePca(force = false): PcaProbe {
  if (mocked()) return { present: true, acks: ["mock"] };
  if (trackerIsLive()) return { present: true, acks: ["tracker"] };
  if (!force && probeCache && Date.now() - probeCache.at < 3000) return probeCache.value;
  const script = scriptPath();
  if (!existsSync(script)) {
    const value = { present: false, acks: [], error: `Missing ${script}` };
    probeCache = { at: Date.now(), value };
    return value;
  }
  try {
    const result = spawnSync(pythonBin(), ["-u", script, "probe"], {
      encoding: "utf8",
      timeout: 800,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    const line = (result.stdout || "").trim().split("\n").pop() || "";
    const parsed = JSON.parse(line) as { present?: boolean; acks?: string[]; error?: string };
    const value: PcaProbe = {
      present: parsed.present === true,
      acks: Array.isArray(parsed.acks) ? parsed.acks.map(String) : [],
      error: parsed.present ? undefined : parsed.error || MISSING_PCA,
    };
    probeCache = { at: Date.now(), value };
    return value;
  } catch {
    const value = { present: false, acks: [], error: MISSING_PCA };
    probeCache = { at: Date.now(), value };
    return value;
  }
}

type RpcResult = { ok: boolean; stdout: string; stderr: string };

let engaged = false;
let child: ReturnType<typeof spawn> | null = null;
let stdoutBuf = "";
let stderrBuf = "";
let waiter: ((result: RpcResult) => void) | null = null;
let chain: Promise<unknown> = Promise.resolve();

function finishWaiter(result: RpcResult) {
  const pending = waiter;
  waiter = null;
  pending?.(result);
}

function detachChild() {
  const proc = child;
  child = null;
  stdoutBuf = "";
  stderrBuf = "";
  if (!proc) return;
  proc.stdout?.removeAllListeners();
  proc.stderr?.removeAllListeners();
  proc.removeAllListeners();
  if (!proc.killed) proc.kill("SIGTERM");
}

function parseLine(line: string): RpcResult {
  try {
    const parsed = JSON.parse(line) as { ok?: boolean; error?: string };
    return { ok: parsed.ok !== false, stdout: line, stderr: parsed.error ?? stderrBuf };
  } catch {
    return { ok: false, stdout: line, stderr: stderrBuf || "Head helper sent junk." };
  }
}

function ensureChild(): RpcResult | ReturnType<typeof spawn> {
  if (child && !child.killed) return child;
  const script = scriptPath();
  if (!existsSync(script)) return { ok: false, stdout: "", stderr: `Missing ${script}` };
  const proc = spawn(pythonBin(), ["-u", script, "serve"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  child = proc;
  stdoutBuf = "";
  stderrBuf = "";
  proc.stdout?.on("data", (chunk) => {
    stdoutBuf += String(chunk);
    while (true) {
      const nl = stdoutBuf.indexOf("\n");
      if (nl < 0) break;
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line) finishWaiter(parseLine(line));
    }
  });
  proc.stderr?.on("data", (chunk) => {
    stderrBuf += String(chunk);
  });
  proc.on("error", (err) => {
    finishWaiter({ ok: false, stdout: "", stderr: err.message });
    detachChild();
  });
  proc.on("close", (code) => {
    const leftover = stdoutBuf.trim();
    if (leftover) finishWaiter(parseLine(leftover));
    else if (waiter) {
      finishWaiter({
        ok: code === 0,
        stdout: "",
        stderr: code === 0 ? "" : stderrBuf || "Head helper closed.",
      });
    }
    child = null;
  });
  return proc;
}

function rpc(msg: Record<string, unknown>): Promise<RpcResult> {
  if (mocked()) {
    return Promise.resolve({ ok: true, stdout: JSON.stringify({ mock: true, msg }), stderr: "" });
  }
  const next = chain.then(
    () =>
      new Promise<RpcResult>((resolvePromise) => {
        const proc = ensureChild();
        if ("ok" in proc) {
          resolvePromise(proc);
          return;
        }
        if (!proc.stdin) {
          resolvePromise({ ok: false, stdout: "", stderr: "Head helper has no stdin." });
          return;
        }
        const timer = setTimeout(() => {
          if (waiter !== finish) return;
          waiter = null;
          resolvePromise({ ok: false, stdout: stdoutBuf, stderr: stderrBuf || "Head helper timed out." });
        }, 2500);
        const finish = (result: RpcResult) => {
          clearTimeout(timer);
          resolvePromise(result);
        };
        waiter = finish;
        proc.stdin.write(`${JSON.stringify(msg)}\n`, (err) => {
          if (!err) return;
          clearTimeout(timer);
          waiter = null;
          resolvePromise({ ok: false, stdout: "", stderr: err.message });
        });
      }),
  );
  chain = next.catch(() => undefined);
  return next;
}

export function headStatus(): {
  mocked: boolean;
  engaged: boolean;
  tracking: boolean;
  trackerLive: boolean;
  pcaPresent: boolean;
  acks: string[];
  via: "tracker-file" | "python-i2c" | "mock";
  python: string;
  script: string;
  scriptExists: boolean;
  stickFile: string;
  channels: typeof HEAD_CHANNELS;
  error?: string;
} {
  const script = scriptPath();
  const live = trackerIsLive();
  const tracking = trackingEnabled();
  const pca = mocked() || live ? { present: true, acks: live ? ["tracker"] : ["mock"] } : probePca();
  return {
    mocked: mocked(),
    engaged,
    tracking,
    trackerLive: live,
    pcaPresent: pca.present,
    acks: pca.acks,
    via: mocked() ? "mock" : tracking && live ? "tracker-file" : "python-i2c",
    python: mocked() ? "mock" : pythonBin(),
    script,
    scriptExists: existsSync(script),
    stickFile: stickFilePath(),
    channels: HEAD_CHANNELS,
    error: pca.present ? undefined : pca.error || MISSING_PCA,
  };
}

export async function applyHeadStick(stick: HeadStick, dtSec: number): Promise<{
  ok: boolean;
  deltas: HeadStick;
  error?: string;
}> {
  const deltas = stickToDeltas(stick, dtSec);
  const moving = Object.values(deltas).some((v) => v !== 0);
  if (!moving && !engaged) return { ok: true, deltas };

  if (trackingEnabled()) {
    return { ok: false, deltas, error: "Turn off tracking to drive the neck." };
  }

  writeStickFile(stick);
  if (mocked()) {
    engaged = moving;
    if (!moving) clearStickFile();
    return { ok: true, deltas };
  }
  const pca = probePca();
  if (!pca.present) {
    return { ok: false, deltas, error: pca.error || MISSING_PCA };
  }

  if (!engaged) {
    const start = await rpc({ cmd: "engage" });
    if (!start.ok) return { ok: false, deltas, error: start.stderr || start.stdout || "Couldn't take the neck." };
    engaged = true;
  }

  const apply = await rpc({
    cmd: "apply",
    neck: deltas.neck,
    tilt: deltas.tilt,
    roll: deltas.roll,
  });
  if (!apply.ok) return { ok: false, deltas, error: apply.stderr || apply.stdout || "Head move failed." };
  return { ok: true, deltas };
}

export async function releaseHead(): Promise<{ ok: boolean; error?: string }> {
  // Lifting a stick must not hand the neck back to face/voice tracking —
  // that fight on I2C is what wedged the Pi.
  clearStickFile();
  engaged = false;
  return { ok: true };
}
