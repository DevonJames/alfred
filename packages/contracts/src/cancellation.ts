import { z } from "zod";

export const CancellationReasonSchema = z.enum([
  "user_cancellation",
  "interruption",
  "provider_timeout",
  "provider_failure",
  "superseded_generation",
  "session_termination",
  "application_shutdown",
]);
export type CancellationReason = z.infer<typeof CancellationReasonSchema>;
