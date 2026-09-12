import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client";
import { CaptionHud, parseCaptionPayload } from "./captions.js";
import { UserTranscriptHud, parseUserTranscriptPayload } from "./user-transcript.js";
import { LiveWaveform } from "./waveform.js";
import { publishControl, type UiLayout } from "./control.js";
import { TranscriptThread } from "./transcript.js";
import { Composer } from "./composer.js";
import { isEmbedded, postShellState } from "./shell-bridge.js";

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

function publishShell(rms = 0): void {
  postShellState({
    linked: Boolean(room),
    speaking: captions.isSpeaking,
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
  updateSessionControls(Boolean(room));
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
  if (!room) return;
  if (layout === "chat") {
    if (composer.dictationActive) return;
    await room.localParticipant.setMicrophoneEnabled(false);
    setStatus("Online // text");
    return;
  }
  await publishControl(room, { type: "mute", muted: micMuted });
  await room.localParticipant.setMicrophoneEnabled(!micMuted);
  setStatus(micMuted ? "Online // mic muted" : "Online // mic armed");
}

async function shhh(): Promise<void> {
  if (!room) return;
  await publishControl(room, { type: "stop" });
  shhhBtn.classList.remove("active");
  setStatus("Online // hushed");
}

async function toggleMute(): Promise<void> {
  if (!room || layout !== "voice") return;
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

function alfredApiPath(path: string): string {
  const match = location.pathname.match(/^(\/proxy\/[^/]+)/);
  const prefix = match?.[1] ?? "";
  return `${prefix}${path.startsWith("/") ? path : `/${path}`}`;
}

async function connect(): Promise<void> {
  if (sessionOp !== "idle" || room) return;
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
      error?: string;
    };
    if (!res.ok || !payload.url || !payload.token) {
      throw new Error(payload.error ?? `Token request failed (${res.status})`);
    }

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
            captions.handle(msg);
            thread.handleCaption(msg);
            if ((msg.type === "start" || msg.type === "reveal") && msg.text) {
              lastCaption = msg.text;
            }
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
          if (msg.type === "final") thread.handleUserFinal(msg.text);
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
    // Joined LiveKit but a later step failed — do not leave a ghost participant.
    if (next) await forceLeave(next);
    if (room === next) room = undefined;
    sessionOp = "idle";
    throw err;
  }
}

function teardownUi(status: string): void {
  setStatus(status);
  connectBtn.disabled = false;
  setSessionToggle(false);
  metaEl.textContent = "";
  remoteAudioEl.replaceChildren();
  waveform.detach();
  captions.reset();
  userTranscript.reset();
  thread.reset();
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
  if (!active) {
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
    teardownUi("Offline");
    sessionOp = "idle";
  }
}

async function toggleDictate(): Promise<void> {
  if (layout !== "chat" || !room) return;
  if (composer.dictationActive) {
    composer.stopDictate();
    await publishControl(room, { type: "dictate", active: false });
    await room.localParticipant.setMicrophoneEnabled(false);
    return;
  }
  composer.startDictate();
  await publishControl(room, { type: "dictate", active: true });
  await room.localParticipant.setMicrophoneEnabled(true);
}

async function sendComposer(): Promise<void> {
  if (!room) return;
  const wasDictating = composer.dictationActive;
  const text = composer.consume();
  if (wasDictating) {
    await publishControl(room, { type: "dictate", active: false });
    await room.localParticipant.setMicrophoneEnabled(false);
  }
  if (!text) return;
  thread.addLocalUser(text);
  await publishControl(room, { type: "text", text });
}

layoutToggle.addEventListener("click", () => {
  setLayout(layout === "voice" ? "chat" : "voice");
});

document.querySelector<HTMLButtonElement>("#dictate")!.addEventListener("click", () => {
  void toggleDictate();
});

document.querySelector<HTMLFormElement>("#composer")!.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendComposer();
});

connectBtn.addEventListener("click", () => {
  if (room || sessionOp === "connecting") {
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
// desktop shell close must not leave a published mic in alfred-dev.
function leaveOnPageHide(): void {
  const active = room;
  if (!active) return;
  room = undefined;
  void forceLeave(active).finally(() => {
    teardownUi("Offline");
    sessionOp = "idle";
  });
}
window.addEventListener("pagehide", leaveOnPageHide);
window.addEventListener("beforeunload", leaveOnPageHide);

if (isEmbedded()) document.documentElement.classList.add("embedded");
waveform.detach();
applyLayoutDom("voice");
updateSessionControls(false);
setSessionToggle(false);
publishShell();
