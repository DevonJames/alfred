import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { emptyPolicy, type ReminderPolicy } from "./policy.js";

export async function loadReminderPolicy(filePath: string): Promise<ReminderPolicy> {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as ReminderPolicy;
    if (raw?.version !== 1 || !raw.lists || typeof raw.lists !== "object") return emptyPolicy();
    return raw;
  } catch {
    return emptyPolicy();
  }
}

export async function saveReminderPolicy(filePath: string, policy: ReminderPolicy): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
}
