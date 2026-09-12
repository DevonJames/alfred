# Embedding space (Graph beta + Vector Explorer)

**Status:** Implemented (OpenAI embeddings). Local/offline models are a follow-up — [local-embeddings-mac-mini.md](./local-embeddings-mac-mini.md).  
**Rule:** embeddings are a rebuildable index. OIP packages remain the source of truth ([Memory PRD](./ALFRED-MEMORY-prd.md) §3.3).

---

## What this is

Graph (beta) can lay out the same graph-visible records as a **Semantic Map**: points sit near their original-space neighbors (cosine), not near force-layout graph hops. Types/categories are for reveal and metrics only — they do not drive the projection.

Vector Explorer is a **session-only sandbox** for the same math on synthetic texts. It does not write to the memory corpus.

Talk retrieval still uses FTS / graph, not ANN search over this index.

---

## Surfaces

| URL / API | Role |
| --- | --- |
| http://127.0.0.1:3000/memory/graph-beta | Toggle **Graph** vs **Embedding space**. Projection: MDS (cosine), PCA, directional PCA. 2D/3D, k-NN edges, outlier highlight, reveal expected groups. |
| `GET /memory/graph/embeddings` | Cached PCA `{x,y,z}` snapshot + stale/missing flags |
| `POST /memory/graph/embeddings/rebuild` | OpenAI embed + write index (SSE progress) |
| `POST /memory/graph/embeddings/semantic-map` | On-demand MDS/PCA + k-NN from stored vectors |
| http://127.0.0.1:3000/vector-explorer | Demo datasets; `POST /vector-explorer/embed` |

Requires `OPENAI_API_KEY`. Optional `OPENAI_EMBEDDING_MODEL` (default `text-embedding-3-small`).

---

## Storage

`FileVectorIndex` writes under `{oipRoot}/indexes/vectors/` (default `./data/memory-oip/{profileId}/indexes/vectors/`):

```text
manifest.json      provider, model, dimensions, recordCount, builtAt
vectors.jsonl      { id, revision, textHash, embedding[] }
projection.json    cached 3D PCA positions (Graph snapshot)
```

Delete this directory and rebuild — no packages or artifacts are lost.

Embed text is `name` + `search_text` (`buildEmbedText` in `packages/memory/src/embeddings/`).

---

## Projection contract

- **Authoritative similarity:** cosine in the original embedding space.
- **MDS (cosine):** default Semantic Map. Landmark MDS above ~700 points.
- **PCA / directional PCA:** cheaper axes; more distortion of neighborhoods.
- Projections are lossy. The UI disclaimer and neighborhood metrics (retention, silhouette, outliers) exist so a tight-looking cloud is not mistaken for truth.

Code: `packages/memory/src/embeddings/` (`semantic-map.ts`, `mds.ts`, `cosine.ts`, `neighborhood-metrics.ts`, `rebuild-embeddings.ts`) and `packages/memory/src/oip-local/pca.ts`.

---

## Rebuild from the UI

1. `make alfred` (or `pnpm desktop` + `pnpm voice` if you also want Talk).
2. Open Graph (beta) → **Embedding space**.
3. **Rebuild embeddings** (SSE). First ~5K records is about a minute / ~$0.02 on `text-embedding-3-small`.
4. Toggle Graph ↔ Embedding space; adjust k and cosine edge threshold.

If the snapshot is `missing` or `stale` (graph-visible ids drifted), rebuild again.
