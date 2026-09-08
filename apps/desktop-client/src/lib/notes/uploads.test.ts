import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getNoteAudioChunk, getNoteAudioMeta } from "./service.js";
import {
  NOTE_UPLOAD_CHUNK_BYTES,
  completeNoteUpload,
  createNoteUpload,
  getNoteUpload,
  putNoteChunk,
} from "./uploads.js";

describe("note upload sessions", () => {
  const dirs: string[] = [];
  const prevOip = process.env.ALFRED_MEMORY_OIP_PATH;
  const prevPersona = process.env.ALFRED_PERSONA_DIR;

  afterEach(async () => {
    for (const dir of dirs) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          await rm(dir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      }
    }
    dirs.length = 0;
    if (prevOip === undefined) delete process.env.ALFRED_MEMORY_OIP_PATH;
    else process.env.ALFRED_MEMORY_OIP_PATH = prevOip;
    if (prevPersona === undefined) delete process.env.ALFRED_PERSONA_DIR;
    else process.env.ALFRED_PERSONA_DIR = prevPersona;
  });

  async function isolatedRoot() {
    const root = await mkdtemp(path.join(tmpdir(), "alfred-note-upload-"));
    dirs.push(root);
    process.env.ALFRED_MEMORY_OIP_PATH = path.join(root, "oip");
    process.env.ALFRED_PERSONA_DIR = path.join(root, "persona");
    return root;
  }

  it("accepts chunks out of order and resumes from received indexes", async () => {
    await isolatedRoot();
    const bytes = Buffer.alloc(NOTE_UPLOAD_CHUNK_BYTES + 80, 7);
    const created = await createNoteUpload({
      filename: "tour.m4a",
      mimeType: "audio/mp4",
      byteLength: bytes.length,
    });
    expect(created.totalChunks).toBe(2);
    expect(created.received).toEqual([]);

    const second = await putNoteChunk({
      id: created.id,
      index: 1,
      data: bytes.subarray(NOTE_UPLOAD_CHUNK_BYTES).toString("base64"),
    });
    expect(second.received).toEqual([1]);

    const again = await putNoteChunk({
      id: created.id,
      index: 1,
      data: bytes.subarray(NOTE_UPLOAD_CHUNK_BYTES).toString("base64"),
    });
    expect(again.received).toEqual([1]);

    const first = await putNoteChunk({
      id: created.id,
      index: 0,
      data: bytes.subarray(0, NOTE_UPLOAD_CHUNK_BYTES).toString("base64"),
    });
    expect(first.received).toEqual([0, 1]);
    expect((await getNoteUpload(created.id))?.received).toEqual([0, 1]);
  });

  it("refuses complete until every chunk is present", async () => {
    await isolatedRoot();
    const bytes = Buffer.alloc(NOTE_UPLOAD_CHUNK_BYTES + 12, 3);
    const created = await createNoteUpload({
      filename: "partial.m4a",
      byteLength: bytes.length,
    });
    await putNoteChunk({
      id: created.id,
      index: 0,
      data: bytes.subarray(0, NOTE_UPLOAD_CHUNK_BYTES).toString("base64"),
    });
    await expect(completeNoteUpload(created.id)).rejects.toThrow(/incomplete/);
  });

  it("assembles the original bytes and starts a note job", async () => {
    await isolatedRoot();
    const bytes = Buffer.from("rental-tour-audio-bytes-for-assemble-test!!");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const created = await createNoteUpload({
      filename: "rental.m4a",
      mimeType: "audio/mp4",
      byteLength: bytes.length,
      contentHash: hash,
      title: "Rental tour",
      template: "meeting",
    });
    expect(created.totalChunks).toBe(1);
    await putNoteChunk({
      id: created.id,
      index: 0,
      data: bytes.toString("base64"),
    });
    const finished = await completeNoteUpload(created.id);
    expect(finished.note.title).toMatch(/rental/i);
    expect(finished.note.processingStatus).toBe("processing");
    expect(finished.job.noteId).toBe(finished.note.id);
    expect(finished.upload.status).toBe("completed");
    const meta = await getNoteAudioMeta(finished.note.id, NOTE_UPLOAD_CHUNK_BYTES);
    expect(meta?.byteLength).toBe(bytes.length);
    const chunk = await getNoteAudioChunk(finished.note.id, 0, NOTE_UPLOAD_CHUNK_BYTES);
    expect(chunk && Buffer.from(chunk.data, "base64").equals(bytes)).toBe(true);
  });
});
