import path from "node:path";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      "@alfred/contracts": path.join(root, "packages/contracts/src/index.ts"),
      "@alfred/core": path.join(root, "packages/core/src/index.ts"),
      "@alfred/persistence": path.join(root, "packages/persistence/src/index.ts"),
      "@alfred/providers": path.join(root, "packages/providers/src/index.ts"),
      "@alfred/memory": path.join(root, "packages/memory/src/index.ts"),
      "@alfred/agents": path.join(root, "packages/agents/src/index.ts"),
      "@alfred/provider-deepgram": path.join(root, "packages/provider-deepgram/src/index.ts"),
      "@alfred/provider-openai": path.join(root, "packages/provider-openai/src/index.ts"),
      "@alfred/provider-elevenlabs": path.join(root, "packages/provider-elevenlabs/src/index.ts"),
      "@alfred/livekit": path.join(root, "packages/livekit/src/index.ts"),
    },
  },
  test: {
    globals: false,
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    clearMocks: true,
  },
});
