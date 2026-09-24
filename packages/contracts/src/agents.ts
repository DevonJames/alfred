import { z } from "zod";
import { PermissionScopeSchema } from "./secrets.js";

export const AgentCapabilitySchema = z.enum([
  "email",
  "calendar",
  "coding",
  "repository",
  "filesystem",
  "shell",
  "browser",
  "research",
  "computer_use",
  "messaging",
  "household",
  "general",
]);
export type AgentCapability = z.infer<typeof AgentCapabilitySchema>;

export const TaskCategorySchema = z.enum([
  "email",
  "calendar",
  "coding",
  "repository",
  "filesystem",
  "shell",
  "browser",
  "research",
  "computer_use",
  "household",
  "general",
]);
export type TaskCategory = z.infer<typeof TaskCategorySchema>;

export const AgentHarnessManifestSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  version: z.string().default("0.1.0"),
  capabilities: z.array(AgentCapabilitySchema),
  notes: z.string().optional(),
});
export type AgentHarnessManifest = z.infer<typeof AgentHarnessManifestSchema>;

export const AgentDelegationRequestSchema = z.object({
  correlationId: z.string(),
  taskDescription: z.string().min(1),
  taskCategory: TaskCategorySchema,
  conversationContext: z.string().default(""),
  permissions: z.array(PermissionScopeSchema).default(["agent.delegate"]),
  requestedOutputFormat: z.enum(["text", "json", "markdown"]).default("text"),
  confirmationRequired: z.boolean().default(false),
  deadlineMs: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().default(60_000),
});
export type AgentDelegationRequest = z.infer<typeof AgentDelegationRequestSchema>;

export const AgentDelegationResultSchema = z.object({
  correlationId: z.string(),
  harnessId: z.string(),
  status: z.enum(["completed", "failed", "needs_confirmation", "cancelled"]),
  output: z.string().default(""),
  error: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type AgentDelegationResult = z.infer<typeof AgentDelegationResultSchema>;

export interface AgentHarness {
  readonly manifest: AgentHarnessManifest;
  supports(category: TaskCategory): boolean;
  execute(request: AgentDelegationRequest): Promise<AgentDelegationResult>;
}

export const DELEGATE_TASK_TOOL = {
  name: "delegate_task",
  description:
    "Delegate an external action such as ingesting X.com links from Apple Notes or fetching a single X URL into memory.",
  parameters: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: [
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
        ],
      },
      taskDescription: { type: "string" },
    },
    required: ["category", "taskDescription"],
  },
} as const;

/**
 * Complete, dismiss, or snooze a due briefing reminder from conversation.
 * Call on casual completion language — not only explicit "clear reminder".
 */
export const UPDATE_REMINDER_TOOL = {
  name: "update_reminder",
  description:
    "Update a due daily-briefing reminder when the user indicates it is done, no longer needed, already handled, or should be snoozed/rescheduled. " +
    "Call this for casual phrasing too (e.g. 'I took care of X yesterday', 'already done', 'you can stop reminding me', 'thanks for the reminder' when clearly about a due item). " +
    "Use action=completed when finished, dismissed when they want it dropped without completing, snoozed when they want it later (requires snoozedUntil). " +
    "Prefer recordId from the due-reminders list when known; otherwise pass match text describing which reminder.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["completed", "dismissed", "snoozed"],
      },
      match: {
        type: "string",
        description: "Free-text description of which reminder when recordId is unknown",
      },
      recordId: {
        type: "string",
        description: "Exact memory record id from the due-reminders list when known",
      },
      snoozedUntil: {
        type: "string",
        description: "ISO timestamp or YYYY-MM-DD when action is snoozed",
      },
    },
    required: ["action"],
  },
} as const;

/**
 * Persist durable people/facts/relations from conversation as Entity + Assertion
 * (same shape as knowledge ingest), not as assistant-turn Observations.
 */
