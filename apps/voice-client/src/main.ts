import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client";
import { CaptionHud, parseCaptionPayload } from "./captions.js";
import { LiveWaveform } from "./waveform.js";

const statusEl = document.querySelector<HTMLElement>("#status")!;
const linkDot = document.querySelector<HTMLElement>("#link-dot")!;
const metaEl = document.querySelector<HTMLElement>("#meta")!;
const levelTag = document.querySelector<HTMLElement>("#level-tag")!;
const remoteAudioEl = document.querySelector<HTMLElement>("#remote-audio")!;
const connectBtn = document.querySelector<HTMLButtonElement>("#connect")!;
const disconnectBtn = document.querySelector<HTMLButtonElement>("#disconnect")!;
const waveCanvas = document.querySelector<HTMLCanvasElement>("#wave")!;

const captions = new CaptionHud({
  live: document.querySelector<HTMLElement>("#caption-live")!,
  rest: document.querySelector<HTMLElement>("#caption-rest")!,
  cursor: document.querySelector<HTMLElement>("#cursor")!,
  mode: document.querySelector<HTMLElement>("#mode-tag")!,
});

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

function setStatus(text: string): void {
  statusEl.textContent = text.toUpperCase();
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
      (
        track: RemoteTrack,
        _pub: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
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
      if (topic && topic !== "alfred.caption") return;
      const msg = parseCaptionPayload(payload);
      if (msg) captions.handle(msg);
    })
    .on(RoomEvent.Disconnected, () => {
      teardownUi("Offline");
    });

  await next.connect(payload.url, payload.token);
  await next.localParticipant.setMicrophoneEnabled(true);

  // Caption + audio may already be present if agent joined first.
  for (const participant of next.remoteParticipants.values()) {
    for (const pub of participant.trackPublications.values()) {
      if (pub.track && pub.kind === Track.Kind.Audio) {
        attachRemoteAudio(pub.track);
      }
    }
  }

  room = next;
  disconnectBtn.disabled = false;
  document.body.classList.add("linked");
  linkDot.classList.add("live");
  setStatus("Online // mic armed");
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

// Idle line before connect
waveform.detach();
