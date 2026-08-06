#!/usr/bin/env node
import { runAllScenarios, type ScenarioResult } from "./scenarios.js";

function formatResult(r: ScenarioResult): string {
  const mark = r.passed ? "PASS" : "FAIL";
  return `[${mark}] ${r.id} ${r.name} — ${r.detail}`;
}

async function main(): Promise<void> {
  console.log("ALFRED Conversation Core — M1 text-only simulator\n");
  const results = await runAllScenarios();
  for (const r of results) {
    console.log(formatResult(r));
  }
  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
