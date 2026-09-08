import { getLights, putLights } from "./client.js";
import { discoverElgatoLights, type DiscoverOpts } from "./discover.js";
import {
  BRIGHTNESS_MAX,
  BRIGHTNESS_MIN,
  BRIGHTNESS_STEP,
  TEMP_MIRED_COOL,
  TEMP_MIRED_NEUTRAL,
  TEMP_MIRED_WARM,
  TEMPERATURE_STEP,
  type ElgatoLightState,
  type StudioLight,
  type StudioLightAction,
  type StudioLightCommand,
  type StudioLightControlResult,
  type StudioLightSnapshot,
} from "./types.js";

const ACTIONS = new Set<StudioLightAction>([
  "on",
  "off",
  "brighter",
  "dimmer",
  "warmer",
  "cooler",
  "set",
  "status",
]);

export function clampBrightness(value: number): number {
  return Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, Math.round(value)));
}

export function clampTemperature(mireds: number): number {
  return Math.min(TEMP_MIRED_WARM, Math.max(TEMP_MIRED_COOL, Math.round(mireds)));
}

export function kelvinToMireds(kelvin: number): number {
  return clampTemperature(1_000_000 / kelvin);
}

export function miredsToKelvin(mireds: number): number {
  return Math.round(1_000_000 / mireds);
}

