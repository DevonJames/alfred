import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { calendarHelperRoot } from "./paths.js";
import type { DiscoveredCalendar } from "./policy.js";

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  calendarId: string;
  calendarTitle: string;
  sourceTitle: string;
  location?: string | null;
}

interface HelperFailure {
  ok?: boolean;
  error?: string;
  message?: string;
}

export class CalendarHelperError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "CalendarHelperError";
  }
}

function helperBinary(): string {
  return path.join(calendarHelperRoot(), "Contents", "MacOS", "calendar-helper");
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
    throw new CalendarHelperError(
      "Calendar access runs on the Mac that owns the calendars.",
      "unsupported_platform",
    );
  }
  const source = path.join(calendarHelperRoot(), "..", "main.swift");
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
  await runProcess("codesign", ["-s", "-", "--force", binary]);
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
      else reject(new CalendarHelperError(stderr.trim() || `${command} failed`, "helper_build"));
    });
  });
}

async function callHelper(body: Record<string, unknown>, timeoutMs = 120_000): Promise<unknown> {
  const binary = await ensureHelperBinary();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new CalendarHelperError(
          "Calendar helper timed out. If macOS asked for Calendar access, allow Alfred Calendar and try again.",
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
        reject(new CalendarHelperError(stderr.trim() || "Calendar helper returned no result.", "empty"));
        return;
      }
      try {
        const payload = JSON.parse(line) as HelperFailure;
        if (payload.ok === false) {
          reject(
            new CalendarHelperError(
              payload.message || "Calendar helper failed.",
              payload.error || "helper",
            ),
          );
          return;
        }
        resolve(payload);
      } catch {
        reject(new CalendarHelperError(stderr.trim() || line, "bad_json"));
      }
    });
    child.stdin.end(JSON.stringify(body));
  });
}

export interface CalendarGateway {
  catalog(): Promise<DiscoveredCalendar[]>;
  events(input: { start: string; end: string; calendarId?: string }): Promise<CalendarEvent[]>;
  create(input: {
    calendarId: string;
    title: string;
    start: string;
    end: string;
    notes?: string;
    location?: string;
  }): Promise<CalendarEvent>;
  update(input: { eventId: string; title?: string; start: string; end: string; calendarId?: string }): Promise<CalendarEvent>;
  delete(eventId: string): Promise<void>;
}

export function createEventKitGateway(policyPath: string): CalendarGateway {
  const policy = { policyPath };
  return {
    async catalog() {
      const payload = (await callHelper({ op: "catalog" })) as { calendars?: DiscoveredCalendar[] };
      return (payload.calendars ?? []).map((calendar) => ({
        ...calendar,
        color: calendar.color ?? null,
        writable: Boolean(calendar.writable),
      }));
    },
    async events(input) {
      const payload = (await callHelper({ op: "events", ...input, ...policy })) as {
        events?: CalendarEvent[];
      };
      return payload.events ?? [];
    },
    async create(input) {
      const payload = (await callHelper({ op: "create", ...input, ...policy })) as {
        event: CalendarEvent;
      };
      return payload.event;
    },
    async update(input) {
      const payload = (await callHelper({ op: "update", ...input, ...policy })) as {
        event: CalendarEvent;
      };
      return payload.event;
    },
    async delete(eventId) {
      await callHelper({ op: "delete", eventId, ...policy });
    },
  };
}
