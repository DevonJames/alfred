import type { LLMProvider } from "@alfred/contracts";
import { loadBriefingConfig, type TaskReminder } from "@alfred/briefing";
import {
  createRemindersGateway,
  remindersForBriefing,
  remindersPolicyPath,
  type AppleReminder,
} from "@alfred/reminders-gateway";
import { OpenAiResponsesLLMProvider } from "@alfred/provider-openai";
import { resolveGrokApiKey, XaiGrokLLMProvider } from "@alfred/provider-xai";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { contactLabel } from "./contact-names.js";
import {
  commitmentPrompt,
  initialScanCursor,
  messageLookbackDays,
  parseCommitmentReply,
  calendarYear,
  normalizeDueYear,
  readMessageContext,
  readMessageSentAt,
  readNewIncomingMessages,
  readNewOutgoingMessages,
  readNewSelfNotes,
  looksLikeFollowUp,
  looksLikeObligation,
  shouldDraftMessage,
  type IncomingMessage,
  type MessageContextLine,
} from "./message-scan.js";

export interface CommitmentProposal {
  id: string;
  messageId: number;
  title: string;
  due: string | null;
  quote: string;
  handle: string | null;
  isGroup: boolean;
  chatName: string | null;
  createdAt: string;
  sentAt?: string | null;
  /** Received copy of a note the user sent to themself. */
  selfNote?: boolean;
}

interface SettledCommitment {
  messageId: number;
  action: "dismissed" | "added";
  title: string;
}

interface CommitmentFile {
  cursor: number;
  proposals: CommitmentProposal[];
  /** Messages already dismissed or turned into a reminder. A later scan leaves them alone. */
  settled?: SettledCommitment[];
  /** 1 once messages stored only in attributedBody have been included. */
  bodyScan?: number;
  /** 1 once incoming requests have a cursor of their own. */
  incomingScan?: number;
  incomingCursor?: number;
  /** 1 once outgoing follow-up asks in the lookback window have been read. */
  followScan?: number;
  followCursor?: number;
  /** 1 once "I need to…" notes in the lookback window have been read. */
  obligationScan?: number;
  obligationCursor?: number;
  /** 1 once notes the user sent themself have a cursor of their own. */
  selfScan?: number;
  selfCursor?: number;
}

function profileId(): string {
  return process.env.ALFRED_PROFILE_ID ?? "profile.default";
}

function storePath(): string {
  const root = path.dirname(remindersPolicyPath(profileId()));
  return path.join(root, "message-commitments.json");
}

function gateway() {
  return createRemindersGateway(remindersPolicyPath(profileId()));
}

async function readStore(): Promise<CommitmentFile> {
  try {
    const raw = JSON.parse(await readFile(storePath(), "utf8")) as CommitmentFile;
    if (!raw || typeof raw.cursor !== "number" || !Array.isArray(raw.proposals)) {
      return { cursor: 0, proposals: [] };
    }
    if (!Array.isArray(raw.settled)) raw.settled = [];
    return raw;
  } catch {
    return { cursor: 0, proposals: [] };
  }
}

