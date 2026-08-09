import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestKnowledgeDocument } from "./knowledge-ingest.js";
import type { KnowledgeExport } from "./knowledge-export-schema.js";
import { OipLocalMemoryProvider } from "./oip-local/provider.js";

describe("ingestKnowledgeDocument", () => {
  const dirs: string[] = [];
  const prevPersona = process.env.ALFRED_PERSONA_DIR;
  const prevOip = process.env.ALFRED_MEMORY_OIP_PATH;

  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
    if (prevPersona === undefined) delete process.env.ALFRED_PERSONA_DIR;
    else process.env.ALFRED_PERSONA_DIR = prevPersona;
    if (prevOip === undefined) delete process.env.ALFRED_MEMORY_OIP_PATH;
    else process.env.ALFRED_MEMORY_OIP_PATH = prevOip;
  });

  it("JSON export updates USER.md and creates linked OIP records", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alfred-ki-"));
    dirs.push(root);
    process.env.ALFRED_PERSONA_DIR = path.join(root, "persona");
    process.env.ALFRED_MEMORY_OIP_PATH = path.join(root, "oip");

    const doc: KnowledgeExport = {
      version: 1,
      exportedAt: "2026-08-09",
      source: "test",
      subjectName: "Devon",
      userPatch: {
        highPriorityPersistentContext: "Devon lives in SLO. Building Alfred.",
        howToWorkEffectivelyWithMe: "Be direct. No sycophancy.",
        negativePreferences: "Dislikes vague answers.",
      },
      entities: [
        {
          tempId: "person-devon",
          schemaType: "https://schema.org/Person",
          entityClass: "Person",
          name: "Devon James",
          aliases: ["Devon"],
          summary: "Primary user",
          confidence: "explicit",
          relationships: [{ predicate: "spouseOf", objectTempId: "person-amy" }],
        },
        {
          tempId: "person-amy",
          schemaType: "https://schema.org/Person",
          entityClass: "Person",
          name: "Amy",
          aliases: [],
          summary: "Wife",
          confidence: "explicit",
          relationships: [],
        },
      ],
      episodes: [],
      assertions: [
        {
          tempId: "a1",
          subjectTempId: "person-devon",
          predicate: "building",
          objectText: "Alfred",
          summary: "Devon is building Alfred",
          confidence: "explicit",
          topics: ["alfred"],
        },
      ],
      memories: [
        {
          tempId: "m1",
          kind: "fact",
          title: "Son Matty",
          text: "Devon and Amy have a son named Matty.",
          confidence: "explicit",
          topics: ["family"],
          relatedTempIds: ["person-devon", "person-amy"],
          staleRisk: false,
        },
      ],
      potentiallyStale: [],
      knowledgeGaps: [],
    };

    const result = await ingestKnowledgeDocument({
      filename: "sample.json",
      text: JSON.stringify(doc),
      providerId: "memory.oip-local",
    });

    expect(result.mode).toBe("json");
    expect(result.userMdUpdated).toBe(true);
    expect(result.created.entities).toBe(2);
    expect(result.created.assertions).toBeGreaterThanOrEqual(2); // spouse + building
    expect(result.created.observations).toBe(1);

    const userMd = await readFile(path.join(root, "persona", "USER.md"), "utf8");
    expect(userMd).toMatch(/High-Priority Persistent Context/);
    expect(userMd).toMatch(/Be direct/);

    const provider = new OipLocalMemoryProvider(path.join(root, "oip"));
    const hits = await provider.retrieve({ text: "Matty son Amy", limit: 8 });
    expect(hits.items.some((i) => /Matty/i.test(i.content))).toBe(true);
  });
});
