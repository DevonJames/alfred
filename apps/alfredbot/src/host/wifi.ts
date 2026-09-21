import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WifiNetwork {
  ssid: string;
  signal: number;
  secure: boolean;
  active: boolean;
}

export interface WifiStatus {
  connected: boolean;
  ssid: string | null;
  online: boolean;
  mock: boolean;
  reason?: string;
}

function forceWifiUi(): boolean {
  return process.env.ALFREDBOT_FORCE_WIFI_UI === "1";
}

function skipWifi(): boolean {
  return process.env.ALFREDBOT_SKIP_WIFI === "1";
}

async function run(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { timeout: 12_000 });
  return stdout.toString();
}

let cachedStatus: { at: number; status: WifiStatus } | undefined;

async function linuxStatus(): Promise<WifiStatus> {
  try {
    // `general` reads cached state. `networking connectivity` can block on a
    // captive-portal check and freeze the kiosk on a grey first paint.
    const general = (await run("nmcli", ["-t", "-g", "STATE,CONNECTIVITY", "general"])).trim();
    const [state, connectivity] = general.split(/[:\n]/);
    const online = connectivity === "full" || connectivity === "limited";
    const connected = online || state === "connected";
    let ssid: string | null = null;
    try {
      const active = await run("nmcli", ["-t", "-f", "ACTIVE,SSID", "device", "wifi"]);
      for (const line of active.split("\n")) {
        const [isActive, name] = line.split(":");
        if (isActive === "yes" && name) {
          ssid = name;
          break;
        }
      }
    } catch {
      ssid = null;
    }
    return { connected: connected || Boolean(ssid), ssid, online, mock: false };
  } catch (err) {
    return {
      connected: true,
      ssid: cachedStatus?.status.ssid ?? null,
      online: true,
      mock: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function darwinStatus(): Promise<WifiStatus> {
  if (forceWifiUi()) {
    return { connected: false, ssid: null, online: false, mock: true };
  }
  // Local Mac development: assume the machine is already on a network.
  return { connected: true, ssid: "dev", online: true, mock: true };
}

export async function wifiStatus(): Promise<WifiStatus> {
  if (skipWifi() && !forceWifiUi()) {
    return { connected: true, ssid: "skipped", online: true, mock: true };
  }
  if (cachedStatus && Date.now() - cachedStatus.at < 4_000) return cachedStatus.status;
  const status = process.platform === "linux" ? await linuxStatus() : await darwinStatus();
  cachedStatus = { at: Date.now(), status };
  return status;
}

export async function wifiScan(): Promise<WifiNetwork[]> {
  if (forceWifiUi() || process.platform !== "linux") {
    return [
      { ssid: "Alfred-Lab", signal: 88, secure: true, active: false },
      { ssid: "Cafe-Guest", signal: 54, secure: true, active: false },
      { ssid: "Open-Workshop", signal: 31, secure: false, active: false },
    ];
  }
  const raw = await run("nmcli", ["-t", "-f", "ACTIVE,SSID,SIGNAL,SECURITY", "device", "wifi", "list"]);
  const seen = new Set<string>();
  const networks: WifiNetwork[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [active, ssid, signal, security] = line.split(":");
    if (!ssid || seen.has(ssid)) continue;
    seen.add(ssid);
    networks.push({
      ssid,
      signal: Number.parseInt(signal ?? "0", 10) || 0,
      secure: Boolean(security && security !== ""),
      active: active === "yes",
    });
  }
  return networks.sort((a, b) => b.signal - a.signal);
}

export async function wifiJoin(ssid: string, password: string): Promise<WifiStatus> {
  const name = ssid.trim();
  if (!name) throw new Error("Network name is required.");
  if (forceWifiUi() || process.platform !== "linux") {
    if (password && password.length < 8) {
      throw new Error("Password looks too short.");
    }
    return { connected: true, ssid: name, online: true, mock: true };
  }
  const args = ["device", "wifi", "connect", name];
  if (password) args.push("password", password);
  await run("nmcli", args);
  return linuxStatus();
}

export function needsWifiSetup(status: WifiStatus): boolean {
  if (skipWifi() && !forceWifiUi()) return false;
  return !status.connected;
}
