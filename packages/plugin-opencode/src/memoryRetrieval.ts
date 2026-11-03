const PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED = false;

export function memoryRetrievalMode(): "index" | "semantic" {
  return PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED ? "semantic" : "index";
}
