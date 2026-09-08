import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestAudioNote, updateAudioNoteProgress } from "./audio-note-ingest.js";
import { OipLocalMemoryProvider } from "./oip-local/provider.js";

const FAKE_M4A = Buffer.from("fake-m4a-bytes");

describe("ingestAudioNote", () => {
  const dirs: string[] = [];
  const prevOip = process.env.ALFRED_MEMORY_OIP_PATH;
  const prevPersona = process.env.ALFRED_PERSONA_DIR;

  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
    if (prevOip === undefined) delete process.env.ALFRED_MEMORY_OIP_PATH;
    else process.env.ALFRED_MEMORY_OIP_PATH = prevOip;
    if (prevPersona === undefined) delete process.env.ALFRED_PERSONA_DIR;
    else process.env.ALFRED_PERSONA_DIR = prevPersona;
  });

  it("stores an audio artifact, file entity, episode, and metadata observations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alfred-audionote-"));
    dirs.push(root);
    process.env.ALFRED_MEMORY_OIP_PATH = path.join(root, "oip");
    process.env.ALFRED_PERSONA_DIR = path.join(root, "persona");

    const result = await ingestAudioNote({
      filename: "standup.m4a",
      bytes: FAKE_M4A,
      mimeType: "audio/mp4",
      title: "Weekly standup",
      transcript: "We decided to ship the pricing change on Friday. Devon will write the email.",
      metadata: {
        summary: "Team agreed to ship pricing on Friday.",
        takeaways: ["Ship the pricing change Friday"],
        nextSteps: [{ text: "Write the pricing email", assignee: "Devon", dueDate: "2026-09-08" }],
        openQuestions: ["Does marketing need a heads-up?"],
        attendees: ["Devon"],
        template: "meeting",
      },
    });

    expect(result.mode).toBe("audio_note");
    expect(result.artifactId).toBeTruthy();
    expect(result.fileEntityId).toBeTruthy();
    expect(result.episodeId).toBeTruthy();
    expect(result.created.episodes).toBe(1);
    expect(result.created.entities).toBe(1);
    expect(result.created.observations).toBeGreaterThanOrEqual(4);

    const provider = new OipLocalMemoryProvider(path.join(root, "oip"));
    const fileHits = provider.sqlite.findByName("standup.m4a", "Entity");
    expect(fileHits.length).toBeGreaterThan(0);
    const file = await provider.resolveRef(fileHits[0]!.id);
    expect(file?.drefs.sourceArtifact).toBe(result.artifactId);
    expect(file?.schemaType).toBe("https://schema.org/AudioObject");
    expect(file?.provenance?.sourceType).toBe("audio_note");

    const episode = await provider.resolveRef(result.episodeId);
    expect(episode?.type).toBe("Episode");
    expect(episode?.drefs.sourceArtifact).toBe(result.artifactId);
    expect(episode?.drefs.recording).toBe(result.fileEntityId);
    expect(episode?.schema?.processingStatus).toBe("completed");
    expect(episode?.schema?.takeaways).toEqual(["Ship the pricing change Friday"]);

    const retrieved = await provider.retrieve({
      text: "what were the action items from the weekly standup note",
      limit: 10,
    });
    expect(retrieved.items.some((i) => /source=audio note/.test(i.content))).toBe(true);
    expect(retrieved.items.some((i) => /note=Weekly standup/.test(i.content))).toBe(true);
    expect(retrieved.items.some((i) => /pricing|Write the pricing email/i.test(i.content))).toBe(true);

    const actionHits = provider.sqlite.findBySearchSubstring("Write the pricing email");
    expect(actionHits.length).toBeGreaterThan(0);
    const action = await provider.resolveRef(actionHits[0]!.id);
    expect(action?.remindAt).toBe("2026-09-08");
    expect(action?.reminderStatus).toBe("pending");
  });

  it("can write a growing transcript without replacing metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alfred-audionote-progress-"));
    dirs.push(root);
    process.env.ALFRED_MEMORY_OIP_PATH = path.join(root, "oip");
    process.env.ALFRED_PERSONA_DIR = path.join(root, "persona");

    const result = await ingestAudioNote({
      filename: "tour.m4a",
      bytes: FAKE_M4A,
      mimeType: "audio/mp4",
      title: "Rental tour",
      transcript: "",
      metadata: {
        summary: "",
        takeaways: [],
        nextSteps: [],
        openQuestions: [],
        attendees: [],
        template: "meeting",
      },
    });

    await updateAudioNoteProgress({
      episodeId: result.episodeId,
      transcript: "Kitchen has new appliances.",
      processingStatus: "processing",
      durationSeconds: 5400,
    });

    const provider = new OipLocalMemoryProvider(path.join(root, "oip"));
    const episode = await provider.resolveRef(result.episodeId);
    expect(episode?.schema?.transcript).toBe("Kitchen has new appliances.");
    expect(episode?.schema?.processingStatus).toBe("processing");
    expect(episode?.schema?.durationSeconds).toBe(5400);
  });
});
