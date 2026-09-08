/**
 * Side-effect entry: polyfill + register LiveKit RN globals before any
 * `livekit-client` import in the app. Import this from index.ts first.
 */
try {
  const g = globalThis as typeof globalThis & { DOMException?: unknown };
  if (typeof g.DOMException === "undefined") {
    class PolyfillDOMException extends Error {
      code: number;
      constructor(message = "", name = "Error") {
        super(message);
        this.name = name;
        this.code = 0;
      }
    }
    g.DOMException = PolyfillDOMException as unknown as typeof DOMException;
    (global as typeof globalThis & { DOMException?: unknown }).DOMException =
      PolyfillDOMException as unknown as typeof DOMException;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const livekitRn = require("@livekit/react-native") as {
    registerGlobals?: () => void;
  };
  livekitRn.registerGlobals?.();
} catch {
  // Missing natives — Talk falls back to text via isLiveKitAvailable().
}
