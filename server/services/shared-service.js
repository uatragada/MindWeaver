import { normalizeLlmSelection } from "../openai.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const LOW_CONFIDENCE_THRESHOLD = 0.85;
const OPENAI_CONTENT_LIMIT = 16000;
const LOCAL_MODEL_CONTENT_LIMIT = 128000;
const OPENAI_MAX_INGEST_CONTENT_CHARS = 80000;
const LOCAL_MAX_INGEST_CONTENT_CHARS = 128000;
const LOCAL_STRUCTURED_INGEST_RETRY_CHARS = 7000;
const LOCAL_STRUCTURED_INGEST_FOCUSED_CHARS = 1200;
const REVIEW_INTERVALS_DAYS = [1, 3, 7, 14, 30];
const SOURCE_TYPE_LABELS = {
  page: "Web Page",
  note: "Manual Note",
  pdf: "PDF Text",
  youtube: "YouTube Transcript",
  transcript: "Transcript",
  doc: "Document",
  markdown: "Markdown Notes",
  bookmark: "Bookmark",
  repo: "Repository/Docs",
  highlight: "Highlight",
  chatgpt: "ChatGPT History",
  claude: "Claude History",
  other: "AI Chat History"
};
const ALLOWED_SOURCE_TYPES = new Set(Object.keys(SOURCE_TYPE_LABELS));
const RELATIONSHIP_TYPES = new Set(["contains", "builds_on", "prerequisite", "related", "contrasts", "supports", "needs", "pursues", "focuses_on"]);
const CHAT_IMPORT_SCHEMA_VERSION = "mindweaver.chat_import.v1";
const CHAT_IMPORT_PROVIDERS = new Set(["chatgpt", "claude", "other"]);
const HIERARCHY_NODE_TYPES = ["area", "domain", "topic", "skill", "concept"];
const CHAT_IMPORT_NODE_TYPES = new Set(HIERARCHY_NODE_TYPES);
const CHAT_IMPORT_RELATIONSHIP_TYPES = new Set(["contains", "builds_on", "prerequisite", "related", "contrasts", "supports", "needs", "focuses_on"]);
const CHAT_IMPORT_NODE_TYPE_PRIORITY = {
  concept: 1,
  skill: 2,
  topic: 3,
  domain: 4,
  area: 5
};
const SEMANTIC_ROLE_TYPES = new Set(["area", "domain", "topic", "skill"]);
const SEMANTIC_ROLE_ORDER = ["area", "domain", "topic", "skill"];
const USER_CREATABLE_NODE_TYPES = new Set(["goal", ...HIERARCHY_NODE_TYPES]);
const STRUCTURED_NODE_TYPES = ["goal", ...HIERARCHY_NODE_TYPES];
const STRUCTURED_RELATIONSHIP_TYPES = ["contains", "builds_on", "prerequisite", "related", "contrasts", "supports", "needs", "focuses_on"];
const NON_EMPTY_STRING_SCHEMA = { type: "string", minLength: 1 };
const LOCAL_REFINE_MISSING_EVIDENCE_GROUP_SIZE = 4;
const LOCAL_REFINE_SNAPSHOT_NODE_LIMIT = 7;
const LOCAL_REFINE_ARTIFACT_LIMIT = 2;

function getLlmContentLimit(rawSelection = {}) {
  const selection = normalizeLlmSelection(rawSelection);
  return selection.provider === "local" ? LOCAL_MODEL_CONTENT_LIMIT : OPENAI_CONTENT_LIMIT;
}

function getMaxIngestContentChars(rawSelection = {}) {
  const selection = normalizeLlmSelection(rawSelection);
  return selection.provider === "local" ? LOCAL_MAX_INGEST_CONTENT_CHARS : OPENAI_MAX_INGEST_CONTENT_CHARS;
}

function buildLocalStructuredIngestExcerpt(content, maxChars = LOCAL_STRUCTURED_INGEST_RETRY_CHARS) {
  const safeContent = String(content ?? "").trim();
  const safeLimit = Math.max(500, Math.floor(Number(maxChars) || LOCAL_STRUCTURED_INGEST_RETRY_CHARS));
  if (!safeContent || safeContent.length <= safeLimit) return safeContent;

  const windowSize = Math.max(400, Math.floor((safeLimit - 8) / 3));
  const middleStart = Math.max(0, Math.floor((safeContent.length - windowSize) / 2));
  const endStart = Math.max(0, safeContent.length - windowSize);

  return [
    safeContent.slice(0, windowSize),
    safeContent.slice(middleStart, middleStart + windowSize),
    safeContent.slice(endStart)
  ]
    .join("\n\n...")
    .slice(0, safeLimit);
}

