/**
 * Standing medicine and supplement schedule, plus today's taken log.
 * The user's plan decides timing and quantity. Bottle text is identity only.
 */

export type MedicinePeriod = "morning" | "midday" | "evening";
/** "daily", or weekday numbers Sunday = 0 through Saturday = 6. */
export type MedicineDays = "daily" | number[];

export interface MedicineItem {
  id: string;
  name: string;
  quantity: string;
  period: MedicinePeriod;
  instruction: string;
  days: MedicineDays;
  labelText: string;
  needsReview: boolean;
  imageId?: string;
}

export interface MedicineDraft {
  name: string;
  quantity: string;
  period: MedicinePeriod;
  instruction: string;
  days: MedicineDays;
  labelText: string;
  needsReview: boolean;
  imageIndex?: number;
}

export interface MedicineLogEntry {
  itemId: string;
  taken: boolean;
}

export interface MedicineDayLog {
  date: string;
  entries: MedicineLogEntry[];
}

export type MedicineLogMode = "only" | "all" | "except" | "undo" | "status";

export interface MedicineLogRequest {
  mode: MedicineLogMode;
  period?: MedicinePeriod;
  names?: string[];
  ids?: string[];
}

export interface MedicineScheduleViewItem extends MedicineItem {
  taken: boolean;
  dueToday: boolean;
}

const PERIODS: MedicinePeriod[] = ["morning", "midday", "evening"];
const MAX_ITEMS = 40;

export function normalizeMedicineName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function weekdayOfDayKey(dayKey: string): number {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)).getUTCDay();
}

export function itemDueOn(item: MedicineItem, dayKey: string): boolean {
  if (item.days === "daily" || !Array.isArray(item.days) || item.days.length === 0) return true;
  return item.days.includes(weekdayOfDayKey(dayKey));
}

export function emptyMedicineLog(date: string): MedicineDayLog {
  return { date, entries: [] };
}

export function takenIds(log: MedicineDayLog): Set<string> {
  return new Set(log.entries.filter((entry) => entry.taken).map((entry) => entry.itemId));
}

export function scheduleView(
  items: MedicineItem[],
  log: MedicineDayLog,
  dayKey: string,
): MedicineScheduleViewItem[] {
  const taken = takenIds(log.date === dayKey ? log : emptyMedicineLog(dayKey));
  return items.map((item) => ({
    ...item,
    dueToday: itemDueOn(item, dayKey),
    taken: taken.has(item.id),
  }));
}

export function untakenMorningItems(
  items: MedicineItem[],
  log: MedicineDayLog,
  dayKey: string,
): MedicineItem[] {
  const taken = takenIds(log.date === dayKey ? log : emptyMedicineLog(dayKey));
  return items.filter(
    (item) => item.period === "morning" && itemDueOn(item, dayKey) && !taken.has(item.id),
  );
}

export function formatMedicineSpeech(items: MedicineItem[]): string | null {
  if (!items.length) return null;
  const sentences = items.map(speakItem);
  return `Morning medicine: ${sentences.join(". ")}.`;
}

export function formatMedicineMarkdown(items: MedicineItem[]): string {
  if (!items.length) return "";
  return ["## Morning medicine", "", ...items.map((item) => `- ${medicineDisplayLine(item)}`)].join(
    "\n",
  );
}

export function medicineDisplayLines(items: MedicineItem[]): string[] {
  return items.map(medicineDisplayLine);
}

export function parseMedicineDrafts(raw: string): MedicineDraft[] | null {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return null;
    return parsed.items.flatMap(cleanDraft).slice(0, MAX_ITEMS);
  } catch {
    return null;
  }
}

export function attachDraftImages<T extends MedicineDraft>(
  drafts: T[],
  imageIds: string[],
): Array<T & { imageId?: string }> {
  return drafts.map((draft) => {
    const index = draft.imageIndex;
    if (typeof index === "number" && imageIds[index - 1]) {
      return { ...draft, imageId: imageIds[index - 1] };
    }
    if (drafts.length === 1 && imageIds.length === 1) {
      return { ...draft, imageId: imageIds[0] };
    }
    return { ...draft };
  });
}

