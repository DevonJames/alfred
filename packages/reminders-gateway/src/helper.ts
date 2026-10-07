import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { remindersHelperRoot } from "./paths.js";
import type { DiscoveredList } from "./policy.js";

export interface AppleReminder {
  id: string;
  title: string;
  notes?: string | null;
  due?: string | null;
  listId: string;
  listTitle: string;
  completed: boolean;
}

interface HelperFailure {
  ok?: boolean;
  error?: string;
  message?: string;
}

export class RemindersHelperError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "RemindersHelperError";
  }
}

function helperBinary(): string {
  return path.join(remindersHelperRoot(), "Contents", "MacOS", "reminders-helper");
}

function launcherBinary(): string {
  return path.join(remindersHelperRoot(), "..", "reminders-launch");
}

async function ensureHelperBinary(): Promise<string> {
  const binary = helperBinary();
  try {
    await access(binary);
    return binary;
  } catch {
    /* compile */
  }
  if (process.platform !== "darwin") {
    throw new RemindersHelperError(
      "Reminders access runs on the Mac that owns the lists.",
      "unsupported_platform",
    );
  }
  const source = path.join(remindersHelperRoot(), "..", "main.swift");
  const app = remindersHelperRoot();
  await mkdir(path.dirname(binary), { recursive: true });
  await runProcess("swiftc", [
    "-O",
    "-framework",
    "EventKit",
    "-framework",
    "AppKit",
    "-o",
    binary,
    source,
  ]);
  await runProcess("codesign", ["-s", "-", "--force", "--deep", app]);
  return binary;
}

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new RemindersHelperError(stderr.trim() || `${command} failed`, "helper_build"));
    });
  });
}

async function ensureLauncher(): Promise<string> {
  const binary = launcherBinary();
  try {
    await access(binary);
    return binary;
  } catch {
    /* compile */
  }
  const source = path.join(remindersHelperRoot(), "..", "spawn-disclaim.c");
  await runProcess("clang", ["-O2", "-o", binary, source]);
  return binary;
}

async function callHelper(body: Record<string, unknown>, timeoutMs = 120_000): Promise<unknown> {
  const binary = await ensureHelperBinary();
  const launcher = await ensureLauncher();
  return new Promise((resolve, reject) => {
    const child = spawn(launcher, [binary], { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new RemindersHelperError(
          "Reminders helper timed out. If macOS asked for Reminders access, allow Alfred Reminders and try again.",
          "timeout",
        ),
      );
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const line = stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
      if (!line) {
        reject(new RemindersHelperError(stderr.trim() || "Reminders helper returned no result.", "empty"));
        return;
      }
      try {
        const payload = JSON.parse(line) as HelperFailure;
        if (payload.ok === false) {
          reject(
            new RemindersHelperError(payload.message || "Reminders helper failed.", payload.error || "helper"),
          );
          return;
        }
        resolve(payload);
      } catch {
        reject(new RemindersHelperError(stderr.trim() || line, "bad_json"));
      }
    });
    child.stdin.end(JSON.stringify(body));
  });
}

export interface RemindersGateway {
  lists(): Promise<DiscoveredList[]>;
  items(): Promise<AppleReminder[]>;
  create(input: { listId: string; title: string; notes?: string; due?: string | null }): Promise<AppleReminder>;
  setDue(reminderId: string, due: string | null): Promise<AppleReminder>;
  complete(reminderId: string): Promise<AppleReminder>;
}

export function createRemindersGateway(policyPath: string): RemindersGateway {
  const policy = { policyPath };
  return {
    async lists() {
      const payload = (await callHelper({ op: "lists" })) as { lists?: DiscoveredList[] };
      return (payload.lists ?? []).map((list) => ({
        ...list,
        color: list.color ?? null,
        writable: Boolean(list.writable),
      }));
    },
    async items() {
      const payload = (await callHelper({ op: "items", ...policy })) as { reminders?: AppleReminder[] };
      return payload.reminders ?? [];
    },
    async create(input) {
      const payload = (await callHelper({ op: "create", ...input, due: input.due ?? undefined, ...policy })) as {
        reminder?: AppleReminder;
      };
      if (!payload.reminder) throw new RemindersHelperError("Reminders helper returned no reminder.", "empty");
      return payload.reminder;
    },
    async setDue(reminderId, due) {
      const payload = (await callHelper({ op: "due", reminderId, due: due ?? "", ...policy })) as {
        reminder?: AppleReminder;
      };
      if (!payload.reminder) throw new RemindersHelperError("Reminders helper returned no reminder.", "empty");
      return payload.reminder;
    },
    async complete(reminderId) {
      const payload = (await callHelper({ op: "complete", reminderId, ...policy })) as {
        reminder?: AppleReminder;
      };
      if (!payload.reminder) throw new RemindersHelperError("Reminders helper returned no reminder.", "empty");
      return payload.reminder;
    },
  };
}