export const REMEMBER_MEMORY_TOOL = {
  name: "remember_memory",
  description:
    "Store durable long-term memory as structured Entity and Assertion records when the user tells you lasting facts about people, places, organizations, relationships, preferences, or other things that should be recalled later. " +
    "Call this for casual statements too (e.g. 'my boss is James Nosal', 'Amy is my wife', 'I now work for USPTO', 'James Nosal email is james@co.com', 'his phone is 555-123-4567'). " +
    "Do NOT use this for ephemeral chitchat. Prefer Person/Organization/Thing entities and clear predicates like supervisorOf, reportsTo, worksWith, colleagueOf, spouseOf, parentOf, worksAt, inventorOf, founderOf, cofounderOf, hasBirthDate, partOf, runs, relatedTo, livesIn. " +
    "When someone invented/co-invented a protocol/product/project, create that work as a Thing (or reuse the existing entity) and an inventorOf assertion from the person — do not only link them through a spouse. " +
    "When someone founded or co-founded a company/venture, use founderOf or cofounderOf (reuse the Organization/Thing if it already exists). " +
    "When the user names an employer or company, create an Organization entity and a worksAt assertion to the user. " +
    "If they mention a boss, supervisor, coworker, colleague, teammate, HR specialist, recruiter, or someone they work with, also create worksAt from that person to the same Organization (and worksWith/colleagueOf as appropriate). " +
    "Phrases like 'another person that works at USPTO is my HR specialist; her name is Regina' should create Person Regina linked worksAt USPTO — never entities named 'Person That' or 'USPTO is my HR specialist'. " +
    "For org hierarchies and networking (e.g. 'Jordan works for OPM, the department of the federal government that runs Tech Force which hired me'), create each Organization (OPM, Federal Government, Tech Force), link them with partOf/runs, connect the person worksAt to their org, and connect the user worksAt to the org that hired them. " +
    "When the user gives contact details, put email/telephone on the Person entity (do not only put them in notes). " +
    "When the user shares a birthday or birth date (theirs or someone else's), set birthDate on the Person (ISO YYYY-MM-DD or --MM-DD if year unknown) and create a hasBirthDate assertion to a date Thing labeled like 'March 15' or 'March 15, 1985' so it shows up in graph connections.",
  parameters: {
    type: "object",
    properties: {
      entities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            entityClass: {
              type: "string",
              description: "Person, Place, Organization, Thing, etc.",
            },
            summary: { type: "string" },
            email: { type: "string", description: "Email address for this person" },
            telephone: { type: "string", description: "Phone number for this person" },
            birthDate: {
              type: "string",
              description:
                "schema.org birthDate: YYYY-MM-DD or --MM-DD when year is unknown",
            },
          },
          required: ["name"],
        },
      },
      assertions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            subjectName: { type: "string" },
            predicate: { type: "string" },
            objectName: { type: "string" },
            text: { type: "string" },
          },
          required: ["subjectName", "predicate", "objectName"],
        },
      },
      notes: {
        type: "array",
        items: { type: "string" },
        description: "Free-text durable notes when a full Entity/Assertion does not fit",
      },
    },
  },
} as const;

/**
 * Live weather / forecast lookup mid-conversation (Open-Meteo; same as daily briefing).
 * Prefer this over delegate_task for weather questions.
 */
export const GET_WEATHER_FORECAST_TOOL = {
  name: "get_weather_forecast",
  description:
    "Look up a live weather forecast when the user asks about current conditions or upcoming weather. " +
    "Call this for casual phrasing too (e.g. 'what's the weather', 'will it rain tomorrow', 'forecast for this weekend', 'how's it looking outside'). " +
    "CRITICAL: If the user does not name a city/place/zip, omit location and use the configured home location — do not ask where they mean. " +
    "Only pass location when they explicitly ask about another city, place, or zip. " +
    "Do not invent temperatures or conditions — always call this tool for weather facts.",
  parameters: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description:
          "City, place name, or zip ONLY when the user named a specific place. Leave unset for home (configured BRIEFING_ZIP / lat-lon).",
      },
      days: {
        type: "number",
        description: "How many forecast days to include (1–5). Default 3.",
      },
    },
  },
} as const;

/**
 * Local Elgato Key Light control (mDNS + HTTP, no cloud).
 * Prefer this over delegate_task for studio / room lights.
 */
