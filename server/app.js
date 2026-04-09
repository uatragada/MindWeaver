import express from "express";
import cors from "cors";
import { nanoid } from "nanoid";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createDefaultData } from "./db.js";
import { requestStructuredJson, requestText } from "./openai.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const LOW_CONFIDENCE_THRESHOLD = 0.85;
const OPENAI_CONTENT_LIMIT = 16000;
const MAX_INGEST_CONTENT_CHARS = 80000;
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
  highlight: "Highlight"
};
const ALLOWED_SOURCE_TYPES = new Set(Object.keys(SOURCE_TYPE_LABELS));
const RELATIONSHIP_TYPES = new Set(["contains", "builds_on", "prerequisite", "related", "contrasts", "supports", "needs", "pursues", "focuses_on"]);

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

function buildGraphContext(db) {
  const domains = db.data.nodes.filter((node) => node.type === "domain").map((node) => `"${node.label}"`);
  const skills = db.data.nodes.filter((node) => node.type === "skill").map((node) => `"${node.label}"`);
  const concepts = db.data.nodes.filter((node) => node.type === "concept").map((node) => `"${node.label}"`);
  const sampleEdges = db.data.edges.slice(0, 8).map((edge) => `${edge.source} -[${edge.type}]-> ${edge.target}`);

  return `
EXISTING GRAPH STATE:
Domains (${domains.length}): ${domains.join(", ") || "none"}
Skills (${skills.length}): ${skills.join(", ") || "none"}
Concepts (${concepts.length}): ${concepts.join(", ") || "none"}

Sample edges: ${sampleEdges.join("; ") || "none"}

REQUIRED HIERARCHY:
Goal -> Domain -> Skill -> Concept

INSTRUCTIONS:
1. Reuse existing node labels when they already match semantically.
2. Return concise lowercase labels.
3. Prefer 1-3 concepts maximum.
`;
}

function addHistoryEntry(node, event) {
  node.history ||= [];
  const entry = {
    kind: event.kind,
    sessionId: event.sessionId ?? null,
    artifactId: event.artifactId ?? null,
    sourceType: event.sourceType ?? null,
    title: event.title ?? null,
    summary: event.summary,
    createdAt: event.createdAt ?? Date.now()
  };
  const dedupeKey = `${entry.kind}|${entry.sessionId}|${entry.artifactId}|${entry.summary}`;
  if (node.history.some((existing) => existing.dedupeKey === dedupeKey)) return;
  node.history.push({ ...entry, dedupeKey });
}

function ensureReviewSchedule(node, confidence = node.confidence ?? 0.7) {
  node.reviewSchedule ||= {
    streak: 0,
    intervalDays: REVIEW_INTERVALS_DAYS[0],
    nextReviewAt: confidence < LOW_CONFIDENCE_THRESHOLD ? Date.now() : Date.now() + DAY_MS,
    lastReviewedAt: null
  };
  return node.reviewSchedule;
}

function applyReviewOutcome(node, outcome) {
  const schedule = ensureReviewSchedule(node);
  const now = Date.now();
  schedule.lastReviewedAt = now;

  if (outcome === "success") {
    schedule.streak = Math.min(schedule.streak + 1, REVIEW_INTERVALS_DAYS.length - 1);
    schedule.intervalDays = REVIEW_INTERVALS_DAYS[schedule.streak];
    schedule.nextReviewAt = now + schedule.intervalDays * DAY_MS;
    return;
  }

  schedule.streak = 0;
  schedule.intervalDays = REVIEW_INTERVALS_DAYS[0];
  schedule.nextReviewAt = now + schedule.intervalDays * DAY_MS;
}

function ensureNode(db, id, label, type, options = {}) {
  const {
    createdBy = "system",
    verified = false,
    confidence = verified ? 1 : createdBy === "ai" ? 0.7 : 0.9,
    sessionId,
    description = "",
    sourceType = null,
    artifactId = null,
    reason = null
  } = options;

  const canonicalLabel = normalizeLabel(label);
  let existing = db.data.nodes.find((node) => node.id === id);
  if (!existing) {
    existing = {
      id,
      label,
      canonicalLabel,
      aliases: [],
      type,
      createdBy,
      verified,
      confidence,
      description,
      createdAt: Date.now(),
      sessionIds: sessionId ? [sessionId] : [],
      sessionReviews: {},
      history: []
    };
    ensureReviewSchedule(existing, confidence);
    db.data.nodes.push(existing);
  } else {
    existing.canonicalLabel ||= canonicalLabel;
    existing.aliases ||= [];
    if (label && !existing.label) existing.label = label;
    if (label && label !== existing.label && !existing.aliases.includes(label)) existing.aliases.push(label);
    if (description && !existing.description) existing.description = description;
    if (typeof existing.confidence !== "number") existing.confidence = confidence;
    if (typeof existing.verified !== "boolean") existing.verified = verified;
    if (!existing.createdBy) existing.createdBy = createdBy;
    existing.history ||= [];
    existing.sessionReviews ||= {};
    ensureReviewSchedule(existing, existing.confidence);
    addSessionMembership(existing, sessionId);
  }

  if (reason) {
    addHistoryEntry(existing, {
      kind: "classification",
      sessionId,
      artifactId,
      sourceType,
      summary: reason
    });
  }

  return existing;
}

function ensureEdge(db, source, target, label, edgeType = "generic", confidence = 0.8, createdBy = "system", sessionId) {
  const key = `${source}__${edgeType}__${target}`;
  let existing = db.data.edges.find((edge) => edge.key === key);

  if (!existing) {
    existing = {
      key,
      source,
      target,
      label,
      type: edgeType,
      confidence,
      createdBy,
      verified: createdBy === "user",
      createdAt: Date.now(),
      sessionIds: sessionId ? [sessionId] : [],
      sessionReviews: {}
    };
    db.data.edges.push(existing);
  } else {
    existing.sessionReviews ||= {};
    addSessionMembership(existing, sessionId);
  }

  return existing;
}

function ensureSource(node, sessionId, source) {
  node.sources ||= [];
  const normalizedUrl = normalizeUrl(source.url) ?? source.url;
  const exists = node.sources.some((existing) => existing.sessionId === sessionId && (normalizeUrl(existing.url) ?? existing.url) === normalizedUrl);

  if (!exists) {
    const sourceRecord = {
      ...source,
      url: normalizedUrl,
      sessionId,
      addedAt: Date.now()
    };
    node.sources.push(sourceRecord);
    addHistoryEntry(node, {
      kind: "evidence-added",
      sessionId,
      artifactId: source.artifactId,
      sourceType: source.sourceType,
      title: source.title,
      summary: `${source.title} attached as evidence from ${getSourceTypeLabel(source.sourceType).toLowerCase()}.`
    });
  }
}

function getSession(db, sessionId) {
  return db.data.sessions.find((session) => session.id === sessionId) ?? null;
}

function getSessionGoal(db, sessionId) {
  return db.data.goals.find((goal) => goal.sessionId === sessionId) ?? null;
}

function createGoalForSession(db, sessionId, title, description = "") {
  const existing = getSessionGoal(db, sessionId);
  if (existing || !title) return existing;

  const goalId = `goal:${nanoid()}`;
  const goal = {
    id: goalId,
    sessionId,
    title,
    description,
    createdAt: Date.now()
  };

  db.data.goals.push(goal);
  ensureNode(db, goalId, title, "goal", {
    createdBy: "user",
    verified: true,
    confidence: 1,
    sessionId,
    description,
    reason: "Created as the session goal."
  });
  ensureEdge(db, `session:${sessionId}`, goalId, "pursues", "pursues", 1, "user", sessionId);
  return goal;
}

function findVisibleSessionNodes(db, sessionId) {
  return db.data.nodes.filter((node) => hasSessionMembership(node, sessionId) && !isRejectedForSession(node, sessionId));
}

function buildWhyThisExists(node, sessionId) {
  const sources = (node.sources ?? []).filter((source) => source.sessionId === sessionId);
  if (sources.length) {
    const latest = [...sources].sort((left, right) => right.addedAt - left.addedAt)[0];
    return `${sources.length} evidence source${sources.length === 1 ? "" : "s"} support this node. Latest: ${latest.title}.`;
  }

  if (node.createdBy === "user") {
    return "This node came directly from your goal, manual note, or review action.";
  }

  return "This node was inferred by the classifier and still needs stronger evidence or review.";
}

function getMasteryState(node, sessionId) {
  if (isRejectedForSession(node, sessionId)) return "rejected";
  const reviewStatus = getNodeReview(node, sessionId)?.status;
  if (node.verified || reviewStatus === "approved") return "verified";
  if ((node.confidence ?? 0) >= 0.85 && (node.sources ?? []).some((source) => source.sessionId === sessionId)) return "understood";
  if ((node.sources ?? []).some((source) => source.sessionId === sessionId)) return "seen";
  return "new";
}

function buildConceptSummary(node, sessionId) {
  if (node.summary) return node.summary;
  const sources = (node.sources ?? []).filter((source) => source.sessionId === sessionId);
  if (sources.length) {
    const sourceTypes = [...new Set(sources.map((source) => getSourceTypeLabel(source.sourceType).toLowerCase()))].join(", ");
    return `${node.label} is supported by ${sources.length} source${sources.length === 1 ? "" : "s"} in this map (${sourceTypes}). Review the evidence before treating it as mastered.`;
  }
  if (node.type === "concept") return `${node.label} is in the graph but still needs source evidence before it should be trusted.`;
  return node.description || "";
}