export function parseTemperature(value: string | number | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 143 && value <= 344) return clampTemperature(value);
    if (value >= 2700 && value <= 7500) return kelvinToMireds(value);
    return undefined;
  }
  const raw = String(value).trim().toLowerCase();
  if (raw === "warm" || raw === "warmer") return TEMP_MIRED_WARM;
  if (raw === "cool" || raw === "cooler" || raw === "cold" || raw === "white") return TEMP_MIRED_COOL;
  if (raw === "neutral" || raw === "daylight") return TEMP_MIRED_NEUTRAL;
  const numeric = Number(raw.replace(/k$/i, ""));
  if (Number.isFinite(numeric)) return parseTemperature(numeric);
  return undefined;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function matchLights(lights: StudioLight[], target?: string): StudioLight[] {
  const query = target?.trim() ? normalize(target) : "";
  if (
    !query ||
    query === "all" ||
    query === "all of them" ||
    query === "everything" ||
    query === "studio" ||
    query === "desk" ||
    query === "lights" ||
    query === "the lights"
  ) {
    return lights;
  }

  const scored = lights
    .map((light) => {
      const name = normalize(light.name);
      const product = normalize(light.productName);
      const serial = normalize(light.serialNumber ?? "");
      let score = 0;
      if (name === query) score = 100;
      else if (name.startsWith(query) || query.startsWith(name)) score = 80;
      else if (name.includes(query) || query.includes(name)) score = 60;
      else if (product.includes(query) || query.includes(product)) score = 40;
      else if (serial && (serial.includes(query) || query.includes(serial))) score = 30;
      else if (query.includes("mini") && product.includes("mini")) score = 50;
      else if (
        (query.includes("key light") || query === "key") &&
        product.includes("key light") &&
        !product.includes("mini")
      ) {
        score = 45;
      }
      return { light, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return [];

  const best = scored[0]!.score;
  // Room-level match: "living room" should hit both living room 1 and 2.
  if (best >= 60) return scored.filter((row) => row.score >= 60).map((row) => row.light);
  return scored.filter((row) => row.score === best).map((row) => row.light);
}

export function nextState(
  current: ElgatoLightState,
  command: StudioLightCommand,
): Partial<ElgatoLightState> | null {
  const brightnessAbs =
    typeof command.brightness === "number" && Number.isFinite(command.brightness)
      ? clampBrightness(command.brightness)
      : undefined;
  const temperatureAbs = parseTemperature(command.temperature);

  switch (command.action) {
    case "status":
      return null;
    case "on":
      return {
        on: 1,
        ...(brightnessAbs != null ? { brightness: brightnessAbs } : {}),
        ...(temperatureAbs != null ? { temperature: temperatureAbs } : {}),
      };
    case "off":
      return { on: 0 };
    case "brighter":
      return {
        on: 1,
        brightness: clampBrightness((current.brightness || BRIGHTNESS_MIN) + BRIGHTNESS_STEP),
      };
    case "dimmer":
      return {
        on: 1,
        brightness: clampBrightness((current.brightness || BRIGHTNESS_MIN) - BRIGHTNESS_STEP),
      };
    case "warmer":
      return {
        on: 1,
        temperature: clampTemperature((current.temperature || TEMP_MIRED_NEUTRAL) + TEMPERATURE_STEP),
      };
    case "cooler":
      return {
        on: 1,
        temperature: clampTemperature((current.temperature || TEMP_MIRED_NEUTRAL) - TEMPERATURE_STEP),
      };
    case "set":
      return {
        on: 1,
        ...(brightnessAbs != null ? { brightness: brightnessAbs } : {}),
        ...(temperatureAbs != null ? { temperature: temperatureAbs } : {}),
      };
    default:
      return null;
  }
}

export function describeTemperature(mireds: number): string {
  if (mireds >= 300) return "warm";
  if (mireds <= 180) return "cool";
  return "neutral";
}

export function formatLightSpeech(snapshots: StudioLightSnapshot[]): string {
  if (!snapshots.length) return "I couldn't find any matching lights.";
  const sameOn = snapshots.every((s) => s.state.on === snapshots[0]!.state.on);
  const sameBright = snapshots.every((s) => s.state.brightness === snapshots[0]!.state.brightness);
  const sameTemp = snapshots.every((s) => s.state.temperature === snapshots[0]!.state.temperature);
  if (snapshots.length > 1 && sameOn && sameBright && sameTemp) {
    const first = snapshots[0]!.state;
    if (!first.on) return `${labelForCount(snapshots.length)} are off.`;
    return `${labelForCount(snapshots.length)} are on at ${first.brightness} percent, ${describeTemperature(first.temperature)}.`;
  }
  return snapshots
    .map((snap) => {
      if (!snap.state.on) return `${snap.name} is off.`;
      return `${snap.name} is on at ${snap.state.brightness} percent, ${describeTemperature(snap.state.temperature)}.`;
    })
    .join(" ");
}

function labelForCount(count: number): string {
  if (count === 1) return "The light";
  if (count === 2) return "Both lights";
  return "The lights";
}

export function parseStudioLightCommand(args: Record<string, unknown>): StudioLightCommand | string {
  const actionRaw = String(args.action ?? "").trim().toLowerCase();
  const action = actionRaw as StudioLightAction;
  if (!ACTIONS.has(action)) {
    return "I wasn't sure what to do with the lights.";
  }
  const target = typeof args.target === "string" && args.target.trim() ? args.target.trim() : undefined;
  const brightnessRaw = args.brightness;
  const brightness =
    typeof brightnessRaw === "number" && Number.isFinite(brightnessRaw)
      ? brightnessRaw
      : typeof brightnessRaw === "string" && brightnessRaw.trim() && Number.isFinite(Number(brightnessRaw))
        ? Number(brightnessRaw)
        : undefined;
  const temperature =
    typeof args.temperature === "number" || typeof args.temperature === "string"
      ? args.temperature
      : undefined;
  return { action, target, brightness, temperature };
}

export interface ControlStudioLightsOpts extends DiscoverOpts {
  lights?: StudioLight[];
}

export async function controlStudioLights(
  command: StudioLightCommand,
  opts: ControlStudioLightsOpts = {},
): Promise<StudioLightControlResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const inventory = opts.lights ?? (await discoverElgatoLights(opts));
  if (!inventory.length) {
    return {
      speech:
        "I couldn't find any Elgato lights on the network. Make sure they're on Wi-Fi, or set ELGATO_LIGHT_HOSTS.",
      snapshots: [],
      failed: [],
    };
  }

  const matched = matchLights(inventory, command.target);
  if (!matched.length) {
    const names = inventory.map((light) => light.name).join(", ");
    return {
      speech: `I don't have a light called ${command.target}. I can see ${names}.`,
      snapshots: [],
      failed: [],
    };
  }

  const snapshots: StudioLightSnapshot[] = [];
  const failed: StudioLightControlResult["failed"] = [];

  await Promise.all(
    matched.map(async (light) => {
      try {
        const current = await getLights(light.host, light.port, fetchImpl);
        const state = current.lights[0];
        if (!state) throw new Error("no light state");
        const patch = nextState(state, command);
        if (!patch || command.action === "status") {
          snapshots.push({ ...light, state });
          return;
        }
        const updated = await putLights(light.host, light.port, patch, fetchImpl);
        snapshots.push({ ...light, state: updated.lights[0] ?? { ...state, ...patch } });
      } catch (err) {
        failed.push({
          light,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  snapshots.sort((a, b) => a.name.localeCompare(b.name));
  let speech = formatLightSpeech(snapshots);
  if (failed.length && snapshots.length) {
    speech += ` I couldn't reach ${failed.map((row) => row.light.name).join(" and ")}.`;
  } else if (failed.length) {
    speech = `I couldn't reach ${failed.map((row) => row.light.name).join(" and ")}.`;
  }
  return { speech, snapshots, failed };
}

export function inventorySpeech(lights: StudioLight[]): string {
  if (!lights.length) return "";
  const listed = lights
    .map((light) =>
      light.name.toLowerCase() === light.productName.toLowerCase()
        ? light.name
        : `${light.name} (${light.productName})`,
    )
    .join(", ");
  return `Studio Elgato lights: ${listed}. Use control_studio_lights; default target is all of them.`;
}
