/** Push preview frames to the host so the existing face tracker keeps its JPEG path. */
export function startCameraFrameSink(video: HTMLVideoElement, intervalMs = 100): () => void {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => undefined;

  let busy = false;
  const timer = setInterval(() => {
    if (busy || video.readyState < 2 || video.videoWidth === 0) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    busy = true;
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          busy = false;
          return;
        }
        void fetch("/api/camera-frame", {
          method: "POST",
          headers: { "Content-Type": "image/jpeg" },
          body: blob,
        }).finally(() => {
          busy = false;
        });
      },
      "image/jpeg",
      0.7,
    );
  }, intervalMs);

  return () => clearInterval(timer);
}
