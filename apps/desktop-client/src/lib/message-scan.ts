import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

export interface IncomingMessage {
  id: number;
  text: string;
  fromMe: boolean;
  /** The other person in a direct chat. Empty for a group. */
  handle: string | null;
  priorText: string | null;
  priorFromMe: boolean;
  /** Who sent the earlier line, when it was not the user. */
  priorHandle: string | null;
  isGroup: boolean;
  chatName: string | null;
  participantCount: number;
  sentAt: string | null;
  /** The received copy of a note the user sent to one of their own addresses. */
  selfNote?: boolean;
}

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

/** Days of sent messages to read on the first scan. Unset or 0 watches only new messages. */
export function messageLookbackDays(raw = process.env.ALFRED_MESSAGES_LOOKBACK_DAYS): number {
  if (raw == null || String(raw).trim() === "") return 0;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) return 0;
  return Math.min(Math.floor(days), 3650);
}

/** chat.style 43 is a group. A chat with more than one other person is a group even if style is missing. */
export function chatIsGroup(style: number | null, participantCount: number): boolean {
  return style === 43 || participantCount > 1;
}

export function appleDateScale(sample: number): "seconds" | "nanoseconds" {
  return sample > 1e15 ? "nanoseconds" : "seconds";
}

/** Cutoff in the same unit Messages stored in `message.date`. */
export function appleDateCutoff(nowMs: number, scale: "seconds" | "nanoseconds"): number {
  const seconds = (nowMs - APPLE_EPOCH_MS) / 1000;
  return scale === "seconds" ? Math.floor(seconds) : Math.floor(seconds * 1e9);
}

/** Plain text from a Messages `attributedBody` typedstream, when `text` is empty. */
export function textFromAttributedBody(body: unknown): string | null {
  if (body == null) return null;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body as Uint8Array);
  if (!buf.length) return null;
  const marker = Buffer.from([0x84, 0x01, 0x2b]);
  const at = buf.indexOf(marker);
  if (at < 0) return null;
  let index = at + marker.length;
  if (index >= buf.length) return null;
  let length = buf[index] ?? 0;
  index += 1;
  if (length === 0x81) {
    if (index + 2 > buf.length) return null;
    length = buf.readUInt16LE(index);
    index += 2;
  } else if (length === 0x82) {
    if (index + 3 > buf.length) return null;
    length = buf[index]! | (buf[index + 1]! << 8) | (buf[index + 2]! << 16);
    index += 3;
  } else if (length >= 0x80) {
    return null;
  }
  if (length === 0 || index + length > buf.length) return null;
  const text = buf.subarray(index, index + length).toString("utf8").replace(/\uFFFC/g, "").trim();
  return text || null;
}

/** Prefer the text column. Fall back to the archived body. */
export function messagePlainText(text: unknown, body: unknown): string {
  if (typeof text === "string" && text.trim()) return text;
  return textFromAttributedBody(body) ?? "";
}

export function commitmentPrompt(message: IncomingMessage): string {
  if (message.selfNote) {
    return `This is a note the user sent to themself.\n\nUser:\n${message.text.slice(0, 500)}`;
  }
  if (!message.fromMe) return requestPrompt(message);
  const others =
    message.participantCount === 1 ? "1 other person" : `${message.participantCount} other people`;
  const where = message.isGroup
    ? `This is a group conversation${message.chatName ? ` named "${message.chatName}"` : ""} with ${others}. A promise here is to the group, not a private chat with one person.`
    : `This is a direct conversation${message.handle ? ` with ${message.handle}` : ""}.`;
  const speaker = message.priorFromMe
    ? "the user"
    : message.priorHandle || (message.isGroup ? "someone in the group" : "the other person");
  const prior = message.priorText
    ? `Earlier message from ${speaker}:\n${message.priorText.slice(0, 500)}`
    : "No earlier message.";
  return `${where}\n\n${prior}\n\nUser:\n${message.text.slice(0, 500)}`;
}

function requestPrompt(message: IncomingMessage): string {
  const where = message.isGroup
    ? `This is a group conversation${message.chatName ? ` named "${message.chatName}"` : ""}. Only a request directed at the user is a task.`
    : `This is a direct message${message.handle ? ` from ${message.handle}` : ""}.`;
  return `${where}\n\nMessage sent to the user:\n${message.text.slice(0, 1200)}`;
}

