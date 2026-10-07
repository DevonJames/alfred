import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client";
import { BriefingHud, parseBriefingDisplay } from "./briefing-hud.js";
import { CaptionHud, parseCaptionPayload } from "./captions.js";
import { UserTranscriptHud, parseUserTranscriptPayload } from "./user-transcript.js";
import { LiveWaveform } from "./waveform.js";
import { publishControl, type UiLayout } from "./control.js";
import { TranscriptThread } from "./transcript.js";
import { Composer } from "./composer.js";
import { HistoryDrawer } from "./history-drawer.js";
import { isEmbedded, navigateShell, postShellState, SHELL_CHANNEL } from "./shell-bridge.js";
import {
  ensureSpeechEngineAudible,
  forceSpeechEngineEchoMute,
  hushSpeechEngine,
  interruptSpeechEnginePlayback,
  noteSpeechEngineStillTalking,
  noteSpeechEngineUserTurn,
  releaseSpeechEngineHush,
  speechEngineNextReply,
  setSpeechEngineMicMuted,
  setSpeechEngineUserMuted,
  speechEngineHushed,
  speechEngineOutputTrack,
  speechEngineRunning,
  startSpeechEngineSession,
  stopSpeechEngineSession,
  submitSpeechEngineText,
} from "./speech-engine-session.js";

const statusEl = document.querySelector<HTMLElement>("#status")!;
const linkDot = document.querySelector<HTMLElement>("#link-dot")!;
const metaEl = document.querySelector<HTMLElement>("#meta")!;
const levelTag = document.querySelector<HTMLElement>("#level-tag")!;
const remoteAudioEl = document.querySelector<HTMLElement>("#remote-audio")!;
const connectBtn = document.querySelector<HTMLButtonElement>("#connect")!;
const shhhBtn = document.querySelector<HTMLButtonElement>("#shhh")!;
const muteBtn = document.querySelector<HTMLButtonElement>("#mute")!;
const layoutToggle = document.querySelector<HTMLButtonElement>("#layout-toggle")!;
const waveCanvas = document.querySelector<HTMLCanvasElement>("#wave")!;

const captions = new CaptionHud({
  live: document.querySelector<HTMLElement>("#caption-live")!,
  rest: document.querySelector<HTMLElement>("#caption-rest")!,
  cursor: document.querySelector<HTMLElement>("#cursor")!,
  mode: document.querySelector<HTMLElement>("#mode-tag")!,
});

const briefingHud = new BriefingHud(
  document.querySelector<HTMLElement>("#briefing-panel")!,
  document.querySelector<HTMLElement>("#caption")!,
);

briefingHud.onSectionNavigate((screen) => {
  navigateShell(screen);
});

briefingHud.onHeadlineClick((hit) => {
  const ask = `Tell me more about headline number ${hit.index}`;
  briefingHud.clear();
  // Soft interrupt only — full Shhh latches mute through research/reconnect and
  // the next dig shows captions/waveform with no sound.
  interruptSpeechEnginePlayback();
  userTranscript.handle({ type: "final", text: ask });
  thread.handleUserFinal(ask);
  postAgendaTurn("user", ask, true);
  setStatus("Online // researching headline");
  void (async () => {
    try {
      // Prime the spoken summary on the desktop first. A bare sendUserMessage during
      // briefing playback is treated as echo and never answered out loud.
      const res = await fetch(alfredApiPath("/api/speech/news-dig"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          index: hit.index,
          title: hit.title,
          url: hit.url,
        }),
      });
      const data = (await res.json()) as { speech?: string; error?: string };
      if (!res.ok) throw new Error(data.error || `News dig failed (${res.status})`);
      if (!speechEngineRunning()) await ensureSpeechEngine();
      ensureSpeechEngineAudible();
      if (!submitSpeechEngineText(ask)) {
        throw new Error("Alfred's voice isn't connected. Press Start on Talk.");
      }
      setStatus("Online // digging in");
    } catch (err) {
      console.error("[voice-client] headline dig", err);
      setStatus(err instanceof Error ? err.message : "Couldn’t dig into that headline");
    }
  })();
});

let briefingHudFetch: Promise<void> | null = null;

