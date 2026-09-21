/**
 * Robot / Talk expression events.
 *
 * GPT-Live cannot emit LiveKit Expressive Mode (`lk.expression`). The voice
 * worker calls `show_expression`; clients consume `alfred.expression`.
 * Face + body are allow-listed. The receiving client owns the calm timeout.
 */

export const EXPRESSION_TOPIC = "alfred.expression";

export const EXPRESSION_FACES = [
  "calm",
  "smile",
  "frown",
  "wink",
  "curious",
  "surprised",
  "empathetic",
  "sad",
  "angry",
] as const;

export const EXPRESSION_BODIES = ["none", "nod", "tilt", "wave", "shake"] as const;

export type ExpressionFace = (typeof EXPRESSION_FACES)[number];
export type ExpressionBody = (typeof EXPRESSION_BODIES)[number];

/** Default how long a non-calm face holds before returning to rest. */
export const DEFAULT_EXPRESSION_TIMEOUT_MS = 8_000;
export const MAX_EXPRESSION_TIMEOUT_MS = 20_000;
export const MIN_EXPRESSION_TIMEOUT_MS = 1_500;

export interface ExpressionEvent {
  v: 1;
  channel: typeof EXPRESSION_TOPIC;
  type: "set" | "clear";
  face: ExpressionFace;
  body: ExpressionBody;
  timeoutMs: number;
  atMs: number;
}

export function isExpressionFace(value: string): value is ExpressionFace {
  return (EXPRESSION_FACES as readonly string[]).includes(value);
}

export function isExpressionBody(value: string): value is ExpressionBody {
  return (EXPRESSION_BODIES as readonly string[]).includes(value);
}

export function clampExpressionTimeout(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return DEFAULT_EXPRESSION_TIMEOUT_MS;
  return Math.min(MAX_EXPRESSION_TIMEOUT_MS, Math.max(MIN_EXPRESSION_TIMEOUT_MS, Math.round(ms)));
}

export function buildExpressionEvent(input: {
  type?: "set" | "clear";
  face?: string;
  body?: string;
  timeoutMs?: number;
  atMs?: number;
}): ExpressionEvent {
  const requested = input.type === "clear" ? "clear" : "set";
  const faceRaw = (input.face ?? "calm").trim().toLowerCase();
  const bodyRaw = (input.body ?? "none").trim().toLowerCase();
  const face: ExpressionFace = isExpressionFace(faceRaw) ? faceRaw : "calm";
  const body: ExpressionBody = isExpressionBody(bodyRaw) ? bodyRaw : "none";
  const type = requested === "clear" || face === "calm" ? "clear" : "set";
  return {
    v: 1,
    channel: EXPRESSION_TOPIC,
    type,
    face: type === "clear" ? "calm" : face,
    body: type === "clear" ? "none" : body,
    timeoutMs: clampExpressionTimeout(input.timeoutMs),
    atMs: input.atMs ?? Date.now(),
  };
}

export function parseExpressionPayload(data: Uint8Array): ExpressionEvent | undefined {
  try {
    const raw = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
    if (raw.channel && raw.channel !== EXPRESSION_TOPIC) return undefined;
    if (raw.v != null && raw.v !== 1) return undefined;
    const type = raw.type === "clear" ? "clear" : raw.type === "set" ? "set" : undefined;
    if (!type) return undefined;
    return buildExpressionEvent({
      type,
      face: typeof raw.face === "string" ? raw.face : undefined,
      body: typeof raw.body === "string" ? raw.body : undefined,
      timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : undefined,
      atMs: typeof raw.atMs === "number" ? raw.atMs : undefined,
    });
  } catch {
    return undefined;
  }
}
