import type { ElgatoAccessoryInfo, ElgatoLightState, ElgatoLightsResponse } from "./types.js";
import { ELGATO_DEFAULT_PORT } from "./types.js";

const FETCH_MS = 2_500;

export function lightBaseUrl(host: string, port = ELGATO_DEFAULT_PORT): string {
  return `http://${host}:${port}/elgato`;
}

async function elgatoFetch(
  url: string,
  init: RequestInit | undefined,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function getAccessoryInfo(
  host: string,
  port = ELGATO_DEFAULT_PORT,
  fetchImpl: typeof fetch = fetch,
): Promise<ElgatoAccessoryInfo> {
  const res = await elgatoFetch(`${lightBaseUrl(host, port)}/accessory-info`, undefined, fetchImpl);
  if (!res.ok) throw new Error(`accessory-info ${res.status} from ${host}`);
  return (await res.json()) as ElgatoAccessoryInfo;
}

export async function getLights(
  host: string,
  port = ELGATO_DEFAULT_PORT,
  fetchImpl: typeof fetch = fetch,
): Promise<ElgatoLightsResponse> {
  const res = await elgatoFetch(`${lightBaseUrl(host, port)}/lights`, undefined, fetchImpl);
  if (!res.ok) throw new Error(`GET lights ${res.status} from ${host}`);
  return (await res.json()) as ElgatoLightsResponse;
}

export async function putLights(
  host: string,
  port: number,
  patch: Partial<ElgatoLightState>,
  fetchImpl: typeof fetch = fetch,
): Promise<ElgatoLightsResponse> {
  const body = {
    numberOfLights: 1,
    lights: [patch],
  };
  const res = await elgatoFetch(
    `${lightBaseUrl(host, port)}/lights`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    fetchImpl,
  );
  if (!res.ok) throw new Error(`PUT lights ${res.status} from ${host}`);
  return (await res.json()) as ElgatoLightsResponse;
}
