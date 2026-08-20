/**
 * Wire types shared by the cloud and desktop clients.
 * These mirror the desktop host contract in PRD §8.3 and §11.2.
 */

export type ConnectionMode = "local" | "direct" | "relay" | "offline";
export type Confidence = "remembered" | "likely" | "ambiguous" | "inferred" | "unknown";
export type ProcessingState = "stored" | "extracting" | "indexed" | "needs_resolution";
export type MemoryKind = "entity" | "episode" | "note";
export type EntityType = "Person" | "Place" | "Thing" | "Organization" | "Event" | "Topic";
export type ForgetScope = "artifact" | "extracted" | "entity" | "episode" | "subgraph";

export interface CloudUser {
  id: string;
  email: string;
  displayName: string | null;
}

export interface DesktopSummary {
  serverId: string;
  name: string;
  claimedAt: string | null;
  lastSeenAt: string;
  online: boolean;
}

export interface Candidate {
  type: "lan" | "wan" | "relay";
  url: string;
  priority: number;
}

export interface ConnectInfo {
  desktopClientId: string;
  name: string;
  claimSecret: string;
  claimed: boolean;
  activeMemoryProvider: string;
  privacyMode: "local_only" | "private_hybrid" | "user_managed";
  voiceMode: "cascaded" | "unified";
  profileId: string;
  capabilities: string[];
}

export interface ArtifactRef {
  id: string;
  hash: string;
  hashAlgorithm: string;
  filename: string;
  mimeType: string;
  byteLength: number;
  available: boolean;
  url: string;
}

export interface AssertionRef {
  id: string;
  text: string;
  confidence: Confidence;
  revision: number;
  current: boolean;
  supersedes: string | null;
  supersededBy: string | null;
  sourceKind: string;
  createdAt: string;
}

export interface RelatedRef {
  id: string;
  title: string;
  kind: MemoryKind;
  entityType: EntityType | null;
  relation: string;
}

export interface Reminder {
  dueAt: string;
  dateOnly: boolean;
  timezone: string;
  status: "pending" | "completed" | "dismissed" | "snoozed";
  surfacedAt: string | null;
  snoozedUntil: string | null;
}

export interface Memory {
  id: string;
  kind: MemoryKind;
  entityType: EntityType | null;
  title: string;
  summary: string;
  revision: number;
  processingState: ProcessingState;
  confidence: Confidence;
  needsResolution: { field: string; question: string; options: string[] }[];
  occurredAt: string | null;
  visibility: "private" | "public";
  owner: string;
  reminder: Reminder | null;
  createdAt: string;
  updatedAt: string;
  artifactsForgotten: boolean;
  artifacts: ArtifactRef[];
  assertions: AssertionRef[];
  related: RelatedRef[];
  /** Present on search results only. */
  score?: number;
  via?: "lexical" | "semantic" | "graph";
  matchedTerms?: string[];
  /** Present on due-reminder results only. */
  overdue?: boolean;
}

export interface AskSource {
  id: string;
  title: string;
  kind: MemoryKind;
  score: number;
  via: string;
  occurredAt: string | null;
  assertionIds: string[];
}

export interface AskAnswer {
  answer: string;
  confidence: Confidence;
  interpretedAs: string;
  sources: AskSource[];
}

export interface ProvenanceChain {
  assertion: AssertionRef & { memoryId: string; artifactIds: string[] };
  memory: { id: string; title: string; kind: string; revision: number } | null;
  supersedes: AssertionRef | null;
  supersededBy: AssertionRef | null;
  artifacts: { id: string; hash: string; filename: string; mimeType: string; present: boolean }[];
  relatedEntities: { id: string; title: string; relation: string }[];
}

export interface ConversationTurn {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  ledger: "pending" | "generating" | "delivered" | "superseded" | "cancelled";
  addendumOf: string | null;
  memoryIdsUsed: string[];
  createdAt: string;
}

export interface TurnResponse {
  sessionId: string;
  userTurn: ConversationTurn;
  assistantTurn: ConversationTurn;
  memoryUsed: { id: string; title: string; score: number; via: string }[];
  committedMemoryId: string | null;
  interpretedAs: string;
  /** Voice turns only. */
  transcript?: string;
  audioUrl?: string | null;
}

export interface SessionToken {
  sessionId: string;
  room: string;
  identity: string;
  url: string | null;
  token: string | null;
  transport: "livekit" | "http-capture";
  transportReason: string | null;
  voiceMode: "cascaded" | "unified";
  profileId: string;
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  seq: number;
  type:
    | "state"
    | "caption.user"
    | "caption.assistant"
    | "ledger"
    | "failover"
    | "delegation"
    | "memory.commit";
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface DesktopSettings {
  privacyMode: "local_only" | "private_hybrid" | "user_managed";
  activeMemoryProvider: string;
  voiceMode: "cascaded" | "unified";
  profileId: string;
  desktopName: string;
  device: { id: string; name: string; scopes: string[] };
  providerSelectorsLocked: boolean;
}

export interface PublicCandidate {
  id: string;
  url: string;
  title: string;
  summary: string;
  topics: string[];
  matchedInterests: string[];
  score: number;
}

export interface VerifyReport {
  ok: boolean;
  checked: { memories: number; assertions: number; artifacts: number; drefs: number };
  problems: { kind: string; id: string; detail: string }[];
  verifiedAt: string;
}

export interface RebuildReport {
  rebuiltAt: string;
  prunedReferences: number;
  indexed: { memories: number; distinctTerms: number; reminders: number };
}

/** A capture waiting for the desktop to become reachable (§11.3). */
export interface OutboxItem {
  id: string;
  text: string;
  createdAt: string;
  files: { uri: string; name: string; mimeType: string }[];
  attempts: number;
  lastError: string | null;
}
