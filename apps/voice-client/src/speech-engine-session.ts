import { CommitStrategy, Conversation, RealtimeEvents, Scribe, type RealtimeConnection } from "@elevenlabs/client";

type EngineSession = Awaited<ReturnType<typeof Conversation.startSession>>;

let active: EngineSession | undefined;
let liveTranscript: RealtimeConnection | undefined;
let liveSettled = "";
let unmuteTimer = 0;
/** Mute button. Stays closed after Alfred finishes, same as the cascade mic mute. */
let userMuted = false;
/** While Alfred is speaking we close the mic unless the user explicitly unmuted. */
let echoMuted = false;
/** Cleared when the user hits Unmute, so echo mute does not immediately close it again. */
let allowEchoMute = true;
let hushed = false;
/** A user turn after Shhh. The reply that was cut stays silent; the next one plays. */
let userAfterHush = false;
let hushEnforceTimer = 0;

/** Same post-speech window the cascade echo guard uses, so a pause between sentences does not reopen the mic. */
const SPEECH_TAIL_MS = 2500;

export function speechEngineRunning(): boolean {
  return Boolean(active);
}

export async function startSpeechEngineSession(
  conversationToken: string,
  hooks: {
    onUser: (text: string, kind: "partial" | "final") => void;
    onAgent: (text: string) => void;
    onMode: (mode: "speaking" | "listening") => void;
    onStatus: (status: string) => void;
    onError: (message: string) => void;
    /** Fired when the ElevenLabs session dies unexpectedly (not a user Stop). */
    onDropped?: () => void;
    /** Words as they are spoken. Speech Engine's own transcript arrives at end of turn. */
    onUserPartial?: (text: string) => void;
    /** Assistant words as the audio plays them, not the finished paragraph. */
    onSpoken?: (text: string) => void;
  },
  scribeToken?: string,
): Promise<void> {
  await stopSpeechEngineSession();
  if (scribeToken && hooks.onUserPartial) {
    startLiveTranscript(scribeToken, hooks.onUserPartial);
  }
  let spoken = "";
  let sawConnected = false;
  const absorbSpoken = (chunk: string) => {
    if (!chunk) return;
    if (!spoken || chunk.startsWith(spoken)) spoken = chunk;
    else if (!spoken.endsWith(chunk)) spoken += chunk;
    hooks.onSpoken?.(spoken);
  };
  const clearActive = () => {
    if (active) active = undefined;
    stopLiveTranscript();
  };
  try {
    active = await Conversation.startSession({
      conversationToken,
      connectionType: "webrtc",
      onAudioAlignment: (alignment) => {
        absorbSpoken((alignment.chars ?? []).join(""));
      },
      onIncomingEvent: (event) => {
        if (!event || typeof event !== "object" || !("type" in event)) return;
        const typed = event as {
          type?: string;
          user_transcription_event?: { user_transcript?: string };
          tentative_user_transcription_event?: { user_transcript?: string };
        };
        if (typed.type === "tentative_user_transcript") {
          const text = typed.tentative_user_transcription_event?.user_transcript?.trim();
          if (text) (hooks.onUserPartial ?? ((value) => hooks.onUser(value, "partial")))(text);
          return;
        }
        if (typed.type === "user_transcript") {
          spoken = "";
          const text = typed.user_transcription_event?.user_transcript?.trim();
          if (text) hooks.onUser(text, "final");
        }
      },
      onMessage: ({ message, role }) => {
        if (!message || role === "user") return;
        hooks.onAgent(message);
      },
      onModeChange: ({ mode }) => hooks.onMode(mode),
      onStatusChange: ({ status }) => {
        if (status === "connected") sawConnected = true;
        if (status === "disconnected") {
          clearActive();
          if (sawConnected) hooks.onDropped?.();
        }
        hooks.onStatus(status);
      },
      onError: (message) => {
        clearActive();
        hooks.onError(message);
      },
    });
  } catch (err) {
    clearActive();
    throw err;
  }
}

/** Live captions. Speech Engine withholds its transcript until the turn ends. */
function startLiveTranscript(token: string, onPartial: (text: string) => void): void {
  liveSettled = "";
  const connection = Scribe.connect({
    token,
    modelId: "scribe_v2_realtime",
    commitStrategy: CommitStrategy.VAD,
    microphone: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  liveTranscript = connection;
  const show = (extra: string) => {
    if (connection.isMuted) return;
    const text = [liveSettled, extra].filter(Boolean).join(" ").trim();
    if (text) onPartial(text);
  };
  connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (data) => show(data.text ?? ""));
  connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (data) => {
    const text = data.text?.trim();
    if (!text || connection.isMuted) return;
    liveSettled = [liveSettled, text].filter(Boolean).join(" ").trim();
    onPartial(liveSettled);
  });
  connection.on(RealtimeEvents.ERROR, (data) => {
    console.warn("[voice-client] live transcript", data);
  });
}