export function mergeMedicineItems(
  existing: MedicineItem[],
  drafts: Array<MedicineDraft & { imageId?: string }>,
  newId: () => string,
): { items: MedicineItem[]; added: string[]; updated: string[] } {
  const items = existing.map((item) => ({ ...item }));
  const used = new Set<string>();
  const added: string[] = [];
  const updated: string[] = [];

  for (const draft of drafts) {
    const name = draft.name.trim();
    if (!name) continue;
    const target = findMergeTarget(items, name, used);
    if (!target) {
      if (items.length >= MAX_ITEMS) continue;
      const created = itemFromDraft(newId(), draft);
      items.push(created);
      used.add(created.id);
      added.push(created.name);
      continue;
    }
    used.add(target.id);
    const next = {
      ...target,
      name: preferName(target.name, name),
      quantity: draft.quantity.trim() || target.quantity,
      period: draft.period,
      instruction: draft.instruction.trim() || target.instruction,
      days: draft.days,
      labelText: draft.labelText.trim() || target.labelText,
      needsReview: draft.needsReview || !draft.quantity.trim(),
      imageId: draft.imageId || target.imageId,
    };
    const index = items.findIndex((item) => item.id === target.id);
    items[index] = next;
    updated.push(next.name);
  }

  return { items, added, updated };
}

export function mergeSummary(added: string[], updated: string[]): string {
  if (!added.length && !updated.length) return "Nothing new to add.";
  const parts: string[] = [];
  if (added.length) parts.push(`Added ${joinSpoken(added)}.`);
  if (updated.length) parts.push(`Updated ${joinSpoken(updated)}.`);
  return parts.join(" ");
}

export interface MedicineItemPatch {
  name?: string;
  quantity?: string;
  period?: MedicinePeriod;
  instruction?: string;
  days?: MedicineDays;
}

export function patchMedicineItem(item: MedicineItem, patch: MedicineItemPatch): MedicineItem {
  const name = patch.name !== undefined ? patch.name.trim() : item.name;
  if (!name) throw new Error("Name is required");
  const quantity = patch.quantity !== undefined ? patch.quantity.trim() : item.quantity;
  const instruction = patch.instruction !== undefined ? patch.instruction.trim() : item.instruction;
  return {
    ...item,
    name: name.slice(0, 120),
    quantity: quantity.slice(0, 80),
    period: patch.period ?? item.period,
    instruction: instruction.slice(0, 160),
    days: patch.days ?? item.days,
    needsReview: quantity ? false : true,
  };
}

export function applyMedicineLog(
  items: MedicineItem[],
  log: MedicineDayLog,
  request: MedicineLogRequest,
  dayKey: string,
): { log: MedicineDayLog; speech: string; changed: boolean } {
  const current = log.date === dayKey ? log : emptyMedicineLog(dayKey);
  if (request.mode === "status") {
    return { log: current, speech: formatMedicineStatus(items, current, dayKey), changed: false };
  }
  if (!items.length) {
    return { log: current, speech: "You don't have a medicine schedule yet.", changed: false };
  }

  const due = items.filter((item) => itemDueOn(item, dayKey));
  const scope = request.period ? due.filter((item) => item.period === request.period) : due;

  if (request.mode === "all") {
    if (!scope.length) {
      return { log: current, speech: emptyScopeSpeech(request.period), changed: false };
    }
    return writeTaken(current, scope.map((item) => item.id), true, allTakenSpeech(request.period, scope));
  }

  if (request.mode === "except") {
    const resolved = resolveRequestItems(items, due, scope, request);
    if (!resolved.ok) return { log: current, speech: resolved.speech, changed: false };
    if (!scope.length) {
      return { log: current, speech: emptyScopeSpeech(request.period), changed: false };
    }
    const exclude = new Set(resolved.items.map((item) => item.id));
    const mark = scope.filter((item) => !exclude.has(item.id)).map((item) => item.id);
    const clear = resolved.items.map((item) => item.id);
    const next = writeTakenIds(current, mark, true);
    const cleared = writeTakenIds(next.log, clear, false);
    return {
      log: cleared.log,
      changed: next.changed || cleared.changed,
      speech: exceptSpeech(request.period, resolved.items),
    };
  }

  const resolved = resolveRequestItems(items, due, request.period ? scope : due, request);
  if (!resolved.ok) return { log: current, speech: resolved.speech, changed: false };
  if (request.mode === "undo") {
    return writeTaken(
      current,
      resolved.items.map((item) => item.id),
      false,
      `Cleared ${joinSpoken(resolved.items.map((item) => item.name))} for today.`,
    );
  }
  return writeTaken(
    current,
    resolved.items.map((item) => item.id),
    true,
    `Marked ${joinSpoken(resolved.items.map((item) => item.name))} taken.`,
  );
}