async function refreshBriefingHud(): Promise<void> {
  if (briefingHud.isActive || briefingHudFetch) return briefingHudFetch ?? undefined;
  briefingHudFetch = (async () => {
    try {
      const res = await fetch(alfredApiPath("/briefing/hud"));
      if (!res.ok) return;
      const data = (await res.json()) as {
        active?: boolean;
        display?: unknown;
        spokenAt?: number | null;
      };
      const fresh =
        typeof data.spokenAt === "number" && Date.now() - data.spokenAt < 45_000;
      const display = data.active && fresh ? parseBriefingDisplay(data.display) : null;
      if (display) {
        // Swap layout only — do not captions.reset() (that clears speaking state
        // and races the shell). Spoken text stays hidden under the panel.
        briefingHud.show(display);
      }
    } catch (err) {
      console.warn("[voice-client] briefing hud", err);
    } finally {
      briefingHudFetch = null;
    }
  })();
  return briefingHudFetch;
}

const userTranscript = new UserTranscriptHud({
  root: document.querySelector<HTMLElement>("#user-panel")!,
  text: document.querySelector<HTMLElement>("#user-text")!,
  mode: document.querySelector<HTMLElement>("#user-mode")!,
  cursor: document.querySelector<HTMLElement>("#user-cursor")!,
});

const thread = new TranscriptThread(document.querySelector<HTMLElement>("#thread")!);
const composer = new Composer(
  document.querySelector<HTMLFormElement>("#composer")!,
  document.querySelector<HTMLTextAreaElement>("#composer-input")!,
  document.querySelector<HTMLButtonElement>("#dictate")!,
);

function alfredApiPath(path: string): string {
  const match = location.pathname.match(/^(\/proxy\/[^/]+)/);
  const prefix = match?.[1] ?? "";
  return `${prefix}${path.startsWith("/") ? path : `/${path}`}`;
}

const historyDrawer = new HistoryDrawer(
  document.querySelector<HTMLElement>("#history-drawer")!,
  document.querySelector<HTMLElement>("#history-list")!,
  alfredApiPath,
  (_id, messages) => {
    thread.load(messages);
    if (layout !== "chat") setLayout("chat");
    setStatus("Conversation resumed — Start or Send to continue");
  },
  () => {
    thread.reset();
    setStatus("New conversation — Start or Send when ready");
  },
);

document.querySelector<HTMLButtonElement>("#history-toggle")!.addEventListener("click", () => {
  historyDrawer.toggle();
  document
    .querySelector<HTMLButtonElement>("#history-toggle")!
    .setAttribute("aria-pressed", String(historyDrawer.isOpen));
});
document.querySelector<HTMLButtonElement>("#history-close")!.addEventListener("click", () => {
  historyDrawer.setOpen(false);
  document.querySelector<HTMLButtonElement>("#history-toggle")!.setAttribute("aria-pressed", "false");
});
document.querySelector<HTMLButtonElement>("#new-chat")!.addEventListener("click", () => {
  void historyDrawer.prepareNew();
});

const waveform = new LiveWaveform(waveCanvas);
waveform.setLevelHandler((rms) => {
  captions.onLevel(rms);
  const db = rms < 0.001 ? "--" : String(Math.min(99, Math.round(rms * 120))).padStart(2, "0");
  levelTag.textContent = `LVL ${db}`;
  if (captions.isSpeaking) {
    linkDot.classList.add("speaking");
    linkDot.classList.remove("live");
    shhhBtn.classList.add("active");
  } else if (document.body.classList.contains("linked")) {
    linkDot.classList.add("live");
    linkDot.classList.remove("speaking");
    shhhBtn.classList.remove("active");
  } else {
    shhhBtn.classList.remove("active");
  }
  publishShell(rms);
});

let room: Room | undefined;
let layout: UiLayout = "voice";
/** Voice-layout mic mute — conversation stays open; unmute resumes listening. */
let micMuted = false;
let lastCaption = "";
/** Prevents Start/Stop races from leaving a LiveKit participant orphaned. */
let sessionOp: "idle" | "connecting" | "disconnecting" = "idle";
/** LiveKit room from the last mint — used to delete ephemeral GPT-Live rooms on Stop. */
let activeSessionId: string | undefined;

let waveTrackId = "";

function syncSpeechEngineWave(): void {
  const track = speechEngineOutputTrack();
  if (!track || track.id === waveTrackId) return;
  waveTrackId = track.id;
  void waveform.attach(track).catch((err) => {
    waveTrackId = "";
    console.warn("waveform attach failed", err);
  });
}

