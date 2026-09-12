export {
  buildEmbedText,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  embeddingModelFromEnv,
  hashEmbedText,
  openaiEmbedTexts,
  requireOpenAiApiKey,
  type EmbedBatchProgress,
} from "./openai-embeddings.js";
export {
  rebuildOpenAiEmbeddings,
  type EmbedRecordInput,
  type EmbeddingRebuildProgress,
  type EmbeddingRebuildResult,
} from "./rebuild-embeddings.js";
export {
  cosineDistance,
  cosineSimilarity,
  pairwiseCosineMatrix,
} from "./cosine.js";
export { classicalMds, projectCosineMds, type MdsProjection } from "./mds.js";
export {
  betweenGroupCosine,
  computeNeighborhoodMetrics,
  findOutliers,
  knnFromCosineMatrix,
  nnCategoryAccuracy,
  projectedDistance,
  projectionNeighborhoodRetention,
  silhouetteCosine,
  withinGroupCosine,
  type NeighborHit,
  type NeighborhoodMetrics,
  type OutlierHit,
} from "./neighborhood-metrics.js";
export {
  CATEGORY_LABELS,
  CLUSTER_DEMO,
  DEMO_DATASETS,
  EMERGING_DEMO,
  getDemoDataset,
  type DemoDataset,
  type DemoObservation,
} from "./demo-datasets.js";
export {
  buildSemanticMap,
  type SemanticMapMethod,
  type SemanticMapNeighbor,
  type SemanticMapPoint,
  type SemanticMapResult,
} from "./semantic-map.js";
export { projectEmbeddingsDirectional, projectEmbeddingsPca } from "../oip-local/pca.js";
