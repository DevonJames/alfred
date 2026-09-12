# Local embeddings on a Mac Mini (follow-up)

High-level brief for running Graph (beta) **embedding space** without OpenAI — e.g. on a Mac Mini with 64GB unified memory. Today Alfred builds that view via `OPENAI_API_KEY` + `text-embedding-3-small` and stores vectors under `{oipRoot}/indexes/vectors/`.

## Why this is a later project

For ~5K memory records (~1M tokens of `name` + `search_text`), the API path is about **$0.02** and finishes in about a minute. Local inference does not win on cost at this scale; it wins on **offline / privacy / no API dependency**.

Rough local wall times (same ~5K corpus):

| Setup | Ballpark |
|-------|----------|
| Mac Mini 64GB (Apple Silicon, MPS / Neural Engine) | MiniLM ~20–60s; nomic / bge-base ~1–5 min |
| Workstation 128GB + 2× RTX 4090 | Mid-size model ~10–60s (one 4090 is enough) |

## What already exists (reuse this)

- **Storage contract:** `FileVectorIndex` writes `indexes/vectors/{manifest.json,vectors.jsonl,projection.json}`.
- **Projection:** cached PCA → fixed `x,y,z` in `projection.json` (UMAP can replace later). Live Semantic Map also supports MDS (cosine) and directional PCA via `POST /memory/graph/embeddings/semantic-map`.
- **UI / API:** Graph (beta) Embedding space toggle + Vector Explorer (`/vector-explorer`) + `GET /memory/graph/embeddings` + `POST /memory/graph/embeddings/rebuild`. Current-state guide: [embedding-space.md](./embedding-space.md).
- **Provider field:** `manifest.provider` is `"openai"` today; local should set `"local"` (and a model id string).

Swap the **embed step only**; keep store, PCA, routes, and UI.

## Work to do later

1. **Choose a local stack**
   - Prefer something Node-friendly: `@xenova/transformers` / ONNX Runtime, or an **Ollama** HTTP embed endpoint (`nomic-embed-text`, etc.).
   - Pick one default model and pin it in config (e.g. `ALFRED_EMBEDDING_PROVIDER=local` + `ALFRED_EMBEDDING_MODEL=…`).

2. **Implement a local embedder**
   - Same batch interface as `openaiEmbedTexts` in `packages/memory/src/embeddings/`.
   - Input text: `buildEmbedText(name, search_text)` (unchanged).
   - Output: `number[]` per record; dimensions must be consistent for a given model.

3. **Wire rebuild**
   - Branch in `rebuildOpenAiEmbeddings` (or rename to `rebuildMemoryEmbeddings`) on provider env.
   - Write manifest with `provider: "local"` and the local model name.
   - Do **not** mix OpenAI and local vectors in one index without a full rebuild (different spaces).

4. **Mac Mini ops**
   - First run downloads the model weights (disk + time).
   - Keep the process memory-aware: batch size 16–64 is usually enough; 64GB is not the bottleneck for these models.
   - Optional: run Ollama as a sidecar and call `http://127.0.0.1:11434` so the desktop app stays thin.

5. **Quality / viz notes**
   - Local small models are fine for a semantic cloud; clusters may differ from OpenAI.
   - After swapping models, always rebuild + re-run PCA.
   - Optional later: UMAP instead of PCA for tighter clusters; incremental embed on ingest.

## Non-goals for the first local cut

- Hybrid retrieval / ANN search in Talk (can reuse `FileVectorIndex.search` later).
- Dual-GPU sharding (irrelevant at 5K).
- Replacing FTS as the default retrieval path.

## Smoke test

1. Point `ALFRED_EMBEDDING_PROVIDER=local` (once implemented).
2. In Graph (beta) → **Embedding space** → rebuild.
3. Confirm `indexes/vectors/manifest.json` shows the local model and non-empty `projection.json`.
4. Toggle Graph ↔ Embedding space without errors offline (API key unset).
