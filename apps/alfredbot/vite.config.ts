import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  publicDir: "public",
  build: {
    outDir: "dist-ui",
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:3200",
    },
  },
  resolve: {
    alias: {
      "@alfred/contracts": resolve(import.meta.dirname, "../../packages/contracts/src/index.ts"),
    },
  },
});
