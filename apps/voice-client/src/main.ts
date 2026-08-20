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

const statusEl = document.querySelector<HTMLElement>("#status")!;
const linkDot = document.querySelector<HTMLElement>("#link-dot")!;
const metaEl = document.querySelector<HTMLElement>("#meta")!;
const levelTag = document.querySelector<HTMLElement>("#level-tag")!;
const remoteAudioEl = document.querySelector<HTMLElement>("#remote-audio")!;
const connectBtn = document.querySelector<HTMLButtonElement>("#connect")!;
const disconnectBtn = document.querySelector<HTMLButtonElement>("#disconnect")!;
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
  } else if (document.body.classList.contains("linked")) {
    linkDot.classList.add("live");
    linkDot.classList.remove("speaking");
  }
});

let room: Room | undefined;
let layout: UiLayout = "voice";

function setStatus(text: string): void {
  statusEl.textContent = text.toUpperCase();
}

function applyLayoutDom(next: UiLayout): void {
  layout = next;
  document.body.dataset.layout = next;
  layoutToggle.textContent = next === "voice" ? "CHAT" : "VOICE";
  layoutToggle.setAttribute("aria-pressed", String(next === "chat"));
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
  await room.localParticipant.setMicrophoneEnabled(true);
  setStatus("Online // mic armed");
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

async function connect(): Promise<void> {
  connectBtn.disabled = true;
  setStatus("Minting token…");

  const res = await fetch("/api/token");
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
  const next = new Room({
    adaptiveStream: true,
    dynacast: true,
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
      teardownUi("Offline");
    });

  await next.connect(payload.url, payload.token);
  room = next;
  await publishControl(next, { type: "layout", layout });
  await syncMicForLayout();

  for (const participant of next.remoteParticipants.values()) {
    for (const pub of participant.trackPublications.values()) {
      if (pub.track && pub.kind === Track.Kind.Audio) {
        attachRemoteAudio(pub.track);
      }
    }
  }

  disconnectBtn.disabled = false;
  document.body.classList.add("linked");
  linkDot.classList.add("live");
  metaEl.textContent = `${payload.identity} @ ${payload.room}`;
}

function teardownUi(status: string): void {
  setStatus(status);
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
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
}

async function disconnect(): Promise<void> {
  disconnectBtn.disabled = true;
  await room?.disconnect();
  teardownUi("Offline");
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
  void connect().catch((err) => {
    console.error(err);
    setStatus(err instanceof Error ? err.message : String(err));
    connectBtn.disabled = false;
  });
});

disconnectBtn.addEventListener("click", () => {
  void disconnect();
});

waveform.detach();
applyLayoutDom("voice");
