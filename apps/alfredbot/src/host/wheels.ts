/**
 * MDDS30 tank drive — same two-byte serial protocol as alfred-home
 * `robot-client/sensors/alfred_cli.py` `cmd_wheel`.
 *
 * Left motor 0x00, right 0x80, bit 6 = reverse, bits 0–5 = speed 0–63.
 * Old SSH buttons used levels 1/2/3 → speeds 8/20/40. Analog sticks map
 * 0…1 onto that same 0…40 range so full throw is "as fast as it can"
 * in the sense they already used.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WHEEL_DEADZONE = 0.08;
export const WHEEL_SPEEDS = { 1: 8, 2: 20, 3: 40 } as const;
export const WHEEL_MAX_SPEED = WHEEL_SPEEDS[3];
const LEFT_SIDE = 0x00;
const RIGHT_SIDE = 0x80;
const BACK_BIT = 0x40;
const WATCHDOG_MS = 400;

export type WheelStick = { left: number; right: number };
export type WheelBytes = { left: number; right: number };

export function clampStick(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
}

function maxSpeed(): number {
  const raw = Number(process.env.ALFRED_WHEEL_SPEED_MAX ?? WHEEL_MAX_SPEED);
  if (!Number.isFinite(raw)) return WHEEL_MAX_SPEED;
  return Math.max(1, Math.min(63, Math.round(raw)));
}

export function motorByte(side: typeof LEFT_SIDE | typeof RIGHT_SIDE, value: number, cap = maxSpeed()): number {
  const n = clampStick(value);
  if (Math.abs(n) < WHEEL_DEADZONE) return side;
  const speed = Math.max(1, Math.min(63, Math.round(Math.abs(n) * cap)));
  const dir = n < 0 ? BACK_BIT : 0;
  return side | dir | (speed & 0x3f);
}

/** +1 = that motor forward. left up + right down = spin right (old SSH). */
export function stickToWheelBytes(stick: WheelStick, cap = maxSpeed()): WheelBytes {
  return {
    left: motorByte(LEFT_SIDE, stick.left, cap),
    right: motorByte(RIGHT_SIDE, stick.right, cap),
  };
}

export function stopBytes(): WheelBytes {
  return { left: LEFT_SIDE, right: RIGHT_SIDE };
}

function mocked(): boolean {
  if (process.env.ALFREDBOT_WHEELS_MOCK === "1") return true;
  if (process.env.ALFREDBOT_WHEELS_MOCK === "0") return false;
  return process.platform === "darwin";
}

function pythonBin(): string {
  const override = process.env.ALFREDBOT_PYTHON;
  if (override) return override;
  const candidates = ["/home/alfred/alfred_env/bin/python", "/home/alfred/alfred_env/bin/python3"];
  return candidates.find((p) => existsSync(p)) ?? "python3";
}

function scriptPath(): string {
  const override = process.env.ALFREDBOT_WHEELS_STICK;
  if (override) return resolve(override);
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "deploy/wheels-stick.py"),
    resolve(process.cwd(), "deploy/wheels-stick.py"),
    resolve(here, "../../deploy/wheels-stick.py"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

type RpcResult = { ok: boolean; stdout: string; stderr: string };

let last: WheelBytes = stopBytes();
let moving = false;
let child: ChildProcess | null = null;
let stdoutBuf = "";
let stderrBuf = "";
let waiter: ((result: RpcResult) => void) | null = null;
let chain: Promise<unknown> = Promise.resolve();
let watchdog: ReturnType<typeof setTimeout> | null = null;

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
    return { ok: false, stdout: line, stderr: stderrBuf || "Wheel helper sent junk." };
  }
}

function ensureChild(): RpcResult | ChildProcess {
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
        stderr: code === 0 ? "" : stderrBuf || "Wheel helper closed.",
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
          resolvePromise({ ok: false, stdout: "", stderr: "Wheel helper has no stdin." });
          return;
        }
        const timer = setTimeout(() => {
          if (waiter !== finish) return;
          waiter = null;
          resolvePromise({ ok: false, stdout: stdoutBuf, stderr: stderrBuf || "Wheel helper timed out." });
        }, 1500);
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

function armWatchdog() {
  if (watchdog) clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    watchdog = null;
    if (moving) void releaseWheels();
  }, WATCHDOG_MS);
}

export function wheelStatus(): {
  mocked: boolean;
  moving: boolean;
  last: WheelBytes;
  python: string;
  script: string;
  scriptExists: boolean;
} {
  const script = scriptPath();
  return {
    mocked: mocked(),
    moving,
    last,
    python: mocked() ? "mock" : pythonBin(),
    script,
    scriptExists: existsSync(script),
  };
}

export async function applyWheelStick(stick: WheelStick): Promise<{
  ok: boolean;
  bytes: WheelBytes;
  error?: string;
}> {
  const bytes = stickToWheelBytes({ left: clampStick(stick.left), right: clampStick(stick.right) });
  const idle = bytes.left === LEFT_SIDE && bytes.right === RIGHT_SIDE;
  if (idle) return releaseWheels();

  last = bytes;
  moving = true;
  armWatchdog();
  const wrote = await rpc({ cmd: "write", left: bytes.left, right: bytes.right });
  if (!wrote.ok) return { ok: false, bytes, error: wrote.stderr || wrote.stdout || "Wheel write failed." };
  return { ok: true, bytes };
}

export async function releaseWheels(): Promise<{ ok: boolean; bytes: WheelBytes; error?: string }> {
  if (watchdog) {
    clearTimeout(watchdog);
    watchdog = null;
  }
  last = stopBytes();
  moving = false;
  const wrote = await rpc({ cmd: "write", left: last.left, right: last.right });
  if (!wrote.ok) return { ok: false, bytes: last, error: wrote.stderr || wrote.stdout || "Wheel stop failed." };
  return { ok: true, bytes: last };
}