export const CONTROL_STUDIO_LIGHTS_TOOL = {
  name: "control_studio_lights",
  description:
    "Control the local Elgato Key Lights: on/off, brighter/dimmer (up/down), warmer/cooler, or set brightness and color temperature. " +
    "Call this for casual phrasing too (e.g. 'turn on the lights', 'lights down', 'make them warmer', 'bedroom at 30%', 'living room off', 'all of them'). " +
    "If the user does not name a specific light or room — or says the lights / all of them / everything — omit target so every discovered light is used. Do not ask which room. " +
    "These are local Elgato lights on Wi-Fi; do not mention Alfred:Home or a missing home-control connection. " +
    "Do not claim you changed the lights without calling this tool. Prefer this over delegate_task.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["on", "off", "brighter", "dimmer", "warmer", "cooler", "set", "status"],
        description:
          "on/off; brighter/dimmer for up/down; warmer/cooler for color; set for absolute brightness/temperature; status to read current state.",
      },
      target: {
        type: "string",
        description:
          "Display name or room (e.g. bedroom, living room, living room 1). Leave unset for all lights.",
      },
      brightness: {
        type: "number",
        description: "Absolute brightness 0–100 when action is on or set.",
      },
      temperature: {
        type: "string",
        description:
          "warm, cool, or neutral (or Kelvin like 3200). Use with on/set. Prefer warmer/cooler actions for relative changes.",
      },
    },
    required: ["action"],
  },
} as const;

/**
 * Live news headlines from the same RSS sources as the daily briefing.
 * Prefer this over delegate_task for "what's in the news".
 */
export const GET_NEWS_HEADLINES_TOOL = {
  name: "get_news_headlines",
  description:
    "Fetch today's top news headlines from the user's configured briefing sources. " +
    "Call this for casual phrasing too (e.g. 'what's in the news', 'any headlines', 'catch me up on the news', 'top headlines'). " +
    "Do not invent headlines — always call this tool. After speaking them, the user may ask to dig into one by number or title.",
  parameters: {
    type: "object",
    properties: {},
  },
} as const;

/**
 * Fetch and summarize one headline from the last news rundown (or a URL).
 */
export const SUMMARIZE_NEWS_ARTICLE_TOOL = {
  name: "summarize_news_article",
  description:
    "Fetch the full article for a recent headline and return a short spoken summary. " +
    "Call after get_news_headlines when the user asks for more detail (e.g. 'tell me more about the second one', 'summarize that story', 'dig into the AP headline'). " +
    "Prefer index (1-based) from the last rundown, or match text from the title. Pass url only when known.",
  parameters: {
    type: "object",
    properties: {
      index: {
        type: "number",
        description: "1-based index from the last headline rundown (1 = first).",
      },
      match: {
        type: "string",
        description: "Fragment of the headline title when the index is unknown.",
      },
      url: {
        type: "string",
        description: "Direct article URL when already known.",
      },
      title: {
        type: "string",
        description: "Headline title when summarizing a direct URL.",
      },
    },
  },
} as const;

/**
 * Live crypto quote (CoinGecko — same path as the daily briefing).
 */
export const GET_CRYPTO_PRICE_TOOL = {
  name: "get_crypto_price",
  description:
    "Look up a live cryptocurrency price (default: the user's briefing crypto, usually Bitcoin). " +
    "Call for casual phrasing too (e.g. 'what's bitcoin at', 'BTC price', 'how's ethereum'). " +
    "Do not invent prices — always call this tool.",
  parameters: {
    type: "object",
    properties: {
      cryptoId: {
        type: "string",
        description:
          "CoinGecko id such as bitcoin, ethereum, solana. Omit to use the briefing default.",
      },
    },
  },
} as const;

/**
 * Live gold/silver quote (Stooq — same path as the daily briefing).
 */
export const GET_METALS_PRICE_TOOL = {
  name: "get_metals_price",
  description:
    "Look up a live gold or silver price. " +
    "Call for casual phrasing too (e.g. 'gold price', 'how's silver', 'precious metals'). " +
    "Do not invent prices — always call this tool.",
  parameters: {
    type: "object",
    properties: {
      metalSymbol: {
        type: "string",
        enum: ["gold", "silver"],
        description: "Which metal. Default gold when omitted.",
      },
    },
  },
} as const;

