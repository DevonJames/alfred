import type { ArbitrationOutcome, BackchannelClassification, SttResult } from "@alfred/contracts";

/**
 * Placeholder for future acoustic + semantic backchannel classification.
 * Production will integrate VAD / LiveKit turn signals; M1 uses scripts/fakes.
 */
export interface BackchannelClassifier {
  classify(utterance: SttResult): Promise<BackchannelClassification>;
}

export class HeuristicBackchannelClassifier implements BackchannelClassifier {
  private static readonly BACKCHANNELS = new Set([
    "uh huh",
    "uh-huh",
    "mmhmm",
    "mm-hmm",
    "yeah",
    "yep",
    "ok",
    "okay",
    "right",
    "got it",
    "mhm",
  ]);

  async classify(utterance: SttResult): Promise<BackchannelClassification> {
    if (utterance.utteranceKind === "backchannel") {
      return { isBackchannel: true, confidence: 0.95, reason: "stt_utterance_kind" };
    }
    if (utterance.utteranceKind === "speech") {
      return { isBackchannel: false, confidence: 0.9, reason: "stt_utterance_kind" };
    }
    const normalized = utterance.text
      .trim()
      .toLowerCase()
      .replace(/[.!?]+$/, "");
    if (HeuristicBackchannelClassifier.BACKCHANNELS.has(normalized)) {
      return { isBackchannel: true, confidence: 0.8, reason: "heuristic_short_ack" };
    }
    if (normalized.split(/\s+/).length <= 2 && normalized.length <= 12) {
      return { isBackchannel: true, confidence: 0.55, reason: "heuristic_short_utterance" };
    }
    return { isBackchannel: false, confidence: 0.7, reason: "heuristic_default_speech" };
  }
}

export interface InterruptionArbitrationInput {
  deliveredText: string;
  unspokenText: string;
  interruptionText: string;
  /** Optional scripted outcome for deterministic tests/simulator. */
  forcedOutcome?: ArbitrationOutcome;
}

export interface InterruptionArbiter {
  arbitrate(input: InterruptionArbitrationInput): Promise<ArbitrationOutcome>;
}

/**
 * Default rule-based arbiter. Prefer scripted outcomes in tests.
 */
export class RuleBasedInterruptionArbiter implements InterruptionArbiter {
  async arbitrate(input: InterruptionArbitrationInput): Promise<ArbitrationOutcome> {
    if (input.forcedOutcome) return input.forcedOutcome;

    const text = input.interruptionText.trim().toLowerCase();
    if (!text || text === "?" || text === "what") {
      return "ask_clarification";
    }
    if (/\b(wait|stop|actually|hold on)\b/.test(text)) {
      return "abandon_and_answer";
    }
    if (/\b(finish|continue|go on)\b/.test(text)) {
      return "resume_then_answer";
    }
    // If mid-sentence (no terminal punctuation in unspoken start), finish sentence.
    const unspoken = input.unspokenText.trimStart();
    const firstSentenceEnd = unspoken.search(/[.!?](\s|$)/);
    if (firstSentenceEnd >= 0 && firstSentenceEnd < 80) {
      return "finish_sentence_then_answer";
    }
    return "abandon_and_answer";
  }
}

/** Extract text up to and including the first sentence terminator. */
export function firstSentence(text: string): string {
  const match = text.match(/^[\s\S]*?[.!?](?:\s|$)/);
  return match ? match[0] : text;
}
