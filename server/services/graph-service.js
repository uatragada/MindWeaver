import { nanoid } from "nanoid";
import { createDefaultData } from "../db.js";
import { DEFAULT_LOCAL_MODEL, normalizeLlmSelection } from "../openai.js";
import * as shared from "./shared-service.js";

const {
  CHAT_IMPORT_NODE_TYPE_PRIORITY,
  CHAT_IMPORT_PROVIDERS,
  CHAT_IMPORT_SCHEMA_VERSION,
  DAY_MS,
  HIERARCHY_NODE_TYPES,
  LOW_CONFIDENCE_THRESHOLD,
  REVIEW_INTERVALS_DAYS,
  SEMANTIC_ROLE_ORDER,
  SEMANTIC_ROLE_TYPES,
  USER_CREATABLE_NODE_TYPES,
  addSessionMembership,
  getEdgeReview,
  getNodeReview,
  getSourceTypeLabel,
  hasSessionMembership,
  isEdgeRejectedForSession,
  isRejectedForSession,
  normalizeLabel,
  normalizeUrl,
  setNodeReview,
  sanitizeNodeLabelForType
} = shared;
const MAX_NODE_NOTE_LENGTH = 20000;

function createSessionNode(db, {
  type,
  label,
  createdBy = "user",
  verified = false,
  confidence = verified ? 1 : createdBy === "ai" ? 0.7 : 0.92,
  sessionId,
  description = "",
  sourceType = null,
  artifactId = null,
  reason = null
} = {}) {
  const safeLabel = sanitizeNodeLabelForType(type, label);
  if (!safeLabel) return null;

  return ensureNode(db, `${type}:${nanoid()}`, safeLabel, type, {
    createdBy,
    verified,
    confidence,
    sessionId,
    description,
    sourceType,
    artifactId,
    reason
  });
}