async function writeStore(file: CommitmentFile): Promise<void> {
  const target = storePath();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

let storeQueue: Promise<void> = Promise.resolve();

function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = storeQueue.then(fn, fn);
  storeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function remember(file: CommitmentFile, entry: SettledCommitment): void {
  if (!file.settled) file.settled = [];
  const existing = file.settled.find((item) => item.messageId === entry.messageId);
  if (existing) {
    existing.action = entry.action;
    existing.title = entry.title;
    return;
  }
  file.settled.push(entry);
}

function messageIsSettled(file: CommitmentFile, messageId: number): boolean {
  return file.settled?.some((item) => item.messageId === messageId) ?? false;
}

export async function listOpenReminders(): Promise<AppleReminder[]> {
  return gateway().items();
}

export async function loadTaskReminders(): Promise<TaskReminder[]> {
  try {
    const zone = loadBriefingConfig().timezone;
    return remindersForBriefing(await gateway().items(), new Date(), zone).map((item) => ({
      title: item.title,
      overdue: item.overdue,
    }));
  } catch (err) {
    console.warn("[reminders] brief list failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

export async function listProposals(): Promise<CommitmentProposal[]> {
  const proposals = (await readStore()).proposals;
  const missing = proposals.filter((proposal) => !proposal.sentAt).map((proposal) => proposal.messageId);
  const sentAt = readMessageSentAt(missing);
  const year = calendarYear();
  return proposals.map((proposal) => ({
    ...proposal,
    handle: contactLabel(proposal.handle),
    sentAt: proposal.sentAt ?? sentAt[proposal.messageId] ?? null,
    due: normalizeDueYear(proposal.due, proposal.quote, year),
  }));
}

export function proposalContext(messageId: number): MessageContextLine[] | null {
  const lines = readMessageContext(messageId);
  if (!lines) return lines;
  return lines.map((line) => ({ ...line, handle: contactLabel(line.handle) }));
}

export async function dismissProposal(id: string): Promise<void> {
  await withStoreLock(async () => {
    const file = await readStore();
    const proposal = file.proposals.find((item) => item.id === id);
    if (!proposal) return;
    remember(file, { messageId: proposal.messageId, action: "dismissed", title: proposal.title });
    file.proposals = file.proposals.filter((item) => item.id !== id);
    await writeStore(file);
  });
}

export async function renameProposal(id: string, title: string): Promise<void> {
  const next = title.trim().slice(0, 180);
  if (!next) return;
  await withStoreLock(async () => {
    const file = await readStore();
    const proposal = file.proposals.find((item) => item.id === id);
    if (!proposal) return;
    proposal.title = next;
    await writeStore(file);
  });
}

export async function approveProposal(
  id: string,
  listId: string,
  due: string,
  title?: string,
): Promise<AppleReminder> {
  const file = await readStore();
  const proposal = file.proposals.find((item) => item.id === id);
  if (!proposal) throw new Error("That proposal is no longer waiting.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error("Choose the day it is due.");
  const nextTitle = (title ?? proposal.title).trim().slice(0, 180);
  if (!nextTitle) throw new Error("The task needs wording.");
  const reminder = await gateway().create({
    listId,
    title: nextTitle,
    due,
    notes: proposal.selfNote
      ? "From a note to yourself"
      : proposal.isGroup
        ? proposal.chatName
          ? `From the group ${proposal.chatName}`
          : "From a group conversation"
        : proposal.handle
          ? `From a message with ${contactLabel(proposal.handle)}`
          : "From a message",
  });
  await withStoreLock(async () => {
    const latest = await readStore();
    const current = latest.proposals.find((item) => item.id === id) ?? proposal;
    remember(latest, { messageId: current.messageId, action: "added", title: nextTitle });
    latest.proposals = latest.proposals.filter((item) => item.id !== id);
    await writeStore(latest);
  });
  return reminder;
}

export async function rescheduleReminder(id: string, due: string | null): Promise<AppleReminder> {
  return gateway().setDue(id, due);
}

export async function renameReminder(id: string, title: string): Promise<AppleReminder> {
  const next = title.trim().slice(0, 180);
  if (!next) throw new Error("A reminder needs a name.");
  return gateway().setTitle(id, next);
}

export async function completeReminder(id: string): Promise<void> {
  await gateway().complete(id);
}

function llm(): LLMProvider | null {
  const openai = process.env.OPENAI_API_KEY?.trim();
  if (openai) return new OpenAiResponsesLLMProvider({ apiKey: openai });
  const grok = resolveGrokApiKey();
  if (grok) return new XaiGrokLLMProvider({ apiKey: grok });
  return null;
}

async function draftCommitment(message: IncomingMessage): Promise<string | null> {
  const model = llm();
  if (!model) return null;
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: process.env.BRIEFING_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const instructions = message.fromMe
    ? [
        "Decide whether the user's own message is an explicit promise to do something, or the user assigning a concrete task to themselves.",
        "\"I need to\", \"I have to\", \"I must\", and \"remind me to\" are commitments when they name a real action, such as calling, paying, sending, filing, or dealing with a bill or notice.",
        "A maybe, a question, small talk, or agreement without a task is not a commitment.",
        "If a letter or notice date is given and payment or action is due within a number of days of that date, including \"w/in N days\", due is that date plus those days. When the year is not written, use the current year.",
        "When the conversation is a group, the promise is to that group. Do not rewrite it as a private task with whichever person spoke last.",
        "Also decide whether the user asked someone else to do a concrete thing by a deadline or a time window, such as tomorrow, next week, a weekday, or before something expires.",
        "When they did, the task is for the user to follow up. The title starts with \"Follow up\". due is the day that follow-up should happen. Use null when the timing is too vague to name a day.",
        "A social plan, a thank-you, or a request with no time attached is not a follow-up. If the user promised to do the thing themselves, the task is that promise, not a follow-up.",
        `Today is ${today}. If the message does not contain a 4-digit year, due must use ${today.slice(0, 4)}. Do not invent an earlier year. A tax year or account year is not the due year unless the deadline itself includes that year.`,
        "Reply with JSON only: {\"commit\":false} or {\"commit\":true,\"title\":\"short task\",\"due\":\"YYYY-MM-DD\"}.",
        "title is the task, not a quote of the chat. Include the group name only when the task would be unclear without it.",
      ].join(" ")
    : [
        "Someone else sent the user this message. Decide whether it asks the user to do a concrete personal task: sign or file something, pay a bill, schedule an appointment, send information, or finish a step on their own account.",
        "News, a confirmation of something already finished, small talk, and a code or receipt are not tasks.",
        "Marketing, political campaigns, fundraising, and texts that exist to get a vote or a donation are not tasks, even when they say please or use the user's name.",
        "In a group, only a request directed at the user is a task.",
        `Today is ${today}. If the message does not contain a 4-digit year, due must use ${today.slice(0, 4)}. Do not invent an earlier year. A tax year or account year is not the due year unless the deadline itself includes that year.`,
        "Reply with JSON only: {\"commit\":false} or {\"commit\":true,\"title\":\"short task\",\"due\":\"YYYY-MM-DD\"}.",
        "title is the task in a few words, not a quote of the message.",
      ].join(" ");
  let out = "";
  try {
    for await (const chunk of model.generateStream({
      messages: [
        { role: "system", content: instructions },
        {
          role: "user",
          content: commitmentPrompt({
            ...message,
            handle: contactLabel(message.handle),
            priorHandle: contactLabel(message.priorHandle),
          }),
        },
      ],
      modelPreset: "instant",
      correlationId: "message-commitment",
    })) {
      if (chunk.type === "error") return null;
      if (chunk.type === "token" && chunk.text) out += chunk.text;
    }
  } catch {
    return null;
  }
  return out;
}

let scanning = false;
let loggedUnreadable = false;

const BODY_SCAN = 1;
const INCOMING_SCAN = 1;
const FOLLOW_SCAN = 1;
const OBLIGATION_SCAN = 1;
const SELF_SCAN = 1;
const SCAN_BATCH = 200;
const DRAFTS_PER_TICK = 8;

async function saveProgress(
  patch: {
    cursor?: number;
    bodyScan?: number;
    incomingCursor?: number;
    incomingScan?: number;
    followCursor?: number;
    followScan?: number;
    obligationCursor?: number;
    obligationScan?: number;
    selfCursor?: number;
    selfScan?: number;
  },
  added: CommitmentProposal[] = [],
): Promise<void> {
  await withStoreLock(async () => {
    const latest = await readStore();
    if (patch.cursor != null) latest.cursor = patch.cursor;
    if (patch.bodyScan != null) latest.bodyScan = patch.bodyScan;
    if (patch.incomingCursor != null) latest.incomingCursor = patch.incomingCursor;
    if (patch.incomingScan != null) latest.incomingScan = patch.incomingScan;
    if (patch.followCursor != null) latest.followCursor = patch.followCursor;
    if (patch.followScan != null) latest.followScan = patch.followScan;
    if (patch.obligationCursor != null) latest.obligationCursor = patch.obligationCursor;
    if (patch.obligationScan != null) latest.obligationScan = patch.obligationScan;
    if (patch.selfCursor != null) latest.selfCursor = patch.selfCursor;
    if (patch.selfScan != null) latest.selfScan = patch.selfScan;
    for (const proposal of added) {
      if (messageIsSettled(latest, proposal.messageId)) continue;
      if (latest.proposals.some((item) => item.messageId === proposal.messageId)) continue;
      latest.proposals.push(proposal);
    }
    await writeStore(latest);
  });
}

async function considerMessage(
  file: CommitmentFile,
  message: IncomingMessage,
  drafts: { n: number },
  added: CommitmentProposal[],
): Promise<"skip" | "kept" | "defer"> {
  if (!shouldDraftMessage(message)) return "skip";
  if (file.proposals.some((proposal) => proposal.messageId === message.id)) return "skip";
  if (messageIsSettled(file, message.id)) return "skip";
  if (drafts.n >= DRAFTS_PER_TICK) return "defer";
  drafts.n += 1;
  const raw = await draftCommitment(message);
  const draft = raw ? parseCommitmentReply(raw) : null;
  if (!draft) return "kept";
  const proposal: CommitmentProposal = {
    id: `msg_${message.id}`,
    messageId: message.id,
    title: draft.title,
    due: normalizeDueYear(draft.due, `${message.priorText ?? ""}\n${message.text}`, calendarYear()),
    quote: message.text.slice(0, 240),
    handle: message.selfNote ? null : message.handle,
    isGroup: message.isGroup,
    chatName: message.chatName,
    createdAt: new Date().toISOString(),
    sentAt: message.sentAt,
    selfNote: message.selfNote === true,
  };
  file.proposals.push(proposal);
  added.push(proposal);
  console.log(`[messages] proposal: ${proposal.title}`);
  return "kept";
}

async function walkMessages(
  file: CommitmentFile,
  read: (afterId: number, limit: number) => IncomingMessage[] | null,
  cursor: number,
  drafts: { n: number },
  accept: (message: IncomingMessage) => boolean = () => true,
): Promise<{ cursor: number; added: CommitmentProposal[] } | null> {
  let next = cursor;
  const added: CommitmentProposal[] = [];
  for (let batch = 0; batch < 8; batch += 1) {
    const messages = read(next, SCAN_BATCH);
    if (messages == null) return null;
    let defer = false;
    for (const message of messages) {
      if (!accept(message)) {
        next = Math.max(next, message.id);
        continue;
      }
      const outcome = await considerMessage(file, message, drafts, added);
      if (outcome === "defer") {
        defer = true;
        break;
      }
      next = Math.max(next, message.id);
    }
    if (defer || messages.length < SCAN_BATCH) break;
  }
  return { cursor: next, added };
}

export async function scanMessageCommitments(): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    const file = await readStore();
    const needsBodyRescan = (file.bodyScan ?? 0) < BODY_SCAN;
    if (needsBodyRescan || file.cursor === 0) {
      const days = messageLookbackDays();
      const window = needsBodyRescan ? Math.max(days, 14) : days;
      const start = initialScanCursor(window);
      if (start == null) {
        if (!loggedUnreadable) {
          loggedUnreadable = true;
          console.warn("[messages] chat.db is not readable. Grant Full Disk Access to the app running Alfred.");
        }
        return;
      }
      file.cursor = start;
      file.bodyScan = BODY_SCAN;
      await saveProgress({ cursor: file.cursor, bodyScan: file.bodyScan });
      if (needsBodyRescan) {
        console.log(`[messages] reading the last ${window} days, including messages stored without a plain text field`);
      }
      if (!needsBodyRescan && days <= 0) return;
    }
    const drafts = { n: 0 };
    const outgoing = await walkMessages(file, readNewOutgoingMessages, file.cursor, drafts);
    if (outgoing == null) {
      if (!loggedUnreadable) {
        loggedUnreadable = true;
        console.warn("[messages] chat.db is not readable. Grant Full Disk Access to the app running Alfred.");
      }
      return;
    }
    file.cursor = outgoing.cursor;
    await saveProgress({ cursor: file.cursor }, outgoing.added);

    const needsObligation = (file.obligationScan ?? 0) < OBLIGATION_SCAN || typeof file.obligationCursor !== "number";
    if (needsObligation) {
      const days = messageLookbackDays();
      const start = initialScanCursor(days);
      if (start == null) {
        if (!loggedUnreadable) {
          loggedUnreadable = true;
          console.warn("[messages] chat.db is not readable. Grant Full Disk Access to the app running Alfred.");
        }
        return;
      }
      file.obligationCursor = start;
      file.obligationScan = OBLIGATION_SCAN;
      await saveProgress({ obligationCursor: file.obligationCursor, obligationScan: file.obligationScan });
      if (days > 0) console.log(`[messages] reading notes you assigned yourself from the last ${days} days`);
    }
    const obligations = await walkMessages(
      file,
      readNewOutgoingMessages,
      file.obligationCursor ?? 0,
      drafts,
      (message) => looksLikeObligation(message.text),
    );
    if (obligations == null) return;
    file.obligationCursor = obligations.cursor;
    await saveProgress({ obligationCursor: file.obligationCursor }, obligations.added);

    const needsFollow = (file.followScan ?? 0) < FOLLOW_SCAN || typeof file.followCursor !== "number";
    if (needsFollow) {
      const days = messageLookbackDays();
      const start = initialScanCursor(days);
      if (start == null) {
        if (!loggedUnreadable) {
          loggedUnreadable = true;
          console.warn("[messages] chat.db is not readable. Grant Full Disk Access to the app running Alfred.");
        }
        return;
      }
      file.followCursor = start;
      file.followScan = FOLLOW_SCAN;
      await saveProgress({ followCursor: file.followCursor, followScan: file.followScan });
      if (days > 0) console.log(`[messages] reading follow-ups from the last ${days} days`);
    }
    const followed = await walkMessages(
      file,
      readNewOutgoingMessages,
      file.followCursor ?? 0,
      drafts,
      (message) => looksLikeFollowUp(message.text),
    );
    if (followed == null) return;
    file.followCursor = followed.cursor;
    await saveProgress({ followCursor: file.followCursor }, followed.added);

    const needsIncoming = (file.incomingScan ?? 0) < INCOMING_SCAN || typeof file.incomingCursor !== "number";
    if (needsIncoming) {
      const days = messageLookbackDays();
      const start = initialScanCursor(days);
      if (start == null) {
        if (!loggedUnreadable) {
          loggedUnreadable = true;
          console.warn("[messages] chat.db is not readable. Grant Full Disk Access to the app running Alfred.");
        }
        return;
      }
      file.incomingCursor = start;
      file.incomingScan = INCOMING_SCAN;
      await saveProgress({ incomingCursor: file.incomingCursor, incomingScan: file.incomingScan });
      if (days > 0) console.log(`[messages] reading incoming requests from the last ${days} days`);
    }
    const incoming = await walkMessages(file, readNewIncomingMessages, file.incomingCursor ?? 0, drafts);
    if (incoming == null) return;
    file.incomingCursor = incoming.cursor;
    await saveProgress({ incomingCursor: file.incomingCursor }, incoming.added);

    const needsSelf = (file.selfScan ?? 0) < SELF_SCAN || typeof file.selfCursor !== "number";
    if (needsSelf) {
      const days = messageLookbackDays();
      const start = initialScanCursor(days);
      if (start == null) {
        if (!loggedUnreadable) {
          loggedUnreadable = true;
          console.warn("[messages] chat.db is not readable. Grant Full Disk Access to the app running Alfred.");
        }
        return;
      }
      file.selfCursor = start;
      file.selfScan = SELF_SCAN;
      await saveProgress({ selfCursor: file.selfCursor, selfScan: file.selfScan });
      if (days > 0) console.log(`[messages] reading notes you sent yourself from the last ${days} days`);
    }
    const selfNotes = await walkMessages(
      file,
      readNewSelfNotes,
      file.selfCursor ?? 0,
      drafts,
      (message) => message.selfNote === true && shouldDraftMessage(message),
    );
    if (selfNotes == null) return;
    file.selfCursor = selfNotes.cursor;
    await saveProgress({ selfCursor: file.selfCursor }, selfNotes.added);
  } finally {
    scanning = false;
  }
}

export function startMessageWatcher(): void {
  const tick = () => {
    void scanMessageCommitments().catch((err) => {
      console.warn("[messages] scan failed:", err instanceof Error ? err.message : err);
    });
  };
  tick();
  const timer = setInterval(tick, 60_000);
  timer.unref?.();
}
