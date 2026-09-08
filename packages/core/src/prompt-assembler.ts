import type { AssembledPrompt, LlmMessage, PromptAssemblyInput } from "@alfred/contracts";

/**
 * Assembles structured prompts. Does not indiscriminately concatenate context.
 */
export class PromptAssembler {
  assemble(input: PromptAssemblyInput): AssembledPrompt {
    const notes: string[] = [];
    const systemParts: string[] = [input.systemInstructions.trim()];

    const persona = input.personaContext;
    if (persona?.soul) {
      notes.push("soul_attached");
      systemParts.push(`SOUL.md (persona / boundaries):\n${persona.soul}`);
    }
    if (persona?.identity) {
      notes.push("identity_attached");
      systemParts.push(`IDENTITY.md (who you are):\n${persona.identity}`);
    }
    if (persona?.user) {
      notes.push("user_model_attached");
      systemParts.push(`USER.md (user model):\n${persona.user}`);
    }

    if (input.extraSystem?.trim()) {
      notes.push("extra_system_attached");
      systemParts.push(input.extraSystem.trim());
    }

    if (input.availableCapabilities.length > 0) {
      systemParts.push(
        `Available high-level capabilities: ${input.availableCapabilities.join(", ")}.`,
      );
      const caps = new Set(input.availableCapabilities);
      const guidance: string[] = [];
      if (caps.has("delegate_task")) {
        guidance.push(
          "For external harness actions (email, coding, X ingest, browser, etc.), use delegate_task rather than inventing harness-specific tools.",
        );
      }
      if (caps.has("update_reminder")) {
        guidance.push(
          "When the user indicates a due reminder is done, already handled, should stop, or should be snoozed, call update_reminder (including casual phrasing). Do not invent a different tool for reminders.",
        );
      }
      if (caps.has("remember_memory")) {
        guidance.push(
          "When the user shares durable facts about people, relationships, places, or preferences that should be remembered long-term, call remember_memory with Entity/Assertion structure (e.g. Person James Nosal + supervisorOf/reportsTo). Do not rely on your spoken reply alone to store memory.",
        );
      }
      if (caps.has("get_weather_forecast")) {
        guidance.push(
          "When the user asks about current weather or the forecast, call get_weather_forecast immediately (including casual phrasing like \"what's the weather\"). Do not ask which city or zip unless they named a different place — if they omit a location, call the tool with no location argument so home (BRIEFING_ZIP / lat-lon) is used. Only pass location when they specify another city, place, or zip. Do not invent temperatures or conditions. Prefer this over delegate_task for weather.",
        );
      }
      if (caps.has("control_studio_lights")) {
        guidance.push(
          "When the user asks to turn lights on or off, up or down, warmer or cooler, or to set brightness or color temperature, call control_studio_lights immediately (including casual phrasing like \"lights down\", \"make it warm\", \"kill the lights\", \"turn off the lights\"). " +
            "Phrases like \"the lights\", \"all of them\", or \"everything\" mean every Elgato light — omit target and do not ask which room. " +
            "These lights are local Elgato Key Lights on this LAN. Do not mention Alfred:Home, HomeKit, or a missing home-control connection. " +
            "Do not claim you changed the lights without calling the tool. Prefer this over delegate_task.",
        );
      }
      if (guidance.length) {
        systemParts.push(guidance.join(" "));
      }
    }

    notes.push("memory_access_model");
    systemParts.push(
      [
        "Memory access model:",
        "Ingested documents, docs folders, knowledge exports, audio notes, and X notes are extracted into your long-term memory graph — you do not open those files on disk during a conversation.",
        "When the user asks about something they ingested or “in a document/file,” treat that as a memory question: use the Retrieved long-term memory block when present, and if it is empty or incomplete ask for a sharper name/keyword rather than saying you cannot read documents.",
        "Never claim you lack access to ingested material; search/retrieval is how you read it.",
      ].join(" "),
    );

    if ((input.dueReminders?.length ?? 0) > 0) {
      notes.push("due_reminders_attached");
      const block = input.dueReminders!
        .map((r, i) => {
          const when = r.remindAt ? ` remindAt=${r.remindAt}` : "";
          const status = r.status ? ` status=${r.status}` : "";
          return `[${i + 1}] id=${r.recordId}${when}${status} — ${r.summary}`;
        })
        .join("\n");
      systemParts.push(
        "Due reminders for the daily briefing (call update_reminder when the user indicates done/stop/snooze; do not claim you cleared one without calling the tool):\n" +
          block,
      );
    }

    if (input.retrievedMemory.length > 0) {
      notes.push("long_term_memory_attached");
      const memoryBlock = input.retrievedMemory
        .map(
          (m, i) =>
            `[${i + 1}] (id=${m.id}, source=${m.sourceId}, provider=${m.providerId}` +
            `${m.relevance !== undefined ? `, relevance=${m.relevance}` : ""}) ${m.content}`,
        )
        .join("\n");
      systemParts.push(
        "Retrieved long-term memory (distinct from recent conversation context):\n" + memoryBlock,
      );
    }

    const response = input.existingResponseState;
    if (response) {
      if (response.isGenerating) {
        notes.push("answer_already_generating");
        systemParts.push(
          "An answer to the user's earlier statement is already being generated or delivered.",
        );
      }
      if (response.isSpeaking || response.spokenText) {
        systemParts.push(`Exact text already spoken to the user:\n"""${response.spokenText}"""`);
      }
      if (response.unspokenText) {
        systemParts.push(`Unspoken remainder of the prior answer:\n"""${response.unspokenText}"""`);
      }
      if (response.proposedText && response.isGenerating) {
        systemParts.push(`Text currently proposed/in-flight:\n"""${response.proposedText}"""`);
      }
    }

    if (input.lateAddenda.length > 0) {
      notes.push("late_addenda_present");
      systemParts.push(
        "The user provided additional information after the initial turn was committed:\n" +
          input.lateAddenda.map((a, i) => `${i + 1}. ${a}`).join("\n"),
      );
    }

    if (input.interruptionState?.interrupted) {
      notes.push("interruption_context");
      systemParts.push(
        `The user interrupted. Arbitration outcome: ${input.interruptionState.arbitrationOutcome ?? "unspecified"}.`,
      );
      if (input.interruptionState.userInterruptionText) {
        systemParts.push(
          `Interrupting user input: ${input.interruptionState.userInterruptionText}`,
        );
      }
    }

    if (input.agentResults.length > 0) {
      notes.push("agent_results_attached");
      systemParts.push(
        "Agent harness results:\n" +
          input.agentResults
            .map((r) => `- [${r.harnessId}] ${r.status}: ${r.output || r.error || ""}`)
            .join("\n"),
      );
    }

    switch (input.mode) {
      case "addendum":
        systemParts.push(
          "Mode=addendum: Produce a separate response segment that supplements or corrects the original answer without unnecessarily repeating it. If the addendum materially invalidates the unspoken portion, say so clearly.",
        );
        break;
      case "continuation":
        systemParts.push(
          "Mode=continuation: Continue from the unspoken remainder without restarting the spoken portion.",
        );
        break;
      case "correction":
        systemParts.push(
          "Mode=correction: Correct the prior answer in light of new information; avoid full repetition.",
        );
        break;
      case "replacement":
        systemParts.push(
          "Mode=replacement: Replace the abandoned/unspoken prior answer with a new complete answer to the latest user input.",
        );
        break;
      case "clarification":
        systemParts.push(
          "Mode=clarification: Ask a brief clarifying question about the interruption or ambiguous input.",
        );
        break;
      default:
        systemParts.push("Mode=initial: Answer the current user turn.");
    }

    const messages: LlmMessage[] = [{ role: "system", content: systemParts.join("\n\n") }];

    for (const turn of input.recentConversation) {
      messages.push({
        role: turn.role === "system" ? "system" : turn.role,
        content: turn.text,
      });
    }

    messages.push({ role: "user", content: input.currentUserTurn });

    return { mode: input.mode, messages, notes };
  }
}
