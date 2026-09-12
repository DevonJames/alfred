/**
 * LiveKit Agents function tools wrapping Alfred brain ports
 * (same capabilities as cascade VoiceSessionController committed tools).
 */
import { llm } from "@livekit/agents";
import { createId, type TaskCategory } from "@alfred/contracts";
import { resolveReminderMatch } from "@alfred/core";
import { z } from "zod";
import type { AlfredBrain } from "../brain.js";

export function createAlfredLiveTools(brain: AlfredBrain) {
  return {
    search_memory: llm.tool({
      description:
        "Search Alfred long-term memory for people, facts, notes, ingested docs, and past context. " +
        "Call this when the user asks about something they told you before, someone they know, or material they ingested.",
      parameters: z.object({
        query: z.string().describe("Keywords or natural-language question to search memory with"),
        limit: z.number().min(1).max(12).optional().describe("Max results (default 8)"),
      }),
      execute: async ({ query, limit }) => {
        const result = await brain.memory.retrieve({
          text: query,
          profileId: brain.profileId,
          sessionId: brain.sessionId,
          limit: limit ?? 8,
        });
        if (!result.items.length) {
          return "No matching long-term memory found. Ask for a sharper name or keyword.";
        }
        return result.items
          .map(
            (m, i) =>
              `[${i + 1}] (id=${m.id}, source=${m.sourceId}, provider=${m.providerId}` +
              `${m.relevance !== undefined ? `, relevance=${m.relevance}` : ""}) ${m.content}`,
          )
          .join("\n");
      },
    }),

    remember_memory: llm.tool({
      description:
        "Store durable long-term memory as structured Entity and Assertion records when the user tells you lasting facts about people, places, organizations, relationships, preferences, or other things that should be recalled later.",
      parameters: z.object({
        entities: z
          .array(
            z.object({
              name: z.string(),
              entityClass: z.string().optional(),
              summary: z.string().optional(),
              email: z.string().optional(),
              telephone: z.string().optional(),
              birthDate: z.string().optional(),
            }),
          )
          .optional(),
        assertions: z
          .array(
            z.object({
              subjectName: z.string(),
              predicate: z.string(),
              objectName: z.string(),
              text: z.string().optional(),
            }),
          )
          .optional(),
        notes: z.array(z.string()).optional(),
      }),
      execute: async (args) => {
        const entities = (args.entities ?? [])
          .map((e) => ({
            name: e.name.trim(),
            entityClass: e.entityClass,
            summary: e.summary,
            email: e.email?.trim(),
            telephone: e.telephone?.trim(),
            birthDate: e.birthDate?.trim(),
          }))
          .filter((e) => e.name);
        const assertions = (args.assertions ?? [])
          .map((a) => ({
            subjectName: a.subjectName.trim(),
            predicate: a.predicate.trim(),
            objectName: a.objectName.trim(),
            text: a.text,
          }))
          .filter((a) => a.subjectName && a.predicate && a.objectName);
        const notes = (args.notes ?? []).map((n) => n.trim()).filter(Boolean);
        if (!entities.length && !assertions.length && !notes.length) {
          return "I need something concrete to remember.";
        }
        try {
          const result = await brain.structuredMemory.remember({ entities, assertions, notes });
          const parts: string[] = [];
          if (result.entitiesUpserted) parts.push(`${result.entitiesUpserted} people or things`);
          if (result.assertionsCreated) parts.push(`${result.assertionsCreated} relationships`);
          if (result.notesCreated) parts.push(`${result.notesCreated} notes`);
          return parts.length
            ? `Stored in memory (${parts.join(", ")}).`
            : "Noted in memory.";
        } catch (err) {
          console.error("[voice:live] remember_memory failed:", err);
          return "Could not store that memory just now.";
        }
      },
    }),

    update_reminder: llm.tool({
      description:
        "Update a due daily-briefing reminder when the user indicates it is done, no longer needed, already handled, or should be snoozed/rescheduled.",
      parameters: z.object({
        action: z.enum(["completed", "dismissed", "snoozed"]),
        match: z.string().optional(),
        recordId: z.string().optional(),
        snoozedUntil: z.string().optional(),
      }),
      execute: async (args) => {
        const due = await brain.listDueReminders();
        const resolved = resolveReminderMatch(due, {
          recordId: args.recordId ?? null,
          match: args.match ?? null,
        });
        if (resolved.kind === "none") {
          return "No matching due reminder to update.";
        }
        if (resolved.kind === "ambiguous") {
          const names = resolved.candidates
            .slice(0, 4)
            .map((c) => c.summary)
            .join("; ");
          return `Which reminder should I update — ${names}?`;
        }
        const target = resolved.reminder;
        if (args.action === "snoozed" && !args.snoozedUntil?.trim()) {
          return "When should I remind you again?";
        }
        try {
          await brain.reminders.setStatus(target.recordId, args.action, args.snoozedUntil);
          await brain.reminders.invalidateBriefingDay();
          if (args.action === "completed") {
            return `Cleared the reminder about ${target.summary}.`;
          }
          if (args.action === "dismissed") {
            return `Won't keep reminding about ${target.summary}.`;
          }
          return `Snoozed the reminder about ${target.summary} until ${args.snoozedUntil}.`;
        } catch (err) {
          console.error("[voice:live] update_reminder failed:", err);
          return "Could not update that reminder just now.";
        }
      },
    }),

    get_weather_forecast: llm.tool({
      description:
        "Look up a live weather forecast. If the user does not name a city/place/zip, omit location and use the configured home location.",
      parameters: z.object({
        location: z.string().optional(),
        days: z.number().min(1).max(5).optional(),
      }),
      execute: async ({ location, days }) => {
        try {
          return await brain.weather.getForecast({
            location: location?.trim() || undefined,
            days,
          });
        } catch (err) {
          console.error("[voice:live] get_weather_forecast failed:", err);
          return "Could not get the weather forecast just now.";
        }
      },
    }),

    control_studio_lights: llm.tool({
      description:
        "Control local Elgato Key Lights: on/off, brighter/dimmer, warmer/cooler, or set brightness/color. Omit target for all lights.",
      parameters: z.object({
        action: z.enum(["on", "off", "brighter", "dimmer", "warmer", "cooler", "set", "status"]),
        target: z.string().optional(),
        brightness: z.number().optional(),
        temperature: z.union([z.string(), z.number()]).optional(),
      }),
      execute: async (args) => {
        try {
          return await brain.lights.control({
            action: args.action,
            target: args.target?.trim() || undefined,
            brightness: args.brightness,
            temperature: args.temperature,
          });
        } catch (err) {
          console.error("[voice:live] control_studio_lights failed:", err);
          return "Could not reach the lights just now.";
        }
      },
    }),

    play_daily_briefing: llm.tool({
      description:
        "Generate and return today's daily briefing speech when the user asks for the briefing or affirms a soft offer (e.g. 'brief me', 'yes', 'go ahead' after being offered the briefing).",
      parameters: z.object({
        userText: z
          .string()
          .optional()
          .describe("The user utterance that triggered the briefing, if available"),
      }),
      execute: async ({ userText }) => {
        try {
          const decision = await brain.briefing.handleUserTurn(
            userText?.trim() || "brief me",
          );
          if (decision.action === "play") {
            return decision.speech;
          }
          if (decision.action === "decline") {
            return decision.speech;
          }
          const payload = await brain.briefing.generate({
            refresh: true,
            markSurfaced: true,
            userText: userText?.trim(),
          });
          await brain.briefing.markPlayed();
          return payload.speech;
        } catch (err) {
          console.error("[voice:live] play_daily_briefing failed:", err);
          return "I couldn't put the briefing together just now.";
        }
      },
    }),

    decline_briefing_offer: llm.tool({
      description:
        "Call when the user declines a soft offer for the daily briefing (e.g. 'not now', 'no thanks').",
      parameters: z.object({}),
      execute: async () => {
        await brain.briefing.markDeclined();
        return brain.briefing.declineAck;
      },
    }),

    list_due_reminders: llm.tool({
      description: "List due daily-briefing reminders the user may want to complete, dismiss, or snooze.",
      parameters: z.object({}),
      execute: async () => {
        const due = await brain.listDueReminders();
        if (!due.length) return "No due reminders right now.";
        return due
          .map((r, i) => {
            const when = r.remindAt ? ` remindAt=${r.remindAt}` : "";
            const status = r.status ? ` status=${r.status}` : "";
            return `[${i + 1}] id=${r.recordId}${when}${status} — ${r.summary}`;
          })
          .join("\n");
      },
    }),

    delegate_task: llm.tool({
      description:
        "Delegate an external action such as ingesting X.com links from Apple Notes or fetching a single X URL into memory.",
      parameters: z.object({
        category: z.enum([
          "email",
          "calendar",
          "coding",
          "repository",
          "filesystem",
          "shell",
          "browser",
          "research",
          "computer_use",
          "general",
        ]),
        taskDescription: z.string(),
      }),
      execute: async ({ category, taskDescription }) => {
        const description = taskDescription.trim();
        if (!description) return "Need a task description to delegate.";
        try {
          const result = await brain.agents.delegate({
            correlationId: createId("corr"),
            taskDescription: description,
            taskCategory: category as TaskCategory,
            conversationContext: "",
            permissions: ["agent.delegate"],
            requestedOutputFormat: "text",
            confirmationRequired: false,
            timeoutMs: 600_000,
          });
          return result.output || result.error || "Delegation finished with no output.";
        } catch (err) {
          console.error("[voice:live] delegate_task failed:", err);
          return "Delegation failed.";
        }
      },
    }),
  };
}
