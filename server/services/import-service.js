import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import { normalizeLlmSelection, requestStructuredJson } from "../openai.js";
import * as shared from "./shared-service.js";
import * as graph from "./graph-service.js";
import * as learning from "./learning-service.js";
import * as refine from "./refine-service.js";

const {
  ALLOWED_SOURCE_TYPES,
  CHAT_IMPORT_NODE_TYPES,
  CHAT_IMPORT_PROVIDERS,
  CHAT_IMPORT_RELATIONSHIP_TYPES,
  CHAT_IMPORT_SCHEMA_VERSION,
  STRUCTURED_RESPONSE_SCHEMAS,
  buildLocalFocusedIngestExcerpt,
  buildLocalStructuredIngestExcerpt,
  clampConfidence,
  createSyntheticUrl,
  getLlmContentLimit,
  getMaxIngestContentChars,
  getSourceTypeLabel,
  hasSessionMembership,
  normalizeLabel,
  normalizeUrl,
  sanitizeNodeLabelForType
} = shared;

const {
  addHistoryEntry,
  buildChatHistoryImportPrompt,
  buildChatImportWarnings,
  buildGraphContext,
  buildRecommendedActions,
  createGoalForSession,
  createSessionNode,
  ensureEdge,
  ensureNode,
  ensureSource,
  findVisibleSessionNodes,
  getSession,
  getSessionGoal,
  mergeChatImportNode,
  sanitizeShortList
} = graph;

const {
  normalizeSourceClassificationPayload
} = learning;

const {
  applyAutomaticDuplicateCleanup,
  dedupeNodeReferences,
  resolveCanonicalNodeReference,
  resolveCanonicalSessionNodeId
} = refine;

function validateIngestPayload(body, { allowSyntheticUrl = false, llmProvider = null } = {}) {
  const errors = [];

  if (!body || typeof body !== "object") {
    return { ok: false, errors: ["Request body must be a JSON object."] };
  }

  const maxContentChars = getMaxIngestContentChars(llmProvider ?? body?.llmProvider);

  if (!String(body.sessionId ?? "").trim()) errors.push("sessionId is required.");
  if (!allowSyntheticUrl && !String(body.url ?? "").trim()) errors.push("url is required.");
  if (body.url && !normalizeUrl(body.url)) errors.push("url must be a valid absolute URL.");
  if (body.title !== undefined && typeof body.title !== "string") errors.push("title must be a string.");
  if (body.excerpt !== undefined && typeof body.excerpt !== "string") errors.push("excerpt must be a string.");
  if (body.content !== undefined && typeof body.content !== "string") errors.push("content must be a string.");
  if (body.sourceType !== undefined && typeof body.sourceType !== "string") errors.push("sourceType must be a string.");
  if (typeof body.sourceType === "string" && !ALLOWED_SOURCE_TYPES.has(body.sourceType.toLowerCase())) errors.push(`sourceType must be one of: ${[...ALLOWED_SOURCE_TYPES].join(", ")}.`);
  if (typeof body.content === "string" && body.content.length > maxContentChars) errors.push(`content must be ${maxContentChars} characters or less.`);

  return {
    ok: errors.length === 0,
    errors
  };
}

