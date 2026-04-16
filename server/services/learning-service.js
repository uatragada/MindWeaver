import { DEFAULT_OPENAI_MODEL, getOllamaStatus } from "../openai.js";
import * as shared from "./shared-service.js";
import * as graph from "./graph-service.js";

const {
  SOURCE_TYPE_LABELS,
  getLlmContentLimit,
  getMaxIngestContentChars,
  normalizeLabel
} = shared;

const {
  buildProgressReport,
  buildRecommendedActions,
  sanitizeShortList,
  buildSessionGraph,
  getStoredLlmSettings,
  mergeSelectedLocalModelHealth,
  searchGraph
} = graph;

function buildExtractiveAnswer(db, sessionId, question) {
  const search = searchGraph(db, sessionId, question);
  const top = search.results.slice(0, 5);
  if (!top.length) {
    return {
      answer: "I could not find strong evidence in this graph yet. Add or import a source that directly addresses the question, then ask again.",
      citations: []
    };
  }

  return {
    answer: `Based on this map, ${top.map((result) => result.label).join(", ")} are the most relevant items. I would start by reviewing the evidence for ${top[0].label}, then verify it with a quiz or source import if the confidence is low.`,
    citations: top.map((result) => ({
      id: result.id,
      label: result.label,
      kind: result.kind,
      snippet: result.snippet
    }))
  };
}

function buildLearningSummary(db, sessionId) {
  const graph = buildSessionGraph(db, sessionId);
  const progress = buildProgressReport(db, sessionId);
  const topConcepts = graph.nodes
    .filter((node) => node.type === "concept")
    .sort((left, right) => (right.evidenceCount ?? 0) - (left.evidenceCount ?? 0))
    .slice(0, 5)
    .map((node) => node.label);

  return {
    title: graph.session?.goal || "Learning summary",
    summary: `This map has ${progress.session.conceptCount} concepts, ${progress.session.sourceCount} sources, and a health score of ${graph.health.score}/100.`,
    topConcepts,
    risks: graph.health.risks,
    nextActions: graph.recommendations.slice(0, 5)
  };
}

function normalizeQuizCorrectIndex(value) {
  if (Number.isInteger(value) && value >= 0 && value <= 3) return value;
  if (typeof value === "string" && /^[0-3]$/.test(value.trim())) return Number(value.trim());
  return null;
}

function normalizeQuizGenerationPayload(payload, allowedConceptLabels = []) {
  const conceptMap = new Map(
    allowedConceptLabels
      .map((label) => String(label ?? "").trim())
      .filter(Boolean)
      .map((label) => [normalizeLabel(label), label])
  );
  const rawQuestions = Array.isArray(payload?.questions)
    ? payload.questions
    : Array.isArray(payload)
      ? payload
      : [];

  const questions = rawQuestions
    .map((rawQuestion) => {
      if (!rawQuestion || typeof rawQuestion !== "object" || Array.isArray(rawQuestion)) return null;

      const rawConcept = String(rawQuestion.concept ?? "").trim();
      const conceptKey = normalizeLabel(rawConcept);
      const concept = conceptMap.get(conceptKey) ?? rawConcept;
      if (!concept || (conceptMap.size && !conceptMap.has(conceptKey))) return null;

      let correct = normalizeQuizCorrectIndex(rawQuestion.correct);
      const options = [];

      for (const rawOption of Array.isArray(rawQuestion.options) ? rawQuestion.options : []) {
        if (correct === null && rawOption && typeof rawOption === "object" && !Array.isArray(rawOption)) {
          const embeddedCorrect = normalizeQuizCorrectIndex(rawOption.correct);
          if (embeddedCorrect !== null) {
            correct = embeddedCorrect;
            continue;
          }
        }

        if (correct === null && typeof rawOption === "string") {
          const embeddedCorrectMatch = rawOption.match(/^correct\s*[:=-]?\s*([0-3])$/i);
          if (embeddedCorrectMatch) {
            correct = Number(embeddedCorrectMatch[1]);
            continue;
          }
        }

        const option = typeof rawOption === "string"
          ? rawOption.trim()
          : rawOption && typeof rawOption === "object" && typeof rawOption.text === "string"
            ? rawOption.text.trim()
            : "";
        if (!option) continue;
        options.push(option);
        if (options.length >= 4) break;
      }

      const questionText = String(rawQuestion.q ?? rawQuestion.question ?? "").trim();
      if (!questionText || options.length !== 4 || correct === null) return null;

      return {
        concept,
        q: questionText,
        options,
        correct
      };
    })
    .filter(Boolean);

  return { questions };
}

function normalizeLooseShortListInput(values) {
  if (Array.isArray(values)) return values;
  if (typeof values !== "string") return [];

  const trimmed = values.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to delimiter-based parsing for list-like strings.
  }

  return trimmed
    .split(/\r?\n|[,;•]+/)
    .map((value) => value.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

function normalizeSourceClassificationPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;

  return {
    area: String(payload.area ?? "").trim(),
    domain: String(payload.domain ?? "").trim(),
    topic: String(payload.topic ?? "").trim(),
    skill: String(payload.skill ?? "").trim(),
    concepts: sanitizeShortList(normalizeLooseShortListInput(payload.concepts), {
      maxItems: 8,
      maxLength: 100
    })
  };
}


function createFallbackGapResponse(goalLabel, knownConcepts) {
  const gapData = {
    gaps: [],
    pathway: knownConcepts.length ? [`Review evidence connected to "${goalLabel}" and verify your weakest concepts.`] : [`Start collecting source pages for "${goalLabel}" before running gap analysis again.`],
    difficulty: "medium"
  };

  return {
    ...gapData,
    recommendedActions: buildRecommendedActions(gapData)
  };
}


async function buildHealthPayload({ db, openaiClient, ollamaBaseUrl }) {
  const ollamaStatus = await getOllamaStatus({ baseUrl: ollamaBaseUrl });
  const llmSettings = getStoredLlmSettings(db);
  const contentLimitChars = getLlmContentLimit(llmSettings);
  const maxPayloadContentChars = getMaxIngestContentChars(llmSettings);
  const localModels = llmSettings.provider === "local"
    ? mergeSelectedLocalModelHealth(ollamaStatus.models, llmSettings.localModel)
    : ollamaStatus.models;

  return {
    ok: true,
    app: "MindWeaver",
    localOnly: true,
    openaiConfigured: Boolean(openaiClient),
    ollamaAvailable: Boolean(ollamaStatus.available),
    llmSettings,
    llmProviders: {
      openai: {
        label: "OpenAI",
        available: Boolean(openaiClient),
        configured: Boolean(openaiClient),
        defaultModel: DEFAULT_OPENAI_MODEL
      },
      local: {
        label: "Local (Ollama)",
        available: Boolean(ollamaStatus.available),
        baseUrl: ollamaStatus.baseUrl,
        error: ollamaStatus.error,
        models: localModels
      }
    },
    contentLimitChars,
    maxPayloadContentChars,
    sourceTypes: Object.keys(SOURCE_TYPE_LABELS),
    counts: {
      sessions: db.data.sessions.length,
      nodes: db.data.nodes.length,
      artifacts: db.data.artifacts.length,
      workspaces: (db.data.workspaces ?? []).length
    }
  };
}

export {
  buildExtractiveAnswer,
  buildLearningSummary,
  normalizeQuizCorrectIndex,
  normalizeQuizGenerationPayload,
  normalizeLooseShortListInput,
  normalizeSourceClassificationPayload,
  createFallbackGapResponse,
  buildHealthPayload
};
