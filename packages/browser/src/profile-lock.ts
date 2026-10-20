import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function isProfileLockError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${err.cause ?? ""}` : String(err);
  return /ProcessSingleton|SingletonLock|profile is already in use|profile directory/i.test(msg);
}

/** PIDs whose command line includes this Playwright user-data-dir. */
export function pidsFromPsOutput(stdout: string, userDataDir: string): number[] {
  if (!userDataDir) return [];
  const pids: number[] = [];
  const seen = new Set<number>();
  for (const line of stdout.split("\n")) {
    if (!line.includes(userDataDir)) continue;
    if (!/chrome|brave|chromium/i.test(line)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid || seen.has(pid)) continue;
    seen.add(pid);
    pids.push(pid);
  }
  return pids;
}

export async function pidsUsingBrowserProfile(userDataDir: string): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-ax", "-o", "pid=", "-o", "command="], {
      encoding: "utf8",
      timeout: 2_000,
    });
    return pidsFromPsOutput(stdout, userDataDir);
  } catch {
    return [];
  }
}

export async function killBrowserProfileLocks(userDataDir: string): Promise<number[]> {
  const pids = await pidsUsingBrowserProfile(userDataDir);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  if (pids.length) await new Promise((resolve) => setTimeout(resolve, 300));
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  return pids;
}