function validateChatHistoryImportPayload(body) {
  const errors = [];
  const warningCounts = {
    invalidNodes: 0,
    duplicateNodes: 0,
    invalidRelationships: 0,
    relationshipsMissingNodes: 0,
    selfRelationships: 0,
    invalidHighlights: 0
  };

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: ["importData must be a JSON object."] };
  }

  const schemaVersion = String(body.schema_version ?? "").trim();
  const provider = String(body.provider ?? "").trim().toLowerCase();
  const title = String(body.title ?? "").trim().slice(0, 160);
  const summary = String(body.summary ?? "").trim().slice(0, 4000);
  const nodesRaw = Array.isArray(body.nodes) ? body.nodes : [];
  const relationshipsRaw = Array.isArray(body.relationships) ? body.relationships : [];
  const highlightsRaw = Array.isArray(body.conversation_highlights) ? body.conversation_highlights : [];

  if (schemaVersion !== CHAT_IMPORT_SCHEMA_VERSION) {
    errors.push(`schema_version must be "${CHAT_IMPORT_SCHEMA_VERSION}".`);
  }

  if (!CHAT_IMPORT_PROVIDERS.has(provider)) {
    errors.push(`provider must be one of: ${[...CHAT_IMPORT_PROVIDERS].join(", ")}.`);
  }

  if (!title) errors.push("title is required.");
  if (!summary) errors.push("summary is required.");
  if (!nodesRaw.length) errors.push("nodes must contain at least one item.");

  const nodesByLabel = new Map();

  nodesRaw.forEach((rawNode, index) => {
    if (!rawNode || typeof rawNode !== "object" || Array.isArray(rawNode)) {
      warningCounts.invalidNodes += 1;
      return;
    }

    const type = String(rawNode.type ?? "").trim().toLowerCase();
    const label = normalizeLabel(rawNode.label);
    const description = String(rawNode.description ?? "").trim().slice(0, 520);
    const confidence = clampConfidence(Number(rawNode.confidence), type === "concept" ? 0.7 : 0.78);
    const aliases = sanitizeShortList(rawNode.aliases, { maxItems: 12, maxLength: 100, excluded: [label] });
    const evidence = sanitizeShortList(rawNode.evidence, { maxItems: 8, maxLength: 220 });

    if (!CHAT_IMPORT_NODE_TYPES.has(type)) {
      warningCounts.invalidNodes += 1;
      return;
    }

    if (!label) {
      warningCounts.invalidNodes += 1;
      return;
    }

    const nextNode = {
      type,
      label,
      description,
      confidence,
      aliases,
      evidence
    };
    if (nodesByLabel.has(label)) {
      warningCounts.duplicateNodes += 1;
      nodesByLabel.set(label, mergeChatImportNode(nodesByLabel.get(label), nextNode));
      return;
    }

    nodesByLabel.set(label, nextNode);
  });

  const nodes = [...nodesByLabel.values()];
  const labelSet = new Set(nodesByLabel.keys());
  if (!nodes.length) errors.push("nodes must contain at least one valid item.");

  const relationships = [];
  const relationshipSet = new Set();

  relationshipsRaw.forEach((rawRelationship, index) => {
    if (!rawRelationship || typeof rawRelationship !== "object" || Array.isArray(rawRelationship)) {
      warningCounts.invalidRelationships += 1;
      return;
    }

    const source = normalizeLabel(rawRelationship.source);
    const target = normalizeLabel(rawRelationship.target);
    const type = String(rawRelationship.type ?? "").trim().toLowerCase();
    const label = String(rawRelationship.label ?? type).trim().slice(0, 80) || type;

    if (!source || !target) {
      warningCounts.invalidRelationships += 1;
      return;
    }

    if (!CHAT_IMPORT_RELATIONSHIP_TYPES.has(type)) {
      warningCounts.invalidRelationships += 1;
      return;
    }

    if (!labelSet.has(source) || !labelSet.has(target)) {
      warningCounts.relationshipsMissingNodes += 1;
      return;
    }

    if (source === target) {
      warningCounts.selfRelationships += 1;
      return;
    }

    const dedupeKey = `${source}|${type}|${target}`;
    if (relationshipSet.has(dedupeKey)) return;
    relationshipSet.add(dedupeKey);
    relationships.push({ source, target, type, label });
  });

  const conversationHighlights = [];

  highlightsRaw.forEach((rawHighlight, index) => {
    if (!rawHighlight || typeof rawHighlight !== "object" || Array.isArray(rawHighlight)) {
      warningCounts.invalidHighlights += 1;
      return;
    }

    const highlightTitle = String(rawHighlight.title ?? "").trim().slice(0, 120);
    const highlightSummary = String(rawHighlight.summary ?? "").trim().slice(0, 520);
    const concepts = sanitizeShortList(rawHighlight.concepts, { maxItems: 10, maxLength: 80 })
      .map((concept) => normalizeLabel(concept))
      .filter((concept) => labelSet.has(concept));

    if (!highlightTitle || !highlightSummary) {
      warningCounts.invalidHighlights += 1;
      return;
    }

    conversationHighlights.push({
      title: highlightTitle,
      summary: highlightSummary,
      concepts
    });
  });

  return {
    ok: errors.length === 0,
    errors,
    warnings: buildChatImportWarnings(warningCounts),
    data: errors.length
      ? null
      : {
          schemaVersion,
          provider,
          title,
          summary,
          nodes,
          relationships,
          conversationHighlights
        }
  };
}

