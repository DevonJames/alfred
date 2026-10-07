import type {
  AgentDelegationRequest,
  AgentDelegationResult,
  AgentHarness,
  AgentHarnessManifest,
  TaskCategory,
} from "@alfred/contracts";
import {
  calendarPolicyPath,
  createEventKitGateway,
  loadCalendarPolicy,
  mergeCalendarAccess,
  readableCalendars,
  runCalendarTask,
  type CalendarGateway,
} from "@alfred/calendar-gateway";

export interface CalendarGatewayHarnessOptions {
  profileId?: string;
  policyPath?: string;
  gateway?: CalendarGateway;
  now?: () => Date;
  timeZone?: string;
}

/**
 * Calendar-only adapter. EventKit and the access file live on this Mac.
 * The full OpenClaw agent is not called, and the main OpenClaw config is not read.
 */
export class CalendarGatewayHarness implements AgentHarness {
  readonly manifest: AgentHarnessManifest = {
    id: "harness.openclaw-local",
    displayName: "Context & Action Gateway",
    version: "0.1.0",
    capabilities: ["calendar"],
    notes: "Local calendars only. Access is the No Access / Read / Write file from the desktop gateway page.",
  };

  constructor(private readonly opts: CalendarGatewayHarnessOptions = {}) {}

  supports(category: TaskCategory): boolean {
    return category === "calendar";
  }

  async execute(request: AgentDelegationRequest): Promise<AgentDelegationResult> {
    if (request.taskCategory !== "calendar") {
      return {
        correlationId: request.correlationId,
        harnessId: this.manifest.id,
        status: "failed",
        output: "",
        error: "This gateway only handles calendars.",
        metadata: {},
      };
    }
    const profileId = this.opts.profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
    const policyPath = this.opts.policyPath ?? calendarPolicyPath(profileId);
    const gateway = this.opts.gateway ?? createEventKitGateway(policyPath);
    const timeZone =
      this.opts.timeZone ?? process.env.BRIEFING_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      const [discovered, policy] = await Promise.all([
        gateway.catalog(),
        loadCalendarPolicy(policyPath),
      ]);
      const merged = mergeCalendarAccess(discovered, policy);
      const speech = await runCalendarTask({
        task: request.taskDescription,
        context: request.conversationContext,
        now: this.opts.now?.() ?? new Date(),
        timeZone,
        calendars: readableCalendars(merged.sources),
        gateway,
      });
      return {
        correlationId: request.correlationId,
        harnessId: this.manifest.id,
        status: "completed",
        output: speech,
        metadata: {},
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        correlationId: request.correlationId,
        harnessId: this.manifest.id,
        status: "failed",
        output: message,
        error: message,
        metadata: {},
      };
    }
  }
}

export function createCalendarGatewayHarness(
  opts?: CalendarGatewayHarnessOptions,
): CalendarGatewayHarness {
  return new CalendarGatewayHarness(opts);
}