export const GET_EARTHQUAKES_TOOL = {
  name: "get_earthquakes",
  description:
    "Look up recent earthquakes from the USGS feed. " +
    "Call for 'any earthquakes', 'significant earthquakes today', or 'what just shook' a place. " +
    "Do not invent magnitudes or locations.",
  parameters: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["significant", "notable"],
        description: "significant for the USGS significant feed. notable (default) for magnitude 4.5, or 2.5 when recent.",
      },
      recent: {
        type: "boolean",
        description: "True when the user means the last hour or 'just now'.",
      },
      place: {
        type: "string",
        description: "Region or place to filter, such as California or Japan. Omit for worldwide.",
      },
    },
  },
} as const;

export const GET_WEATHER_ALERTS_TOOL = {
  name: "get_weather_alerts",
  description:
    "Look up active National Weather Service warnings and advisories. " +
    "Call for severe weather, warnings, watches, and advisories. " +
    "This is not the daily forecast — use get_weather_forecast for temperature and conditions. " +
    "Omit location to use home. Do not invent alerts.",
  parameters: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "City, region, or zip. Omit for the configured home location.",
      },
    },
  },
} as const;

export const GET_SPACE_WEATHER_TOOL = {
  name: "get_space_weather",
  description:
    "Look up NOAA geomagnetic storm scales and whether aurora is more likely. " +
    "Call for geomagnetic storms, space weather, solar storms, and aurora. " +
    "Do not invent storm levels.",
  parameters: { type: "object", properties: {} },
} as const;

export const GET_NATURAL_EVENTS_TOOL = {
  name: "get_natural_events",
  description:
    "Look up open wildfires and volcanoes from NASA EONET. " +
    "Call for wildfires, forest fires, volcanoes, and eruptions. " +
    "Do not invent events.",
  parameters: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["wildfires", "volcanoes", "both"],
        description: "Which events to speak. Default both.",
      },
    },
  },
} as const;

export const GET_EXCHANGE_RATE_TOOL = {
  name: "get_exchange_rate",
  description:
    "Convert an amount between currencies using European Central Bank rates, or say how a rate moved over the past week. " +
    "Call for euros, yen, pounds, and similar. Do not use this for Bitcoin or gold. " +
    "Do not invent rates.",
  parameters: {
    type: "object",
    properties: {
      amount: { type: "number", description: "Amount to convert. Omit for 1, or when asking how the rate moved." },
      from: { type: "string", description: "Source ISO currency code, such as USD." },
      to: { type: "string", description: "Target ISO currency code, such as EUR or JPY." },
      change: { type: "boolean", description: "True when the user asks how the rate has moved." },
    },
    required: ["from", "to"],
  },
} as const;

export const GET_HACKER_NEWS_TOOL = {
  name: "get_hacker_news",
  description:
    "Read the current Hacker News front page. " +
    "Call when the user asks what developers are talking about, or for AI stories on Hacker News. " +
    "This is not the general news briefing. Do not invent story titles.",
  parameters: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        enum: ["general", "ai"],
        description: "ai filters titles for AI. general is the front page.",
      },
    },
  },
} as const;

export const GET_CURRENT_TIME_TOOL = {
  name: "get_current_time",
  description:
    "Say the current local time or today's date. " +
    "Call for 'what time is it', 'do you have the time', and 'what's today's date'. " +
    "Omit place for the user's home timezone. Pass place for a city such as Tokyo or London. " +
    "Do not invent the time. This is not for scheduling a future event.",
  parameters: {
    type: "object",
    properties: {
      place: {
        type: "string",
        description: "City to check, such as Tokyo. Omit for home.",
      },
      kind: {
        type: "string",
        enum: ["time", "date"],
        description: "time for the clock. date for the weekday and calendar date.",
      },
    },
  },
} as const;

export const AgentRoutingRuleSchema = z.object({
  category: TaskCategorySchema,
  orderedHarnessIds: z.array(z.string().min(1)).min(1),
});
export type AgentRoutingRule = z.infer<typeof AgentRoutingRuleSchema>;