function serializeNodeForSession(node, sessionId) {
  const reviewSchedule = ensureReviewSchedule(node);
  const sources = (node.sources ?? []).filter((source) => source.sessionId === sessionId);
  const history = (node.history ?? [])
    .filter((event) => !event.sessionId || event.sessionId === sessionId)
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 8)
    .map(({ dedupeKey, ...event }) => event);

  return {
    ...node,
    sources,
    history,
    evidenceCount: sources.length,
    reviewStatus: getNodeReview(node, sessionId)?.status ?? "pending",
    masteryState: getMasteryState(node, sessionId),
    summary: buildConceptSummary(node, sessionId),
    nextReviewAt: reviewSchedule.nextReviewAt,
    dueForReview: reviewSchedule.nextReviewAt <= Date.now(),
    whyThisExists: buildWhyThisExists(node, sessionId)
  };
}

function serializeEdgeForSession(edge, sessionId) {
  return {
    ...edge,
    reviewStatus: getEdgeReview(edge, sessionId)?.status ?? "pending"
  };
}

function rebuildEdgeKey(edge) {
  edge.key = `${edge.source}__${edge.type}__${edge.target}`;
  return edge.key;
}

function sanitizeDataShape(data) {
  const defaults = createDefaultData();
  return {
    ...defaults,
    ...data,
    sessions: Array.isArray(data?.sessions) ? data.sessions : [],
    goals: Array.isArray(data?.goals) ? data.goals : [],
    nodes: Array.isArray(data?.nodes) ? data.nodes : [],
    edges: Array.isArray(data?.edges) ? data.edges : [],
    verifications: Array.isArray(data?.verifications) ? data.verifications : [],
    artifacts: Array.isArray(data?.artifacts) ? data.artifacts : [],
    users: Array.isArray(data?.users) ? data.users : [],
    workspaces: Array.isArray(data?.workspaces) ? data.workspaces : [],
    reports: Array.isArray(data?.reports) ? data.reports : [],
    preferences: {
      ...defaults.preferences,
      ...(data?.preferences ?? {})
    }
  };
}

function deleteArtifactFromSession(db, sessionId, artifactId) {
  const artifact = db.data.artifacts.find((entry) => entry.id === artifactId && entry.sessionId === sessionId);
  if (!artifact) return false;

  db.data.artifacts = db.data.artifacts.filter((entry) => !(entry.id === artifactId && entry.sessionId === sessionId));

  for (const node of db.data.nodes) {
    const hadSource = (node.sources ?? []).some((source) => source.sessionId === sessionId && source.artifactId === artifactId);
    node.sources = (node.sources ?? []).filter((source) => !(source.sessionId === sessionId && source.artifactId === artifactId));
    if (!hadSource) continue;
    addHistoryEntry(node, {
      kind: "evidence-removed",
      sessionId,
      artifactId,
      title: artifact.title,
      sourceType: artifact.sourceType,
      summary: `${artifact.title} removed as evidence.`
    });
  }

  return true;
}

function mergeNodeIntoTarget(db, sessionId, sourceId, targetId) {
  if (sourceId === targetId) return { ok: false, error: "source and target must be different" };
  const source = db.data.nodes.find((node) => node.id === sourceId && hasSessionMembership(node, sessionId));
  const target = db.data.nodes.find((node) => node.id === targetId && hasSessionMembership(node, sessionId));
  if (!source || !target) return { ok: false, error: "source or target not found in session" };

  target.aliases ||= [];
  for (const alias of [source.label, ...(source.aliases ?? [])]) {
    if (alias && alias !== target.label && !target.aliases.includes(alias)) target.aliases.push(alias);
  }

  for (const sourceRecord of source.sources ?? []) {
    if (sourceRecord.sessionId === sessionId) ensureSource(target, sessionId, sourceRecord);
  }

  for (const event of source.history ?? []) {
    if (event.sessionId && event.sessionId !== sessionId) continue;
    addHistoryEntry(target, {
      ...event,
      kind: "node-merged",
      summary: `${source.label} merged into ${target.label}.`
    });
  }

  target.confidence = Math.max(target.confidence ?? 0, source.confidence ?? 0);
  target.verified ||= source.verified;
  addSessionMembership(target, sessionId);

  const newEdges = [];
  for (const edge of db.data.edges) {
    if (!hasSessionMembership(edge, sessionId)) continue;
    const nextSource = edge.source === sourceId ? targetId : edge.source;
    const nextTarget = edge.target === sourceId ? targetId : edge.target;
    if (nextSource === nextTarget) {
      edge.sessionIds = edge.sessionIds.filter((id) => id !== sessionId);
      continue;
    }
    if (nextSource !== edge.source || nextTarget !== edge.target) {
      const moved = {
        ...edge,
        source: nextSource,
        target: nextTarget,
        sessionIds: [sessionId],
        sessionReviews: {
          ...(edge.sessionReviews ?? {})
        }
      };
      rebuildEdgeKey(moved);
      const duplicate = db.data.edges.find((existing) => existing.key === moved.key && hasSessionMembership(existing, sessionId));
      if (duplicate) {
        duplicate.confidence = Math.max(duplicate.confidence ?? 0, moved.confidence ?? 0);
        duplicate.verified ||= moved.verified;
      } else {
        newEdges.push(moved);
      }
      edge.sessionIds = edge.sessionIds.filter((id) => id !== sessionId);
    }
  }
  db.data.edges.push(...newEdges);
  db.data.edges = db.data.edges.filter((edge) => (edge.sessionIds ?? []).length > 0);

  setNodeReview(source, sessionId, "rejected");
  source.confidence = Math.min(source.confidence ?? 0.7, 0.2);
  addHistoryEntry(source, {
    kind: "node-merged-away",
    sessionId,
    summary: `Merged into ${target.label}.`
  });
  addHistoryEntry(target, {
    kind: "node-merge-complete",
    sessionId,
    summary: `${source.label} merged into this node.`
  });

  return { ok: true, source, target };
}

function buildReviewQueue(db, sessionId) {
  return findVisibleSessionNodes(db, sessionId)
    .filter((node) => node.type === "concept")
    .map((node) => serializeNodeForSession(node, sessionId))
    .filter((node) => node.reviewStatus !== "approved" && (node.dueForReview || !node.verified || node.confidence < LOW_CONFIDENCE_THRESHOLD))
    .sort((left, right) => Number(right.dueForReview) - Number(left.dueForReview) || left.confidence - right.confidence)
    .slice(0, 12);
}

function buildRecommendedActions(gapData) {
  const actions = [];

  for (const gap of gapData.gaps ?? []) {
    actions.push({
      kind: "fill-gap",
      title: `Fill gap: ${gap}`,
      reason: `Capture or import a source that directly teaches ${gap}.`
    });
  }

  if (gapData.pathway?.length) {
    actions.push({
      kind: "follow-pathway",
      title: "Follow the suggested pathway",
      reason: gapData.pathway[0]
    });
  }

  return actions.slice(0, 4);
}

function buildRecommendations(db, sessionId) {
  const session = getSession(db, sessionId);
  const visibleNodes = findVisibleSessionNodes(db, sessionId).map((node) => serializeNodeForSession(node, sessionId));
  const reviewQueue = buildReviewQueue(db, sessionId);
  const recommendations = [];
  const seenTitles = new Set();

  const pushRecommendation = (recommendation) => {
    if (!recommendation?.title || seenTitles.has(recommendation.title)) return;
    seenTitles.add(recommendation.title);
    recommendations.push(recommendation);
  };

  for (const node of reviewQueue.slice(0, 3)) {
    pushRecommendation({
      kind: "review",
      title: `Review ${node.label}`,
      reason: node.dueForReview ? "This concept is due for spaced review." : "This concept is still low-confidence.",
      nodeId: node.id,
      priority: 100 - Math.round((node.confidence ?? 0) * 100)
    });
  }

  for (const node of visibleNodes.filter((entry) => entry.type === "concept" && entry.evidenceCount === 0).slice(0, 2)) {
    pushRecommendation({
      kind: "evidence",
      title: `Add evidence for ${node.label}`,
      reason: "This concept exists in the graph but has no direct source evidence yet.",
      nodeId: node.id,
      priority: 82
    });
  }

  for (const action of session?.latestGapAnalysis?.recommendedActions ?? []) {
    pushRecommendation({
      kind: action.kind,
      title: action.title,
      reason: action.reason,
      priority: 90
    });
  }

  if ((db.data.artifacts.filter((artifact) => artifact.sessionId === sessionId).length ?? 0) < 3) {
    pushRecommendation({
      kind: "capture",
      title: "Import a note, PDF extract, or transcript",
      reason: "Broader source types make the graph more trustworthy and useful.",
      priority: 70
    });
  }

  return recommendations.sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0)).slice(0, 8);
}