const OBLIGATION =
  /\bi (?:need|have) to\b|\bi must\b|\bi(?:'ve| have) got to\b|\bi gotta\b|\bremind me to\b/i;

function commitmentText(text: string): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || t.length > 400) return null;
  if (/\b(maybe|might|if i have time|we('ll| will) see)\b/i.test(t)) return null;
  return t;
}

/** The user told themselves, or someone else, that a concrete task is theirs. */
export function looksLikeObligation(text: string): boolean {
  const t = commitmentText(text);
  return t != null && OBLIGATION.test(t);
}

/** The user's own promise or self-assigned task, not a vague maybe. */
export function looksLikeCommitment(text: string): boolean {
  const t = commitmentText(text);
  if (!t) return false;
  if (/\bi(?:'|’)?ll\b|\bi will\b/i.test(t)) return true;
  if (
    /\b(take care of (that|it)|i can do that (on|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i.test(
      t,
    )
  ) {
    return true;
  }
  return OBLIGATION.test(t);
}

const FOLLOW_ASK =
  /\b(please|can you|could you|would you|will you|keep an eye|let me know|make sure|need you to|don(?:'|’)?t forget)\b/i;
const FOLLOW_WHEN =
  /\b(tomorrow|tonight|next week|this week|later half|end of (?:the )?(?:day|week|month)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|(?:in|after) a few (?:days|weeks)|within \d+ (?:days|weeks)|expires?|deadline|due)\b/i;

/**
 * The user asked someone else to do something by a deadline.
 * The task for the user is to follow up, not to do the other person's chore.
 */
export function looksLikeFollowUp(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || t.length > 800) return false;
  if (/\b(maybe|might|if you have time)\b/i.test(t)) return false;
  return FOLLOW_ASK.test(t) && FOLLOW_WHEN.test(t);
}

const OPT_OUT = /\b(reply\s+stop|text\s+stop|stop\s+to\s+opt|opt[-\s]?out|unsubscribe)\b/i;
const CAMPAIGN =
  /\b(vote\s+(yes|no)|prop(?:osition)?\s*\d+|political action committee|\bpac\b|paid for by|ballots?\s+banked)\b/i;
const FUNDRAISING = /\b(please\s+donate|donate\s+now|chip\s+in|fundraising)\b/i;

/** Bulk political, fundraising, or opt-out traffic. A real account notice can keep an opt-out footer. */
export function looksLikeSolicitation(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (CAMPAIGN.test(t) || FUNDRAISING.test(t)) return true;
  return OPT_OUT.test(t) && !looksLikeRequest(t);
}

/**
 * An incoming message that asks the user to do something on their own account.
 * Campaigns and opt-out blasts are excluded by looksLikeSolicitation.
 */
export function looksLikeRequest(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || t.length > 4000) return false;
  if (/\b(verification code|one-time code|security code)\b/i.test(t)) return false;
  if (
    /\b(please|kindly)\s+(reply|send|sign|complete|review|download|upload|confirm|call|provide|submit|schedule|follow|log\s?in)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(you need to|what you need to do|action required|still waiting on|waiting on your|let us know what day|preferred day|what day and time)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/\b(e-?file|authorization form|client portal)\b/i.test(t)) return true;
  return /\bsign(?:ed|ing)?\b[^.]{0,60}\b(form|authorization|document|return)\b/i.test(t);
}

/** Outgoing promises, or incoming account requests that are not campaigns. */
export function shouldDraftMessage(message: { fromMe: boolean; selfNote?: boolean; text: string }): boolean {
  if (!message.text.trim()) return false;
  if (message.fromMe || message.selfNote) return looksLikeCommitment(message.text) || looksLikeFollowUp(message.text);
  if (looksLikeSolicitation(message.text)) return false;
  return looksLikeRequest(message.text);
}

export interface CommitmentDraft {
  title: string;
  due: string | null;
}

export function parseCommitmentReply(raw: string): CommitmentDraft | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      commit?: unknown;
      title?: unknown;
      due?: unknown;
    };
    if (parsed.commit !== true) return null;
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    if (!title) return null;
    const due = typeof parsed.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.due) ? parsed.due : null;
    return { title: title.slice(0, 180), due };
  } catch {
    return null;
  }
}

export function calendarYear(
  now = new Date(),
  timeZone = process.env.BRIEFING_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
): number {
  return Number(now.toLocaleDateString("en-CA", { timeZone }).slice(0, 4));
}

/**
 * A due year is kept when the message writes that year on a date.
 * A bare mention, such as a tax year, does not count. Otherwise the year is the current one.
 */
export function normalizeDueYear(due: string | null, text: string, currentYear: number): string | null {
  if (due == null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const nextYear = /\bnext year\b/i.test(text);
  const lastYear = /\blast year\b/i.test(text);
  let target = currentYear;
  if (dueYearIsWritten(year, text)) return due;
  if (nextYear) target = currentYear + 1;
  else if (lastYear) target = currentYear - 1;
  if (year === target) return due;
  const candidate = `${target}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  if (parsed.getUTCFullYear() !== target || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) {
    return null;
  }
  return candidate;
}

function dueYearIsWritten(year: number, text: string): boolean {
  const y = String(year);
  const month =
    "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  return [
    new RegExp(`\\b${month}\\.?\\s+\\d{1,2},?\\s+${y}\\b`, "i"),
    new RegExp(`\\b${y}[-/]\\d{1,2}[-/]\\d{1,2}\\b`),
    new RegExp(`\\b\\d{1,2}[-/]\\d{1,2}[-/]${y}\\b`),
    new RegExp(`\\b(?:in|by|before|after|during)\\s+${y}\\b`, "i"),
  ].some((pattern) => pattern.test(text));
}

interface SqliteDatabase {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

type DatabaseSyncCtor = new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;

const nodeRequire = createRequire(import.meta.url);

function openMessagesDb(): SqliteDatabase | null {
  const dbPath = path.join(homedir(), "Library", "Messages", "chat.db");
  try {
    const { DatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: DatabaseSyncCtor };
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

function mapMessageRow(row: Record<string, unknown>, fromMe: boolean): IncomingMessage {
  const style = row.chatStyle == null ? null : Number(row.chatStyle);
  const participantCount = Number(row.participantCount ?? 0);
  const isGroup = chatIsGroup(Number.isFinite(style) ? style : null, participantCount);
  const directHandle = row.directHandle == null ? null : String(row.directHandle);
  const chatName = row.chatName == null || String(row.chatName).trim() === "" ? null : String(row.chatName);
  return {
    id: Number(row.id),
    text: messagePlainText(row.text, row.body),
    fromMe,
    handle: isGroup ? null : directHandle,
    priorText: messagePlainText(row.priorText, row.priorBody) || null,
    priorFromMe: Number(row.priorFromMe) === 1,
    priorHandle: row.priorHandle == null ? null : String(row.priorHandle),
    isGroup,
    chatName,
    participantCount,
    sentAt: typeof row.seconds === "number" ? isoFromAppleSeconds(row.seconds) : null,
  };
}

const OUTGOING_SQL = `SELECT m.ROWID AS id, m.text AS text, m.attributedBody AS body,
    CASE WHEN m.date > 1000000000000000 THEN m.date / 1000000000 ELSE m.date END AS seconds,
    c.ROWID AS chatId, c.display_name AS chatName, c.style AS chatStyle,
    (SELECT COUNT(*) FROM chat_handle_join ch WHERE ch.chat_id = c.ROWID) AS participantCount,
    (SELECT h1.id FROM chat_handle_join ch1
      JOIN handle h1 ON h1.ROWID = ch1.handle_id
      WHERE ch1.chat_id = c.ROWID LIMIT 1) AS directHandle
  FROM message m
  LEFT JOIN chat c ON c.ROWID = (
    SELECT j.chat_id FROM chat_message_join j WHERE j.message_id = m.ROWID ORDER BY j.chat_id LIMIT 1
  )
  WHERE m.ROWID > ? AND m.is_from_me = 1
    AND ((m.text IS NOT NULL AND m.text != '') OR m.attributedBody IS NOT NULL)
  ORDER BY m.ROWID ASC
  LIMIT ?`;

const PRIOR_SQL = `SELECT p.text AS text, p.attributedBody AS body, p.is_from_me AS fromMe, h.id AS handle
  FROM message p
  JOIN chat_message_join pj ON pj.message_id = p.ROWID
  LEFT JOIN handle h ON h.ROWID = p.handle_id AND p.is_from_me = 0
  WHERE pj.chat_id = ? AND p.ROWID < ?
    AND ((p.text IS NOT NULL AND p.text != '') OR p.attributedBody IS NOT NULL)
  ORDER BY p.ROWID DESC
  LIMIT 1`;

/** Messages the user sent after the cursor, with the chat and the previous line for context. */
export function readNewOutgoingMessages(afterId: number, limit = 80): IncomingMessage[] | null {
  const db = openMessagesDb();
  if (!db) return null;
  try {
    const rows = db.prepare(OUTGOING_SQL).all(afterId, limit) as Array<Record<string, unknown>>;
    const prior = db.prepare(PRIOR_SQL);
    return rows.map((row) => {
      const message = mapMessageRow(row, true);
      if ((!looksLikeCommitment(message.text) && !looksLikeFollowUp(message.text)) || row.chatId == null) return message;
      const earlier = prior.all(row.chatId, message.id)[0] as Record<string, unknown> | undefined;
      if (!earlier) return message;
      message.priorText = messagePlainText(earlier.text, earlier.body) || null;
      message.priorFromMe = Number(earlier.fromMe) === 1;
      message.priorHandle = earlier.handle == null || message.priorFromMe ? null : String(earlier.handle);
      return message;
    });
  } finally {
    db.close();
  }
}

const INCOMING_SQL = `SELECT m.ROWID AS id, m.text AS text, m.attributedBody AS body,
    CASE WHEN m.date > 1000000000000000 THEN m.date / 1000000000 ELSE m.date END AS seconds,
    c.ROWID AS chatId, c.display_name AS chatName, c.style AS chatStyle,
    (SELECT COUNT(*) FROM chat_handle_join ch WHERE ch.chat_id = c.ROWID) AS participantCount,
    h.id AS directHandle
  FROM message m
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  LEFT JOIN chat c ON c.ROWID = (
    SELECT j.chat_id FROM chat_message_join j WHERE j.message_id = m.ROWID ORDER BY j.chat_id LIMIT 1
  )
  WHERE m.ROWID > ? AND m.is_from_me = 0
    AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)
    AND ((m.text IS NOT NULL AND m.text != '') OR m.attributedBody IS NOT NULL)
  ORDER BY m.ROWID ASC
  LIMIT ?`;

/** Addresses this Mac sends from. A direct chat with one of them is a note to yourself. */
function ownSenderIds(db: SqliteDatabase): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT destination_caller_id AS id FROM message
       WHERE is_from_me = 1 AND destination_caller_id IS NOT NULL AND destination_caller_id != ''`,
    )
    .all() as Array<{ id?: string }>;
  return rows.map((row) => row.id).filter((id): id is string => Boolean(id));
}

/**
 * The received copy of a note the user sent to themself.
 * Messages keeps that copy as incoming, so the sent-message scan never sees it.
 */
export function readNewSelfNotes(afterId: number, limit = 80): IncomingMessage[] | null {
  const db = openMessagesDb();
  if (!db) return null;
  try {
    const own = ownSenderIds(db);
    if (!own.length) return [];
    const placeholders = own.map(() => "?").join(", ");
    const sql = INCOMING_SQL.replace(
      "WHERE m.ROWID > ? AND m.is_from_me = 0",
      `WHERE m.ROWID > ? AND m.is_from_me = 0 AND h.id IN (${placeholders})`,
    );
    const rows = db.prepare(sql).all(afterId, ...own, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const message = mapMessageRow(row, true);
      if (!message.isGroup) message.selfNote = true;
      return message;
    });
  } finally {
    db.close();
  }
}