/** True while Speech Engine reports Alfred is talking (not caption HUD state). */
let engineSpeaking = false;

/** True when heard is speaker-bleed of Alfred's current / recent reply. */
function looksLikeAssistantEcho(heard: string, spoken: string): boolean {
  const ref = spoken.trim() || lastCaption.trim();
  if (!ref || !heard.trim()) return false;
  const h = heard.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const s = ref.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!h || !s) return false;
  if (s.includes(h) || h.includes(s.slice(0, Math.min(48, s.length)))) return true;
  const hWords = h.split(" ").filter((w) => w.length >= 4);
  if (
    hWords.length >= 2 &&
    hWords.filter((w) => s.includes(w)).length >= Math.ceil(hWords.length * 0.6)
  ) {
    return true;
  }
  return false;
}

/** Drop speaker-bleed so Alfred's words do not paint into YOU // MIC. */
function suppressUserHud(heard: string, spoken: string): boolean {
  // While he is talking, keep YOU // MIC idle (server still handles real barge-in).
  if (engineSpeaking) return true;
  return looksLikeAssistantEcho(heard, spoken);
}

function publishShell(rms = 0): void {
  postShellState({
    linked: Boolean(room) || speechEngineRunning(),
    speaking: engineSpeaking || captions.isSpeaking || briefingHud.isActive,
    muted: micMuted,
    rms,
    caption: lastCaption,
  });
}

function setStatus(text: string): void {
  statusEl.textContent = text.toUpperCase();
}

function setSessionToggle(running: boolean): void {
  connectBtn.textContent = running ? "Stop" : "Start";
  connectBtn.classList.toggle("stop", running);
  connectBtn.setAttribute("aria-pressed", String(running));
}

function updateSessionControls(linked: boolean): void {
  shhhBtn.disabled = !linked;
  muteBtn.disabled = !linked || layout !== "voice";
  muteBtn.classList.toggle("muted", micMuted);
  muteBtn.textContent = micMuted ? "Unmute" : "Mute";
  muteBtn.setAttribute("aria-pressed", String(micMuted));
}

function applyLayoutDom(next: UiLayout): void {
  layout = next;
  document.body.dataset.layout = next;
  layoutToggle.textContent = next === "voice" ? "CHAT" : "VOICE";
  layoutToggle.setAttribute("aria-pressed", String(next === "chat"));
  updateSessionControls(Boolean(room) || speechEngineRunning());
}

function setLayout(next: UiLayout): void {
  if (next === layout) return;
  const apply = () => {
    if (composer.dictationActive) {
      composer.stopDictate();
      void publishControl(room, { type: "dictate", active: false });
    }
    applyLayoutDom(next);
    void syncMicForLayout();
    void publishControl(room, { type: "layout", layout: next });
  };
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => { finished: Promise<void> };
  };
  if (typeof doc.startViewTransition === "function") {
    doc.startViewTransition(apply);
  } else {
    apply();
  }
}

async function syncMicForLayout(): Promise<void> {
  if (speechEngineRunning()) {
    if (layout === "chat") {
      // Text chat: keep the session up but don't treat ambient audio as turns.
      setSpeechEngineUserMuted(true);
      setStatus("Online // text");
      return;
    }
    setSpeechEngineUserMuted(micMuted);
    setStatus(micMuted ? "Online // mic muted" : "Online // mic armed");
    return;
  }
  if (!room) return;
  if (layout === "chat") {
    // Keep a published (muted) mic so GPT-Live can bind; unpublishing leaves
    // the worker waiting for audio and the typed send has no agent.
    await room.localParticipant.setMicrophoneEnabled(true);
    const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (composer.dictationActive) {
      if (mic?.isMuted) await mic.unmute();
      return;
    }
    if (mic && !mic.isMuted) await mic.mute();
    setStatus("Online // text");
    return;
  }
  await publishControl(room, { type: "mute", muted: micMuted });
  await room.localParticipant.setMicrophoneEnabled(!micMuted);
  const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  if (mic && !micMuted && mic.isMuted) await mic.unmute();
  setStatus(micMuted ? "Online // mic muted" : "Online // mic armed");
}

