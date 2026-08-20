/**
 * Load LiveKit packages that may fail at runtime on builds without native WebRTC.
 *
 * Literals are required so Metro includes the modules in the bundle. A dynamic
 * `require(name)` looks "missing" to Metro even when the packages are installed
 * (the "Requiring unknown module" lines in expo.log).
 *
 * On Expo Go the JS loads but native bindings are absent —
 * `require` or `registerGlobals` may throw; callers treat that as unavailable
 * and Talk falls back to typing.
 */

export function loadLiveKitClient<T>(): T | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("livekit-client") as T;
  } catch {
    return null;
  }
}

export function loadLiveKitNative<T>(): T | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@livekit/react-native") as T;
  } catch {
    return null;
  }
}
