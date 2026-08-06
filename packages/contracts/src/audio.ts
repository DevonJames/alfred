import { z } from "zod";

/** Provider-neutral PCM audio frame (typically Int16 LE). */
export const AudioFrameSchema = z.object({
  data: z.instanceof(Uint8Array),
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive().optional(),
  samplesPerChannel: z.number().int().nonnegative().optional(),
  timestampMs: z.number().nonnegative().optional(),
});
export type AudioFrame = {
  data: Uint8Array;
  sampleRate: number;
  channels?: number;
  samplesPerChannel?: number;
  timestampMs?: number;
};

export const VadSignalSchema = z.object({
  speaking: z.boolean(),
  confidence: z.number().min(0).max(1).optional(),
  atMs: z.number().nonnegative(),
});
export type VadSignal = z.infer<typeof VadSignalSchema>;
