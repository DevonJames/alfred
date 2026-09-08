export const ELGATO_DEFAULT_PORT = 9123;
export const ELGATO_MDNS_TYPE = "_elg._tcp.local";

/** Elgato mired range: 143 ≈ 7000K (cool), 344 ≈ 2900K (warm). */
export const TEMP_MIRED_COOL = 143;
export const TEMP_MIRED_WARM = 344;
export const TEMP_MIRED_NEUTRAL = 213;

export const BRIGHTNESS_MIN = 3;
export const BRIGHTNESS_MAX = 100;
export const BRIGHTNESS_STEP = 15;
export const TEMPERATURE_STEP = 40;

export type StudioLightAction =
  | "on"
  | "off"
  | "brighter"
  | "dimmer"
  | "warmer"
  | "cooler"
  | "set"
  | "status";

export interface ElgatoLightState {
  on: number;
  brightness: number;
  temperature: number;
}

export interface ElgatoLightsResponse {
  numberOfLights: number;
  lights: ElgatoLightState[];
}

export interface ElgatoAccessoryInfo {
  productName?: string;
  displayName?: string;
  serialNumber?: string;
  macAddress?: string;
  firmwareVersion?: string;
  features?: string[];
}

export interface StudioLight {
  id: string;
  name: string;
  productName: string;
  host: string;
  port: number;
  serialNumber?: string;
}

export interface StudioLightSnapshot extends StudioLight {
  state: ElgatoLightState;
}

export interface StudioLightCommand {
  action: StudioLightAction;
  /** Light name, model ("mini", "key light"), or "all". Defaults to all. */
  target?: string;
  /** Absolute brightness 0–100. */
  brightness?: number;
  /**
   * Absolute color: "warm" | "cool" | "neutral", Kelvin (2900–7000),
   * or Elgato mireds (143–344).
   */
  temperature?: string | number;
}

export interface StudioLightControlResult {
  speech: string;
  snapshots: StudioLightSnapshot[];
  failed: Array<{ light: StudioLight; error: string }>;
}