function calculateMapHealth(nodes, artifacts, reviewQueue) {
  const concepts = nodes.filter((node) => node.type === "concept");
  const reviewedConcepts = concepts.filter((node) => node.reviewStatus === "approved" || node.verified);
  const evidencedConcepts = concepts.filter((node) => (node.evidenceCount ?? 0) > 0);
  const averageConfidence = concepts.length
    ? concepts.reduce((total, node) => total + (node.confidence ?? 0), 0) / concepts.length
    : 0;
  const evidenceCoverage = concepts.length ? evidencedConcepts.length / concepts.length : 0;
  const reviewCoverage = concepts.length ? reviewedConcepts.length / concepts.length : 0;
  const sourceDiversity = new Set(artifacts.map((artifact) => artifact.sourceType || "page")).size;
  const sourceScore = Math.min(1, artifacts.length / 5);
  const diversityScore = Math.min(1, sourceDiversity / 3);
  const score = Math.round((averageConfidence * 0.35 + evidenceCoverage * 0.3 + reviewCoverage * 0.2 + sourceScore * 0.1 + diversityScore * 0.05) * 100);

  const strengths = [];
  const risks = [];

  if (evidenceCoverage >= 0.7) strengths.push("Most concepts have direct source evidence.");
  if (reviewCoverage >= 0.5) strengths.push("A meaningful share of concepts has been reviewed.");
  if (sourceDiversity >= 2) strengths.push("The map uses more than one source type.");

  if (concepts.length === 0) risks.push("No concepts have been captured yet.");
  if (evidenceCoverage < 0.5 && concepts.length) risks.push("Several concepts need stronger source evidence.");
  if (reviewQueue.length > 4) risks.push("The review queue is growing and should be cleaned up.");
  if (artifacts.length < 3) risks.push("Add a few more sources before trusting gap analysis.");

  return {
    score,
    averageConfidence,
    evidenceCoverage,
    reviewCoverage,
    sourceDiversity,
    sourceCount: artifacts.length,
    conceptCount: concepts.length,
    reviewQueueCount: reviewQueue.length,
    strengths,
    risks
  };
}

function buildStudyPlan(db, sessionId, recommendations, health) {
  const reviewQueue = buildReviewQueue(db, sessionId);
  const session = getSession(db, sessionId);
  const steps = [];

  if (reviewQueue.length) {
    steps.push({
      title: `Review ${Math.min(3, reviewQueue.length)} queued concept${reviewQueue.length === 1 ? "" : "s"}`,
      minutes: 5,
      detail: reviewQueue.slice(0, 3).map((node) => node.label).join(", ")
    });
  }

  if (health.evidenceCoverage < 0.65) {
    const target = findVisibleSessionNodes(db, sessionId)
      .map((node) => serializeNodeForSession(node, sessionId))
      .find((node) => node.type === "concept" && node.evidenceCount === 0);
    steps.push({
      title: target ? `Add evidence for ${target.label}` : "Add one stronger source",
      minutes: 5,
      detail: "Import a note, transcript, PDF extract, or source page that directly teaches the concept."
    });
  }

  if (session?.latestGapAnalysis?.pathway?.length) {
    steps.push({
      title: "Follow the latest gap pathway",
      minutes: 4,
      detail: session.latestGapAnalysis.pathway[0]
    });
  } else if (recommendations.length) {
    steps.push({
      title: recommendations[0].title,
      minutes: 4,
      detail: recommendations[0].reason
    });
  }

  steps.push({
    title: "Export or quiz the map",
    minutes: 1,
    detail: health.score >= 70 ? "Export Markdown/JSON or generate a quiz to lock in the map." : "Generate a quiz after reviewing the weakest concepts."
  });

  return {
    title: health.score >= 75 ? "Polish this map" : "Strengthen this map",
    totalMinutes: steps.reduce((total, step) => total + step.minutes, 0),
    steps: steps.slice(0, 4)
  };
}

function buildSessionGraph(db, sessionId) {
  const nodes = findVisibleSessionNodes(db, sessionId).map((node) => serializeNodeForSession(node, sessionId));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = db.data.edges
    .filter((edge) => hasSessionMembership(edge, sessionId) && !isEdgeRejectedForSession(edge, sessionId) && nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map((edge) => serializeEdgeForSession(edge, sessionId));
  const artifacts = db.data.artifacts.filter((artifact) => artifact.sessionId === sessionId);
  const goals = db.data.goals.filter((goal) => goal.sessionId === sessionId);
  const reviewQueue = buildReviewQueue(db, sessionId);
  const recommendations = buildRecommendations(db, sessionId);
  const health = calculateMapHealth(nodes, artifacts, reviewQueue);

  return {
    session: getSession(db, sessionId),
    rootId: `session:${sessionId}`,
    goals,
    nodes,
    edges,
    artifacts,
    reviewQueue,
    recommendations,
    health,
    studyPlan: buildStudyPlan(db, sessionId, recommendations, health),
    latestGapAnalysis: getSession(db, sessionId)?.latestGapAnalysis ?? null
  };
}

function slugify(value) {
  return normalizeLabel(value).replace(/\s+/g, "-") || "mindweaver-map";
}

function escapeMarkdown(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\n+/g, " ")
    .trim();
}

function buildSessionExport(db, sessionId) {
  const graph = buildSessionGraph(db, sessionId);
  if (!graph.session) return null;

  const concepts = graph.nodes
    .filter((node) => node.type === "concept")
    .sort((left, right) => (right.confidence ?? 0) - (left.confidence ?? 0))
    .map((node) => ({
      id: node.id,
      label: node.label,
      confidence: node.confidence ?? 0,
      evidenceCount: node.evidenceCount ?? 0,
      reviewStatus: node.reviewStatus,
      whyThisExists: node.whyThisExists,
      sources: (node.sources ?? []).map((source) => ({
        title: source.title,
        url: source.url,
        sourceType: source.sourceType,
        addedAt: source.addedAt
      }))
    }));

  return {
    exportedAt: Date.now(),
    summary: buildSessionSummary(db, graph.session),
    goal: graph.session.goal,
    concepts,
    sources: graph.artifacts.map((artifact) => ({
      id: artifact.id,
      title: artifact.title,
      url: artifact.url,
      sourceType: artifact.sourceType,
      contentLength: artifact.contentLength,
      ingestStatus: artifact.ingestStatus,
      addedAt: artifact.addedAt
    })),
    recommendations: graph.recommendations,
    latestGapAnalysis: graph.latestGapAnalysis,
    edges: graph.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      label: edge.label,
      type: edge.type,
      confidence: edge.confidence
    }))
  };
}

