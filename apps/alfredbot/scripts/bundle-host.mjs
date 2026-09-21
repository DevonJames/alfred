import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const require = createRequire(import.meta.url);

let esbuildBin;
try {
  esbuildBin = require.resolve("esbuild/bin/esbuild");
} catch {
  esbuildBin = resolve(
    appRoot,
    "../../node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/bin/esbuild",
  );
}

const result = spawnSync(
  esbuildBin,
  [
    resolve(appRoot, "src/host/main.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--outfile=" + resolve(appRoot, "dist/host.mjs"),
    "--legal-comments=none",
  ],
  { stdio: "inherit" },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