function buildLocalFocusedIngestExcerpt(content, maxChars = LOCAL_STRUCTURED_INGEST_FOCUSED_CHARS) {
  const safeContent = String(content ?? "").trim();
  const safeLimit = Math.max(280, Math.floor(Number(maxChars) || LOCAL_STRUCTURED_INGEST_FOCUSED_CHARS));
  if (!safeContent || safeContent.length <= safeLimit) return safeContent;
  return safeContent.slice(0, safeLimit).trim();
}

function buildStrictObjectSchema(properties, required = Object.keys(properties)) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required
  };
}

function buildStringArraySchema({ minItems = 0, maxItems = null } = {}) {
  const schema = {
    type: "array",
    items: { type: "string" },
    uniqueItems: true
  };

  if (Number.isFinite(minItems) && minItems > 0) {
    schema.minItems = minItems;
  }

  if (Number.isFinite(maxItems)) {
    schema.maxItems = maxItems;
  }

  return schema;
}

function createSequentialTaskQueue() {
  let tail = Promise.resolve();

  return async function enqueue(work) {
    const nextRun = tail.catch(() => undefined).then(() => work());
    tail = nextRun.catch(() => undefined);
    return nextRun;
  };
}

const STRUCTURED_RESPONSE_SCHEMAS = {
  graphRefinement: buildStrictObjectSchema({
    summary: NON_EMPTY_STRING_SCHEMA,
    rename_nodes: {
      type: "array",
      items: buildStrictObjectSchema({
        id: NON_EMPTY_STRING_SCHEMA,
        label: NON_EMPTY_STRING_SCHEMA,
        description: { type: "string" },
        type: { type: "string", enum: STRUCTURED_NODE_TYPES }
      }, ["id", "label", "type"])
    },
    merge_nodes: {
      type: "array",
      items: buildStrictObjectSchema({
        sourceId: NON_EMPTY_STRING_SCHEMA,
        targetId: NON_EMPTY_STRING_SCHEMA,
        reason: NON_EMPTY_STRING_SCHEMA
      })
    },
    add_edges: {
      type: "array",
      items: buildStrictObjectSchema({
        sourceId: NON_EMPTY_STRING_SCHEMA,
        targetId: NON_EMPTY_STRING_SCHEMA,
        type: { type: "string", enum: STRUCTURED_RELATIONSHIP_TYPES },
        label: NON_EMPTY_STRING_SCHEMA
      })
    },
    remove_edges: {
      type: "array",
      items: buildStrictObjectSchema({
        key: NON_EMPTY_STRING_SCHEMA,
        reason: NON_EMPTY_STRING_SCHEMA
      })
    }
  }),
  sourceWorthiness: buildStrictObjectSchema({
    should_ingest: { type: "boolean" },
    reason: NON_EMPTY_STRING_SCHEMA
  }),
  sourceClassification: buildStrictObjectSchema({
    area: { type: "string" },
    domain: NON_EMPTY_STRING_SCHEMA,
    topic: { type: "string" },
    skill: NON_EMPTY_STRING_SCHEMA,
    concepts: buildStringArraySchema({ minItems: 1, maxItems: 8 })
  }),
  directConceptRefinement: buildStrictObjectSchema({
    directly_covered: buildStringArraySchema({ maxItems: 8 })
  }),
  gapAnalysis: buildStrictObjectSchema({
    gaps: buildStringArraySchema({ maxItems: 8 }),
    pathway: buildStringArraySchema({ maxItems: 8 }),
    difficulty: { type: "string", enum: ["easy", "medium", "hard"] }
  }),
  quizGeneration: buildStrictObjectSchema({
    questions: {
      type: "array",
      items: buildStrictObjectSchema({
        concept: NON_EMPTY_STRING_SCHEMA,
        q: NON_EMPTY_STRING_SCHEMA,
        options: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 4,
          maxItems: 4
        },
        correct: { type: "integer", minimum: 0, maximum: 3 }
      })
    }
  }),
  intersectionDiscovery: buildStrictObjectSchema({
    bridge_concepts: buildStringArraySchema({ maxItems: 8 }),
    reasoning: NON_EMPTY_STRING_SCHEMA
  })
};

