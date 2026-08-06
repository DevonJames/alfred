import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client";

const statusEl = document.querySelector<HTMLElement>("#status")!;
const metaEl = document.querySelector<HTMLElement>("#meta")!;
const remoteAudioEl = document.querySelector<HTMLElement>("#remote-audio")!;
const connectBtn = document.querySelector<HTMLButtonElement>("#connect")!;
const disconnectBtn = document.querySelector<HTMLButtonElement>("#disconnect")!;

let room: Room | undefined;

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function attachRemoteAudio(track: RemoteTrack): void {
  const el = track.attach();
  el.autoplay = true;
  el.setAttribute("playsinline", "true");
  remoteAudioEl.appendChild(el);
  void el.play().catch(() => {
    /* autoplay may need a prior user gesture — Connect provides one */
  });
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
    // WebRTC AEC — primary defense against speakerphone self-echo.
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
          setStatus(`Listening — subscribed to ${participant.identity}`);
        }
      },
    )
    .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      track.detach().forEach((el) => el.remove());
    })
    .on(RoomEvent.Disconnected, () => {
      setStatus("Disconnected");
      connectBtn.disabled = false;
      disconnectBtn.disabled = true;
      metaEl.textContent = "";
      remoteAudioEl.replaceChildren();
      room = undefined;
    });

  await next.connect(payload.url, payload.token);
  await next.localParticipant.setMicrophoneEnabled(true);

  room = next;
  disconnectBtn.disabled = false;
  setStatus("Connected — mic on (AEC enabled)");
  metaEl.textContent = `${payload.identity} @ ${payload.room}`;
}

async function disconnect(): Promise<void> {
  disconnectBtn.disabled = true;
  await room?.disconnect();
  room = undefined;
  remoteAudioEl.replaceChildren();
  connectBtn.disabled = false;
  setStatus("Disconnected");
  metaEl.textContent = "";
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
