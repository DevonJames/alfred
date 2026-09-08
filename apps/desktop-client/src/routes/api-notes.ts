import { Hono } from "hono";
import {
  handleAudio,
  handleAudioChunk,
  handleAudioMeta,
  handleCompleteUpload,
  handleCreateUpload,
  handleFromAudio,
  handleFromAudioAsync,
  handleGetJob,
  handleGetNote,
  handleGetUpload,
  handleListNotes,
  handlePutUploadChunk,
  handleRetryDetails,
  handleRetryTranscript,
} from "../lib/notes/handlers.js";
import { requireSidecarOrDevice } from "../middleware/sidecar-or-device.js";

export const apiNotesRouter = new Hono();

apiNotesRouter.use("*", requireSidecarOrDevice);

apiNotesRouter.get("/", handleListNotes);
apiNotesRouter.post("/from-audio", handleFromAudio);
apiNotesRouter.post("/from-audio-async", handleFromAudioAsync);
apiNotesRouter.post("/uploads", handleCreateUpload);
apiNotesRouter.get("/uploads/:uploadId", handleGetUpload);
apiNotesRouter.put("/uploads/:uploadId/chunks/:index", handlePutUploadChunk);
apiNotesRouter.post("/uploads/:uploadId/complete", handleCompleteUpload);
apiNotesRouter.get("/jobs/:jobId", handleGetJob);
apiNotesRouter.get("/:id/audio/meta", handleAudioMeta);
apiNotesRouter.get("/:id/audio/chunks/:index", handleAudioChunk);
apiNotesRouter.get("/:id/audio", handleAudio);
apiNotesRouter.post("/:id/retry-details", handleRetryDetails);
apiNotesRouter.post("/:id/retry-transcript", handleRetryTranscript);
apiNotesRouter.get("/:id", handleGetNote);