/** Messages other people sent after the cursor. */
export function readNewIncomingMessages(afterId: number, limit = 80): IncomingMessage[] | null {
  const db = openMessagesDb();
  if (!db) return null;
  try {
    const rows = db.prepare(INCOMING_SQL).all(afterId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapMessageRow(row, false));
  } finally {
    db.close();
  }
}

/** Seconds since 2001-01-01. Fits in a JS number; raw nanosecond dates do not. */
export function appleSeconds(nowMs: number): number {
  return Math.floor((nowMs - APPLE_EPOCH_MS) / 1000);
}

export function isoFromAppleSeconds(seconds: number): string {
  return new Date(APPLE_EPOCH_MS + seconds * 1000).toISOString();
}

/**
 * `message.date` is seconds or nanoseconds. Comparing it in SQLite avoids pulling
 * an integer bigger than Number.MAX_SAFE_INTEGER into JavaScript.
 */
const DATE_AS_SECONDS = "CASE WHEN date > 1000000000000000 THEN date / 1000000000 ELSE date END";

/**
 * Rowid to start from on the first scan.
 * A lookback of 0 returns the latest row so history is skipped.
 * A positive lookback returns the last row older than that window, or 0 when every row is inside it.
 */
export function initialScanCursor(lookbackDays: number, nowMs = Date.now()): number | null {
  const db = openMessagesDb();
  if (!db) return null;
  try {
    if (lookbackDays <= 0) {
      const rows = db.prepare("SELECT MAX(ROWID) AS id FROM message").all() as Array<{ id?: number | null }>;
      const id = rows[0]?.id;
      return typeof id === "number" ? id : 0;
    }
    const cutoff = appleSeconds(nowMs - lookbackDays * 86_400_000);
    const rows = db
      .prepare(`SELECT MAX(ROWID) AS id FROM message WHERE ${DATE_AS_SECONDS} < ?`)
      .all(cutoff) as Array<{ id?: number | null }>;
    const id = rows[0]?.id;
    return typeof id === "number" ? id : 0;
  } finally {
    db.close();
  }
}