function hasSessionMembership(record, sessionId) {
  return Array.isArray(record?.sessionIds) && record.sessionIds.includes(sessionId);
}

function addSessionMembership(record, sessionId) {
  if (!sessionId) return;
  record.sessionIds ||= [];
  if (!record.sessionIds.includes(sessionId)) {
    record.sessionIds.push(sessionId);
  }
}

function getNodeReview(node, sessionId) {
  return node?.sessionReviews?.[sessionId] ?? null;
}

function setNodeReview(node, sessionId, status) {
  node.sessionReviews ||= {};
  node.sessionReviews[sessionId] = {
    status,
    updatedAt: Date.now()
  };
}

function isRejectedForSession(node, sessionId) {
  return getNodeReview(node, sessionId)?.status === "rejected";
}

function getEdgeReview(edge, sessionId) {
  return edge?.sessionReviews?.[sessionId] ?? null;
}

function setEdgeReview(edge, sessionId, status) {
  edge.sessionReviews ||= {};
  edge.sessionReviews[sessionId] = {
    status,
    updatedAt: Date.now()
  };
}

function isEdgeRejectedForSession(edge, sessionId) {
  return getEdgeReview(edge, sessionId)?.status === "rejected";
}

function normalizeLabel(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b(\w+?)ies\b/g, "$1y")
    .replace(/\b([a-z0-9]{4,})s\b/g, (word, stem) => (/(ss|us|is|ous)$/.test(word) ? word : stem));
}

function normalizeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function getSourceTypeLabel(sourceType) {
  return SOURCE_TYPE_LABELS[sourceType] ?? "Source";
}

function createSyntheticUrl(sourceType, title) {
  const slug = normalizeLabel(title).replace(/\s+/g, "-") || nanoid();
  return `mindweaver://${sourceType}/${slug}`;
}

function clampConfidence(value, fallback = 0.72) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0.35, Math.min(0.99, value));
}

function sanitizeNodeLabelForType(type, value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  return type === "goal" ? trimmed : normalizeLabel(trimmed);
}

export {
  DAY_MS,
  LOW_CONFIDENCE_THRESHOLD,
  OPENAI_CONTENT_LIMIT,
  LOCAL_MODEL_CONTENT_LIMIT,
  OPENAI_MAX_INGEST_CONTENT_CHARS,
  LOCAL_MAX_INGEST_CONTENT_CHARS,
  LOCAL_STRUCTURED_INGEST_RETRY_CHARS,
  LOCAL_STRUCTURED_INGEST_FOCUSED_CHARS,
  REVIEW_INTERVALS_DAYS,
  SOURCE_TYPE_LABELS,
  ALLOWED_SOURCE_TYPES,
  RELATIONSHIP_TYPES,
  CHAT_IMPORT_SCHEMA_VERSION,
  CHAT_IMPORT_PROVIDERS,
  HIERARCHY_NODE_TYPES,
  CHAT_IMPORT_NODE_TYPES,
  CHAT_IMPORT_RELATIONSHIP_TYPES,
  CHAT_IMPORT_NODE_TYPE_PRIORITY,
  SEMANTIC_ROLE_TYPES,
  SEMANTIC_ROLE_ORDER,
  USER_CREATABLE_NODE_TYPES,
  STRUCTURED_NODE_TYPES,
  STRUCTURED_RELATIONSHIP_TYPES,
  NON_EMPTY_STRING_SCHEMA,
  LOCAL_REFINE_MISSING_EVIDENCE_GROUP_SIZE,
  LOCAL_REFINE_SNAPSHOT_NODE_LIMIT,
  LOCAL_REFINE_ARTIFACT_LIMIT,
  STRUCTURED_RESPONSE_SCHEMAS,
  getLlmContentLimit,
  getMaxIngestContentChars,
  buildLocalStructuredIngestExcerpt,
  buildLocalFocusedIngestExcerpt,
  buildStrictObjectSchema,
  buildStringArraySchema,
  createSequentialTaskQueue,
  hasSessionMembership,
  addSessionMembership,
  getNodeReview,
  setNodeReview,
  isRejectedForSession,
  getEdgeReview,
  setEdgeReview,
  isEdgeRejectedForSession,
  normalizeLabel,
  normalizeUrl,
  getSourceTypeLabel,
  createSyntheticUrl,
  clampConfidence,
  sanitizeNodeLabelForType
};