async function shhh(): Promise<void> {
  if (speechEngineRunning()) {
    hushSpeechEngine();
    captions.handle({ type: "end", reason: "ui_stop" });
    shhhBtn.classList.remove("active");
    linkDot.classList.add("live");
    linkDot.classList.remove("speaking");
    setStatus(micMuted ? "Online // mic muted" : "Online // mic armed");
    updateSessionControls(true);
    return;
  }
  if (!room) return;
  await publishControl(room, { type: "stop" });
  shhhBtn.classList.remove("active");
  setStatus("Online // hushed");
}

async function toggleMute(): Promise<void> {
  if (layout !== "voice") return;
  if (speechEngineRunning()) {
    micMuted = !micMuted;
    setSpeechEngineUserMuted(micMuted);
    updateSessionControls(true);
    setStatus(micMuted ? "Online // mic muted" : "Online // mic armed");
    return;
  }
  if (!room) return;
  micMuted = !micMuted;
  // Tell the agent first so STT stops even if WebRTC mute is flaky.
  await publishControl(room, { type: "mute", muted: micMuted });
  await room.localParticipant.setMicrophoneEnabled(!micMuted);
  updateSessionControls(true);
  setStatus(micMuted ? "Online // mic muted" : "Online // mic armed");
}

function attachRemoteAudio(track: RemoteTrack): void {
  const el = track.attach();
  el.autoplay = true;
  el.setAttribute("playsinline", "true");
  remoteAudioEl.appendChild(el);
  void el.play().catch(() => {
    /* Connect click counts as gesture */
  });

  const mst = track.mediaStreamTrack;
  if (mst) {
    void waveform.attach(mst).catch((err) => {
      console.warn("waveform attach failed", err);
    });
  }
}

/** Best-effort: delete ephemeral live room so LiveKit does not keep billing the job. */
async function endLiveSession(sessionId?: string): Promise<void> {
  const id = (sessionId ?? activeSessionId)?.trim();
  activeSessionId = undefined;
  if (!id) return;
  try {
    await fetch(alfredApiPath("/api/token/end"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id }),
      keepalive: true,
    });
  } catch (err) {
    console.warn("[voice-client] session end failed", err);
  }
}

async function connect(): Promise<void> {
  if (sessionOp !== "idle" || room || speechEngineRunning()) return;
  sessionOp = "connecting";
  connectBtn.disabled = true;
  setStatus("Minting token…");

  let next: Room | undefined;
  try {
    const res = await fetch(alfredApiPath("/api/token"));
    const payload = (await res.json()) as {
      url?: string;
      room?: string;
      identity?: string;
      token?: string;
      voiceStack?: string;
      conversationToken?: string;
      scribeToken?: string;
      error?: string;
    };
    if (!res.ok) {
      throw new Error(payload.error ?? `Token request failed (${res.status})`);
    }
    if (payload.voiceStack === "live2") {
      if (!payload.conversationToken) throw new Error("Speech Engine token missing");
      await historyDrawer.ensureActive({ stack: "live2" });
      await connectSpeechEngine(payload.conversationToken, payload.scribeToken);
      return;
    }
    await historyDrawer.ensureActive({
      stack: payload.voiceStack === "live" ? "live" : "cascade",
    });
    if (!payload.url || !payload.token) {
      throw new Error(payload.error ?? `Token request failed (${res.status})`);
    }
    if (payload.room) activeSessionId = payload.room;

    setStatus("Connecting…");
    next = new Room({
      adaptiveStream: true,
      dynacast: true,
      disconnectOnPageLeave: true,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    next
      .on(
        RoomEvent.TrackSubscribed,
        (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
          if (track.kind === Track.Kind.Audio) {
            attachRemoteAudio(track);
            setStatus(`Linked // ${participant.identity}`);
          }
        },
      )
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        track.detach().forEach((el) => el.remove());
        if (track.kind === Track.Kind.Audio) {
          waveform.detach();
        }
      })
      .on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
        if (!topic || topic === "alfred.caption") {
          const msg = parseCaptionPayload(payload);
          if (msg) {
            if (msg.type === "start" && msg.display) {
              briefingHud.show(msg.display);
              captions.reset();
            } else if (msg.type === "start") {
              briefingHud.clear();
              captions.handle(msg);
            } else if (!briefingHud.isActive) {
              captions.handle(msg);
            }
            thread.handleCaption(msg);
            if ((msg.type === "start" || msg.type === "reveal") && msg.text) {
              lastCaption = msg.text;
            }
            if (msg.type === "end") setRemoteAudioMuted(false);
            publishShell();
          }
        }
        if (!topic || topic === "alfred.user") {
          const msg = parseUserTranscriptPayload(payload);
          if (!msg) return;
          if (layout === "chat" && composer.dictationActive) {
            composer.applyDictation(msg.text);
            return;
          }
          userTranscript.handle(msg);
          if (msg.type === "final") {
            briefingHud.clear();
            thread.handleUserFinal(msg.text);
          }
        }
      })
      .on(RoomEvent.Disconnected, () => {
        // Only tear down if this is still the active room — a superseded
        // connect/disconnect race must not clear a newer session.
        if (room === next) teardownUi("Offline");
      });

    await next.connect(payload.url, payload.token);
    // Stop clicked while connect was in flight — leave immediately.
    if (sessionOp !== "connecting") {
      await forceLeave(next);
      await endLiveSession(payload.room);
      teardownUi("Offline");
      sessionOp = "idle";
      return;
    }
    room = next;
    micMuted = false;
    await publishControl(next, { type: "layout", layout });
    await publishControl(next, { type: "mute", muted: false });
    await syncMicForLayout();

    for (const participant of next.remoteParticipants.values()) {
      for (const pub of participant.trackPublications.values()) {
        if (pub.track && pub.kind === Track.Kind.Audio) {
          attachRemoteAudio(pub.track);
        }
      }
    }

    connectBtn.disabled = false;
    setSessionToggle(true);
    document.body.classList.add("linked");
    linkDot.classList.add("live");
    metaEl.textContent = `${payload.identity} @ ${payload.room}`;
    updateSessionControls(true);
    publishShell();
    sessionOp = "idle";
  } catch (err) {
    // Joined LiveKit or Speech Engine but a later step failed — do not leave a ghost session.
    if (speechEngineRunning()) await stopSpeechEngineSession();
    if (next) await forceLeave(next);
    await endLiveSession(activeSessionId);
    if (room === next) room = undefined;
    sessionOp = "idle";
    throw err;
  }
}

