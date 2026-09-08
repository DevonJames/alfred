import { controlStudioLights, inventorySpeech, parseStudioLightCommand } from "./control.js";
import { discoverElgatoLights, type DiscoverOpts } from "./discover.js";
import type { StudioLight, StudioLightCommand } from "./types.js";

export {
  browseElgatoDnsSd,
  DEFAULT_ELGATO_CACHE_PATH,
  discoverElgatoLights,
  hostnameFromInstanceName,
  hostsFromEnv,
  lightKey,
  lightLabel,
  mergeLights,
  parseDnsSdBrowse,
  parseDnsSdLookup,
} from "./discover.js";
export {
  clampBrightness,
  clampTemperature,
  controlStudioLights,
  describeTemperature,
  formatLightSpeech,
  inventorySpeech,
  kelvinToMireds,
  matchLights,
  miredsToKelvin,
  nextState,
  parseStudioLightCommand,
  parseTemperature,
} from "./control.js";
export { getAccessoryInfo, getLights, lightBaseUrl, putLights } from "./client.js";
export type { DiscoverOpts } from "./discover.js";
export type {
  ElgatoAccessoryInfo,
  ElgatoLightState,
  ElgatoLightsResponse,
  StudioLight,
  StudioLightAction,
  StudioLightCommand,
  StudioLightControlResult,
  StudioLightSnapshot,
} from "./types.js";

export interface ElgatoLightsController {
  control(command: StudioLightCommand): Promise<string>;
  inventorySpeech(): Promise<string>;
  refresh(): Promise<StudioLight[]>;
}

export function createElgatoLightsController(opts: DiscoverOpts = {}): ElgatoLightsController {
  let cached: StudioLight[] | null = null;
  let inflight: Promise<StudioLight[]> | null = null;

  async function lights(refresh = false): Promise<StudioLight[]> {
    if (cached?.length && !refresh) return cached;
    if (inflight && !refresh) return inflight;
    if (inflight && refresh) {
      try {
        await inflight;
      } catch {
        // ignore a failed in-flight browse, then search again
      }
    }
    inflight = discoverElgatoLights({ ...opts, knownLights: cached ?? opts.knownLights })
      .then((found) => {
        cached = found;
        return found;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return {
    async refresh() {
      cached = null;
      return lights(true);
    },
    async inventorySpeech() {
      if (!cached?.length) {
        void lights();
        return "";
      }
      return inventorySpeech(cached);
    },
    async control(command) {
      // Untargeted commands (Lights / all) must re-browse so a missed Key Light
      // from the first lookup is not cached forever.
      const found = await lights(!command.target);
      const result = await controlStudioLights(command, { ...opts, lights: found });
      if (!found.length) cached = null;
      return result.speech;
    },
  };
}

export async function applyStudioLightArgs(
  args: Record<string, unknown>,
  controller: ElgatoLightsController,
): Promise<string> {
  const parsed = parseStudioLightCommand(args);
  if (typeof parsed === "string") return parsed;
  return controller.control(parsed);
}