function normalizeRoleValue(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isSemanticRoleType(role) {
  return SEMANTIC_ROLE_TYPES.has(normalizeRoleValue(role));
}

function compareSemanticRoleOrder(left, right) {
  const leftIndex = SEMANTIC_ROLE_ORDER.indexOf(normalizeRoleValue(left));
  const rightIndex = SEMANTIC_ROLE_ORDER.indexOf(normalizeRoleValue(right));
  return (leftIndex >= 0 ? leftIndex : 99) - (rightIndex >= 0 ? rightIndex : 99);
}

function getNodePrimaryRole(node, fallbackType = node?.type) {
  return normalizeRoleValue(node?.primaryRole) || normalizeRoleValue(fallbackType) || null;
}

function getNodeSecondaryRoles(node, primaryRole = getNodePrimaryRole(node, node?.type)) {
  const seen = new Set();
  const roles = [];
  for (const rawRole of [
    ...(Array.isArray(node?.secondaryRoles) ? node.secondaryRoles : []),
    ...(Array.isArray(node?.roles) ? node.roles : [])
  ]) {
    const role = normalizeRoleValue(rawRole);
    if (!isSemanticRoleType(role) || role === primaryRole || seen.has(role)) continue;
    seen.add(role);
    roles.push(role);
  }
  return roles.sort((left, right) => compareSemanticRoleOrder(left, right) || left.localeCompare(right));
}

function getNodeRoleList(node, fallbackType = node?.type) {
  const primaryRole = getNodePrimaryRole(node, fallbackType);
  const secondaryRoles = getNodeSecondaryRoles(node, primaryRole);
  return primaryRole ? [primaryRole, ...secondaryRoles] : secondaryRoles;
}

function normalizeNodeNoteContent(content) {
  return String(content ?? "").replace(/\r\n?/g, "\n");
}

function normalizeStoredSessionNotes(sessionNotes) {
  const normalized = {};

  for (const [rawSessionId, rawNote] of Object.entries(sessionNotes ?? {})) {
    const sessionId = String(rawSessionId ?? "").trim();
    if (!sessionId || !rawNote || typeof rawNote !== "object") continue;

    const content = normalizeNodeNoteContent(rawNote.content);
    if (!content.trim()) continue;

    const createdAt = Number.isFinite(rawNote.createdAt) ? rawNote.createdAt : null;
    const updatedAt = Number.isFinite(rawNote.updatedAt) ? rawNote.updatedAt : createdAt;
    normalized[sessionId] = {
      content,
      createdAt,
      updatedAt
    };
  }

  return normalized;
}

function getSessionNodeNote(node, sessionId) {
  const safeSessionId = String(sessionId ?? "").trim();
  if (!safeSessionId) return null;

  const rawNote = node?.sessionNotes?.[safeSessionId];
  if (!rawNote || typeof rawNote !== "object") return null;

  const content = normalizeNodeNoteContent(rawNote.content);
  if (!content.trim()) return null;

  return {
    content,
    createdAt: Number.isFinite(rawNote.createdAt) ? rawNote.createdAt : null,
    updatedAt: Number.isFinite(rawNote.updatedAt) ? rawNote.updatedAt : Number.isFinite(rawNote.createdAt) ? rawNote.createdAt : null
  };
}

function setSessionNodeNote(node, sessionId, content) {
  const safeSessionId = String(sessionId ?? "").trim();
  if (!safeSessionId) return "unchanged";

  const nextContent = normalizeNodeNoteContent(content);
  const existing = getSessionNodeNote(node, safeSessionId);

  if (!nextContent.trim()) {
    if (!existing) return "unchanged";
    if (node.sessionNotes) {
      delete node.sessionNotes[safeSessionId];
      if (!Object.keys(node.sessionNotes).length) delete node.sessionNotes;
    }
    return "cleared";
  }

  if (existing?.content === nextContent) return "unchanged";

  const now = Date.now();
  node.sessionNotes ||= {};
  node.sessionNotes[safeSessionId] = {
    content: nextContent,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  return existing ? "updated" : "added";
}

function mergeSessionNodeNotes(target, source, sessionId) {
  const sourceNote = getSessionNodeNote(source, sessionId);
  if (!sourceNote) return;

  const targetNote = getSessionNodeNote(target, sessionId);
  if (!targetNote) {
    target.sessionNotes ||= {};
    target.sessionNotes[sessionId] = {
      content: sourceNote.content,
      createdAt: sourceNote.createdAt ?? Date.now(),
      updatedAt: sourceNote.updatedAt ?? sourceNote.createdAt ?? Date.now()
    };
  } else if (targetNote.content !== sourceNote.content) {
    setSessionNodeNote(
      target,
      sessionId,
      `${targetNote.content}\n\n---\n\nMerged note from ${source.label}:\n\n${sourceNote.content}`
    );
  }

  if (source.sessionNotes) {
    delete source.sessionNotes[sessionId];
    if (!Object.keys(source.sessionNotes).length) delete source.sessionNotes;
  }
}

function buildEntityIdFromCanonicalLabel(canonicalLabel) {
  const safeCanonicalLabel = normalizeLabel(canonicalLabel);
  return safeCanonicalLabel ? `entity:${safeCanonicalLabel}` : null;
}

function getNodeSemanticKey(node) {
  const primaryRole = getNodePrimaryRole(node, node?.type);
  if (!isSemanticRoleType(primaryRole)) return null;
  const canonicalLabel = node?.canonicalLabel || normalizeLabel(node?.label);
  return node?.entityId || buildEntityIdFromCanonicalLabel(canonicalLabel);
}

function syncNodeSemanticIdentity(node, { primaryRole = null, secondaryRoles = null } = {}) {
  const resolvedPrimaryRole = normalizeRoleValue(primaryRole) || getNodePrimaryRole(node, node?.type);
  const canonicalLabel = node?.canonicalLabel || normalizeLabel(node?.label);
  if (canonicalLabel) node.canonicalLabel = canonicalLabel;

  if (!isSemanticRoleType(resolvedPrimaryRole)) {
    node.primaryRole = resolvedPrimaryRole || normalizeRoleValue(node?.type) || null;
    node.secondaryRoles = [];
    node.entityId = null;
    return node;
  }

  const mergedSecondaryRoles = [];
  const seen = new Set();
  for (const rawRole of [
    ...(Array.isArray(secondaryRoles) ? secondaryRoles : []),
    ...(Array.isArray(node?.secondaryRoles) ? node.secondaryRoles : []),
    ...(Array.isArray(node?.roles) ? node.roles : [])
  ]) {
    const role = normalizeRoleValue(rawRole);
    if (!isSemanticRoleType(role) || role === resolvedPrimaryRole || seen.has(role)) continue;
    seen.add(role);
    mergedSecondaryRoles.push(role);
  }

  mergedSecondaryRoles.sort((left, right) => compareSemanticRoleOrder(left, right) || left.localeCompare(right));
  node.primaryRole = resolvedPrimaryRole;
  node.secondaryRoles = mergedSecondaryRoles;
  node.type = resolvedPrimaryRole;
  node.entityId = buildEntityIdFromCanonicalLabel(canonicalLabel);
  return node;
}

function addNodeRole(node, role, { preferAsPrimary = false } = {}) {
  const safeRole = normalizeRoleValue(role);
  if (!isSemanticRoleType(safeRole)) {
    return syncNodeSemanticIdentity(node, {
      primaryRole: node?.primaryRole ?? node?.type,
      secondaryRoles: node?.secondaryRoles ?? []
    });
  }

  const currentPrimaryRole = getNodePrimaryRole(node, node?.type);
  const nextPrimaryRole = preferAsPrimary || !isSemanticRoleType(currentPrimaryRole)
    ? safeRole
    : currentPrimaryRole;

  return syncNodeSemanticIdentity(node, {
    primaryRole: nextPrimaryRole,
    secondaryRoles: [
      ...getNodeSecondaryRoles(node, currentPrimaryRole),
      currentPrimaryRole,
      safeRole
    ]
  });
}

function countSessionEvidenceForNode(node, sessionId) {
  return (node?.sources ?? []).filter((source) => source.sessionId === sessionId).length;
}

function compareNodesForSemanticReuse(left, right, sessionId) {
  return countSessionEvidenceForNode(right, sessionId) - countSessionEvidenceForNode(left, sessionId)
    || ((right?.confidence ?? 0) - (left?.confidence ?? 0))
    || Number(Boolean(right?.verified)) - Number(Boolean(left?.verified))
    || ((left?.createdAt ?? 0) - (right?.createdAt ?? 0))
    || String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

function findSessionSemanticNode(db, sessionId, semanticKey, { excludeNodeId = null } = {}) {
  if (!sessionId || !semanticKey) return null;

  const matches = db.data.nodes
    .filter((node) => node.id !== excludeNodeId && hasSessionMembership(node, sessionId) && getNodeSemanticKey(node) === semanticKey)
    .sort((left, right) => compareNodesForSemanticReuse(left, right, sessionId));

  return matches.find((node) => !isRejectedForSession(node, sessionId)) ?? matches[0] ?? null;
}

function buildSessionSemanticMergeOperations(db, sessionId) {
  const groups = new Map();

  for (const node of db.data.nodes) {
    if (!hasSessionMembership(node, sessionId) || isRejectedForSession(node, sessionId)) continue;
    const semanticKey = getNodeSemanticKey(node);
    if (!semanticKey) continue;
    const group = groups.get(semanticKey) ?? [];
    group.push(node);
    groups.set(semanticKey, group);
  }

  return Array.from(groups.values()).flatMap((group) => {
    if (group.length < 2) return [];
    const [target, ...sources] = [...group].sort((left, right) => compareNodesForSemanticReuse(left, right, sessionId));
    return sources.map((source) => ({
      sourceId: source.id,
      targetId: target.id,
      reason: `Exact semantic duplicate "${source.label}" found in this map with a different role.`
    }));
  });
}

function applyStoredSemanticDuplicateCleanup(data) {
  const db = { data };
  for (const session of data.sessions ?? []) {
    const sessionId = String(session?.id ?? "").trim();
    if (!sessionId) continue;
    const mergeOps = buildSessionSemanticMergeOperations(db, sessionId);
    for (const operation of mergeOps) {
      mergeNodeIntoTarget(db, sessionId, operation.sourceId, operation.targetId);
    }
  }
}

function getDefaultRelationshipType(parentType, childType) {
  if (parentType === "root" && childType === "goal") return "pursues";
  if (parentType === "goal" && childType === "area") return "focuses_on";
  if (parentType === "goal" && childType === "domain") return "focuses_on";
  if (parentType === "area" && childType === "domain") return "contains";
  if (parentType === "domain" && childType === "topic") return "contains";
  if (parentType === "topic" && childType === "skill") return "contains";
  if (parentType === "domain" && childType === "skill") return "contains";
  if (parentType === "skill" && childType === "concept") return "builds_on";
  if (childType === "concept") return parentType === "skill" ? "builds_on" : "contains";
  return childType === "goal" ? "pursues" : "contains";
}

function sanitizeShortList(values, { maxItems = 8, maxLength = 180, excluded = [] } = {}) {
  if (!Array.isArray(values)) return [];
  const excludedSet = new Set(excluded.map((value) => normalizeLabel(value)).filter(Boolean));
  const output = [];
  const seen = new Set();

  for (const rawValue of values) {
    const value = String(rawValue ?? "").trim().slice(0, maxLength);
    const normalized = normalizeLabel(value);
    if (!value || !normalized || excludedSet.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(value);
    if (output.length >= maxItems) break;
  }

  return output;
}

function pickPreferredChatImportDescription(currentValue, nextValue) {
  const current = String(currentValue ?? "").trim();
  const next = String(nextValue ?? "").trim();
  return next.length > current.length ? next : current;
}

function mergeChatImportNode(existingNode, nextNode) {
  const existingTypeScore = CHAT_IMPORT_NODE_TYPE_PRIORITY[existingNode.type] ?? 0;
  const nextTypeScore = CHAT_IMPORT_NODE_TYPE_PRIORITY[nextNode.type] ?? 0;

  return {
    type: nextTypeScore > existingTypeScore ? nextNode.type : existingNode.type,
    label: existingNode.label,
    description: pickPreferredChatImportDescription(existingNode.description, nextNode.description),
    confidence: Math.max(existingNode.confidence, nextNode.confidence),
    aliases: sanitizeShortList([...existingNode.aliases, ...nextNode.aliases], {
      maxItems: 12,
      maxLength: 100,
      excluded: [existingNode.label]
    }),
    evidence: sanitizeShortList([...existingNode.evidence, ...nextNode.evidence], {
      maxItems: 8,
      maxLength: 220
    })
  };
}

function buildChatImportWarnings(warningCounts) {
  const warnings = [];

  if (warningCounts.invalidNodes) warnings.push(`Skipped ${warningCounts.invalidNodes} invalid node${warningCounts.invalidNodes === 1 ? "" : "s"}.`);
  if (warningCounts.duplicateNodes) warnings.push(`Merged ${warningCounts.duplicateNodes} duplicate node label${warningCounts.duplicateNodes === 1 ? "" : "s"} after normalization.`);
  if (warningCounts.invalidRelationships) warnings.push(`Skipped ${warningCounts.invalidRelationships} invalid relationship${warningCounts.invalidRelationships === 1 ? "" : "s"}.`);
  if (warningCounts.relationshipsMissingNodes) warnings.push(`Skipped ${warningCounts.relationshipsMissingNodes} relationship${warningCounts.relationshipsMissingNodes === 1 ? "" : "s"} that referenced missing nodes.`);
  if (warningCounts.selfRelationships) warnings.push(`Skipped ${warningCounts.selfRelationships} self-link relationship${warningCounts.selfRelationships === 1 ? "" : "s"}.`);
  if (warningCounts.invalidHighlights) warnings.push(`Skipped ${warningCounts.invalidHighlights} invalid conversation highlight${warningCounts.invalidHighlights === 1 ? "" : "s"}.`);

  return warnings;
}

function buildChatHistoryImportPrompt({ provider = "chatgpt", sessionGoal = "" } = {}) {
  const safeProvider = CHAT_IMPORT_PROVIDERS.has(provider) ? provider : "chatgpt";
  const providerLabel = safeProvider === "claude" ? "Claude" : safeProvider === "chatgpt" ? "ChatGPT" : "your AI assistant";
  const goalCopy = sessionGoal ? `"${sessionGoal}"` : "the user's current knowledge map";

  return `You are preparing a structured export for MindWeaver, a local knowledge-map app.

Use only the conversation history and memory you already have from this user, but sweep as broadly and deeply as possible across ALL CONVERSATIONS you can access.

Goal: import as much useful user context as possible into MindWeaver. Be aggressively comprehensive and wide-ranging. Pull from old conversations, recent conversations, repeated threads, one-off but important breakthroughs, active projects, past projects that still matter, recurring questions, tools, frameworks, domains, habits, preferences, misconceptions, constraints, goals, and specialized vocabulary.

The export should capture everything durable or still-relevant that you know about the user, not just a small sample. If the user has discussed multiple areas over time, include all of them. If they have revisited the same topic from different angles, preserve that breadth. If they seem to have strong preferences, repeated workflows, favorite stacks, or recurring pain points, include those too.

Target map: ${goalCopy}
Source provider: ${providerLabel}

Rules:
- Return valid JSON only.
- Do not wrap the response in markdown fences.
- Use this exact schema_version: "${CHAT_IMPORT_SCHEMA_VERSION}".
- Set provider to "${safeProvider}".
- Keep labels concise, specific, and lower-case.
- Keep labels unique across all nodes.
- Be as detailed as possible while staying structured and useful.
- Be as wide-ranging as possible across the user's full conversation history.
- Prefer recall coverage over minimalism.
- Include one-off items if they appear important, identity-shaping, project-critical, or frequently revisited later.
- Avoid secrets, credentials, private personal data, or raw transcript dumps.
- If unsure, omit the node instead of inventing one.

Allowed node types:
- "area"
- "domain"
- "topic"
- "skill"
- "concept"

Allowed relationship types:
- "contains"
- "builds_on"
- "prerequisite"
- "related"
- "contrasts"
- "supports"
- "needs"
- "focuses_on"

Requirements:
- title: short name for the import
- summary: 4-8 sentences and as comprehensive as needed
- conversation_highlights: include as many durable threads and patterns as are useful
- nodes: include every meaningful area, domain, topic, skill, and concept you can justify from the user's history
- relationships: connect the node labels you created
- relationships: include as many meaningful links as needed to preserve structure and breadth
- area = broad umbrella, domain = major field, topic = subarea within a domain, skill = applied capability, concept = atomic knowledge unit.
- Each domain should connect to an area when possible.
- Each topic should connect to a domain when possible.
- Each skill should connect to a topic or domain when possible.
- Each concept should connect to a skill or topic when possible.
- confidence must be a number between 0.55 and 0.95.
- evidence should be grounded in the conversation history.
- Cover all meaningful domains of knowledge you know about this user, not just the most recent one.
- When in doubt, add another relevant node rather than collapsing distinct user interests together.

Return this JSON shape:
{
  "schema_version": "${CHAT_IMPORT_SCHEMA_VERSION}",
  "provider": "${safeProvider}",
  "title": "short import title",
  "summary": "comprehensive summary of the user's interests, goals, preferences, recurring topics, and active context",
  "conversation_highlights": [
    {
      "title": "short highlight title",
      "summary": "why this thread or pattern matters",
      "concepts": ["concept label"]
    }
  ],
  "nodes": [
    {
      "type": "area",
      "label": "distributed systems",
      "description": "The user repeatedly explores asynchronous architectures and event flow tradeoffs.",
      "confidence": 0.88,
      "aliases": ["event systems"],
      "evidence": ["Asked repeated questions about brokers, consumers, and delivery guarantees."]
    }
  ],
  "relationships": [
    {
      "source": "distributed systems",
      "target": "event handling",
      "type": "contains",
      "label": "contains"
    }
  ]
}`;
}

function buildGraphContext(db) {
  const areas = db.data.nodes.filter((node) => node.type === "area").map((node) => `"${node.label}"`);
  const domains = db.data.nodes.filter((node) => node.type === "domain").map((node) => `"${node.label}"`);
  const topics = db.data.nodes.filter((node) => node.type === "topic").map((node) => `"${node.label}"`);
  const skills = db.data.nodes.filter((node) => node.type === "skill").map((node) => `"${node.label}"`);
  const concepts = db.data.nodes.filter((node) => node.type === "concept").map((node) => `"${node.label}"`);
  const sampleEdges = db.data.edges.slice(0, 8).map((edge) => `${edge.source} -[${edge.type}]-> ${edge.target}`);

  return `
EXISTING GRAPH STATE:
Areas (${areas.length}): ${areas.join(", ") || "none"}
Domains (${domains.length}): ${domains.join(", ") || "none"}
Topics (${topics.length}): ${topics.join(", ") || "none"}
Skills (${skills.length}): ${skills.join(", ") || "none"}
Concepts (${concepts.length}): ${concepts.join(", ") || "none"}

Sample edges: ${sampleEdges.join("; ") || "none"}

PREFERRED HIERARCHY:
Goal -> Area -> Domain -> Topic -> Skill -> Concept
The graph can stay flexible, but when hierarchy is clear, use that ordering.
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
    summary = "",
    sourceType = null,
    artifactId = null,
    reason = null,
    primaryRole = null,
    secondaryRoles = []
  } = options;

  const canonicalLabel = normalizeLabel(label);
  const semanticKey = buildEntityIdFromCanonicalLabel(canonicalLabel);
  let existing = db.data.nodes.find((node) => node.id === id);
  if (!existing && sessionId && isSemanticRoleType(type) && semanticKey) {
    existing = findSessionSemanticNode(db, sessionId, semanticKey, { excludeNodeId: id });
  }

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
      summary,
      createdAt: Date.now(),
      sessionIds: sessionId ? [sessionId] : [],
      sessionReviews: {},
      history: []
    };
    syncNodeSemanticIdentity(existing, {
      primaryRole: primaryRole ?? type,
      secondaryRoles
    });
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
    existing.aliases ||= [];
    ensureReviewSchedule(existing, existing.confidence);
    addSessionMembership(existing, sessionId);
    if (summary && !existing.summary) existing.summary = summary;
  }

  if (isSemanticRoleType(type)) {
    addNodeRole(existing, primaryRole ?? type);
    if (Array.isArray(secondaryRoles) && secondaryRoles.length) {
      syncNodeSemanticIdentity(existing, {
        primaryRole: existing.primaryRole ?? existing.type,
        secondaryRoles: [...(existing.secondaryRoles ?? []), ...secondaryRoles]
      });
    }
  } else {
    syncNodeSemanticIdentity(existing, {
      primaryRole: existing.primaryRole ?? existing.type,
      secondaryRoles: existing.secondaryRoles ?? []
    });
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
  if (!source || !target || source === target) return null;
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

function createGoalForSession(db, sessionId, title, description = "", { syncWithMapName = false } = {}) {
  const existing = getSessionGoal(db, sessionId);
  if (existing || !title) return existing;

  const goalId = `goal:${nanoid()}`;
  const goal = {
    id: goalId,
    sessionId,
    title,
    description,
    syncWithMapName,
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

function renameSessionMap(db, sessionId, nextMapNameRaw) {
  const session = getSession(db, sessionId);
  if (!session) {
    return { ok: false, error: "session not found" };
  }

  const previousMapName = String(session.goal ?? "").trim();
  const nextMapName = String(nextMapNameRaw ?? "").trim();
  session.goal = nextMapName || null;

  let updatedPrimaryGoalNode = false;
  const storedGoal = getSessionGoal(db, sessionId);
  const storedGoalNode = storedGoal
    ? db.data.nodes.find((node) => node.id === storedGoal.id && hasSessionMembership(node, sessionId))
    : null;
  const shouldSyncPrimaryGoal = Boolean(
    nextMapName
    && storedGoal
    && (storedGoal.syncWithMapName === true || storedGoal.syncWithMapName === undefined)
    && (
      String(storedGoal.title ?? "").trim() === previousMapName
      || String(storedGoalNode?.label ?? "").trim() === previousMapName
    )
  );

  if (shouldSyncPrimaryGoal) {
    storedGoal.title = nextMapName;
    if (storedGoalNode) {
      storedGoalNode.aliases ||= [];
      if (previousMapName && previousMapName !== nextMapName && !storedGoalNode.aliases.includes(previousMapName)) {
        storedGoalNode.aliases.push(previousMapName);
      }
      storedGoalNode.label = nextMapName;
      storedGoalNode.canonicalLabel = normalizeLabel(nextMapName);
      addHistoryEntry(storedGoalNode, {
        kind: "map-renamed",
        sessionId,
        summary: `Map renamed from "${previousMapName || "Untitled map"}" to "${nextMapName}".`
      });
    }
    updatedPrimaryGoalNode = true;
  }

  return {
    ok: true,
    session,
    updatedPrimaryGoalNode
  };
}

function findPreferredParentNode(db, sessionId, type) {
  const visibleNodes = findVisibleSessionNodes(db, sessionId);
  const sessionRootNode = db.data.nodes.find((node) => node.id === `session:${sessionId}` && hasSessionMembership(node, sessionId)) ?? null;
  const findVisibleByTypes = (...types) => {
    for (const candidateType of types) {
      const match = visibleNodes.find((node) => node.type === candidateType);
      if (match) return match;
    }
    return null;
  };

  if (type === "goal") {
    return sessionRootNode;
  }

  if (type === "area") {
    return sessionRootNode;
  }

  if (type === "domain") {
    return findVisibleByTypes("area") ?? sessionRootNode;
  }

  if (type === "topic") {
    return findVisibleByTypes("domain", "area") ?? sessionRootNode;
  }

  if (type === "skill") {
    return findVisibleByTypes("topic", "domain", "area") ?? sessionRootNode;
  }

  if (type === "concept") {
    return findVisibleByTypes("skill", "topic", "domain", "area") ?? sessionRootNode;
  }

  return null;
}

function findVisibleSessionNodes(db, sessionId) {
  return db.data.nodes.filter((node) => hasSessionMembership(node, sessionId) && !isRejectedForSession(node, sessionId));
}

function buildWhyThisExists(node, sessionId) {
  const secondaryRoles = getNodeSecondaryRoles(node);
  const roleNote = secondaryRoles.length
    ? ` It also acts as ${secondaryRoles.join(", ")} in this map.`
    : "";
  const sources = (node.sources ?? []).filter((source) => source.sessionId === sessionId);
  if (sources.length) {
    const latest = [...sources].sort((left, right) => right.addedAt - left.addedAt)[0];
    return `${sources.length} evidence source${sources.length === 1 ? "" : "s"} support this node. Latest: ${latest.title}.${roleNote}`;
  }

  if (node.createdBy === "user") {
    return `This node came directly from your goal, manual note, or review action.${roleNote}`;
  }

  return `This node was inferred by the classifier and still needs stronger evidence or review.${roleNote}`;
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
  const note = getSessionNodeNote(node, sessionId);
  const primaryRole = getNodePrimaryRole(node, node.type);
  const secondaryRoles = getNodeSecondaryRoles(node, primaryRole);
  const roles = primaryRole ? [primaryRole, ...secondaryRoles] : secondaryRoles;
  const history = (node.history ?? [])
    .filter((event) => !event.sessionId || event.sessionId === sessionId)
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 8)
    .map(({ dedupeKey, ...event }) => event);

  return {
    ...node,
    primaryRole,
    secondaryRoles,
    roles,
    roleSummary: secondaryRoles.length ? `${primaryRole} + ${secondaryRoles.join(", ")}` : primaryRole,
    entityId: getNodeSemanticKey(node),
    sources,
    history,
    evidenceCount: sources.length,
    note: note?.content ?? "",
    hasNote: Boolean(note?.content),
    noteCreatedAt: note?.createdAt ?? null,
    noteUpdatedAt: note?.updatedAt ?? null,
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

function normalizeStoredIdList(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
  ));
}

function normalizeStoredNodeRecord(node) {
  const safeNode = {
    ...(node ?? {}),
    aliases: Array.isArray(node?.aliases)
      ? Array.from(new Set(node.aliases.map((alias) => String(alias ?? "").trim()).filter(Boolean)))
      : [],
    sessionIds: normalizeStoredIdList(node?.sessionIds),
    sessionReviews: node?.sessionReviews && typeof node.sessionReviews === "object" ? node.sessionReviews : {},
    sessionNotes: normalizeStoredSessionNotes(node?.sessionNotes),
    history: Array.isArray(node?.history) ? node.history : []
  };

  safeNode.canonicalLabel ||= normalizeLabel(safeNode.label);
  return syncNodeSemanticIdentity(safeNode, {
    primaryRole: safeNode.primaryRole ?? safeNode.type,
    secondaryRoles: safeNode.secondaryRoles ?? []
  });
}

function normalizeStoredEdgeRecord(edge) {
  const safeEdge = {
    ...(edge ?? {}),
    sessionIds: normalizeStoredIdList(edge?.sessionIds),
    sessionReviews: edge?.sessionReviews && typeof edge.sessionReviews === "object" ? edge.sessionReviews : {}
  };

  if (!safeEdge.key && safeEdge.source && safeEdge.type && safeEdge.target) {
    rebuildEdgeKey(safeEdge);
  }

  return safeEdge;
}

function sanitizeDataShape(data) {
  const defaults = createDefaultData();
  const sanitized = {
    ...defaults,
    ...data,
    sessions: Array.isArray(data?.sessions) ? data.sessions : [],
    goals: Array.isArray(data?.goals) ? data.goals : [],
    nodes: Array.isArray(data?.nodes) ? data.nodes.map((node) => normalizeStoredNodeRecord(node)) : [],
    edges: Array.isArray(data?.edges) ? data.edges.map((edge) => normalizeStoredEdgeRecord(edge)) : [],
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

  applyStoredSemanticDuplicateCleanup(sanitized);
  sanitized.nodes = sanitized.nodes.map((node) => normalizeStoredNodeRecord(node));
  sanitized.edges = sanitized.edges
    .map((edge) => normalizeStoredEdgeRecord(edge))
    .filter((edge) => edge.source && edge.target && (edge.sessionIds ?? []).length > 0);
  return sanitized;
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
  if (!target.description && source.description) target.description = source.description;
  if (!target.summary && source.summary) target.summary = source.summary;
  mergeSessionNodeNotes(target, source, sessionId);
  syncNodeSemanticIdentity(target, {
    primaryRole: target.primaryRole ?? target.type,
    secondaryRoles: [
      ...(target.secondaryRoles ?? []),
      getNodePrimaryRole(source, source.type),
      ...getNodeSecondaryRoles(source)
    ]
  });

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

  const notes = graph.nodes
    .filter((node) => node.note)
    .sort((left, right) => String(left.label ?? "").localeCompare(String(right.label ?? "")))
    .map((node) => ({
      id: node.id,
      label: node.label,
      type: node.type,
      note: node.note,
      updatedAt: node.noteUpdatedAt
    }));

  const nodes = graph.nodes
    .filter((node) => HIERARCHY_NODE_TYPES.includes(node.type) || node.type === "goal")
    .sort((left, right) => String(left.label ?? "").localeCompare(String(right.label ?? "")))
    .map((node) => ({
      id: node.id,
      label: node.label,
      type: node.type,
      primaryRole: node.primaryRole,
      secondaryRoles: node.secondaryRoles,
      confidence: node.confidence ?? 0,
      evidenceCount: node.evidenceCount ?? 0,
      whyThisExists: node.whyThisExists,
      note: node.note || "",
      noteUpdatedAt: node.noteUpdatedAt
    }));
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
      note: node.note || "",
      noteUpdatedAt: node.noteUpdatedAt,
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
    nodes,
    concepts,
    notes,
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
    `- Nodes: ${exportData.summary.nodeCount}`,
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

  lines.push("", "## Hierarchy Nodes", "");
  if (exportData.nodes?.length) {
    lines.push("| Label | Type | Confidence | Evidence |", "| --- | --- | ---: | ---: |");
    for (const node of exportData.nodes) {
      lines.push(`| ${escapeMarkdown(node.label)} | ${escapeMarkdown(node.type)} | ${Math.round((node.confidence ?? 0) * 100)}% | ${node.evidenceCount ?? 0} |`);
    }
  } else {
    lines.push("No hierarchy nodes have been captured yet.");
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

  if (exportData.notes?.length) {
    lines.push("", "## Node Notes", "");
    for (const note of exportData.notes) {
      lines.push(`### ${escapeMarkdown(note.label)} (${escapeMarkdown(note.type)})`, "");
      if (note.updatedAt) {
        lines.push(`_Updated: ${new Date(note.updatedAt).toLocaleString()}_`, "");
      }
      lines.push(note.note, "");
    }
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

function normalizeSessionIdList(values, validSessionIds = null, limit = 24) {
  const seen = new Set();
  const normalized = [];

  for (const rawValue of Array.isArray(values) ? values : []) {
    const sessionId = String(rawValue ?? "").trim();
    if (!sessionId || seen.has(sessionId)) continue;
    if (validSessionIds && !validSessionIds.has(sessionId)) continue;
    seen.add(sessionId);
    normalized.push(sessionId);
  }

  if (normalized.length <= limit) return normalized;
  return normalized.slice(normalized.length - limit);
}

function getUserPreferences(db) {
  db.data.preferences ||= {
    activeSessionId: null,
    lastSessionId: null,
    llmProvider: "openai",
    localLlmModel: DEFAULT_LOCAL_MODEL,
    openSessionIds: []
  };

  const hadStoredOpenSessionIds = Array.isArray(db.data.preferences.openSessionIds);
  const sessionIdsByRecency = [...db.data.sessions]
    .sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
    .map((session) => session.id);

  db.data.preferences.activeSessionId = String(db.data.preferences.activeSessionId ?? "").trim() || null;
  db.data.preferences.lastSessionId = String(db.data.preferences.lastSessionId ?? "").trim() || null;
  db.data.preferences.llmProvider = String(db.data.preferences.llmProvider ?? "").trim().toLowerCase() === "local" ? "local" : "openai";
  db.data.preferences.localLlmModel = String(db.data.preferences.localLlmModel ?? "").trim() || DEFAULT_LOCAL_MODEL;
  db.data.preferences.openSessionIds = normalizeSessionIdList(
    hadStoredOpenSessionIds ? db.data.preferences.openSessionIds : sessionIdsByRecency,
    new Set(sessionIdsByRecency)
  );
  return db.data.preferences;
}

function getStoredLlmSettings(db) {
  const preferences = getUserPreferences(db);
  return {
    provider: preferences.llmProvider,
    localModel: preferences.localLlmModel
  };
}

function setStoredLlmSettings(db, rawSelection) {
  const selection = normalizeLlmSelection(rawSelection);
  const preferences = getUserPreferences(db);
  preferences.llmProvider = selection.provider;
  preferences.localLlmModel = selection.provider === "local"
    ? selection.model
    : preferences.localLlmModel || DEFAULT_LOCAL_MODEL;
  return getStoredLlmSettings(db);
}

function resolveRequestLlmSelection(db, rawSelection) {
  if (rawSelection && typeof rawSelection === "object") {
    return normalizeLlmSelection(rawSelection);
  }

  const storedSettings = getStoredLlmSettings(db);
  return normalizeLlmSelection({
    provider: storedSettings.provider,
    model: storedSettings.localModel
  });
}

function buildStoredLocalModelHealthEntry(modelName) {
  const normalizedModel = String(modelName ?? "").trim();
  if (!normalizedModel) return null;

  return {
    value: normalizedModel,
    label: normalizedModel === DEFAULT_LOCAL_MODEL ? "Qwen3.5 4B" : normalizedModel,
    installed: false
  };
}

function mergeSelectedLocalModelHealth(models, selectedModel) {
  const availableModels = Array.isArray(models)
    ? models.filter((model) => String(model?.value ?? "").trim())
    : [];
  const selectedEntry = buildStoredLocalModelHealthEntry(selectedModel);

  if (!selectedEntry) return availableModels;
  if (availableModels.some((model) => model.value === selectedEntry.value)) return availableModels;
  return [selectedEntry, ...availableModels];
}

function repairSessionSelection(db) {
  const preferences = getUserPreferences(db);
  const sessionsByStartedAt = [...db.data.sessions].sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0));
  const sessionIds = new Set(sessionsByStartedAt.map((session) => session.id));

  preferences.openSessionIds = normalizeSessionIdList(preferences.openSessionIds, sessionIds);

  if (preferences.activeSessionId && !sessionIds.has(preferences.activeSessionId)) {
    preferences.activeSessionId = null;
  }

  if (preferences.lastSessionId && !sessionIds.has(preferences.lastSessionId)) {
    preferences.lastSessionId = sessionsByStartedAt[0]?.id ?? null;
  }

  if (!preferences.lastSessionId) {
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
    preferences.openSessionIds = normalizeSessionIdList([
      ...preferences.openSessionIds.filter((entry) => entry !== nextSessionId),
      nextSessionId
    ], new Set(db.data.sessions.map((session) => session.id)));
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
  const tabSessions = preferences.openSessionIds
    .map((sessionId) => getSession(db, sessionId))
    .filter(Boolean)
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
    tabSessions,
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

const SEARCH_STOP_WORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "be",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "map",
  "of",
  "on",
  "or",
  "should",
  "the",
  "this",
  "to",
  "what",
  "why",
  "with"
]);

function tokenizeSearchTerms(query) {
  return normalizeLabel(query)
    .split(" ")
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !SEARCH_STOP_WORDS.has(term));
}

function searchGraph(db, sessionId, query) {
  const q = normalizeLabel(query);
  if (!q) return { query, results: [] };
  const searchTerms = tokenizeSearchTerms(query);
  const scopedTerms = searchTerms.length ? searchTerms : [q];

  const graph = buildSessionGraph(db, sessionId);
  const results = [];

  for (const node of graph.nodes) {
    const haystack = normalizeLabel(`${node.label} ${node.description ?? ""} ${node.summary ?? ""} ${node.whyThisExists ?? ""}`);
    const phraseMatch = haystack.includes(q);
    const matchedTerms = scopedTerms.filter((term) => haystack.includes(term));
    if (!phraseMatch && matchedTerms.length === 0) continue;
    results.push({
      kind: "node",
      id: node.id,
      label: node.label,
      type: node.type,
      confidence: node.confidence ?? 0,
      masteryState: node.masteryState,
      evidenceCount: node.evidenceCount ?? 0,
      snippet: node.summary || node.whyThisExists,
      score: (phraseMatch ? 100 : 0) + matchedTerms.length
    });
  }

  for (const artifact of graph.artifacts) {
    const haystack = normalizeLabel(`${artifact.title} ${artifact.excerpt ?? ""} ${artifact.contentPreview ?? ""} ${artifact.sourceType ?? ""}`);
    const phraseMatch = haystack.includes(q);
    const matchedTerms = scopedTerms.filter((term) => haystack.includes(term));
    if (!phraseMatch && matchedTerms.length === 0) continue;
    results.push({
      kind: "source",
      id: artifact.id,
      label: artifact.title,
      type: artifact.sourceType || "page",
      confidence: artifact.ingestStatus === "classified" ? 0.8 : 0.5,
      evidenceCount: 1,
      snippet: artifact.excerpt || artifact.contentPreview,
      url: artifact.url,
      score: (phraseMatch ? 100 : 0) + matchedTerms.length
    });
  }

  return {
    query,
    results: results
      .sort((left, right) =>
        ((right.score ?? 0) - (left.score ?? 0))
        || (right.evidenceCount - left.evidenceCount)
        || ((right.confidence ?? 0) - (left.confidence ?? 0))
      )
      .slice(0, 20)
      .map(({ score, ...result }) => result)
  };
}


function deleteSessionData(db, sessionId) {
  const sessionExists = db.data.sessions.some((session) => session.id === sessionId);
  if (!sessionExists) return false;

  const preferences = getUserPreferences(db);

  db.data.sessions = db.data.sessions.filter((session) => session.id !== sessionId);
  db.data.goals = db.data.goals.filter((goal) => goal.sessionId !== sessionId);
  db.data.artifacts = db.data.artifacts.filter((artifact) => artifact.sessionId !== sessionId);
  db.data.verifications = db.data.verifications.filter((verification) => verification.sessionId !== sessionId);
  db.data.reports = (db.data.reports ?? []).filter((report) => report.sessionId !== sessionId);
  preferences.openSessionIds = preferences.openSessionIds.filter((id) => id !== sessionId);
  if (preferences.activeSessionId === sessionId) {
    preferences.activeSessionId = null;
  }
  if (preferences.lastSessionId === sessionId) {
    preferences.lastSessionId = null;
  }

  for (const node of db.data.nodes) {
    node.sessionIds = (node.sessionIds ?? []).filter((id) => id !== sessionId);
    if (node.sessionReviews) delete node.sessionReviews[sessionId];
    if (node.sessionNotes) {
      delete node.sessionNotes[sessionId];
      if (!Object.keys(node.sessionNotes).length) delete node.sessionNotes;
    }
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

export {
  MAX_NODE_NOTE_LENGTH,
  createSessionNode,
  getDefaultRelationshipType,
  sanitizeShortList,
  pickPreferredChatImportDescription,
  mergeChatImportNode,
  buildChatImportWarnings,
  buildChatHistoryImportPrompt,
  buildGraphContext,
  addHistoryEntry,
  ensureReviewSchedule,
  applyReviewOutcome,
  ensureNode,
  ensureEdge,
  ensureSource,
  getSession,
  getSessionGoal,
  createGoalForSession,
  renameSessionMap,
  findPreferredParentNode,
  findVisibleSessionNodes,
  buildWhyThisExists,
  getMasteryState,
  buildConceptSummary,
  getSessionNodeNote,
  setSessionNodeNote,
  serializeNodeForSession,
  serializeEdgeForSession,
  rebuildEdgeKey,
  sanitizeDataShape,
  deleteArtifactFromSession,
  mergeNodeIntoTarget,
  buildReviewQueue,
  buildRecommendedActions,
  buildRecommendations,
  calculateMapHealth,
  buildStudyPlan,
  buildSessionGraph,
  slugify,
  escapeMarkdown,
  buildSessionExport,
  buildMarkdownExport,
  buildSessionSummary,
  normalizeSessionIdList,
  getUserPreferences,
  getStoredLlmSettings,
  setStoredLlmSettings,
  resolveRequestLlmSelection,
  buildStoredLocalModelHealthEntry,
  mergeSelectedLocalModelHealth,
  repairSessionSelection,
  selectActiveSession,
  clearActiveSession,
  buildSessionTargetPayload,
  isAllowedCorsOrigin,
  getDefaultWorkspace,
  ensureSessionWorkspace,
  buildProgressReport,
  syncNodeSemanticIdentity,
  SEARCH_STOP_WORDS,
  tokenizeSearchTerms,
  searchGraph,
  deleteSessionData
};
