import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyExtraction, ingestAudioNote, ingestDocument, ingestKnowledgeDocument, ingestPhoto, OipLocalMemoryProvider } from "@alfred/memory";
import {
  readMemoryArtifactBytes,
  resolveMemoryFilePreview,
  resolveMemoryImagePreview,
} from "./memory-graph.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("memory graph image preview", () => {
  const dirs: string[] = [];
  const prevOip = process.env.ALFRED_MEMORY_OIP_PATH;
  const prevPersona = process.env.ALFRED_PERSONA_DIR;
  const prevProfile = process.env.ALFRED_PROFILE_ID;

  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
    if (prevOip === undefined) delete process.env.ALFRED_MEMORY_OIP_PATH;
    else process.env.ALFRED_MEMORY_OIP_PATH = prevOip;
    if (prevPersona === undefined) delete process.env.ALFRED_PERSONA_DIR;
    else process.env.ALFRED_PERSONA_DIR = prevPersona;
    if (prevProfile === undefined) delete process.env.ALFRED_PROFILE_ID;
    else process.env.ALFRED_PROFILE_ID = prevProfile;
  });

  it("resolves the stored photo artifact for the file entity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alfred-graph-img-"));
    dirs.push(root);
    process.env.ALFRED_MEMORY_OIP_PATH = path.join(root, "oip");
    process.env.ALFRED_PERSONA_DIR = path.join(root, "persona");
    process.env.ALFRED_PROFILE_ID = "profile.default";

    const result = await ingestPhoto({
      filename: "shot.png",
      bytes: PNG_1X1,
      mimeType: "image/png",
      analysis: {
        backend: "openai",
        model: "gpt-4o",
        summary: "A tiny test pixel",
        fullText: "pixel",
        handwrittenNotes: [],
        names: [],
        dates: [],
        places: [],
        objects: [],
        documentType: "photo",
      },
      extractor: async () => emptyExtraction(),
    });

    const preview = await resolveMemoryImagePreview(result.artifactId!);
    expect(preview).toBeTruthy();
    expect(preview?.mimeType).toBe("image/png");
    expect(preview?.filename).toBe("shot.png");
    expect(preview?.url).toMatch(/\/memory\/graph\/artifact\//);

    const bytes = await readMemoryArtifactBytes(result.artifactId!);
    expect(bytes?.bytes.equals(PNG_1X1)).toBe(true);
    expect(bytes?.mimeType).toBe("image/png");

    const provider = new OipLocalMemoryProvider(path.join(root, "oip"));
    const fileHits = provider.sqlite.findByName("shot.png", "Entity");
    expect(fileHits.length).toBeGreaterThanOrEqual(1);
    const fromEntity = await resolveMemoryImagePreview(fileHits[0]!.id);
    expect(fromEntity?.artifactId).toBe(preview?.artifactId);
  });

  it("resolves original PDF and markdown artifacts for file nodes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alfred-graph-file-"));
    dirs.push(root);
    process.env.ALFRED_MEMORY_OIP_PATH = path.join(root, "oip");
    process.env.ALFRED_PERSONA_DIR = path.join(root, "persona");
    process.env.ALFRED_PROFILE_ID = "profile.default";

    const pdf = await ingestDocument({
      filename: "brief.pdf",
      bytes: Buffer.from("%PDF-fake-bytes"),
      pages: ["Alfred stores memories as OIP packages."],
      extractor: async () => emptyExtraction(),
    });
    const pdfPreview = await resolveMemoryFilePreview(pdf.artifactId!);
    expect(pdfPreview?.kind).toBe("pdf");
    expect(pdfPreview?.mimeType).toBe("application/pdf");
    expect((await readMemoryArtifactBytes(pdf.artifactId!))?.bytes.toString()).toBe("%PDF-fake-bytes");

    const md = await ingestKnowledgeDocument({
      filename: "notes.md",
      text: "# Hello\n\nWorld from a markdown file.",
      bytes: Buffer.from("# Hello\n\nWorld from a markdown file."),
      providerId: "memory.oip-local",
    });
    expect(md.artifactId).toBeTruthy();
    const mdPreview = await resolveMemoryFilePreview(md.artifactId!);
    expect(mdPreview?.kind).toBe("text");
    expect(mdPreview?.mimeType).toBe("text/markdown");
    expect((await readMemoryArtifactBytes(md.artifactId!))?.bytes.toString()).toMatch(/World from a markdown file/);

    const provider = new OipLocalMemoryProvider(path.join(root, "oip"));
    const fileHits = provider.sqlite.findByName("notes.md", "Entity");
    expect(fileHits.length).toBeGreaterThanOrEqual(1);
    expect((await resolveMemoryFilePreview(fileHits[0]!.id))?.artifactId).toBe(mdPreview?.artifactId);
  });

  it("resolves the stored audio artifact for the file entity and episode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alfred-graph-audio-"));
    dirs.push(root);
    process.env.ALFRED_MEMORY_OIP_PATH = path.join(root, "oip");
    process.env.ALFRED_PERSONA_DIR = path.join(root, "persona");
    process.env.ALFRED_PROFILE_ID = "profile.default";

    const bytes = Buffer.from("fake-m4a-bytes");
    const result = await ingestAudioNote({
      filename: "standup.m4a",
      bytes,
      mimeType: "audio/mp4",
      title: "Weekly standup",
      transcript: "Ship pricing Friday.",
      metadata: {
        summary: "Ship pricing Friday.",
        takeaways: ["Ship pricing Friday"],
        nextSteps: [],
        openQuestions: [],
        attendees: [],
        template: "meeting",
      },
    });

    const fromArtifact = await resolveMemoryFilePreview(result.artifactId);
    expect(fromArtifact?.kind).toBe("audio");
    expect(fromArtifact?.mimeType).toBe("audio/mp4");
    expect(fromArtifact?.filename).toBe("standup.m4a");
    expect((await readMemoryArtifactBytes(result.artifactId))?.bytes.equals(bytes)).toBe(true);

    const fromFile = await resolveMemoryFilePreview(result.fileEntityId);
    expect(fromFile?.artifactId).toBe(fromArtifact?.artifactId);
    expect(fromFile?.kind).toBe("audio");

    const fromEpisode = await resolveMemoryFilePreview(result.episodeId);
    expect(fromEpisode?.artifactId).toBe(fromArtifact?.artifactId);
    expect(fromEpisode?.kind).toBe("audio");
  });
});