export interface MessageContextLine {
  id: number;
  at: string | null;
  fromMe: boolean;
  handle: string | null;
  text: string;
  focus: boolean;
}

const CONTEXT_SQL = `SELECT m.ROWID AS id,
    CASE WHEN m.date > 1000000000000000 THEN m.date / 1000000000 ELSE m.date END AS seconds,
    m.is_from_me AS fromMe, m.text AS text, m.attributedBody AS body, h.id AS handle
  FROM message m
  JOIN chat_message_join j ON j.message_id = m.ROWID
  LEFT JOIN handle h ON h.ROWID = m.handle_id AND m.is_from_me = 0
  WHERE j.chat_id = ? AND m.ROWID __OP__ ?
    AND ((m.text IS NOT NULL AND m.text != '') OR m.attributedBody IS NOT NULL)
  ORDER BY m.ROWID __ORDER__
  LIMIT ?`;

function contextLine(row: Record<string, unknown>, focusId: number): MessageContextLine {
  const fromMe = Number(row.fromMe) === 1;
  return {
    id: Number(row.id),
    at: typeof row.seconds === "number" ? isoFromAppleSeconds(row.seconds) : null,
    fromMe,
    handle: fromMe || row.handle == null ? null : String(row.handle),
    text: messagePlainText(row.text, row.body).slice(0, 1000),
    focus: Number(row.id) === focusId,
  };
}

