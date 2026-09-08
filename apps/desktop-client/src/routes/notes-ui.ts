import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  handleAudio,
  handleFromAudio,
  handleFromAudioAsync,
  handleGetJob,
  handleGetNote,
  handleListNotes,
  handleRetryDetails,
  handleRetryTranscript,
} from "../lib/notes/handlers.js";

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), "../ui");

export const notesUiRouter = new Hono();

notesUiRouter.get("/", async (c) => {
  const html = await readFile(resolve(uiDir, "notes.html"), "utf8");
  return c.html(html);
});

notesUiRouter.get("/list", handleListNotes);
notesUiRouter.post("/from-audio", handleFromAudio);
notesUiRouter.post("/from-audio-async", handleFromAudioAsync);
notesUiRouter.get("/jobs/:jobId", handleGetJob);
notesUiRouter.get("/:id/audio", handleAudio);
notesUiRouter.post("/:id/retry-details", handleRetryDetails);
notesUiRouter.post("/:id/retry-transcript", handleRetryTranscript);
notesUiRouter.get("/:id", handleGetNote);
