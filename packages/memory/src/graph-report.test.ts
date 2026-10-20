import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  chunkMemoriesForReport,
  fallbackGraphReportMarkdown,
  GRAPH_REPORT_COMPILE_SYSTEM,
  GRAPH_REPORT_EXTRACT_SYSTEM,
  graphReportLooksThin,
  rankMemoriesForReport,
  revisionPlainText,
  slugFromReportTitle,
  titleFromReportPrompt,
  writeGraphViewReport,
  type GraphReportMemory,
} from "./graph-report.js";
import { OipLocalMemoryProvider } from "./oip-local/provider.js";
import { SCHEMA_ORG } from "./oip-local/schema-org.js";

describe("graph view report", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  async function tempProvider(): Promise<OipLocalMemoryProvider> {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-graph-report-"));
    dirs.push(dir);
    return new OipLocalMemoryProvider(dir);
  }

  it("titles from the prompt, view, or a default", () => {
    expect(titleFromReportPrompt("ADHD themes and contradictions")).toBe(
      "ADHD themes and contradictions",
    );
    expect(titleFromReportPrompt("", { from: "adhd info from x" })).toBe("Report: adhd info from x");
    expect(titleFromReportPrompt("")).toBe("Graph report");
    expect(slugFromReportTitle("ADHD themes!")).toBe("adhd-themes");
  });

  it("treats a 7-section briefing of hundreds of memories as too thin", () => {
    const short = `# Title\n\n## One\nShort.\n\n## Two\nShort.\n`;
    expect(graphReportLooksThin(short, 262)).toBe(true);
    expect(graphReportLooksThin(`${"#".repeat(8)}\n${"claim\n".repeat(4000)}`, 262)).toBe(false);
    expect(GRAPH_REPORT_EXTRACT_SYSTEM).toMatch(/every distinct claim/i);
    expect(GRAPH_REPORT_COMPILE_SYSTEM).toMatch(/not a short briefing/i);
    expect(GRAPH_REPORT_COMPILE_SYSTEM).toMatch(/5–10 point overview/i);
  });

  it("ranks longer memories first and chunks by character budget", () => {
    const items: GraphReportMemory[] = [
      { id: "a", name: "short", type: "Entity", text: "hi" },
      { id: "b", name: "long", type: "Observation", text: "x".repeat(400) },
      { id: "c", name: "mid", type: "Assertion", text: "y".repeat(40) },
    ];
    expect(rankMemoriesForReport(items, 2).map((m) => m.id)).toEqual(["b", "c"]);
    const batches = chunkMemoriesForReport(items, 80);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map((m) => m.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("builds a fallback briefing from the shown memories and prompt", () => {
    const md = fallbackGraphReportMarkdown({
      title: "ADHD briefing",
      prompt: "Focus on practical takeaways.",
      view: { from: "adhd info from x" },
      generatedAt: "2026-10-16T14:00:00.000Z",
      memories: [
        {
          id: "did:memory:1",
          name: "Gali — HIGH-IQ ADHD",
          type: "Observation",
          text: "Working memory load collapses under shame.",
        },
      ],
    });
    expect(md).toMatch(/^# ADHD briefing/m);
    expect(md).toContain("adhd info from x");
    expect(md).toContain("Focus on practical takeaways.");
    expect(md).toContain("Working memory load collapses under shame.");
  });

  it("reads schema description when text is empty", () => {
    expect(
      revisionPlainText({
        id: "did:memory:x",
        type: "Entity",
        revision: "sha256:aa",
        previousRevision: null,
        createdAt: "2026-10-16T00:00:00.000Z",
        updatedAt: "2026-10-16T00:00:00.000Z",
        schema: { description: "Saved thread on sleep." },
        alfred: {},
        drefs: {},
        provenance: {},
      } as never),
    ).toBe("Saved thread on sleep.");
  });

  it("writes a markdown artifact linked to the source memories", async () => {
    const provider = await tempProvider();
    const a = await provider.createRecord("Observation", {
      name: "Sleep and ADHD",
      text: "Delayed sleep phase is common in ADHD.",
      schemaType: SCHEMA_ORG.CreativeWork,
    });
    const b = await provider.createRecord("Observation", {
      name: "Shame spirals",
      text: "Shame collapses working memory.",
      schemaType: SCHEMA_ORG.CreativeWork,
    });
    const result = await writeGraphViewReport({
      provider,
      nodeIds: [a.id, b.id],
      prompt: "ADHD practical briefing",
      view: { from: "adhd info from x" },
      now: new Date("2026-10-16T14:00:00.000Z"),
      writer: async () => "# ADHD practical briefing\n\nShame collapses working memory under load.\n",
    });
    expect(result.title).toBe("ADHD practical briefing");
    expect(result.linkedCount).toBe(2);
    expect(result.usedCount).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.markdown).toContain("Shame collapses working memory under load.");
    expect(result.markdown).toContain("adhd info from x");

    const doc = await provider.packages.readCurrent(result.did.replace(/^did:memory:/, ""));
    expect(doc?.drefs?.about).toEqual([a.id, b.id]);
    expect(doc?.drefs?.sourceArtifact).toBe(result.artifactDid);
    expect(doc?.alfred?.entityClass).toBe("graph_view_report");

    provider.sqlite.open();
    const about = provider.sqlite.edgesFrom(result.did).filter((e) => e.predicate === "about");
    expect(about.map((e) => e.target_id).sort()).toEqual([a.id, b.id].sort());
  });
});