export function formatMedicineStatus(items: MedicineItem[], log: MedicineDayLog, dayKey: string): string {
  const due = items.filter((item) => itemDueOn(item, dayKey));
  if (!due.length) return "Nothing is on today's medicine schedule.";
  const taken = takenIds(log.date === dayKey ? log : emptyMedicineLog(dayKey));
  const parts: string[] = [];
  for (const period of PERIODS) {
    const group = due.filter((item) => item.period === period);
    if (!group.length) continue;
    const open = group.filter((item) => !taken.has(item.id));
    const done = group.filter((item) => taken.has(item.id));
    const label = periodLabel(period);
    if (open.length) parts.push(`Still to take ${label}: ${joinSpoken(open.map(speakItem))}.`);
    if (done.length) parts.push(`Already taken ${label}: ${joinSpoken(done.map((item) => item.name))}.`);
  }
  return parts.join(" ");
}

export function isMedicinePeriod(value: string): value is MedicinePeriod {
  return (PERIODS as string[]).includes(value);
}

export function isMedicineLogMode(value: string): value is MedicineLogMode {
  return value === "only" || value === "all" || value === "except" || value === "undo" || value === "status";
}

function cleanDraft(raw: unknown): MedicineDraft[] {
  if (!raw || typeof raw !== "object") return [];
  const row = raw as Record<string, unknown>;
  const name = typeof row.name === "string" ? row.name.trim().slice(0, 120) : "";
  if (!name) return [];
  const quantity = typeof row.quantity === "string" ? row.quantity.trim().slice(0, 80) : "";
  const instruction = typeof row.instruction === "string" ? row.instruction.trim().slice(0, 160) : "";
  const labelText = typeof row.labelText === "string" ? row.labelText.trim().slice(0, 500) : "";
  const period = parsePeriod(row.period);
  const imageIndex =
    typeof row.imageIndex === "number" && Number.isInteger(row.imageIndex) && row.imageIndex > 0
      ? row.imageIndex
      : undefined;
  const needsReview = row.needsReview === true || period.uncertain || !quantity;
  return [
    {
      name,
      quantity,
      period: period.period,
      instruction,
      days: parseDays(row.days),
      labelText,
      needsReview,
      imageIndex,
    },
  ];
}

function parsePeriod(value: unknown): { period: MedicinePeriod; uncertain: boolean } {
  const raw = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (raw === "morning" || raw === "am") return { period: "morning", uncertain: false };
  if (raw === "midday" || raw === "afternoon" || raw === "noon" || raw === "lunch") {
    return { period: "midday", uncertain: false };
  }
  if (raw === "evening" || raw === "night" || raw === "bedtime") {
    return { period: "evening", uncertain: false };
  }
  return { period: "morning", uncertain: true };
}

function parseDays(value: unknown): MedicineDays {
  if (typeof value === "string") {
    const raw = value.toLowerCase().trim();
    if (raw === "weekdays" || raw === "weekday") return [1, 2, 3, 4, 5];
    if (raw === "weekends" || raw === "weekend") return [0, 6];
    return "daily";
  }
  if (!Array.isArray(value)) return "daily";
  const days = [...new Set(value.map(Number).filter((day) => day >= 0 && day <= 6))].sort((a, b) => a - b);
  if (!days.length || days.length === 7) return "daily";
  return days;
}

function itemFromDraft(id: string, draft: MedicineDraft & { imageId?: string }): MedicineItem {
  return {
    id,
    name: draft.name.trim(),
    quantity: draft.quantity.trim(),
    period: draft.period,
    instruction: draft.instruction.trim(),
    days: draft.days,
    labelText: draft.labelText.trim(),
    needsReview: draft.needsReview || !draft.quantity.trim(),
    imageId: draft.imageId,
  };
}

function findMergeTarget(items: MedicineItem[], name: string, used: Set<string>): MedicineItem | null {
  const available = items.filter((item) => !used.has(item.id));
  const matches = matchMedicineByName(available, name);
  const needle = normalizeMedicineName(name);
  const exact = matches.filter((item) => normalizeMedicineName(item.name) === needle);
  if (exact.length === 1) return exact[0] ?? null;
  if (matches.length === 1) return matches[0] ?? null;
  return null;
}

function preferName(existing: string, incoming: string): string {
  const current = normalizeMedicineName(existing);
  const next = normalizeMedicineName(incoming);
  if (!next || current === next) return existing;
  if (current.includes(next) && next.length < current.length) return existing;
  return incoming;
}