function teardownUi(status: string): void {
  waveTrackId = "";
  engineSpeaking = false;
  setStatus(status);
  connectBtn.disabled = false;
  setSessionToggle(false);
  metaEl.textContent = "";
  remoteAudioEl.replaceChildren();
  waveform.detach();
  briefingHud.clear();
  captions.reset();
  userTranscript.reset();
  thread.endStreaming();
  composer.reset();
  document.body.classList.remove("linked");
  linkDot.classList.remove("live", "speaking");
  levelTag.textContent = "LVL --";
  room = undefined;
  micMuted = false;
  shhhBtn.classList.remove("active");
  lastCaption = "";
  updateSessionControls(false);
  publishShell();
}

/** Best-effort leave: mute, stop tracks, send Leave even if something throws. */
async function forceLeave(target: Room): Promise<void> {
  try {
    await target.localParticipant.setMicrophoneEnabled(false);
  } catch {
    /* ignore */
  }
  try {
    await target.disconnect(true);
  } catch (err) {
    console.error("[voice-client] room.disconnect failed", err);
  }
}

async function connectSpeechEngine(conversationToken: string, scribeToken?: string): Promise<void> {
  let agentText = "";
  let userText = "";
  setStatus("Connecting…");

  const recoverFromDrop = async (reason: string) => {
    if (sessionOp === "disconnecting") return;
    console.warn("[voice-client] speech engine dropped:", reason);
    await stopSpeechEngineSession();
    sessionOp = "idle";
    teardownUi("Offline // session dropped — press Start");
  };

  await startSpeechEngineSession(conversationToken, {
    onUser: (text, kind) => {
      if (suppressUserHud(text, agentText)) {
        forceSpeechEngineEchoMute();
        return;
      }
      userText = text;
      userTranscript.handle({ type: kind, text });
      if (kind === "final") {
        briefingHud.clear();
        noteSpeechEngineUserTurn();
        thread.handleUserFinal(text);
      }
      postAgendaTurn("user", text, kind === "final");
      publishShell();
    },
    onAgent: (text) => {
      if (speechEngineHushed()) {
        const continuation =
          agentText.length > 0 && (text.startsWith(agentText) || agentText.startsWith(text));
        if (continuation || !speechEngineNextReply()) return;
        releaseSpeechEngineHush();
      }
      // Mute before playback lands in the mic. A transcript of his own voice
      // aborts the in-flight reply on the Speech Engine socket.
      engineSpeaking = true;
      forceSpeechEngineEchoMute();
      agentText = text;
      lastCaption = text;
      void refreshBriefingHud().then(() => {
        if (!briefingHud.isActive) captions.setUpcoming(text);
      });
      if (!briefingHud.isActive) postAgendaTurn("assistant", text, false);
      publishShell();
    },
    onSpoken: (text) => {
      if (speechEngineHushed()) return;
      engineSpeaking = true;
      forceSpeechEngineEchoMute();
      if (!briefingHud.isActive) {
        captions.revealSpoken(text);
        postAgendaTurn("assistant", text, false);
      }
      publishShell();
    },
    onMode: (mode) => {
      if (mode === "speaking") {
        engineSpeaking = true;
        syncSpeechEngineWave();
        if (speechEngineHushed()) {
          noteSpeechEngineStillTalking();
          return;
        }
        // Dig/reconnect can leave volume at 0 while captions still update.
        ensureSpeechEngineAudible();
        forceSpeechEngineEchoMute();
        shhhBtn.classList.add("active");
        linkDot.classList.add("speaking");
        linkDot.classList.remove("live");
        if (agentText && !briefingHud.isActive) captions.setUpcoming(agentText);
        void refreshBriefingHud();
        publishShell();
        return;
      }
      engineSpeaking = false;
      linkDot.classList.add("live");
      linkDot.classList.remove("speaking");
      shhhBtn.classList.remove("active");
      if (!speechEngineHushed()) setSpeechEngineMicMuted(false);
      // Don't lock YOU // MIC on speaker-bleed that arrived as the turn ended.
      if (userText && looksLikeAssistantEcho(userText, agentText)) userText = "";
      if (userText) {
        userTranscript.handle({ type: "final", text: userText });
        thread.handleUserFinal(userText);
        userText = "";
      }
      if (agentText) {
        const hushed = speechEngineHushed();
        if (!briefingHud.isActive) {
          captions.handle({ type: "end", reason: hushed ? "ui_stop" : undefined });
        }
        const shown = hushed ? captions.spokenText() : agentText;
        if (shown) {
          thread.handleCaption({ type: "reveal", text: shown });
          thread.handleCaption({ type: "end" });
          if (!hushed) postAgendaTurn("assistant", shown, true);
        }
        agentText = "";
      }
      if (!speechEngineHushed()) releaseSpeechEngineHush();
      publishShell();
    },
    onStatus: (status) => {
      if (status === "connected") setStatus("Linked // speech engine");
      else if (status === "connecting") setStatus("Connecting…");
    },
    onDropped: () => {
      void recoverFromDrop("disconnected");
    },
    onError: (message) => {
      console.error("[voice-client] speech engine", message);
      void recoverFromDrop(message || "error");
    },
    onUserPartial: (text) => {
      if (suppressUserHud(text, agentText)) {
        forceSpeechEngineEchoMute();
        return;
      }
      userTranscript.handle({ type: "partial", text });
      postAgendaTurn("user", text, false);
      publishShell();
    },
  }, scribeToken);
  if (sessionOp !== "connecting") {
    await stopSpeechEngineSession();
    teardownUi("Offline");
    sessionOp = "idle";
    return;
  }
  connectBtn.disabled = false;
  setSessionToggle(true);
  document.body.classList.add("linked");
  linkDot.classList.add("live");
  metaEl.textContent = "elevenlabs speech engine";
  updateSessionControls(true);
  publishShell();
  sessionOp = "idle";
  setStatus(layout === "chat" ? "Online // text" : "Online // speech engine");
  void syncMicForLayout();
  syncSpeechEngineWave();
  window.setTimeout(syncSpeechEngineWave, 400);
  window.setTimeout(syncSpeechEngineWave, 1200);
}