/** When the triggering message was sent. */
export function readMessageSentAt(ids: number[]): Record<number, string> {
  const wanted = ids.filter((id) => Number.isInteger(id));
  if (!wanted.length) return {};
  const db = openMessagesDb();
  if (!db) return {};
  try {
    const placeholders = wanted.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT ROWID AS id,
            CASE WHEN date > 1000000000000000 THEN date / 1000000000 ELSE date END AS seconds
         FROM message WHERE ROWID IN (${placeholders})`,
      )
      .all(...wanted) as Array<{ id?: number; seconds?: number }>;
    const found: Record<number, string> = {};
    for (const row of rows) {
      if (typeof row.id === "number" && typeof row.seconds === "number") {
        found[row.id] = isoFromAppleSeconds(row.seconds);
      }
    }
    return found;
  } finally {
    db.close();
  }
}

/** Five messages before and five after, in the same chat, plus the message itself. */
export function readMessageContext(messageId: number, radius = 5): MessageContextLine[] | null {
  const db = openMessagesDb();
  if (!db) return null;
  try {
    const chats = db
      .prepare("SELECT chat_id AS chatId FROM chat_message_join WHERE message_id = ? LIMIT 1")
      .all(messageId) as Array<{ chatId?: number }>;
    const chatId = chats[0]?.chatId;
    if (typeof chatId !== "number") return [];
    const before = db
      .prepare(CONTEXT_SQL.replace("__OP__", "<").replace("__ORDER__", "DESC"))
      .all(chatId, messageId, radius) as Array<Record<string, unknown>>;
    const after = db
      .prepare(CONTEXT_SQL.replace("__OP__", ">").replace("__ORDER__", "ASC"))
      .all(chatId, messageId, radius) as Array<Record<string, unknown>>;
    const focus = db
      .prepare(
        `SELECT m.ROWID AS id,
            CASE WHEN m.date > 1000000000000000 THEN m.date / 1000000000 ELSE m.date END AS seconds,
            m.is_from_me AS fromMe, m.text AS text, m.attributedBody AS body, h.id AS handle
         FROM message m
         LEFT JOIN handle h ON h.ROWID = m.handle_id AND m.is_from_me = 0
         WHERE m.ROWID = ?`,
      )
      .all(messageId) as Array<Record<string, unknown>>;
    return [...before.reverse(), ...focus, ...after].map((row) => contextLine(row, messageId));
  } finally {
    db.close();
  }
}
