import { z } from "zod";

/** Credential reference — never store raw secrets in config documents committed to git. */
export const SecretRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("env"),
    name: z.string().min(1),
  }),
  z.object({
    kind: z.literal("encrypted"),
    ciphertext: z.string().min(1),
    keyId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("localStub"),
    /** Test-only stub value. Must not be used for production credentials. */
    stubValue: z.string(),
  }),
]);
export type SecretRef = z.infer<typeof SecretRefSchema>;

export const PermissionScopeSchema = z.enum([
  "conversation.read",
  "conversation.write",
  "memory.read",
  "memory.write",
  "memory.admin",
  "agent.delegate",
  "agent.confirm",
  "provider.configure",
  "secrets.read",
]);
export type PermissionScope = z.infer<typeof PermissionScopeSchema>;

export const AuditEventSchema = z.object({
  id: z.string(),
  timestamp: z.string().datetime(),
  actor: z.string(),
  action: z.string(),
  resource: z.string(),
  scopes: z.array(PermissionScopeSchema).default([]),
  outcome: z.enum(["allowed", "denied", "error"]),
  detail: z.record(z.unknown()).optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;
