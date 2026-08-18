import { hashBytes } from "../oip-local/hashing.js";
import type { OipLocalMemoryProvider } from "../oip-local/provider.js";
import { SCHEMA_ORG, schemaOrgPerson } from "../oip-local/schema-org.js";
import type { MemoryRevision } from "../oip-local/schemas.js";
import type { XCapture, XSource } from "./types.js";
import { isoDuration } from "./youtube-capture.js";

export interface XOipWriteResult {
  memoryDid: string;
  authorDid: string;
  contentHash: string;
  created: boolean;
}

function xProvenance(opts: {
  url: string;
  learnedAt: string;
  author?: string;
  noteNames: string[];
  noteFolders: string[];
  sourceType?: "x_com" | "youtube";
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    sourceType: opts.sourceType ?? "x_com",
    extractionMethod: "x_notes_ingest",
    source: opts.url,
    learnedAt: opts.learnedAt,
    author: opts.author,
    noteName: opts.noteNames[0],
    noteFolder: opts.noteFolders[0],
    noteNames: opts.noteNames,
    noteFolders: opts.noteFolders,
    ...opts.extra,
  };
}

export function captureContentHash(capture: XCapture): string {
  return hashBytes(
    JSON.stringify({
      url: capture.canonicalUrl,
      text: capture.text,
      description: capture.description ?? "",
      posts: capture.posts.map((p) => p.text),
      linked: capture.linkedPage?.text ?? "",
    }),
  );
}

async function findPerson(
  provider: OipLocalMemoryProvider,
  name: string,
  handle?: string,
): Promise<MemoryRevision | undefined> {
  const keys = [handle?.replace(/^@/, ""), name].filter(Boolean) as string[];
  for (const key of keys) {
    const rows = provider.sqlite.findByName(key, "Entity");
    for (const row of rows) {
      const rev = await provider.packages.readCurrent(row.logical_id);
      if (!rev) continue;
      if (rev.schemaType === SCHEMA_ORG.Person || rev.alfred?.entityClass === "Person") {
        return rev;
      }
    }
  }
  return undefined;
}

async function findPostingByUrl(
  provider: OipLocalMemoryProvider,
  canonicalUrl: string,
): Promise<MemoryRevision | undefined> {
  const needle = canonicalUrl.toLowerCase();
  const rows = provider.sqlite.findBySearchSubstring(canonicalUrl);
  for (const row of rows) {
    const rev = await provider.packages.readCurrent(row.logical_id);
    if (!rev) continue;
    const url = String(rev.schema?.url ?? rev.provenance?.source ?? "").toLowerCase();
    if (url === needle || url.includes(needle)) return rev;
  }
  return undefined;
}

