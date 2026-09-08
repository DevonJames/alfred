/**
 * Load LiveKit packages that may fail at runtime on builds without native WebRTC.
 *
 * Order matters on React Native / Hermes:
 * 1. Polyfill `DOMException` (livekit-client reads it at module eval time)
 * 2. Require `@livekit/react-native` (applies more polyfills + registerGlobals)
 * 3. Only then require `livekit-client`
 *
 * Loading `livekit-client` first throws: Property 'DOMException' doesn't exist.
 */

function ensureDomException(): void {
  const g = globalThis as typeof globalThis & { DOMException?: unknown };
  if (typeof g.DOMException !== "undefined") return;

  class PolyfillDOMException extends Error {
    code: number;
    constructor(message = "", name = "Error") {
      super(message);
      this.name = name;
      this.code = 0;
    }
  }

  g.DOMException = PolyfillDOMException as unknown as typeof DOMException;
  // Hermes also resolves bare globals from `global`.
  (global as typeof globalThis & { DOMException?: unknown }).DOMException =
    PolyfillDOMException as unknown as typeof DOMException;
}

export function loadLiveKitNative<T>(): T | null {
  try {
    ensureDomException();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@livekit/react-native") as T;
  } catch {
    return null;
  }
}

export function loadLiveKitClient<T>(): T | null {
  try {
    ensureDomException();
    // Ensure RN polyfills run before livekit-client evaluates.
    loadLiveKitNative();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("livekit-client") as T;
  } catch {
    return null;
  }
}