function setLiveTranscriptMuted(muted: boolean): void {
  liveSettled = "";
  const connection = liveTranscript;
  if (!connection) return;
  try {
    if (muted) connection.mute();
    else connection.unmute();
  } catch (err) {
    console.warn("[voice-client] live transcript mute failed", err);
  }
}

function stopLiveTranscript(): void {
  const connection = liveTranscript;
  liveTranscript = undefined;
  liveSettled = "";
  connection?.close();
}

function applyMicMuted(): void {
  const muted = userMuted || echoMuted;
  active?.setMicMuted(muted);
  setLiveTranscriptMuted(muted);
}

/** Mute button. Conversation stays up; Unmute listens again, including during a reply. */
export function setSpeechEngineUserMuted(muted: boolean): void {
  userMuted = muted;
  if (!muted) {
    allowEchoMute = false;
    echoMuted = false;
  }
  applyMicMuted();
}

/**
 * Close the mic while Alfred is audible. A transcript of his own voice is a
 * new turn on the Speech Engine socket, and that aborts the reply in progress.
 * The cascade stack does this with a PCM gate; here the mic track is all we have.
 */
export function setSpeechEngineMicMuted(muted: boolean): void {
  window.clearTimeout(unmuteTimer);
  if (muted) {
    if (!allowEchoMute) return;
    echoMuted = true;
    applyMicMuted();
    return;
  }
  unmuteTimer = window.setTimeout(() => {
    echoMuted = false;
    allowEchoMute = true;
    applyMicMuted();
  }, SPEECH_TAIL_MS);
}

function cutPlayback(): void {
  active?.setVolume({ volume: 0 });
  for (const el of document.querySelectorAll("audio")) {
    el.volume = 0;
    el.pause();
    const stream = el.srcObject;
    if (stream instanceof MediaStream) {
      for (const track of stream.getAudioTracks()) track.enabled = false;
    }
  }
}

function restorePlayback(): void {
  active?.setVolume({ volume: 1 });
  for (const el of document.querySelectorAll("audio")) {
    el.volume = 1;
    const stream = el.srcObject;
    if (stream instanceof MediaStream) {
      for (const track of stream.getAudioTracks()) track.enabled = true;
    }
    void el.play().catch(() => {});
  }
}

/** Drop echo-mute so the user can talk. The Mute button still wins. */
function armMicForUser(): void {
  window.clearTimeout(unmuteTimer);
  echoMuted = false;
  allowEchoMute = false;
  applyMicMuted();
}

/**
 * Shhh — end this reply. Later chunks stay cut, and the mic opens unless Mute is on.
 * The session stays up so the next thing said is a new question.
 */
export function hushSpeechEngine(): void {
  hushed = true;
  userAfterHush = false;
  cutPlayback();
  armMicForUser();
  try {
    active?.sendUserActivity();
  } catch {
    /* session may already be closing */
  }
  window.clearInterval(hushEnforceTimer);
  hushEnforceTimer = window.setInterval(() => {
    if (hushed) cutPlayback();
  }, 100);
  void fetch(speechHushUrl(), { method: "POST", keepalive: true }).catch(() => {
    /* desktop may already have finished sending the reply */
  });
}

function speechHushUrl(): string {
  const match = location.pathname.match(/^(\/proxy\/[^/]+)/);
  const prefix = match?.[1] ?? "";
  return `${prefix}/api/speech/hush`;
}

export function speechEngineHushed(): boolean {
  return hushed;
}

export function speechEngineNextReply(): boolean {
  return hushed && userAfterHush;
}

/** Later chunks of the hushed reply must not start playing. */
export function noteSpeechEngineStillTalking(): void {
  if (!hushed) return;
  cutPlayback();
}

/** The next answer, after the user speaks, should be audible. */
export function noteSpeechEngineUserTurn(): void {
  if (!hushed) return;
  userAfterHush = true;
}

export function releaseSpeechEngineHush(): void {
  if (!hushed) return;
  hushed = false;
  userAfterHush = false;
  window.clearInterval(hushEnforceTimer);
  hushEnforceTimer = 0;
  allowEchoMute = true;
  restorePlayback();
}

export async function stopSpeechEngineSession(): Promise<void> {
  window.clearTimeout(unmuteTimer);
  userMuted = false;
  echoMuted = false;
  allowEchoMute = true;
  hushed = false;
  userAfterHush = false;
  window.clearInterval(hushEnforceTimer);
  stopLiveTranscript();
  const session = active;
  active = undefined;
  if (!session) return;
  try {
    await session.endSession();
  } catch (err) {
    console.warn("[voice-client] speech engine end failed", err);
  }
}