export async function writeXCaptureToOip(opts: {
  provider: OipLocalMemoryProvider;
  capture: XCapture;
  sources: Pick<XSource, "note" | "folder">[];
  learnedAt?: string;
  extraFacts?: Array<{ summary: string; predicate?: string }>;
}): Promise<XOipWriteResult> {
  const { provider, capture } = opts;
  const learnedAt = opts.learnedAt ?? new Date().toISOString();
  const noteNames = [...new Set(opts.sources.map((s) => s.note).filter(Boolean))];
  const noteFolders = [...new Set(opts.sources.map((s) => s.folder).filter(Boolean))];
  const publishedAt = capture.publishedAt ?? capture.posts[0]?.publishedAt ?? null;
  const contentHash = captureContentHash(capture);
  const isVideo = capture.kind === "video";
  const provenance = xProvenance({
    url: capture.canonicalUrl,
    learnedAt,
    author: capture.author,
    noteNames,
    noteFolders,
    sourceType: isVideo ? "youtube" : "x_com",
    extra: { authorHandle: capture.authorHandle, kind: capture.kind, contentHash },
  });

  const artifactIds: string[] = [];
  const captureJson = Buffer.from(
    JSON.stringify(
      {
        ...capture,
        screenshots: capture.screenshots.map((s) => s.name),
        images: capture.images.map((i) => i.name),
      },
      null,
      2,
    ),
    "utf8",
  );
  const jsonArt = await provider.putArtifactBytes(captureJson, {
    mimeType: "application/json",
    originalFilename: `x-capture-${contentHash.slice(-12)}.json`,
    name: capture.headline || capture.canonicalUrl,
    reindex: false,
  });
  artifactIds.push(jsonArt.id);

  for (const shot of capture.screenshots) {
    const a = await provider.putArtifactBytes(shot.bytes, {
      mimeType: shot.mimeType,
      originalFilename: shot.name,
      name: shot.name,
      reindex: false,
    });
    artifactIds.push(a.id);
  }
  for (const img of capture.images) {
    const a = await provider.putArtifactBytes(img.bytes, {
      mimeType: img.mimeType,
      originalFilename: img.name,
      name: img.name,
      reindex: false,
    });
    artifactIds.push(a.id);
  }

  const aliases = capture.authorHandle
    ? [capture.authorHandle.replace(/^@/, ""), `@${capture.authorHandle.replace(/^@/, "")}`]
    : [];
  let author = await findPerson(provider, capture.author, capture.authorHandle);
  if (author) {
    const existingAliases = Array.isArray(author.schema?.alternateName)
      ? author.schema.alternateName.map(String)
      : [];
    const merged = [...new Set([...existingAliases, ...aliases])];
    author = await provider.updateRecord(
      author.id,
      {
        schema: schemaOrgPerson(capture.author || String(author.name ?? ""), merged),
        provenance: { ...author.provenance, ...provenance },
      },
      { reindex: false },
    );
  } else {
    author = await provider.createRecord(
      "Entity",
      {
        name: capture.author || capture.authorHandle || "Unknown author",
        schemaType: SCHEMA_ORG.Person,
        schema: schemaOrgPerson(capture.author || "Unknown author", aliases),
        alfred: { entityClass: "Person", confidence: 0.9, visibility: "private" },
        learnedAt,
        provenance,
        drefs: artifactIds[0] ? { sourceArtifact: artifactIds[0] } : {},
      },
      undefined,
      { reindex: false },
    );
  }

  const schemaType = isVideo
    ? SCHEMA_ORG.VideoObject
    : capture.kind === "article" || capture.kind === "linked_page"
      ? SCHEMA_ORG.Article
      : SCHEMA_ORG.SocialMediaPosting;
  const schemaAtType = isVideo
    ? "VideoObject"
    : capture.kind === "article" || capture.kind === "linked_page"
      ? "Article"
      : "SocialMediaPosting";
  const noteLabel = noteNames.length ? noteNames.join(", ") : "";
  const searchBits = isVideo
    ? ["youtube", "YouTube", "video", capture.author, capture.description, noteLabel, "note"]
        .filter(Boolean)
        .join(" ")
    : ["x.com", "twitter", "X", capture.authorHandle, noteLabel, "note"].filter(Boolean).join(" ");
  const bodyText = [
    capture.text,
    capture.description && isVideo ? capture.description : "",
    capture.quoted ? `Quoted: ${capture.quoted.text}` : "",
    capture.linkedPage ? `Linked: ${capture.linkedPage.title}\n${capture.linkedPage.text}` : "",
    searchBits,
  ]
    .filter(Boolean)
    .join("\n\n");

  const duration = isoDuration(capture.durationSeconds);
  const postingBody = {
    name: capture.headline,
    text: bodyText,
    schemaType,
    schema: {
      "@type": schemaAtType,
      name: capture.headline,
      url: capture.canonicalUrl,
      datePublished: publishedAt,
      author: capture.author,
      description: capture.description,
      duration,
      identifier: capture.videoId || capture.canonicalUrl,
      keywords: [isVideo ? "youtube" : "x.com", capture.kind, ...noteNames].filter(Boolean).join(", "),
    },
    alfred: {
      entityClass: capture.kind,
      confidence: 0.9,
      visibility: "private" as const,
      assertionType: "extracted" as const,
    },
    validFrom: publishedAt,
    validTimeStart: publishedAt ?? undefined,
    learnedAt,
    provenance,
    drefs: {
      author: author.id,
      ...(artifactIds[0] ? { sourceArtifact: artifactIds[0] } : {}),
      ...(artifactIds.length > 1 ? { artifacts: artifactIds } : {}),
    },
  };

  let posting = await findPostingByUrl(provider, capture.canonicalUrl);
  let created = false;
  if (posting) {
    posting = await provider.updateRecord(posting.id, postingBody, { reindex: false });
  } else {
    posting = await provider.createRecord("Observation", postingBody, undefined, { reindex: false });
    created = true;
  }

  await provider.createRecord(
    "Assertion",
    {
      name: `${capture.author} authored ${capture.headline}`,
      text: isVideo
        ? `${capture.author} authored this YouTube video`
        : `${capture.author} authored this X ${capture.kind}`,
      subject: author.id,
      predicate: "authored",
      object: posting.id,
      schema: { "@type": "Statement", name: "authored" },
      drefs: { subject: author.id, object: posting.id },
        alfred: { assertionType: "extracted" as const, confidence: 0.9, visibility: "private" as const },
      validFrom: publishedAt,
      learnedAt,
      provenance,
    },
    undefined,
    { reindex: false },
  );

  for (const fact of opts.extraFacts ?? []) {
    await provider.createRecord(
      "Assertion",
      {
        name: fact.summary,
        text: fact.summary,
        subject: posting.id,
        predicate: fact.predicate ?? "asserts",
        object: fact.summary,
        schema: { "@type": "Statement", name: fact.summary },
        drefs: { subject: posting.id },
        alfred: { assertionType: "extracted", confidence: 0.7, visibility: "private" },
        validFrom: publishedAt,
        learnedAt,
        provenance,
      },
      undefined,
      { reindex: false },
    );
  }

  await provider.rebuildIndexes();
  return { memoryDid: posting.id, authorDid: author.id, contentHash, created };
}
