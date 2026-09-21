/**
 * Arm wave — the Pi opens BLE to the LewanSoul bus (`arm_wave.py` / bleak).
 * The phone only POSTs here; it never pairs with the arm.
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { trackingEnabled } from "./head.js";

const PAUSE_PATH = process.env.ALFRED_TRACK_PAUSE_PATH ?? "/tmp/alfred-tracker-pause.json";
const FOREVER_S = 10 * 365 * 24 * 3600;
const WAVE_MS = 25_000;
const LIVE_SCRIPT = "/home/alfred/arm_wave.py";

let waving = false;

function mocked(): boolean {
  if (process.env.ALFREDBOT_ARM_MOCK === "1") return true;
  if (process.env.ALFREDBOT_ARM_MOCK === "0") return false;
  return process.platform === "darwin";
}

function pythonBin(): string {
  const override = process.env.ALFREDBOT_PYTHON;
  if (override) return override;
  // The live script uses system python3 (bleak), same as `alfred armWave`.
  return "python3";
}

export function armWaveScript(): string {
  const override = process.env.ALFRED_ARM_WAVE_SCRIPT;
  if (override) return resolve(override);
  if (existsSync(LIVE_SCRIPT)) return LIVE_SCRIPT;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "deploy/arm-wave.py"),
    resolve(process.cwd(), "deploy/arm-wave.py"),
    resolve(here, "../../deploy/arm-wave.py"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

function writePause(untilTs: number, reason: string) {
  writeFileSync(PAUSE_PATH, JSON.stringify({ until_ts: untilTs, reason }));
}

function restorePause() {
  if (trackingEnabled()) writePause(0, "post-arm-wave");
  else writePause(Date.now() / 1000 + FOREVER_S, "trackingOff");
}

export function armStatus(): { mocked: boolean; waving: boolean; script: string; scriptExists: boolean } {
  const script = armWaveScript();
  return { mocked: mocked(), waving, script, scriptExists: existsSync(script) };
}

export async function runArmWave(): Promise<{ ok: boolean; error?: string }> {
  if (waving) return { ok: false, error: "He's already waving." };
  const script = armWaveScript();
  if (mocked()) {
    console.log(`[arm] mock wave script=${script}`);
    return { ok: true };
  }
  if (!existsSync(script)) {
    return { ok: false, error: `Arm wave script missing (${script}).` };
  }

  waving = true;
  writePause(Date.now() / 1000 + 20, "ios:armWave");
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(pythonBin(), [script], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        if (!child.killed) child.kill("SIGTERM");
        reject(new Error("The wave timed out before the arm finished."));
      }, WAVE_MS);
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.stdout?.on("data", (chunk) => {
        const text = String(chunk);
        stdout += text;
        const line = text.trim();
        if (line) console.log(`[arm] ${line}`);
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const bleError = /(?:^|\n)Error:\s*(.+)/.exec(stdout)?.[1]?.trim();
        if (code === 0 && !bleError) {
          resolvePromise();
          return;
        }
        reject(
          new Error(
            bleError || stderr.trim() || `Arm wave exited ${code ?? "unknown"}.`,
          ),
        );
      });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    waving = false;
    restorePause();
  }
}