async function disconnect(): Promise<void> {
  if (sessionOp === "disconnecting") return;
  // Connecting: flip the op so connect()'s post-join check leaves immediately.
  if (sessionOp === "connecting") {
    sessionOp = "disconnecting";
    connectBtn.disabled = true;
    setStatus("Canceling…");
    return;
  }
  const active = room;
  const sessionId = activeSessionId;
  if (speechEngineRunning()) {
    sessionOp = "disconnecting";
    connectBtn.disabled = true;
    setStatus("Leaving…");
    try {
      await stopSpeechEngineSession();
    } finally {
      teardownUi("Offline");
      sessionOp = "idle";
    }
    return;
  }
  if (!active) {
    await endLiveSession(sessionId);
    teardownUi("Offline");
    sessionOp = "idle";
    return;
  }
  sessionOp = "disconnecting";
  connectBtn.disabled = true;
  setStatus("Leaving…");
  // Clear the handle first so a late Disconnected event is harmless, but keep
  // `active` so we always call disconnect on the real Room instance.
  room = undefined;
  try {
    await forceLeave(active);
  } finally {
    await endLiveSession(sessionId);
    teardownUi("Offline");
    sessionOp = "idle";
  }
}

async function toggleDictate(): Promise<void> {
  if (layout !== "chat" || !room) return;
  if (composer.dictationActive) {
    composer.stopDictate();
    await publishControl(room, { type: "dictate", active: false });
    await syncMicForLayout();
    return;
  }
  composer.startDictate();
  await publishControl(room, { type: "dictate", active: true });
  await room.localParticipant.setMicrophoneEnabled(true);
}