function sessionNodeHasIncomingParentOfTypes(db, sessionId, targetNodeId, allowedParentTypes = []) {
  const allowedTypeSet = new Set(allowedParentTypes);
  if (!targetNodeId || !allowedTypeSet.size) return false;

  return db.data.edges.some((edge) => {
    if (!hasSessionMembership(edge, sessionId) || edge.target !== targetNodeId) return false;
    const sourceNode = db.data.nodes.find((node) => node.id === edge.source);
    return allowedTypeSet.has(sourceNode?.type);
  });
}

async function ingestChatHistoryImport({ db, sessionId, importData }) {
  const session = getSession(db, sessionId);
  if (!session) {
    return { status: 404, body: { ok: false, error: "session not found" } };
  }

  const serializedImport = JSON.stringify({
    ...importData,
    nodes: importData.nodes,
    relationships: importData.relationships,
    conversationHighlights: importData.conversationHighlights
  });
  const fingerprint = createHash("sha1").update(serializedImport).digest("hex").slice(0, 16);
  const normalizedUrl = `mindweaver://${importData.provider}/chat-history/${fingerprint}`;
  const sourceType = importData.provider;
  const artifactTitle = importData.title;

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
        importedNodeCount: artifact.structuredImport?.nodeCount ?? importData.nodes.length,
        importedRelationshipCount: artifact.structuredImport?.relationshipCount ?? importData.relationships.length
      }
    };
  }

  artifact = {
    id: `artifact:${nanoid()}`,
    sessionId,
    url: normalizedUrl,
    title: artifactTitle,
    excerpt: importData.summary.slice(0, 280),
    sourceType,
    contentPreview: importData.summary,
    contentLength: serializedImport.length,
    addedAt: Date.now(),
    lastSeenAt: Date.now(),
    viewCount: 1,
    ingestStatus: "classified",
    classification: {
      schemaVersion: importData.schemaVersion,
      provider: importData.provider,
      nodeCount: importData.nodes.length,
      relationshipCount: importData.relationships.length
    },
    structuredImport: {
      nodeCount: importData.nodes.length,
      relationshipCount: importData.relationships.length,
      conversationHighlights: importData.conversationHighlights,
      summary: importData.summary
    }
  };
  db.data.artifacts.push(artifact);

  const sessionGoal = getSessionGoal(db, sessionId);
  const goalNodeId = sessionGoal?.id ?? `session:${sessionId}`;
  const labelToNode = new Map();
  const importedNodes = {
    area: [],
    domain: [],
    topic: [],
    skill: [],
    concept: []
  };
  const conceptIds = new Set();
  const importReason = `Imported from ${getSourceTypeLabel(sourceType)} "${artifactTitle}".`;

  for (const importedNodeData of importData.nodes) {
    const importedNode = ensureNode(db, `${importedNodeData.type}:${importedNodeData.label}`, importedNodeData.label, importedNodeData.type, {
      createdBy: "import",
      verified: false,
      confidence: importedNodeData.confidence,
      sessionId,
      description: importedNodeData.description,
      sourceType,
      artifactId: artifact.id,
      reason: importReason
    });

    importedNode.aliases ||= [];
    for (const alias of importedNodeData.aliases) {
      if (alias !== importedNode.label && !importedNode.aliases.includes(alias)) importedNode.aliases.push(alias);
    }
    if (importedNodeData.description && !importedNode.summary && importedNode.type === "concept") {
      importedNode.summary = importedNodeData.description;
    }

    ensureSource(importedNode, sessionId, {
      url: normalizedUrl,
      title: artifact.title,
      artifactId: artifact.id,
      sourceType,
      excerpt: importedNodeData.evidence[0] ?? importData.summary,
      evidence: importedNodeData.evidence
    });

    addHistoryEntry(importedNode, {
      kind: "chat-history-import",
      sessionId,
      artifactId: artifact.id,
      sourceType,
      title: artifact.title,
      summary: importedNodeData.evidence[0]
        ? `Imported from chat history: ${importedNodeData.evidence[0]}`
        : `Imported from ${getSourceTypeLabel(sourceType).toLowerCase()} history.`
    });

    labelToNode.set(importedNodeData.label, importedNode);
    importedNodes[importedNodeData.type].push(importedNode);
    if (importedNodeData.type === "concept") conceptIds.add(importedNode.id);
  }

  for (const relationship of importData.relationships) {
    const sourceNode = labelToNode.get(relationship.source);
    const targetNode = labelToNode.get(relationship.target);
    if (!sourceNode || !targetNode) continue;
    ensureEdge(
      db,
      sourceNode.id,
      targetNode.id,
      relationship.label || relationship.type,
      relationship.type,
      clampConfidence((sourceNode.confidence + targetNode.confidence) / 2, 0.78),
      "import",
      sessionId
    );
  }

  const visibleNodes = findVisibleSessionNodes(db, sessionId);
  const primaryArea = importedNodes.area[0] ?? visibleNodes.find((node) => node.type === "area") ?? null;
  const primaryDomain = importedNodes.domain[0] ?? visibleNodes.find((node) => node.type === "domain") ?? null;
  const primaryTopic = importedNodes.topic[0] ?? visibleNodes.find((node) => node.type === "topic") ?? null;
  const primarySkill = importedNodes.skill[0] ?? visibleNodes.find((node) => node.type === "skill") ?? null;

  for (const areaNode of importedNodes.area) {
    ensureEdge(db, goalNodeId, areaNode.id, sessionGoal ? "focuses_on" : "contains", sessionGoal ? "focuses_on" : "contains", 0.86, "import", sessionId);
  }

  for (const domainNode of importedNodes.domain) {
    if (sessionNodeHasIncomingParentOfTypes(db, sessionId, domainNode.id, ["area", "goal", "root"])) continue;
    const parentNode = primaryArea ?? null;
    if (parentNode) {
      ensureEdge(db, parentNode.id, domainNode.id, parentNode.type === "goal" ? "focuses_on" : "contains", parentNode.type === "goal" ? "focuses_on" : "contains", 0.86, "import", sessionId);
    } else {
      ensureEdge(db, goalNodeId, domainNode.id, sessionGoal ? "focuses_on" : "contains", sessionGoal ? "focuses_on" : "contains", 0.86, "import", sessionId);
    }
  }

  for (const topicNode of importedNodes.topic) {
    if (sessionNodeHasIncomingParentOfTypes(db, sessionId, topicNode.id, ["domain", "area", "goal", "root"])) continue;
    const parentNode = primaryDomain ?? primaryArea ?? null;
    if (parentNode) {
      ensureEdge(db, parentNode.id, topicNode.id, parentNode.type === "goal" ? "focuses_on" : "contains", parentNode.type === "goal" ? "focuses_on" : "contains", 0.84, "import", sessionId);
    }
  }

  for (const skillNode of importedNodes.skill) {
    const hasIncomingHierarchyParent = sessionNodeHasIncomingParentOfTypes(db, sessionId, skillNode.id, ["topic", "domain", "area"]);
    const parentNode = primaryTopic ?? primaryDomain ?? primaryArea ?? null;

    if (!hasIncomingHierarchyParent && parentNode) {
      ensureEdge(db, parentNode.id, skillNode.id, "contains", "contains", 0.84, "import", sessionId);
    }
  }

  for (const conceptNode of importedNodes.concept) {
    const hasIncomingHierarchyParent = sessionNodeHasIncomingParentOfTypes(db, sessionId, conceptNode.id, ["skill", "topic", "domain"]);
    const parentNode = primarySkill ?? primaryTopic ?? primaryDomain ?? null;

    if (!hasIncomingHierarchyParent && parentNode) {
      ensureEdge(db, parentNode.id, conceptNode.id, parentNode.type === "skill" ? "builds_on" : "contains", parentNode.type === "skill" ? "builds_on" : "contains", 0.84, "import", sessionId);
    }
  }

  const automaticCleanup = applyAutomaticDuplicateCleanup(db, sessionId);
  artifact.conceptIds = [...new Set(
    [...conceptIds]
      .map((conceptId) => resolveCanonicalSessionNodeId(conceptId, automaticCleanup))
      .filter(Boolean)
  )];

  await db.write();
  return {
    status: 200,
    body: {
      ok: true,
      deduped: false,
      artifactId: artifact.id,
      importedNodeCount: importData.nodes.length,
      importedRelationshipCount: importData.relationships.length,
      provider: importData.provider
    }
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
  const area = ensureNode(db, "area:technology", "technology", "area", {
    createdBy: "demo",
    verified: true,
    confidence: 0.93,
    sessionId: session.id,
    reason: "Demo map area grouping the event-driven domain."
  });
  const domain = ensureNode(db, "domain:event driven architecture", "event driven architecture", "domain", {
    createdBy: "demo",
    verified: true,
    confidence: 0.92,
    sessionId: session.id,
    reason: "Demo map domain for event-driven learning."
  });
  const topic = ensureNode(db, "topic:asynchronous messaging", "asynchronous messaging", "topic", {
    createdBy: "demo",
    verified: true,
    confidence: 0.91,
    sessionId: session.id,
    reason: "Demo map topic between the area and implementation skills."
  });
  const skill = ensureNode(db, "skill:event handling", "event handling", "skill", {
    createdBy: "demo",
    verified: true,
    confidence: 0.9,
    sessionId: session.id,
    reason: "Demo map skill connecting sources to practical event concepts."
  });

  ensureEdge(db, goal.id, area.id, "focuses_on", "focuses_on", 0.92, "demo", session.id);
  ensureEdge(db, area.id, domain.id, "contains", "contains", 0.92, "demo", session.id);
  ensureEdge(db, domain.id, topic.id, "contains", "contains", 0.92, "demo", session.id);
  ensureEdge(db, topic.id, skill.id, "contains", "contains", 0.92, "demo", session.id);

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
          area: area.label,
          domain: domain.label,
          topic: topic.label,
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

async function ingestSource({ db, llmRuntime, payload }) {
  const sessionId = String(payload.sessionId).trim();
  const session = getSession(db, sessionId);
  const title = String(payload.title ?? "").trim();
  const excerpt = String(payload.excerpt ?? "").trim();
  const content = String(payload.content ?? "");
  const llmSelection = normalizeLlmSelection(llmRuntime?.llmProvider);
  const contentLimitChars = getLlmContentLimit(llmRuntime?.llmProvider);
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
    ingestStatus: "pending"
  };
  db.data.artifacts.push(artifact);

  let classification = null;
  let area = null;
  let domain = null;
  let topic = null;
  let skill = null;
  let concepts = [];
  const truncatedContent = content.slice(0, contentLimitChars);
  const condensedLocalContent = llmSelection.provider === "local"
    ? buildLocalStructuredIngestExcerpt(truncatedContent)
    : truncatedContent;
  const focusedLocalContent = llmSelection.provider === "local"
    ? buildLocalFocusedIngestExcerpt(truncatedContent)
    : truncatedContent;
  const excerptLocalContent = llmSelection.provider === "local"
    ? buildLocalFocusedIngestExcerpt(artifact.excerpt || truncatedContent, artifact.excerpt ? Math.max(280, artifact.excerpt.length) : 480)
    : truncatedContent;
  const localRetryNote = "This is a condensed excerpt from a longer source. Base your answer only on the excerpt shown here.";
  const sourceClassificationGraphContext = llmSelection.provider === "local" ? "" : buildGraphContext(db);

  async function requestStructuredIngestJson({
    label,
    schema,
    timeoutMs,
    max_completion_tokens,
    normalizeResult = null,
    buildUserContent
  }) {
    const baseOptions = {
      model: "gpt-4o-mini",
      temperature: llmSelection.provider === "local" ? 0 : 0.2,
      schema
    };

    const attemptRequest = (bodyContent, retryContext = {}) =>
      requestStructuredJson(llmRuntime, {
        ...baseOptions,
        label,
        timeoutMs: llmSelection.provider === "local" ? Math.max(timeoutMs, 30000) : timeoutMs,
        max_completion_tokens,
        normalizeResult,
        messages: buildUserContent(bodyContent, retryContext)
      });

    try {
      return await attemptRequest(truncatedContent);
    } catch (error) {
      if (llmSelection.provider !== "local") throw error;

      const fallbackAttempts = [
        { bodyContent: condensedLocalContent, retryContext: { condensed: true } },
        { bodyContent: focusedLocalContent, retryContext: { condensed: true, focused: true, localCompact: true } },
        { bodyContent: excerptLocalContent, retryContext: { condensed: true, excerptOnly: true, localCompact: true } }
      ].filter(({ bodyContent }, index, values) => (
        bodyContent
        && bodyContent !== truncatedContent
        && values.findIndex((entry) => entry.bodyContent === bodyContent) === index
      ));

      let lastError = error;
      for (const { bodyContent, retryContext } of fallbackAttempts) {
        try {
          return await attemptRequest(bodyContent, retryContext);
        } catch (fallbackError) {
          lastError = fallbackError;
        }
      }

      throw lastError;
    }
  }

  try {
    const worthiness = await requestStructuredIngestJson({
      label: "Source worthiness check",
      schema: STRUCTURED_RESPONSE_SCHEMAS.sourceWorthiness,
      timeoutMs: 12000,
      max_completion_tokens: 120,
      buildUserContent: (bodyContent, { condensed = false } = {}) => [
        {
          role: "system",
          content: `Evaluate whether this ${getSourceTypeLabel(sourceType)} has substantive educational content worth adding to a knowledge graph.
Return only JSON: {"should_ingest": true/false, "reason": "brief explanation"}`
        },
        {
          role: "user",
          content: `Title: ${artifact.title}
Type: ${getSourceTypeLabel(sourceType)}
${condensed ? `${localRetryNote}\n` : ""}Content preview: ${bodyContent}`
        }
      ]
    });

    if (worthiness?.should_ingest === false) {
      artifact.ingestStatus = "rejected";
      artifact.rejectionReason = worthiness.reason ?? "Source lacks substantive content";
      await db.write();
      return {
        status: 400,
        body: { ok: false, reason: artifact.rejectionReason }
      };
    }

    classification = await requestStructuredIngestJson({
      label: "Source classification",
      schema: STRUCTURED_RESPONSE_SCHEMAS.sourceClassification,
      timeoutMs: 15000,
      max_completion_tokens: 360,
      normalizeResult: normalizeSourceClassificationPayload,
      buildUserContent: (bodyContent, { condensed = false, localCompact = false } = {}) => [
        {
          role: "system",
          content: localCompact
            ? `Return one compact JSON object only with keys area, domain, topic, skill, and concepts.
Use an empty string for area or topic if they are not clearly supported by the source.
Use 1 domain, 1 skill, and 1-5 concepts.
Prefer the main topic from the lead section of the source.
No prose, no markdown, no analysis.
Return only JSON: {"area":"...", "domain":"...", "topic":"...", "skill":"...", "concepts":["..."]}`
            : `You are a knowledge graph classifier.
 ${sourceClassificationGraphContext}
 
 Classify this source into one domain, one skill, and 1-8 core concepts.
 area = broad umbrella, domain = major field, topic = subarea within a domain, skill = applied capability, concept = atomic knowledge unit.
 Use an empty string for area or topic if the source does not strongly justify them.
 Do not reuse or snap to existing graph nodes just because they look similar. Generate fresh labels from the current source alone.
 Prefer concrete mechanisms, protocols, components, and practices over generic benefits.
 Avoid vague concepts like "scalability", "resilience", "performance", or "efficiency" unless the source is directly teaching that concept itself.
 If the source mentions named systems or implementation details, favor those specifics.
 Return only JSON: {"area":"...", "domain":"...", "topic":"...", "skill":"...", "concepts":["..."]}`
        },
        {
          role: "user",
          content: `Title: ${artifact.title}
Type: ${getSourceTypeLabel(sourceType)}
${artifact.excerpt ? `Excerpt: ${artifact.excerpt}\n` : ""}
${condensed ? `${localRetryNote}\n` : ""}Content: ${bodyContent}`
        }
      ]
    });
  } catch {
    artifact.ingestStatus = "stored";
  }

  const sessionGoal = getSessionGoal(db, sessionId);
  const parentId = sessionGoal?.id ?? `session:${sessionId}`;
  const sourceReason = `Identified from ${getSourceTypeLabel(sourceType).toLowerCase()} "${artifact.title}".`;
  const normalizedAreaLabel = sanitizeNodeLabelForType("area", classification?.area);
  const normalizedDomainLabel = sanitizeNodeLabelForType("domain", classification?.domain);
  const normalizedTopicLabel = sanitizeNodeLabelForType("topic", classification?.topic);
  const normalizedSkillLabel = sanitizeNodeLabelForType("skill", classification?.skill);
  const normalizedConceptLabels = [];
  const seenConceptLabels = new Set();

  for (const conceptName of Array.isArray(classification?.concepts) ? classification.concepts : []) {
    const conceptLabel = sanitizeNodeLabelForType("concept", conceptName);
    if (!conceptLabel || seenConceptLabels.has(conceptLabel)) continue;
    seenConceptLabels.add(conceptLabel);
    normalizedConceptLabels.push(conceptLabel);
    if (normalizedConceptLabels.length >= 8) break;
  }

  if (normalizedAreaLabel) {
    const areaNode = createSessionNode(db, {
      type: "area",
      label: normalizedAreaLabel,
      createdBy: "ai",
      verified: false,
      sessionId,
      sourceType,
      artifactId: artifact.id,
      reason: sourceReason
    });
    if (areaNode) {
      ensureEdge(db, parentId, areaNode.id, sessionGoal ? "focuses_on" : "contains", sessionGoal ? "focuses_on" : "contains", 0.8, sessionGoal ? "user" : "ai", sessionId);
      area = { id: areaNode.id, label: areaNode.label };
    }
  }

  if (normalizedDomainLabel) {
    const domainNode = createSessionNode(db, {
      type: "domain",
      label: normalizedDomainLabel,
        createdBy: "ai",
        verified: false,
        sessionId,
        sourceType,
        artifactId: artifact.id,
        reason: sourceReason
      });
    if (domainNode) {
      ensureEdge(db, area?.id ?? parentId, domainNode.id, area ? "contains" : sessionGoal ? "focuses_on" : "contains", area ? "contains" : sessionGoal ? "focuses_on" : "contains", 0.8, sessionGoal ? "user" : "ai", sessionId);
      domain = { id: domainNode.id, label: domainNode.label };
    }
  }

  if (domain && normalizedTopicLabel) {
    const topicNode = createSessionNode(db, {
      type: "topic",
      label: normalizedTopicLabel,
        createdBy: "ai",
        verified: false,
        sessionId,
        sourceType,
        artifactId: artifact.id,
        reason: sourceReason
      });
    if (topicNode) {
      ensureEdge(db, domain.id, topicNode.id, "contains", "contains", 0.82, "ai", sessionId);
      topic = { id: topicNode.id, label: topicNode.label };
    }
  }

  if ((topic ?? domain) && normalizedSkillLabel) {
    const skillNode = createSessionNode(db, {
      type: "skill",
      label: normalizedSkillLabel,
        createdBy: "ai",
        verified: false,
        sessionId,
        sourceType,
        artifactId: artifact.id,
        reason: sourceReason
      });
    if (skillNode) {
      ensureEdge(db, (topic ?? domain).id, skillNode.id, "contains", "contains", 0.82, "ai", sessionId);
      skill = { id: skillNode.id, label: skillNode.label };
    }
  }

  if ((skill ?? topic ?? domain) && normalizedConceptLabels.length) {
    for (const conceptLabel of normalizedConceptLabels) {
      const conceptNode = createSessionNode(db, {
        type: "concept",
        label: conceptLabel,
        createdBy: "ai",
        verified: false,
        sessionId,
        sourceType,
        artifactId: artifact.id,
        reason: sourceReason
      });
      if (!conceptNode) continue;
      ensureEdge(db, (skill ?? topic ?? domain).id, conceptNode.id, skill ? "builds_on" : "contains", skill ? "builds_on" : "contains", 0.85, "ai", sessionId);
      concepts.push({ id: conceptNode.id, label: conceptNode.label });
    }
  }

  let directlyCoveredConcepts = concepts.map((concept) => concept.label);
  if (concepts.length > 1) {
    try {
      const refinement = await requestStructuredJson(llmRuntime, {
        model: "gpt-4o-mini",
        label: "Direct concept refinement",
        timeoutMs: 12000,
        temperature: 0.2,
        max_completion_tokens: 140,
        schema: STRUCTURED_RESPONSE_SCHEMAS.directConceptRefinement,
        messages: [
          {
            role: "system",
            content: 'Return only JSON: {"directly_covered": ["concept1", "concept2"]}. Keep only specific concepts directly taught by the source, not vague benefits or outcomes.'
          },
          {
            role: "user",
            content: `Title: ${artifact.title}
Content: ${content.slice(0, contentLimitChars)}
Concepts: ${concepts.map((concept) => concept.label).join(", ")}

Which concepts are directly taught by this source?`
          }
        ]
      });

      if (Array.isArray(refinement?.directly_covered)) {
        directlyCoveredConcepts = refinement.directly_covered.map((concept) => normalizeLabel(concept)).filter(Boolean);
      }
    } catch {
      // Keep the original concept list if the refinement pass is unavailable.
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

  const automaticCleanup = applyAutomaticDuplicateCleanup(db, sessionId);
  if (automaticCleanup.merged) {
    area = resolveCanonicalNodeReference(db, sessionId, area, automaticCleanup);
    domain = resolveCanonicalNodeReference(db, sessionId, domain, automaticCleanup);
    topic = resolveCanonicalNodeReference(db, sessionId, topic, automaticCleanup);
    skill = resolveCanonicalNodeReference(db, sessionId, skill, automaticCleanup);
    concepts = dedupeNodeReferences(
      concepts.map((concept) => resolveCanonicalNodeReference(db, sessionId, concept, automaticCleanup))
    );
  }

  artifact.classification = {
    area: area?.label ?? (normalizedAreaLabel || null),
    domain: domain?.label ?? (normalizedDomainLabel || null),
    topic: topic?.label ?? (normalizedTopicLabel || null),
    skill: skill?.label ?? (normalizedSkillLabel || null),
    concepts: concepts.map((concept) => concept.label)
  };
  artifact.conceptIds = concepts.map((concept) => concept.id);
  artifact.ingestStatus = classification ? "classified" : "stored";

  await db.write();
  return {
    status: 200,
    body: {
      ok: true,
      deduped: false,
      artifactId: artifact.id,
      classification: artifact.classification,
      domain,
      skill,
      concepts
    }
  };
}

export {
  validateIngestPayload,
  validateChatHistoryImportPayload,
  ingestChatHistoryImport,
  createDemoSession,
  ingestSource
};
