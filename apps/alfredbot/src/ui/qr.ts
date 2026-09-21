import { startCameraFrameSink } from "./camera-sink.js";

type Detector = {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>;
};

function barcodeDetector(): Detector | null {
  const Ctor = (
    window as unknown as {
      BarcodeDetector?: new (opts: { formats: string[] }) => Detector;
    }
  ).BarcodeDetector;
  return Ctor ? new Ctor({ formats: ["qr_code"] }) : null;
}

async function readCode(detector: Detector | null, source: ImageBitmapSource): Promise<string | undefined> {
  if (!detector) return undefined;
  try {
    const codes = await detector.detect(source);
    return codes[0]?.rawValue?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function openUserCamera(): Promise<MediaStream> {
  const attempts: MediaStreamConstraints[] = [
    { audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 } } },
    { audio: false, video: { facingMode: "environment" } },
    { audio: false, video: true },
  ];
  let last: unknown;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error("Camera is not available.");
}

export async function scanClaimFromVideo(
  video: HTMLVideoElement,
  jpeg: HTMLImageElement,
  onCode: (raw: string) => void,
  onStatus: (text: string) => void,
): Promise<() => void> {
  const detector = barcodeDetector();
  let stream: MediaStream | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let objectUrl: string | undefined;
  let stopSink: (() => void) | undefined;

  const cleanup = () => {
    stopped = true;
    if (timer) clearInterval(timer);
    stopSink?.();
    stream?.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };

  const useHostFrames = async (): Promise<boolean> => {
    const res = await fetch("/api/camera/start", { method: "POST" });
    if (!res.ok) return false;
    const status = (await res.json()) as { running?: boolean; source?: string; rotation?: number };
    if (status.source !== "rpicam" && !status.running) return false;
    video.classList.add("hidden");
    jpeg.classList.remove("hidden");
    jpeg.style.transform = status.rotation ? `rotate(${status.rotation}deg)` : "";
    onStatus("Starting camera…");
    jpeg.addEventListener("load", () => {
      if (!stopped) onStatus("Camera on · hold the QR in the box");
    });
    timer = setInterval(() => {
      if (stopped) return;
      void fetch(`/api/camera/latest.jpg?t=${Date.now()}`)
        .then(async (frameRes) => {
          if (!frameRes.ok || stopped) return;
          const blob = await frameRes.blob();
          if (blob.size < 2) return;
          const next = URL.createObjectURL(blob);
          jpeg.src = next;
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = next;
          const bitmap = await createImageBitmap(blob);
          const raw = await readCode(detector, bitmap);
          bitmap.close();
          if (raw) onCode(raw);
        })
        .catch(() => undefined);
    }, 120);
    return true;
  };

  try {
    if (await useHostFrames()) return cleanup;
  } catch {
    // Fall through to the browser camera.
  }

  try {
    onStatus("Opening camera…");
    stream = await openUserCamera();
    jpeg.classList.add("hidden");
    video.classList.remove("hidden");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    await video.play();
    stopSink = startCameraFrameSink(video);
    onStatus("Camera on · hold the QR in the box");
  } catch (err) {
    cleanup();
    throw new Error(err instanceof Error ? err.message : "Camera is not available for QR scanning.");
  }

  timer = setInterval(() => {
    if (stopped || video.readyState < 2) return;
    void readCode(detector, video).then((raw) => {
      if (raw) onCode(raw);
    });
  }, 250);

  if (!detector) {
    onStatus("Camera on · this browser cannot read QR codes, so type the claim code.");
  }

  return cleanup;
}