async function sendComposer(): Promise<void> {
  const wasDictating = composer.dictationActive;
  const text = composer.consume();
  if (!text) return;
  thread.addLocalUser(text);
  void historyDrawer.appendLocalTurn({ role: "user", text, source: "text" });

  // Typed SEND never speaks. live2 (and offline typed) use the desktop text brain;
  // LiveKit stacks publish a text control turn (cascade is caption-only; GPT-Live audio is muted).
  if (!room) {
    await runSilentTypedTurn(text);
    return;
  }

  if (wasDictating && layout === "chat") {
    await publishControl(room, { type: "dictate", active: false });
    await syncMicForLayout();
  }
  try {
    setRemoteAudioMuted(true);
    await publishControl(room, { type: "text", text });
    userTranscript.handle({ type: "final", text });
    thread.handleUserFinal(text);
    postAgendaTurn("user", text, true);
    setStatus(layout === "chat" ? "Online // text" : "Online // mic armed");
    publishShell();
  } catch (err) {
    setRemoteAudioMuted(false);
    console.error("[voice-client] send failed", err);
    setStatus(err instanceof Error ? err.message : "Send failed");
  }
}

function setRemoteAudioMuted(muted: boolean): void {
  for (const el of remoteAudioEl.querySelectorAll("audio")) {
    el.muted = muted;
  }
}

