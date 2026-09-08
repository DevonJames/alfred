import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestAudioNote, OipLocalMemoryProvider } from "@alfred/memory";
import {
  artifactRefFromRevision,
  revisionToPhoneMemory,
  sourceArtifactIdFromRevision,
} from "./phone-memory.js";

const FAKE_M4A = Buffer.from("fake-m4a-bytes");

describe("phone memory audio artifacts", () => {
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

  it("attaches the original recording when an audio note episode is opened", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alfred-phone-audio-"));
    dirs.push(root);
    process.env.ALFRED_MEMORY_OIP_PATH = path.join(root, "oip");
    process.env.ALFRED_PERSONA_DIR = path.join(root, "persona");

    const result = await ingestAudioNote({
      filename: "standup.m4a",
      bytes: FAKE_M4A,
      mimeType: "audio/mp4",
      title: "Weekly standup",
      transcript: "Ship pricing Friday.",
      metadata: {
        summary: "Ship pricing Friday.",
        takeaways: ["Ship pricing Friday"],
        nextSteps: [{ text: "Write the pricing email", assignee: "Devon", dueDate: "2026-09-08" }],
        openQuestions: [],
        attendees: ["Devon"],
        template: "meeting",
      },
    });

    const provider = new OipLocalMemoryProvider(path.join(root, "oip"));
    const episode = await provider.resolveRef(result.episodeId);
    expect(episode).toBeTruthy();
    expect(sourceArtifactIdFromRevision(episode)).toBe(result.artifactId);

    const artifactRev = await provider.resolveRef(result.artifactId);
    const artifact = artifactRefFromRevision(artifactRev);
    expect(artifact).toBeTruthy();
    expect(artifact?.mimeType).toBe("audio/mp4");
    expect(artifact?.filename).toBe("standup.m4a");
    expect(artifact?.available).toBe(true);
    expect(artifact?.url).toMatch(/\/memory\/graph\/artifact\//);

    const phone = revisionToPhoneMemory(episode!, { artifacts: artifact ? [artifact] : [] });
    expect(phone.kind).toBe("episode");
    expect(phone.title).toMatch(/standup/i);
    expect(phone.artifacts).toHaveLength(1);
    expect(phone.artifacts[0]?.mimeType).toBe("audio/mp4");
    expect(phone.artifacts[0]?.url).toBe(artifact?.url);
  });
});