function buildMarkdownExport(exportData) {
  const title = exportData.goal || "Untitled MindWeaver Map";
  const lines = [
    `# ${title}`,
    "",
    `Exported: ${new Date(exportData.exportedAt).toLocaleString()}`,
    "",
    "## Summary",
    "",
    `- Concepts: ${exportData.summary.conceptCount}`,
    `- Reviewed concepts: ${exportData.summary.reviewedConceptCount}`,
    `- Sources: ${exportData.summary.sourceCount}`,
    `- Status: ${exportData.summary.endedAt ? "Ended" : "Live"}`,
    "",
    "## Next Actions",
    ""
  ];

  if (exportData.recommendations.length) {
    for (const recommendation of exportData.recommendations) {
      lines.push(`- ${recommendation.title}: ${recommendation.reason}`);
    }
  } else {
    lines.push("- No recommendations were available when this map was exported.");
  }

  lines.push("", "## Concepts", "");
  if (exportData.concepts.length) {
    lines.push("| Concept | Confidence | Evidence | Why it exists |", "| --- | ---: | ---: | --- |");
    for (const concept of exportData.concepts) {
      lines.push(`| ${escapeMarkdown(concept.label)} | ${Math.round(concept.confidence * 100)}% | ${concept.evidenceCount} | ${escapeMarkdown(concept.whyThisExists)} |`);
    }
  } else {
    lines.push("No concepts have been captured yet.");
  }

  lines.push("", "## Sources", "");
  if (exportData.sources.length) {
    for (const source of exportData.sources) {
      lines.push(`- ${source.title} (${source.sourceType || "page"}): ${source.url}`);
    }
  } else {
    lines.push("No sources have been imported yet.");
  }

  if (exportData.latestGapAnalysis?.gaps?.length) {
    lines.push("", "## Gap Analysis", "");
    for (const gap of exportData.latestGapAnalysis.gaps) {
      lines.push(`- ${gap}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function buildSessionSummary(db, session) {
  const nodes = findVisibleSessionNodes(db, session.id);
  const concepts = nodes.filter((node) => node.type === "concept");
  const reviewedConcepts = concepts.filter((node) => getNodeReview(node, session.id)?.status === "approved");
  const artifacts = db.data.artifacts.filter((artifact) => artifact.sessionId === session.id);

  return {
    id: session.id,
    goal: session.goal,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    workspaceId: session.workspaceId ?? null,
    ownerId: session.ownerId ?? null,
    nodeCount: nodes.length,
    conceptCount: concepts.length,
    reviewedConceptCount: reviewedConcepts.length,
    sourceCount: artifacts.length,
    latestGapAnalysisAt: session.latestGapAnalysis?.runAt ?? null
  };
}

function getUserPreferences(db) {
  db.data.preferences ||= {
    activeSessionId: null,
    lastSessionId: null
  };
  db.data.preferences.activeSessionId = String(db.data.preferences.activeSessionId ?? "").trim() || null;
  db.data.preferences.lastSessionId = String(db.data.preferences.lastSessionId ?? "").trim() || null;
  return db.data.preferences;
}

function repairSessionSelection(db) {
  const preferences = getUserPreferences(db);
  const sessionsByStartedAt = [...db.data.sessions].sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0));
  const sessionIds = new Set(sessionsByStartedAt.map((session) => session.id));

  if (preferences.activeSessionId && !sessionIds.has(preferences.activeSessionId)) {
    preferences.activeSessionId = null;
  }

  if (preferences.lastSessionId && !sessionIds.has(preferences.lastSessionId)) {
    preferences.lastSessionId = sessionsByStartedAt[0]?.id ?? null;
  }

  return preferences;
}

function selectActiveSession(db, sessionId) {
  const preferences = repairSessionSelection(db);
  const nextSessionId = String(sessionId ?? "").trim() || null;
  preferences.activeSessionId = nextSessionId;
  if (nextSessionId) {
    preferences.lastSessionId = nextSessionId;
  }
  return preferences;
}

function clearActiveSession(db, sessionId = null) {
  const preferences = repairSessionSelection(db);
  const nextSessionId = String(sessionId ?? "").trim() || null;

  if (!nextSessionId || preferences.activeSessionId === nextSessionId) {
    preferences.activeSessionId = null;
  }

  if (nextSessionId) {
    preferences.lastSessionId = nextSessionId;
  }

  return preferences;
}

function buildSessionTargetPayload(db, limit = 24) {
  const safeLimit = Math.max(1, Math.min(60, Number(limit ?? 24)));
  const preferences = repairSessionSelection(db);
  const workspace = getDefaultWorkspace(db);
  const sessions = [...db.data.sessions]
    .sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
    .slice(0, safeLimit)
    .map((session) => ({
      ...buildSessionSummary(db, session),
      isActiveTarget: session.id === preferences.activeSessionId
    }));

  const activeRecord = preferences.activeSessionId ? getSession(db, preferences.activeSessionId) : null;
  const lastRecord = preferences.lastSessionId ? getSession(db, preferences.lastSessionId) : null;
  const activeSession = activeRecord ? buildSessionSummary(db, activeRecord) : null;
  const lastSession = lastRecord ? buildSessionSummary(db, lastRecord) : null;

  return {
    activeSessionId: preferences.activeSessionId,
    lastSessionId: preferences.lastSessionId,
    activeSession,
    lastSession,
    sessions,
    workspaces: [workspace]
  };
}

function isAllowedCorsOrigin(origin) {
  if (!origin) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return true;
  if (/^(chrome-extension|moz-extension):\/\//i.test(origin)) return true;
  return false;
}

function getDefaultWorkspace(db) {
  db.data.users ||= [];
  db.data.workspaces ||= [];
  let user = db.data.users.find((entry) => entry.id === "local-user");
  if (!user) {
    user = {
      id: "local-user",
      name: "Local User",
      createdAt: Date.now()
    };
    db.data.users.push(user);
  }

  let workspace = db.data.workspaces.find((entry) => entry.id === "local-workspace");
  if (!workspace) {
    workspace = {
      id: "local-workspace",
      name: "Personal Learning",
      ownerId: user.id,
      visibility: "private",
      createdAt: Date.now()
    };
    db.data.workspaces.push(workspace);
  }

  return workspace;
}

function ensureSessionWorkspace(db, session) {
  const workspace = getDefaultWorkspace(db);
  session.workspaceId ||= workspace.id;
  session.ownerId ||= workspace.ownerId;
  return workspace;
}

function buildProgressReport(db, sessionId) {
  const graph = buildSessionGraph(db, sessionId);
  const concepts = graph.nodes.filter((node) => node.type === "concept");
  const byMastery = concepts.reduce((acc, node) => {
    acc[node.masteryState] = (acc[node.masteryState] ?? 0) + 1;
    return acc;
  }, {});
  const sourceTypes = graph.artifacts.reduce((acc, artifact) => {
    const key = artifact.sourceType || "page";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const allSessions = db.data.sessions.map((session) => buildSessionSummary(db, session));

  return {
    session: buildSessionSummary(db, graph.session),
    health: graph.health,
    byMastery,
    sourceTypes,
    longTerm: {
      sessionCount: db.data.sessions.length,
      conceptCount: db.data.nodes.filter((node) => node.type === "concept").length,
      sourceCount: db.data.artifacts.length,
      verifiedConceptCount: db.data.nodes.filter((node) => node.type === "concept" && node.verified).length
    },
    history: allSessions
      .sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
      .slice(0, 12)
  };
}

function searchGraph(db, sessionId, query) {
  const q = normalizeLabel(query);
  if (!q) return { query, results: [] };

  const graph = buildSessionGraph(db, sessionId);
  const results = [];

  for (const node of graph.nodes) {
    const haystack = normalizeLabel(`${node.label} ${node.description ?? ""} ${node.summary ?? ""} ${node.whyThisExists ?? ""}`);
    if (!haystack.includes(q)) continue;
    results.push({
      kind: "node",
      id: node.id,
      label: node.label,
      type: node.type,
      confidence: node.confidence ?? 0,
      masteryState: node.masteryState,
      evidenceCount: node.evidenceCount ?? 0,
      snippet: node.summary || node.whyThisExists
    });
  }

  for (const artifact of graph.artifacts) {
    const haystack = normalizeLabel(`${artifact.title} ${artifact.excerpt ?? ""} ${artifact.contentPreview ?? ""} ${artifact.sourceType ?? ""}`);
    if (!haystack.includes(q)) continue;
    results.push({
      kind: "source",
      id: artifact.id,
      label: artifact.title,
      type: artifact.sourceType || "page",
      confidence: artifact.ingestStatus === "classified" ? 0.8 : 0.5,
      evidenceCount: 1,
      snippet: artifact.excerpt || artifact.contentPreview,
      url: artifact.url
    });
  }

  return {
    query,
    results: results
      .sort((left, right) => (right.evidenceCount - left.evidenceCount) || ((right.confidence ?? 0) - (left.confidence ?? 0)))
      .slice(0, 20)
  };
}

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

function deleteSessionData(db, sessionId) {
  const sessionExists = db.data.sessions.some((session) => session.id === sessionId);
  if (!sessionExists) return false;

  db.data.sessions = db.data.sessions.filter((session) => session.id !== sessionId);
  db.data.goals = db.data.goals.filter((goal) => goal.sessionId !== sessionId);
  db.data.artifacts = db.data.artifacts.filter((artifact) => artifact.sessionId !== sessionId);
  db.data.verifications = db.data.verifications.filter((verification) => verification.sessionId !== sessionId);
  db.data.reports = (db.data.reports ?? []).filter((report) => report.sessionId !== sessionId);

  for (const node of db.data.nodes) {
    node.sessionIds = (node.sessionIds ?? []).filter((id) => id !== sessionId);
    if (node.sessionReviews) delete node.sessionReviews[sessionId];
    node.sources = (node.sources ?? []).filter((source) => source.sessionId !== sessionId);
    node.history = (node.history ?? []).filter((event) => event.sessionId !== sessionId);
  }

  db.data.nodes = db.data.nodes.filter((node) => (node.sessionIds ?? []).length > 0);
  db.data.edges = db.data.edges
    .map((edge) => ({
      ...edge,
      sessionIds: (edge.sessionIds ?? []).filter((id) => id !== sessionId)
    }))
    .filter((edge) => edge.sessionIds.length > 0);

  return true;
}

function validateIngestPayload(body, { allowSyntheticUrl = false } = {}) {
  const errors = [];

  if (!body || typeof body !== "object") {
    return { ok: false, errors: ["Request body must be a JSON object."] };
  }

  if (!String(body.sessionId ?? "").trim()) errors.push("sessionId is required.");
  if (!allowSyntheticUrl && !String(body.url ?? "").trim()) errors.push("url is required.");
  if (body.url && !normalizeUrl(body.url)) errors.push("url must be a valid absolute URL.");
  if (body.title !== undefined && typeof body.title !== "string") errors.push("title must be a string.");
  if (body.excerpt !== undefined && typeof body.excerpt !== "string") errors.push("excerpt must be a string.");
  if (body.content !== undefined && typeof body.content !== "string") errors.push("content must be a string.");
  if (body.sourceType !== undefined && typeof body.sourceType !== "string") errors.push("sourceType must be a string.");
  if (typeof body.sourceType === "string" && !ALLOWED_SOURCE_TYPES.has(body.sourceType.toLowerCase())) errors.push(`sourceType must be one of: ${[...ALLOWED_SOURCE_TYPES].join(", ")}.`);
  if (typeof body.content === "string" && body.content.length > MAX_INGEST_CONTENT_CHARS) errors.push(`content must be ${MAX_INGEST_CONTENT_CHARS} characters or less.`);

  return {
    ok: errors.length === 0,
    errors
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

function createDemoSession(db) {
  const session = {
    id: nanoid(),
    startedAt: Date.now(),
    endedAt: null,
    goal: "Understand event-driven systems with source-grounded confidence",
    latestGapAnalysis: {
      gaps: ["consumer lag", "schema registry"],
      pathway: [
        "Review producers, consumers, and brokers first.",
        "Add one source about consumer lag and monitoring.",
        "Quiz yourself on idempotency and dead-letter queues."
      ],
      difficulty: "medium",
      recommendedActions: buildRecommendedActions({
        gaps: ["consumer lag", "schema registry"],
        pathway: ["Review producers, consumers, and brokers first."]
      }),
      runAt: Date.now()
    },
    isDemo: true
  };

  db.data.sessions.push(session);
  ensureNode(db, `session:${session.id}`, "Learning Session", "root", {
    sessionId: session.id,
    verified: true,
    confidence: 1,
    reason: "Created as the root node for this demo session."
  });

  const goal = createGoalForSession(db, session.id, session.goal);
  const domain = ensureNode(db, "domain:event driven architecture", "event driven architecture", "domain", {
    createdBy: "demo",
    verified: true,
    confidence: 0.92,
    sessionId: session.id,
    reason: "Demo map domain for event-driven learning."
  });
  const skill = ensureNode(db, "skill:event handling", "event handling", "skill", {
    createdBy: "demo",
    verified: true,
    confidence: 0.9,
    sessionId: session.id,
    reason: "Demo map skill connecting sources to practical event concepts."
  });

  ensureEdge(db, goal.id, domain.id, "focuses_on", "focuses_on", 0.92, "demo", session.id);
  ensureEdge(db, domain.id, skill.id, "contains", "contains", 0.92, "demo", session.id);

  const artifacts = [
    {
      title: "Demo Note: Event-Driven Basics",
      url: "mindweaver://demo/event-driven-basics",
      sourceType: "note",
      concepts: ["event producer", "event consumer", "broker"]
    },
    {
      title: "Demo Transcript: Reliable Consumers",
      url: "mindweaver://demo/reliable-consumers",
      sourceType: "youtube",
      concepts: ["idempotency", "dead letter queue"]
    },
    {
      title: "Demo PDF Extract: Operational Signals",
      url: "mindweaver://demo/operational-signals",
      sourceType: "pdf",
      concepts: ["consumer lag", "schema versioning"]
    }
  ];

  for (const artifactConfig of artifacts) {
    const artifact = {
      id: `artifact:${nanoid()}`,
      sessionId: session.id,
      url: artifactConfig.url,
      title: artifactConfig.title,
      excerpt: `${artifactConfig.title} connects concepts in a realistic demo knowledge map.`,
      sourceType: artifactConfig.sourceType,
      contentPreview: `${artifactConfig.concepts.join(", ")} are covered by this demo source.`,
      contentLength: 900,
      addedAt: Date.now(),
      lastSeenAt: Date.now(),
      viewCount: 1,
      ingestStatus: "classified",
      classification: {
        domain: domain.label,
        skill: skill.label,
        concepts: artifactConfig.concepts
      }
    };
    db.data.artifacts.push(artifact);

    for (const conceptLabel of artifactConfig.concepts) {
      const normalized = normalizeLabel(conceptLabel);
      const concept = ensureNode(db, `concept:${normalized}`, normalized, "concept", {
        createdBy: "demo",
        verified: normalized === "event producer",
        confidence: normalized === "consumer lag" ? 0.52 : 0.76,
        sessionId: session.id,
        sourceType: artifact.sourceType,
        artifactId: artifact.id,
        reason: `Demo source "${artifact.title}" teaches ${normalized}.`
      });
      ensureEdge(db, skill.id, concept.id, "builds_on", "builds_on", 0.9, "demo", session.id);
      ensureSource(concept, session.id, {
        url: artifact.url,
        title: artifact.title,
        artifactId: artifact.id,
        sourceType: artifact.sourceType
      });
      artifact.conceptIds ||= [];
      artifact.conceptIds.push(concept.id);
    }
  }

  return session;
}

async function ingestSource({ db, openaiClient, payload }) {
  const sessionId = String(payload.sessionId).trim();
  const session = getSession(db, sessionId);
  const title = String(payload.title ?? "").trim();
  const excerpt = String(payload.excerpt ?? "").trim();
  const content = String(payload.content ?? "");
  const sourceType = String(payload.sourceType ?? "page").trim().toLowerCase() || "page";
  const normalizedUrl = normalizeUrl(payload.url) ?? createSyntheticUrl(sourceType, title || "imported-source");

  if (!session) {
    return { status: 404, body: { ok: false, error: "session not found" } };
  }

  const minimumContentLength = sourceType === "highlight" ? 20 : 200;
  if (content.trim().length < minimumContentLength) {
    return {
      status: 400,
      body: {
        ok: false,
        reason: `Content too minimal (< ${minimumContentLength} chars) - likely not a substantive source`
      }
    };
  }

  let artifact = db.data.artifacts.find((entry) => entry.sessionId === sessionId && entry.url === normalizedUrl);
  if (artifact) {
    artifact.lastSeenAt = Date.now();
    artifact.viewCount = (artifact.viewCount ?? 1) + 1;
    await db.write();
    return {
      status: 200,
      body: {
        ok: true,
        deduped: true,
        artifactId: artifact.id,
        classification: artifact.classification ?? null
      }
    };
  }

  artifact = {
    id: `artifact:${nanoid()}`,
    sessionId,
    url: normalizedUrl,
    title: title || normalizedUrl,
    excerpt,
    sourceType,
    contentPreview: content.slice(0, 500),
    contentLength: content.length,
    addedAt: Date.now(),
    lastSeenAt: Date.now(),
    viewCount: 1,
    ingestStatus: openaiClient ? "pending" : "stored"
  };
  db.data.artifacts.push(artifact);

  let classification = null;
  let domain = null;
  let skill = null;
  const concepts = [];

  if (openaiClient) {
    const worthiness = await requestStructuredJson(openaiClient, {
      model: "gpt-4o-mini",
      label: "Source worthiness check",
      timeoutMs: 12000,
      temperature: 0.2,
      max_completion_tokens: 120,
      messages: [
        {
          role: "system",
          content: `Evaluate whether this ${getSourceTypeLabel(sourceType)} has substantive educational content worth adding to a knowledge graph.
Return only JSON: {"should_ingest": true/false, "reason": "brief explanation"}`
        },
        {
          role: "user",
          content: `Title: ${artifact.title}
Type: ${getSourceTypeLabel(sourceType)}
Content preview: ${content.slice(0, OPENAI_CONTENT_LIMIT)}`
        }
      ]
    }).catch(() => null);

    if (worthiness?.should_ingest === false) {
      artifact.ingestStatus = "rejected";
      artifact.rejectionReason = worthiness.reason ?? "Source lacks substantive content";
      await db.write();
      return {
        status: 400,
        body: { ok: false, reason: artifact.rejectionReason }
      };
    }

    classification = await requestStructuredJson(openaiClient, {
      model: "gpt-4o-mini",
      label: "Source classification",
      timeoutMs: 15000,
      temperature: 0.2,
      max_completion_tokens: 220,
      messages: [
        {
          role: "system",
          content: `You are a knowledge graph classifier.
${buildGraphContext(db)}

Classify this source into one domain, one skill, and 1-3 core concepts.
Prefer concrete mechanisms, protocols, components, and practices over generic benefits.
Avoid vague concepts like "scalability", "resilience", "performance", or "efficiency" unless the source is directly teaching that concept itself.
If the source mentions named systems or implementation details, favor those specifics.
Return only JSON: {"domain":"...", "skill":"...", "concepts":["..."]}`
        },
        {
          role: "user",
          content: `Title: ${artifact.title}
Type: ${getSourceTypeLabel(sourceType)}
Content: ${content.slice(0, OPENAI_CONTENT_LIMIT)}`
        }
      ]
    }).catch(() => null);
  }

  const sessionGoal = getSessionGoal(db, sessionId);
  const parentId = sessionGoal?.id ?? `session:${sessionId}`;
  const sourceReason = `Identified from ${getSourceTypeLabel(sourceType).toLowerCase()} "${artifact.title}".`;

  if (classification?.domain) {
    const domainLabel = normalizeLabel(classification.domain);
    if (domainLabel) {
      const domainNode = ensureNode(db, `domain:${domainLabel}`, domainLabel, "domain", {
        createdBy: "ai",
        verified: false,
        sessionId,
        sourceType,
        artifactId: artifact.id,
        reason: sourceReason
      });
      ensureEdge(db, parentId, domainNode.id, sessionGoal ? "focuses_on" : "contains", sessionGoal ? "focuses_on" : "contains", 0.8, sessionGoal ? "user" : "ai", sessionId);
      domain = { id: domainNode.id, label: domainNode.label };
    }
  }

  if (domain && classification?.skill) {
    const skillLabel = normalizeLabel(classification.skill);
    if (skillLabel) {
      const skillNode = ensureNode(db, `skill:${skillLabel}`, skillLabel, "skill", {
        createdBy: "ai",
        verified: false,
        sessionId,
        sourceType,
        artifactId: artifact.id,
        reason: sourceReason
      });
      ensureEdge(db, domain.id, skillNode.id, "contains", "contains", 0.82, "ai", sessionId);
      skill = { id: skillNode.id, label: skillNode.label };
    }
  }

  if (skill && Array.isArray(classification?.concepts)) {
    for (const conceptName of classification.concepts) {
      const conceptLabel = normalizeLabel(conceptName);
      if (!conceptLabel) continue;
      const conceptNode = ensureNode(db, `concept:${conceptLabel}`, conceptLabel, "concept", {
        createdBy: "ai",
        verified: false,
        sessionId,
        sourceType,
        artifactId: artifact.id,
        reason: sourceReason
      });
      ensureEdge(db, skill.id, conceptNode.id, "builds_on", "builds_on", 0.85, "ai", sessionId);
      concepts.push({ id: conceptNode.id, label: conceptNode.label });
    }
  }

  let directlyCoveredConcepts = concepts.map((concept) => concept.label);
  if (openaiClient && concepts.length > 1) {
    const refinement = await requestStructuredJson(openaiClient, {
      model: "gpt-4o-mini",
      label: "Direct concept refinement",
      timeoutMs: 12000,
      temperature: 0.2,
      max_completion_tokens: 140,
      messages: [
        {
          role: "system",
          content: 'Return only JSON: {"directly_covered": ["concept1", "concept2"]}. Keep only specific concepts directly taught by the source, not vague benefits or outcomes.'
        },
        {
          role: "user",
          content: `Title: ${artifact.title}
Content: ${content.slice(0, OPENAI_CONTENT_LIMIT)}
Concepts: ${concepts.map((concept) => concept.label).join(", ")}

Which concepts are directly taught by this source?`
        }
      ]
    }).catch(() => null);

    if (Array.isArray(refinement?.directly_covered)) {
      directlyCoveredConcepts = refinement.directly_covered.map((concept) => normalizeLabel(concept)).filter(Boolean);
    }
  }

  for (const concept of concepts) {
    if (!directlyCoveredConcepts.includes(concept.label)) continue;
    const conceptNode = db.data.nodes.find((node) => node.id === concept.id);
    if (!conceptNode) continue;

    ensureSource(conceptNode, sessionId, {
      url: normalizedUrl,
      title: artifact.title,
      artifactId: artifact.id,
      sourceType
    });
  }

  artifact.classification = classification;
  artifact.conceptIds = concepts.map((concept) => concept.id);
  artifact.ingestStatus = classification ? "classified" : "stored";

  await db.write();
  return {
    status: 200,
    body: {
      ok: true,
      deduped: false,
      artifactId: artifact.id,
      classification,
      domain,
      skill,
      concepts
    }
  };
}

export function createApp({ db, openaiClient = null, staticDir = null } = {}) {
  if (!db) throw new Error("createApp requires a db instance");

  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });
  app.use(cors({
    origin(origin, callback) {
      return callback(null, isAllowedCorsOrigin(origin));
    }
  }));
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", async (req, res) => {
    res.json({
      ok: true,
      app: "MindWeaver",
      localOnly: true,
      openaiConfigured: Boolean(openaiClient),
      contentLimitChars: OPENAI_CONTENT_LIMIT,
      maxPayloadContentChars: MAX_INGEST_CONTENT_CHARS,
      sourceTypes: Object.keys(SOURCE_TYPE_LABELS),
      counts: {
        sessions: db.data.sessions.length,
        nodes: db.data.nodes.length,
        artifacts: db.data.artifacts.length,
        workspaces: (db.data.workspaces ?? []).length
      }
    });
  });

  app.get("/api/workspaces", async (req, res) => {
    const workspace = getDefaultWorkspace(db);
    await db.write();
    res.json({ workspaces: [workspace] });
  });

  app.post("/api/workspaces", async (req, res) => {
    const name = String(req.body?.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "name required" });
    getDefaultWorkspace(db);
    const user = db.data.users.find((entry) => entry.id === "local-user");
    const workspace = {
      id: `workspace:${nanoid()}`,
      name,
      ownerId: user?.id ?? "local-user",
      visibility: "private",
      createdAt: Date.now()
    };
    db.data.workspaces.push(workspace);
    await db.write();
    res.json(workspace);
  });

  app.get("/api/backup", async (req, res) => {
    res.json({
      app: "MindWeaver",
      version: 1,
      exportedAt: Date.now(),
      data: sanitizeDataShape(db.data)
    });
  });

  app.post("/api/restore", async (req, res) => {
    const confirm = req.body?.confirm === true;
    const backup = req.body?.backup;
    if (!confirm) return res.status(400).json({ error: "confirm=true required for restore" });
    if (!backup?.data || backup.app !== "MindWeaver") return res.status(400).json({ error: "valid MindWeaver backup required" });

    db.data = sanitizeDataShape(backup.data);
    repairSessionSelection(db);
    await db.write();
    res.json({
      ok: true,
      counts: {
        sessions: db.data.sessions.length,
        nodes: db.data.nodes.length,
        artifacts: db.data.artifacts.length
      }
    });
  });

  app.get("/api/sessions", async (req, res) => {
    const limit = Math.max(1, Math.min(24, Number(req.query.limit ?? 8)));
    const sessions = [...db.data.sessions]
      .sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
      .slice(0, limit)
      .map((session) => buildSessionSummary(db, session));

    res.json({ sessions });
  });

  app.get("/api/session-target", async (req, res) => {
    const payload = buildSessionTargetPayload(db, req.query.limit ?? 24);
    await db.write();
    res.json(payload);
  });

  app.put("/api/session-target", async (req, res) => {
    const sessionId = req.body?.sessionId === null ? null : String(req.body?.sessionId ?? "").trim();

    if (sessionId) {
      const session = getSession(db, sessionId);
      if (!session) return res.status(404).json({ error: "session not found" });
      selectActiveSession(db, sessionId);
    } else {
      clearActiveSession(db);
    }

    await db.write();
    res.json(buildSessionTargetPayload(db, req.body?.limit ?? 24));
  });

  app.post("/api/sessions", async (req, res) => {
    const goalTitle = String(req.body?.goal ?? "").trim();
    const workspace = getDefaultWorkspace(db);
    const session = {
      id: nanoid(),
      startedAt: Date.now(),
      endedAt: null,
      goal: goalTitle || null,
      latestGapAnalysis: null,
      workspaceId: workspace.id,
      ownerId: workspace.ownerId
    };

    db.data.sessions.push(session);
    ensureNode(db, `session:${session.id}`, "Learning Session", "root", {
      sessionId: session.id,
      verified: true,
      confidence: 1,
      reason: "Created as the root node for this session."
    });

    const goal = createGoalForSession(db, session.id, goalTitle);
    selectActiveSession(db, session.id);

    await db.write();
    res.json({
      ...session,
      goalId: goal?.id ?? null
    });
  });

  app.post("/api/demo-session", async (req, res) => {
    const session = createDemoSession(db);
    ensureSessionWorkspace(db, session);
    selectActiveSession(db, session.id);
    await db.write();
    res.json({
      ...session,
      goalId: getSessionGoal(db, session.id)?.id ?? null
    });
  });

  app.post("/api/goals", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const title = String(req.body?.title ?? "").trim();
    const description = String(req.body?.description ?? "").trim();

    if (!sessionId || !title) {
      return res.status(400).json({ error: "sessionId and title required" });
    }

    const session = getSession(db, sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });

    const goal = createGoalForSession(db, sessionId, title, description);
    session.goal = title;

    await db.write();
    res.json(goal);
  });

  app.get("/api/goals/:sessionId", async (req, res) => {
    res.json(db.data.goals.filter((goal) => goal.sessionId === req.params.sessionId));
  });

  app.post("/api/sessions/:id/end", async (req, res) => {
    const session = getSession(db, req.params.id);
    if (!session) return res.status(404).json({ error: "session not found" });

    session.endedAt = Date.now();
    clearActiveSession(db, session.id);
    await db.write();
    res.json(session);
  });

  app.delete("/api/sessions/:id", async (req, res) => {
    const removed = deleteSessionData(db, req.params.id);
    if (!removed) return res.status(404).json({ error: "session not found" });

    repairSessionSelection(db);
    await db.write();
    res.json({ ok: true });
  });

  app.delete("/api/sessions/:sessionId/artifacts/:artifactId", async (req, res) => {
    const removed = deleteArtifactFromSession(db, req.params.sessionId, req.params.artifactId);
    if (!removed) return res.status(404).json({ error: "artifact not found in session" });

    await db.write();
    res.json({ ok: true, graph: buildSessionGraph(db, req.params.sessionId) });
  });

  app.get("/api/sessions/:id/export", async (req, res) => {
    const exportData = buildSessionExport(db, req.params.id);
    if (!exportData) return res.status(404).json({ error: "session not found" });

    const format = String(req.query.format ?? "json").toLowerCase();
    const fileBase = slugify(exportData.goal || exportData.summary.id);

    if (format === "markdown" || format === "md") {
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${fileBase}.md"`);
      return res.send(buildMarkdownExport(exportData));
    }

    res.setHeader("Content-Disposition", `attachment; filename="${fileBase}.json"`);
    res.json(exportData);
  });

  app.post("/api/ingest", async (req, res) => {
    const validation = validateIngestPayload(req.body);
    if (!validation.ok) {
      return res.status(400).json({ ok: false, errors: validation.errors });
    }

    const result = await ingestSource({
      db,
      openaiClient,
      payload: {
        ...req.body,
        sourceType: "page"
      }
    });

    res.status(result.status).json(result.body);
  });

  app.post("/api/import", async (req, res) => {
    const validation = validateIngestPayload(req.body, { allowSyntheticUrl: true });
    if (!validation.ok) {
      return res.status(400).json({ ok: false, errors: validation.errors });
    }

    const result = await ingestSource({
      db,
      openaiClient,
      payload: {
        ...req.body,
        sourceType: req.body.sourceType ?? "note"
      }
    });

    res.status(result.status).json(result.body);
  });

  app.post("/api/import-bulk", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 20) : [];
    if (!sessionId || !items.length) return res.status(400).json({ error: "sessionId and items[] required" });
    if (!getSession(db, sessionId)) return res.status(404).json({ error: "session not found" });

    const results = [];
    for (const [index, item] of items.entries()) {
      const payload = {
        sessionId,
        sourceType: item.sourceType ?? "markdown",
        title: item.title ?? `Bulk import ${index + 1}`,
        url: item.url,
        excerpt: String(item.content ?? "").slice(0, 280),
        content: item.content
      };
      const validation = validateIngestPayload(payload, { allowSyntheticUrl: true });
      if (!validation.ok) {
        results.push({ ok: false, index, errors: validation.errors });
        continue;
      }
      const result = await ingestSource({ db, openaiClient, payload });
      results.push({ index, status: result.status, ...result.body });
    }

    res.json({
      ok: results.some((result) => result.ok),
      importedCount: results.filter((result) => result.ok && !result.deduped).length,
      dedupedCount: results.filter((result) => result.ok && result.deduped).length,
      failedCount: results.filter((result) => !result.ok).length,
      results,
      graph: buildSessionGraph(db, sessionId)
    });
  });

  app.get("/api/graph/:sessionId", async (req, res) => {
    const session = getSession(db, req.params.sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });
    res.json(buildSessionGraph(db, req.params.sessionId));
  });

  app.get("/api/review/:sessionId", async (req, res) => {
    const session = getSession(db, req.params.sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });
    res.json({ reviewQueue: buildReviewQueue(db, req.params.sessionId) });
  });

  app.get("/api/recommendations/:sessionId", async (req, res) => {
    const session = getSession(db, req.params.sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });
    res.json({ recommendations: buildRecommendations(db, req.params.sessionId) });
  });

  app.get("/api/progress/:sessionId", async (req, res) => {
    const session = getSession(db, req.params.sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });
    res.json(buildProgressReport(db, req.params.sessionId));
  });

  app.get("/api/search/:sessionId", async (req, res) => {
    const session = getSession(db, req.params.sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });
    res.json(searchGraph(db, req.params.sessionId, String(req.query.q ?? "")));
  });

  app.post("/api/chat", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const question = String(req.body?.question ?? "").trim();
    if (!sessionId || !question) return res.status(400).json({ error: "sessionId and question required" });
    const session = getSession(db, sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });

    const fallback = buildExtractiveAnswer(db, sessionId, question);
    if (!openaiClient) return res.json(fallback);

    const content = await requestText(openaiClient, {
      model: "gpt-4o-mini",
      label: "Graph chat",
      timeoutMs: 15000,
      temperature: 0.2,
      max_completion_tokens: 340,
      messages: [
        {
          role: "system",
          content: "Answer only from the provided MindWeaver graph evidence. If evidence is weak, say what evidence is missing. Keep the answer concise and cite the labels you used."
        },
        {
          role: "user",
          content: `Question: ${question}

Evidence:
${fallback.citations.map((citation) => `- ${citation.label}: ${citation.snippet ?? ""}`).join("\n") || "No matching evidence."}`
        }
      ]
    }).catch(() => null);

    res.json({
      answer: content ?? fallback.answer,
      citations: fallback.citations
    });
  });

  app.get("/api/summary/:sessionId", async (req, res) => {
    const session = getSession(db, req.params.sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });
    const summary = buildLearningSummary(db, req.params.sessionId);
    db.data.reports ||= [];
    db.data.reports.push({
      id: `report:${nanoid()}`,
      sessionId: req.params.sessionId,
      kind: "learning-summary",
      createdAt: Date.now(),
      summary
    });
    await db.write();
    res.json(summary);
  });

  app.post("/api/prune", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const dryRun = req.body?.dryRun !== false;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    const session = getSession(db, sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });

    const candidates = findVisibleSessionNodes(db, sessionId)
      .map((node) => serializeNodeForSession(node, sessionId))
      .filter((node) => node.type === "concept" && (node.confidence ?? 0) < 0.6 && node.evidenceCount === 0);

    if (!dryRun) {
      for (const candidate of candidates) {
        const node = db.data.nodes.find((entry) => entry.id === candidate.id);
        if (!node) continue;
        setNodeReview(node, sessionId, "rejected");
        addHistoryEntry(node, {
          kind: "graph-pruned",
          sessionId,
          summary: "Pruned because it had low confidence and no direct evidence."
        });
      }
      await db.write();
    }

    res.json({
      dryRun,
      count: candidates.length,
      candidates,
      graph: dryRun ? null : buildSessionGraph(db, sessionId)
    });
  });

  app.post("/api/edges", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const sourceId = String(req.body?.sourceId ?? "").trim();
    const targetId = String(req.body?.targetId ?? "").trim();
    const type = String(req.body?.type ?? "related").trim();
    const label = String(req.body?.label ?? type).trim();

    if (!sessionId || !sourceId || !targetId) return res.status(400).json({ error: "sessionId, sourceId, and targetId required" });
    if (!RELATIONSHIP_TYPES.has(type)) return res.status(400).json({ error: `type must be one of: ${[...RELATIONSHIP_TYPES].join(", ")}` });
    const source = db.data.nodes.find((node) => node.id === sourceId && hasSessionMembership(node, sessionId));
    const target = db.data.nodes.find((node) => node.id === targetId && hasSessionMembership(node, sessionId));
    if (!source || !target) return res.status(404).json({ error: "source or target not found in session" });

    const edge = ensureEdge(db, sourceId, targetId, label, type, 0.95, "user", sessionId);
    setEdgeReview(edge, sessionId, "approved");
    await db.write();
    res.json({ ok: true, edge: serializeEdgeForSession(edge, sessionId), graph: buildSessionGraph(db, sessionId) });
  });

  app.post("/api/edges/:key/review", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const action = String(req.body?.action ?? "").trim();
    if (!sessionId || !["approve", "reject"].includes(action)) return res.status(400).json({ error: "sessionId and action=approve|reject required" });
    const edge = db.data.edges.find((entry) => entry.key === req.params.key && hasSessionMembership(entry, sessionId));
    if (!edge) return res.status(404).json({ error: "edge not found in session" });

    setEdgeReview(edge, sessionId, action === "approve" ? "approved" : "rejected");
    edge.verified = action === "approve";
    edge.confidence = action === "approve" ? 1 : Math.min(edge.confidence ?? 0.5, 0.2);
    await db.write();
    res.json({ ok: true, edge: serializeEdgeForSession(edge, sessionId), graph: buildSessionGraph(db, sessionId) });
  });

  app.post("/api/nodes/:id/review", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const action = String(req.body?.action ?? "").trim();
    const node = db.data.nodes.find((entry) => entry.id === req.params.id);

    if (!sessionId || !["approve", "reject"].includes(action)) {
      return res.status(400).json({ error: "sessionId and action=approve|reject required" });
    }

    if (!node || !hasSessionMembership(node, sessionId)) {
      return res.status(404).json({ error: "node not found in session" });
    }

    if (action === "approve") {
      setNodeReview(node, sessionId, "approved");
      node.verified = true;
      node.confidence = 1;
      applyReviewOutcome(node, "success");
      addHistoryEntry(node, {
        kind: "review-approved",
        sessionId,
        summary: "Approved during manual review."
      });
    } else {
      setNodeReview(node, sessionId, "rejected");
      node.confidence = Math.min(node.confidence ?? 0.7, 0.2);
      applyReviewOutcome(node, "reset");
      addHistoryEntry(node, {
        kind: "review-rejected",
        sessionId,
        summary: "Rejected during manual review."
      });
    }

    await db.write();
    res.json({
      ok: true,
      node: serializeNodeForSession(node, sessionId),
      reviewQueue: buildReviewQueue(db, sessionId),
      recommendations: buildRecommendations(db, sessionId)
    });
  });

  app.patch("/api/nodes/:id", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const node = db.data.nodes.find((entry) => entry.id === req.params.id);
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    if (!node || !hasSessionMembership(node, sessionId)) return res.status(404).json({ error: "node not found in session" });

    const label = req.body?.label === undefined ? null : String(req.body.label).trim();
    const description = req.body?.description === undefined ? null : String(req.body.description).trim();
    const summary = req.body?.summary === undefined ? null : String(req.body.summary).trim();
    const masteryState = req.body?.masteryState === undefined ? null : String(req.body.masteryState).trim();

    if (label) {
      if (label !== node.label) {
        node.aliases ||= [];
        if (node.label && !node.aliases.includes(node.label)) node.aliases.push(node.label);
      }
      node.label = label;
      node.canonicalLabel = normalizeLabel(label);
    }
    if (description !== null) node.description = description;
    if (summary !== null) node.summary = summary;
    if (masteryState && ["new", "seen", "understood", "verified"].includes(masteryState)) {
      if (masteryState === "verified") {
        node.verified = true;
        node.confidence = 1;
        setNodeReview(node, sessionId, "approved");
        applyReviewOutcome(node, "success");
      } else if (masteryState === "understood") {
        node.confidence = Math.max(node.confidence ?? 0, 0.86);
      } else if (masteryState === "seen") {
        node.confidence = Math.max(node.confidence ?? 0, 0.65);
      }
    }

    addHistoryEntry(node, {
      kind: "node-edited",
      sessionId,
      summary: "Edited manually in the inspector."
    });
    await db.write();
    res.json({ ok: true, node: serializeNodeForSession(node, sessionId), graph: buildSessionGraph(db, sessionId) });
  });

  app.post("/api/nodes/:id/merge", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const targetId = String(req.body?.targetId ?? "").trim();
    if (!sessionId || !targetId) return res.status(400).json({ error: "sessionId and targetId required" });
    const result = mergeNodeIntoTarget(db, sessionId, req.params.id, targetId);
    if (!result.ok) return res.status(400).json({ error: result.error });

    await db.write();
    res.json({
      ok: true,
      source: serializeNodeForSession(result.source, sessionId),
      target: serializeNodeForSession(result.target, sessionId),
      graph: buildSessionGraph(db, sessionId)
    });
  });

  app.post("/api/gaps", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const goalId = String(req.body?.goalId ?? "").trim();

    if (!sessionId || !goalId) {
      return res.status(400).json({ error: "goalId and sessionId required" });
    }

    const goalNode = db.data.nodes.find((node) => node.id === goalId && hasSessionMembership(node, sessionId));
    if (!goalNode) return res.status(404).json({ error: "goal not found" });

    const knownConcepts = findVisibleSessionNodes(db, sessionId)
      .filter((node) => node.type === "concept")
      .map((node) => node.label);

    let safeGapData = createFallbackGapResponse(goalNode.label, knownConcepts);

    if (openaiClient) {
      const gapData = await requestStructuredJson(openaiClient, {
        model: "gpt-4o-mini",
        label: "Gap analysis",
        timeoutMs: 16000,
        temperature: 0.2,
        max_completion_tokens: 320,
        messages: [
          {
            role: "system",
            content: `${buildGraphContext(db)}

Goal: "${goalNode.label}"
Known concepts in this session: ${knownConcepts.join(", ") || "none"}

Return only JSON: {"gaps":["concept1"],"pathway":["first step","second step"],"difficulty":"easy|medium|hard"}`
          },
          {
            role: "user",
            content: `What concepts are missing to reach the goal "${goalNode.label}"?`
          }
        ]
      }).catch(() => null);

      if (gapData) {
        safeGapData = {
          ...gapData,
          recommendedActions: buildRecommendedActions(gapData)
        };
      }
    }

    for (const gap of safeGapData.gaps ?? []) {
      const label = normalizeLabel(gap);
      if (!label) continue;
      const gapNode = ensureNode(db, `concept:${label}`, label, "concept", {
        createdBy: "ai",
        verified: false,
        confidence: 0.55,
        sessionId,
        reason: `Gap analysis flagged ${label} as missing for the goal "${goalNode.label}".`
      });
      ensureEdge(db, goalNode.id, gapNode.id, "needs", "needs", 0.55, "ai", sessionId);
    }

    const session = getSession(db, sessionId);
    session.latestGapAnalysis = {
      ...safeGapData,
      runAt: Date.now()
    };

    await db.write();
    res.json(safeGapData);
  });

  app.post("/api/quiz", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    const concepts = findVisibleSessionNodes(db, sessionId)
      .map((node) => serializeNodeForSession(node, sessionId))
      .filter((node) => node.type === "concept")
      .filter((node) => !node.verified || node.dueForReview || node.confidence < 1)
      .sort((left, right) => Number(right.dueForReview) - Number(left.dueForReview) || left.confidence - right.confidence)
      .slice(0, 5);

    if (concepts.length === 0) {
      return res.json({ quiz: [], message: "No review-worthy concepts in this session." });
    }

    if (!openaiClient) {
      return res.json({ quiz: [], message: "OpenAI is not configured, so quiz generation is unavailable." });
    }

    const quizData = await requestStructuredJson(openaiClient, {
      model: "gpt-4o-mini",
      label: "Quiz generation",
      timeoutMs: 18000,
      temperature: 0.2,
      max_completion_tokens: 480,
      messages: [
        {
          role: "system",
          content: `Generate 1 multiple-choice question per concept from this exact list: ${concepts.map((concept) => `"${concept.label}"`).join(", ")}.
Return only JSON: {"questions":[{"concept":"exact concept label","q":"question","options":["a","b","c","d"],"correct":0}]}`
        },
        {
          role: "user",
          content: `Create a short spaced-review quiz covering these concepts: ${concepts.map((concept) => concept.label).join(", ")}`
        }
      ]
    }).catch(() => null);

    const questions = Array.isArray(quizData?.questions) ? quizData.questions : [];
    const conceptMap = new Map(concepts.map((concept) => [concept.label, concept.id]));
    const quiz = questions
      .map((question, index) => {
        const conceptLabel = normalizeLabel(question.concept);
        const conceptId = conceptMap.get(conceptLabel);
        if (!conceptId || !Array.isArray(question.options) || typeof question.correct !== "number") return null;
        return {
          id: `quiz:${index + 1}`,
          concept: conceptLabel,
          conceptId,
          q: question.q,
          options: question.options.slice(0, 4),
          correct: question.correct
        };
      })
      .filter(Boolean);

    res.json({
      quiz,
      concepts: concepts.map((concept) => ({ id: concept.id, label: concept.label }))
    });
  });

  app.post("/api/verify", async (req, res) => {
    const conceptIds = Array.isArray(req.body?.conceptIds) ? req.body.conceptIds : null;
    const correct = Boolean(req.body?.correct);
    const sessionId = String(req.body?.sessionId ?? "").trim() || null;

    if (!conceptIds) {
      return res.status(400).json({ error: "conceptIds array required" });
    }

    for (const conceptId of conceptIds) {
      const node = db.data.nodes.find((entry) => entry.id === conceptId);
      if (!node) continue;

      node.verified = correct;
      node.confidence = correct ? 1 : Math.max(0.3, (node.confidence ?? 0.7) - 0.2);
      applyReviewOutcome(node, correct ? "success" : "reset");

      if (sessionId && hasSessionMembership(node, sessionId)) {
        setNodeReview(node, sessionId, correct ? "approved" : "pending");
      }

      addHistoryEntry(node, {
        kind: "quiz-verification",
        sessionId,
        summary: correct ? "Answered a review question correctly." : "Missed a review question and confidence dropped."
      });

      db.data.verifications.push({
        id: `verification:${nanoid()}`,
        conceptId,
        correct,
        sessionId,
        createdAt: Date.now()
      });
    }

    await db.write();
    res.json({
      ok: true,
      reviewQueue: sessionId ? buildReviewQueue(db, sessionId) : [],
      recommendations: sessionId ? buildRecommendations(db, sessionId) : []
    });
  });

  app.post("/api/intersect", async (req, res) => {
    const nodeId1 = String(req.body?.nodeId1 ?? "").trim();
    const nodeId2 = String(req.body?.nodeId2 ?? "").trim();

    if (!nodeId1 || !nodeId2) {
      return res.status(400).json({ error: "nodeId1 and nodeId2 required" });
    }

    const node1 = db.data.nodes.find((node) => node.id === nodeId1);
    const node2 = db.data.nodes.find((node) => node.id === nodeId2);
    if (!node1 || !node2) return res.status(404).json({ error: "node not found" });

    if (!openaiClient) {
      return res.json({
        bridge_concepts: [],
        reasoning: `${node1.label} and ${node2.label} need OpenAI configured to generate bridge concepts.`
      });
    }

    const result = await requestStructuredJson(openaiClient, {
      model: "gpt-4o-mini",
      label: "Intersection discovery",
      timeoutMs: 15000,
      temperature: 0.2,
      max_completion_tokens: 220,
      messages: [
        {
          role: "system",
          content: 'Return only JSON: {"bridge_concepts":["concept1"],"reasoning":"..."}'
        },
        {
          role: "user",
          content: `How do "${node1.label}" (${node1.type}) and "${node2.label}" (${node2.type}) relate?`
        }
      ]
    }).catch(() => null);

    res.json(result ?? {
      bridge_concepts: [],
      reasoning: `A bridge between ${node1.label} and ${node2.label} could not be generated right now.`
    });
  });

  app.post("/api/learn-more", async (req, res) => {
    const label = String(req.body?.label ?? "").trim();
    const type = String(req.body?.type ?? "").trim();
    const upstream = Array.isArray(req.body?.upstream) ? req.body.upstream : [];
    const downstream = Array.isArray(req.body?.downstream) ? req.body.downstream : [];

    if (!label || !type) {
      return res.status(400).json({ error: "label and type required" });
    }

    if (!openaiClient) {
      return res.json({
        content: `${label} is a ${type} in your graph. Upstream concepts: ${upstream.join(", ") || "none"}. Downstream concepts: ${downstream.join(", ") || "none"}.`
      });
    }

    const content = await requestText(openaiClient, {
      model: "gpt-4o-mini",
      label: "Learn more",
      timeoutMs: 14000,
      temperature: 0.4,
      max_completion_tokens: 260,
      messages: [
        {
          role: "user",
          content: `Explain "${label}" in about 100 words.
Context: ${type} node. Upstream: ${upstream.join(", ") || "none"}. Downstream: ${downstream.join(", ") || "none"}.
Briefly explain what it is, why it matters, and how it fits into the graph.`
        }
      ]
    }).catch(() => null);

    res.json({
      content: content ?? `A short explanation for ${label} could not be generated right now.`
    });
  });

  if (staticDir && existsSync(staticDir)) {
    app.use(express.static(staticDir, {
      index: false,
      maxAge: "1h",
      setHeaders(res, path) {
        if (path.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-cache");
        }
      }
    }));

    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
      res.sendFile(join(staticDir, "index.html"));
    });
  }

  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