async function runSilentTypedTurn(text: string): Promise<void> {
  setStatus("Thinking…");
  userTranscript.handle({ type: "final", text });
  thread.handleUserFinal(text);
  postAgendaTurn("user", text, true);
  try {
    const res = await fetch(alfredApiPath("/api/speech/text-turn"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = (await res.json()) as { assistantText?: string; error?: string };
    if (!res.ok) throw new Error(data.error ?? `Text turn failed (${res.status})`);
    const reply = (data.assistantText ?? "").trim();
    if (reply) {
      thread.handleCaption({ type: "start", text: "" });
      thread.handleCaption({ type: "reveal", text: reply });
      thread.handleCaption({ type: "end", reason: "complete" });
      captions.setUpcoming(reply);
      captions.revealSpoken(reply);
      captions.handle({ type: "end", reason: "complete" });
      postAgendaTurn("assistant", reply, true);
      void historyDrawer.appendLocalTurn({ role: "assistant", text: reply, source: "text" });
    }
    setStatus(
      speechEngineRunning() || room
        ? layout === "chat"
          ? "Online // text"
          : "Online // mic armed"
        : "Online // text",
    );
    publishShell();
  } catch (err) {
    console.error("[voice-client] silent typed turn failed", err);
    setStatus(err instanceof Error ? err.message : "Send failed");
  }
}

layoutToggle.addEventListener("click", () => {
  setLayout(layout === "voice" ? "chat" : "voice");
});

document.querySelector<HTMLButtonElement>("#dictate")!.addEventListener("click", () => {
  void toggleDictate();
});

function postAgendaTurn(role: "user" | "assistant", text: string, final: boolean): void {
  const trimmed = text.trim();
  if (!trimmed || !isEmbedded()) return;
  window.parent.postMessage(
    { channel: SHELL_CHANNEL, type: "turn", role, text: trimmed, final },
    location.origin,
  );
}

async function ensureSpeechEngine(): Promise<void> {
  if (speechEngineRunning() || sessionOp === "connecting") return;
  await connect();
  if (!speechEngineRunning()) {
    throw new Error("Alfred's voice isn't connected. Press Start on Talk.");
  }
}

async function speakAgendaReply(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  await ensureSpeechEngine();
  if (!submitSpeechEngineText(trimmed)) {
    throw new Error("Alfred's voice isn't connected. Press Start on Talk.");
  }
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin) return;
  const data = event.data as {
    channel?: string;
    type?: string;
    text?: string;
    cmd?: string;
    id?: string;
    canvas?: OffscreenCanvas;
    width?: number;
    height?: number;
  } | null;
  if (!data || data.channel !== SHELL_CHANNEL) return;
  if (data.type === "wave-surface" && data.canvas && data.id) {
    const width = Math.max(1, Math.floor(data.width ?? data.canvas.width));
    const height = Math.max(1, Math.floor(data.height ?? data.canvas.height));
    data.canvas.width = width;
    data.canvas.height = height;
    waveform.setMirror(data.id, data.canvas);
    return;
  }
  if (data.type === "wave-size" && data.id && data.width && data.height) {
    waveform.resizeMirror(data.id, Math.floor(data.width), Math.floor(data.height));
    return;
  }
  if (data.type === "voice-cmd") {
    if (data.cmd === "toggle") {
      if (room || sessionOp === "connecting" || speechEngineRunning()) {
        void disconnect().catch((err) => console.error(err));
      } else {
        void connect().catch((err) => {
          console.error(err);
          setStatus(err instanceof Error ? err.message : String(err));
          connectBtn.disabled = false;
          setSessionToggle(false);
          sessionOp = "idle";
        });
      }
    } else if (data.cmd === "shhh") {
      void shhh().catch((err) => console.error(err));
    } else if (data.cmd === "mute") {
      void toggleMute().catch((err) => console.error(err));
    }
    return;
  }
  if (data.type === "listen") {
    void ensureSpeechEngine().catch((err) => {
      const message = err instanceof Error ? err.message : "Alfred's voice didn't start.";
      window.parent.postMessage({ channel: SHELL_CHANNEL, type: "listen-failed", error: message }, location.origin);
    });
    return;
  }
  if (data.type !== "ask") return;
  void speakAgendaReply(data.text ?? "").catch((err) => {
    const message = err instanceof Error ? err.message : "Alfred's voice didn't start.";
    window.parent.postMessage({ channel: SHELL_CHANNEL, type: "ask-failed", error: message }, location.origin);
  });
});

document.querySelector<HTMLFormElement>("#composer")!.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendComposer();
});

connectBtn.addEventListener("click", () => {
  if (room || sessionOp === "connecting" || speechEngineRunning()) {
    void disconnect().catch((err) => console.error(err));
    return;
  }
  void connect().catch((err) => {
    console.error(err);
    setStatus(err instanceof Error ? err.message : String(err));
    connectBtn.disabled = false;
    setSessionToggle(false);
    sessionOp = "idle";
  });
});

shhhBtn.addEventListener("click", () => {
  void shhh().catch((err) => console.error(err));
});

muteBtn.addEventListener("click", () => {
  void toggleMute().catch((err) => console.error(err));
});

// Belt-and-suspenders with LiveKit's disconnectOnPageLeave — iframe teardown /
// desktop shell close must not leave a published mic or a billed live room.
function leaveOnPageHide(): void {
  const active = room;
  const sessionId = activeSessionId;
  const engine = speechEngineRunning();
  if (!active && !sessionId && !engine) return;
  room = undefined;
  const leave = engine
    ? stopSpeechEngineSession()
    : active
      ? forceLeave(active).then(() => endLiveSession(sessionId))
      : endLiveSession(sessionId);
  void leave.finally(() => {
    teardownUi("Offline");
    sessionOp = "idle";
  });
}
window.addEventListener("pagehide", leaveOnPageHide);
window.addEventListener("beforeunload", leaveOnPageHide);

if (isEmbedded()) {
  document.documentElement.classList.add("embedded");
  window.parent.postMessage({ channel: SHELL_CHANNEL, type: "wave-ready" }, location.origin);
}
waveform.detach();
applyLayoutDom("voice");
updateSessionControls(false);
setSessionToggle(false);
publishShell();