function matchMedicineByName(items: MedicineItem[], name: string): MedicineItem[] {
  const needle = normalizeMedicineName(name);
  if (!needle) return [];
  const exact = items.filter((item) => normalizeMedicineName(item.name) === needle);
  if (exact.length) return exact;
  return items.filter((item) => {
    const normalized = normalizeMedicineName(item.name);
    return normalized.includes(needle) || needle.includes(normalized);
  });
}

function resolveRequestItems(
  items: MedicineItem[],
  due: MedicineItem[],
  pool: MedicineItem[],
  request: MedicineLogRequest,
): { ok: true; items: MedicineItem[] } | { ok: false; speech: string } {
  if (request.ids?.length) {
    const found: MedicineItem[] = [];
    for (const id of request.ids) {
      const item = items.find((candidate) => candidate.id === id);
      if (!item) return { ok: false, speech: "I couldn't find that item on the schedule." };
      found.push(item);
    }
    return { ok: true, items: found };
  }
  const names = (request.names ?? []).map((name) => name.trim()).filter(Boolean);
  if (!names.length) {
    return {
      ok: false,
      speech: request.mode === "except" ? "Which one should I leave untaken?" : "Which one did you mean?",
    };
  }
  const found: MedicineItem[] = [];
  for (const name of names) {
    const matches = matchMedicineByName(pool, name);
    if (matches.length > 1) {
      return {
        ok: false,
        speech: `Which ${name} did you mean: ${joinSpoken(matches.map((item) => item.name))}?`,
      };
    }
    if (matches.length === 1 && matches[0]) {
      found.push(matches[0]);
      continue;
    }
    const elsewhere = matchMedicineByName(request.period ? due : items, name);
    if (elsewhere.length === 1 && elsewhere[0] && request.period && elsewhere[0].period !== request.period) {
      return {
        ok: false,
        speech: `${elsewhere[0].name} is on your ${periodLabel(elsewhere[0].period)} schedule.`,
      };
    }
    return { ok: false, speech: `I don't see ${name} on today's medicine schedule.` };
  }
  return { ok: true, items: found };
}

function writeTaken(
  log: MedicineDayLog,
  ids: string[],
  taken: boolean,
  speech: string,
): { log: MedicineDayLog; speech: string; changed: boolean } {
  const next = writeTakenIds(log, ids, taken);
  return { log: next.log, speech, changed: next.changed };
}

function writeTakenIds(
  log: MedicineDayLog,
  ids: string[],
  taken: boolean,
): { log: MedicineDayLog; changed: boolean } {
  const map = new Map(log.entries.map((entry) => [entry.itemId, entry.taken]));
  let changed = false;
  for (const id of ids) {
    const previous = map.get(id) === true;
    if (previous !== taken) changed = true;
    map.set(id, taken);
  }
  const entries = [...map.entries()]
    .filter(([, isTaken]) => isTaken)
    .map(([itemId]) => ({ itemId, taken: true }));
  return { log: { date: log.date, entries }, changed };
}

function allTakenSpeech(period: MedicinePeriod | undefined, items: MedicineItem[]): string {
  const label = period ? `your ${periodLabel(period)} medicine` : "today's medicine";
  return `Marked ${label} taken: ${joinSpoken(items.map((item) => item.name))}.`;
}

function exceptSpeech(period: MedicinePeriod | undefined, left: MedicineItem[]): string {
  const label = period ? `your ${periodLabel(period)} medicine` : "today's medicine";
  return `Marked the rest of ${label} taken, and left ${joinSpoken(left.map((item) => item.name))} untaken.`;
}

function emptyScopeSpeech(period: MedicinePeriod | undefined): string {
  if (!period) return "Nothing is on today's medicine schedule.";
  return `Nothing is scheduled for ${periodLabel(period)}.`;
}

function periodLabel(period: MedicinePeriod): string {
  if (period === "midday") return "mid-day";
  return period;
}

function speakItem(item: MedicineItem): string {
  const extra = [item.quantity.trim(), item.instruction.trim()].filter(Boolean);
  if (!extra.length) return item.name;
  return `${item.name}, ${extra.join(", ")}`;
}

function medicineDisplayLine(item: MedicineItem): string {
  const extra = [item.quantity.trim(), item.instruction.trim()].filter(Boolean).join(", ");
  return extra ? `${item.name} — ${extra}` : item.name;
}

function joinSpoken(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
