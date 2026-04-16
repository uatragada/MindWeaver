import { normalizeLlmSelection, requestStructuredJson } from "../openai.js";
import * as shared from "./shared-service.js";
import * as graph from "./graph-service.js";

const {
  LOCAL_REFINE_ARTIFACT_LIMIT,
  LOCAL_REFINE_MISSING_EVIDENCE_GROUP_SIZE,
  LOCAL_REFINE_SNAPSHOT_NODE_LIMIT,
  RELATIONSHIP_TYPES,
  SEMANTIC_ROLE_TYPES,
  sanitizeNodeLabelForType,
  STRUCTURED_RESPONSE_SCHEMAS,
  USER_CREATABLE_NODE_TYPES,
  hasSessionMembership,
  isRejectedForSession,
  normalizeLabel
} = shared;

const {
  addHistoryEntry,
  buildSessionGraph,
  ensureEdge,
  getSession,
  getSessionGoal,
  mergeNodeIntoTarget
} = graph;

function buildRefineSnapshotNode(node, { compact = false } = {}) {
  const snapshotNode = {
    id: node.id,
    label: node.label,
    type: node.type,
    primaryRole: node.primaryRole ?? node.type,
    secondaryRoles: Array.isArray(node.secondaryRoles) ? node.secondaryRoles : [],
    description: node.description || "",
    confidence: Number((node.confidence ?? 0).toFixed(2)),
    evidenceCount: node.evidenceCount ?? 0,
    masteryState: node.masteryState
  };

  if (!compact) {
    snapshotNode.summary = node.summary || "";
    snapshotNode.whyThisExists = node.whyThisExists;
  }

  return snapshotNode;
}

function buildRefineSnapshotArtifact(artifact, { compact = false } = {}) {
  return {
    id: artifact.id,
    title: artifact.title,
    sourceType: artifact.sourceType,
    ...(compact ? {} : { excerpt: artifact.excerpt })
  };
}

function buildRefineGraphSnapshotShape(graph, { includedNodeIds = null, compact = false, artifactLimit = 8 } = {}) {
  const safeNodeIds = includedNodeIds instanceof Set ? includedNodeIds : null;
  return {
    mapName: graph.session?.goal || "Untitled map",
    nodes: graph.nodes
      .filter((node) => USER_CREATABLE_NODE_TYPES.has(node.type))
      .filter((node) => !safeNodeIds || safeNodeIds.has(node.id))
      .map((node) => buildRefineSnapshotNode(node, { compact })),
    edges: graph.edges
      .filter((edge) => !safeNodeIds || (safeNodeIds.has(edge.source) && safeNodeIds.has(edge.target)))
      .map((edge) => ({
        key: edge.key,
        source: edge.source,
        target: edge.target,
        type: edge.type,
        label: edge.label,
        confidence: Number((edge.confidence ?? 0).toFixed(2))
      })),
    artifacts: graph.artifacts
      .slice(-artifactLimit)
      .map((artifact) => buildRefineSnapshotArtifact(artifact, { compact }))
  };
}

function buildFullRefineGraphSnapshot(graph) {
  return buildRefineGraphSnapshotShape(graph);
}

function buildRefineLabelKey(node) {
  const primaryRole = String(node.primaryRole ?? node.type ?? "").trim().toLowerCase();
  if (!SEMANTIC_ROLE_TYPES.has(primaryRole)) {
    return `${primaryRole}:${normalizeLabel(node.label)}`;
  }
  return String(node.entityId ?? normalizeLabel(node.label)).trim();
}

function buildLocalRefineAdjacency(graph, nodeMap) {
  const adjacency = new Map(Array.from(nodeMap.keys(), (nodeId) => [nodeId, new Set()]));

  for (const edge of graph.edges ?? []) {
    if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) continue;
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }

  return adjacency;
}

function getLocalRefineNodePriority(node) {
  switch (node?.type) {
    case "goal":
      return 0;
    case "area":
      return 1;
    case "domain":
      return 2;
    case "topic":
      return 3;
    case "skill":
      return 4;
    case "concept":
      return 5;
    default:
      return 6;
  }
}

function getPrimaryLocalRefineContextKey(node, adjacency, nodeMap) {
  const neighbors = Array.from(adjacency.get(node.id) ?? [])
    .map((neighborId) => nodeMap.get(neighborId))
    .filter((neighbor) => neighbor && neighbor.type !== "concept")
    .sort((left, right) =>
      getLocalRefineNodePriority(left) - getLocalRefineNodePriority(right)
      || ((right.evidenceCount ?? 0) - (left.evidenceCount ?? 0))
      || left.label.localeCompare(right.label)
    );

  return neighbors[0]?.id ?? `concept:${normalizeLabel(node.label)}`;
}

function buildLocalRefineCandidateGroups(graph) {
  const sessionNodes = graph.nodes.filter((node) => USER_CREATABLE_NODE_TYPES.has(node.type));
  const nodeMap = new Map(sessionNodes.map((node) => [node.id, node]));
  const adjacency = buildLocalRefineAdjacency(graph, nodeMap);
  const labelGroups = new Map();
  for (const node of sessionNodes) {
    const labelKey = buildRefineLabelKey(node);
    const nodesForLabel = labelGroups.get(labelKey) ?? [];
    nodesForLabel.push(node);
    labelGroups.set(labelKey, nodesForLabel);
  }

  const duplicateGroups = Array.from(labelGroups.values())
    .filter((nodes) => nodes.length > 1)
    .sort((left, right) =>
      getLocalRefineNodePriority(left[0]) - getLocalRefineNodePriority(right[0])
      || (right.length - left.length)
      || left[0].label.localeCompare(right[0].label)
    )
    .map((nodes) => nodes.map((node) => node.id));
  const duplicateNodeIds = new Set(duplicateGroups.flat());
  const missingEvidenceBuckets = new Map();

  const missingEvidenceConcepts = sessionNodes
    .filter((node) => node.type === "concept")
    .filter((node) => !duplicateNodeIds.has(node.id))
    .filter((node) => (node.evidenceCount ?? 0) === 0)
    .filter((node) => !/Gap analysis flagged/i.test(String(node.whyThisExists ?? "")))
    .sort((left, right) =>
      ((left.confidence ?? 0) - (right.confidence ?? 0))
      || left.label.localeCompare(right.label)
    );

  for (const node of missingEvidenceConcepts) {
    const contextKey = getPrimaryLocalRefineContextKey(node, adjacency, nodeMap);
    const bucket = missingEvidenceBuckets.get(contextKey) ?? [];
    bucket.push(node);
    missingEvidenceBuckets.set(contextKey, bucket);
  }

  const missingEvidenceGroups = [];
  for (const bucket of missingEvidenceBuckets.values()) {
    for (let index = 0; index < bucket.length; index += LOCAL_REFINE_MISSING_EVIDENCE_GROUP_SIZE) {
      missingEvidenceGroups.push(bucket.slice(index, index + LOCAL_REFINE_MISSING_EVIDENCE_GROUP_SIZE).map((node) => node.id));
    }
  }

  return [...duplicateGroups, ...missingEvidenceGroups];
}

function buildLocalRefineGroupSnapshot(graph, groupNodeIds) {
  const sessionNodes = graph.nodes.filter((node) => USER_CREATABLE_NODE_TYPES.has(node.type));
  const nodeMap = new Map(sessionNodes.map((node) => [node.id, node]));
  const adjacency = buildLocalRefineAdjacency(graph, nodeMap);
  const includedNodeIds = new Set(groupNodeIds.filter((nodeId) => nodeMap.has(nodeId)));
  const rootContextNode = sessionNodes.find((node) => node.type === "goal")
    ?? sessionNodes.find((node) => node.type === "area")
    ?? sessionNodes.find((node) => node.type === "domain")
    ?? null;

  if (rootContextNode && !includedNodeIds.has(rootContextNode.id) && includedNodeIds.size < LOCAL_REFINE_SNAPSHOT_NODE_LIMIT) {
    includedNodeIds.add(rootContextNode.id);
  }

  const neighborCandidates = Array.from(new Set(
    [...includedNodeIds].flatMap((nodeId) => Array.from(adjacency.get(nodeId) ?? []))
  ))
    .filter((nodeId) => !includedNodeIds.has(nodeId))
    .map((nodeId) => nodeMap.get(nodeId))
    .filter(Boolean)
    .sort((left, right) =>
      getLocalRefineNodePriority(left) - getLocalRefineNodePriority(right)
      || ((right.evidenceCount ?? 0) - (left.evidenceCount ?? 0))
      || ((right.confidence ?? 0) - (left.confidence ?? 0))
      || left.label.localeCompare(right.label)
    );

  for (const neighbor of neighborCandidates) {
    if (includedNodeIds.size >= LOCAL_REFINE_SNAPSHOT_NODE_LIMIT) break;
    includedNodeIds.add(neighbor.id);
  }

  return buildRefineGraphSnapshotShape(graph, {
    includedNodeIds,
    compact: true,
    artifactLimit: LOCAL_REFINE_ARTIFACT_LIMIT
  });
}

function buildLocalRefineGraphSnapshots(graph) {
  const sessionNodes = graph.nodes.filter((node) => USER_CREATABLE_NODE_TYPES.has(node.type));
  if (sessionNodes.length <= LOCAL_REFINE_SNAPSHOT_NODE_LIMIT) {
    return [buildRefineGraphSnapshotShape(graph, { compact: true, artifactLimit: LOCAL_REFINE_ARTIFACT_LIMIT })];
  }

  const candidateGroups = buildLocalRefineCandidateGroups(graph);
  if (!candidateGroups.length) {
    return [buildRefineGraphSnapshotShape(graph, { compact: true, artifactLimit: LOCAL_REFINE_ARTIFACT_LIMIT })];
  }

  const snapshots = [];
  const seenSnapshotKeys = new Set();

  for (const candidateGroup of candidateGroups) {
    const snapshot = buildLocalRefineGroupSnapshot(graph, candidateGroup);
    const snapshotKey = snapshot.nodes.map((node) => node.id).sort().join("|");
    if (!snapshotKey || seenSnapshotKeys.has(snapshotKey) || snapshot.nodes.length < 2) continue;
    seenSnapshotKeys.add(snapshotKey);
    snapshots.push(snapshot);
  }

  return snapshots.length
    ? snapshots
    : [buildRefineGraphSnapshotShape(graph, { compact: true, artifactLimit: LOCAL_REFINE_ARTIFACT_LIMIT })];
}

function buildRefineGraphSnapshots(graph, { llmProvider = null } = {}) {
  const llmSelection = normalizeLlmSelection(llmProvider);
  return llmSelection.provider === "local"
    ? buildLocalRefineGraphSnapshots(graph)
    : [buildFullRefineGraphSnapshot(graph)];
}

function dedupeBy(items, getKey) {
  const seen = new Set();
  const deduped = [];

  for (const item of items) {
    const key = getKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function mergeRefinePlans(plans) {
  const safePlans = Array.isArray(plans) ? plans.filter((plan) => plan && typeof plan === "object") : [];
  return {
    summary: Array.from(new Set(
      safePlans
        .map((plan) => String(plan.summary ?? "").trim())
        .filter(Boolean)
    )).join(" "),
    rename_nodes: dedupeBy(
      safePlans.flatMap((plan) => (Array.isArray(plan.rename_nodes) ? plan.rename_nodes : [])),
      (operation) => String(operation?.id ?? "").trim()
    ),
    merge_nodes: dedupeBy(
      safePlans.flatMap((plan) => (Array.isArray(plan.merge_nodes) ? plan.merge_nodes : [])),
      (operation) => `${String(operation?.sourceId ?? "").trim()}->${String(operation?.targetId ?? "").trim()}`
    ),
    add_edges: dedupeBy(
      safePlans.flatMap((plan) => (Array.isArray(plan.add_edges) ? plan.add_edges : [])),
      (operation) => `${String(operation?.sourceId ?? "").trim()}|${String(operation?.type ?? "").trim()}|${String(operation?.targetId ?? "").trim()}`
    ),
    remove_edges: dedupeBy(
      safePlans.flatMap((plan) => (Array.isArray(plan.remove_edges) ? plan.remove_edges : [])),
      (operation) => String(operation?.key ?? "").trim()
    )
  };
}

function buildDeterministicDuplicateMergeOperations(graph) {
  const sessionNodes = graph.nodes.filter((node) => USER_CREATABLE_NODE_TYPES.has(node.type));
  const labelGroups = new Map();

  for (const node of sessionNodes) {
    const labelKey = buildRefineLabelKey(node);
    const group = labelGroups.get(labelKey) ?? [];
    group.push(node);
    labelGroups.set(labelKey, group);
  }

  return Array.from(labelGroups.values())
    .filter((group) => group.length > 1 && group[0]?.type !== "goal")
    .flatMap((group) => {
      const [target, ...sources] = [...group].sort((left, right) =>
        ((right.evidenceCount ?? 0) - (left.evidenceCount ?? 0))
        || ((right.confidence ?? 0) - (left.confidence ?? 0))
        || ((left.createdAt ?? 0) - (right.createdAt ?? 0))
        || left.id.localeCompare(right.id)
      );

      return sources.map((source) => ({
        sourceId: source.id,
        targetId: target.id,
        reason: `Exact semantic duplicate "${source.label}" found in this map.`
      }));
    });
}

function buildDeterministicLocalRefinePlan(graph) {
  const merge_nodes = buildDeterministicDuplicateMergeOperations(graph);

  if (!merge_nodes.length) return null;

  return {
    summary: "Applied conservative duplicate-label cleanup after the local model could not return valid structured refine JSON, including semantic role overlaps.",
    rename_nodes: [],
    merge_nodes,
    add_edges: [],
    remove_edges: []
  };
}

function applyAutomaticDuplicateCleanup(db, sessionId) {
  const session = getSession(db, sessionId);
  if (!session) {
    return {
      merged: 0,
      sourceToTargetIds: new Map()
    };
  }

  const mergeOps = buildDeterministicDuplicateMergeOperations(buildSessionGraph(db, sessionId));
  if (!mergeOps.length) {
    return {
      merged: 0,
      sourceToTargetIds: new Map()
    };
  }

  const primaryGoalId = getSessionGoal(db, sessionId)?.id ?? null;
  const sourceToTargetIds = new Map();
  let merged = 0;

  for (const operation of mergeOps.slice(0, 24)) {
    const sourceId = String(operation?.sourceId ?? "").trim();
    const targetId = String(operation?.targetId ?? "").trim();
    if (!sourceId || !targetId || sourceId === targetId) continue;
    if (primaryGoalId && sourceId === primaryGoalId) continue;

    const result = mergeNodeIntoTarget(db, sessionId, sourceId, targetId);
    if (!result.ok) continue;

    sourceToTargetIds.set(sourceId, result.target.id);
    merged += 1;
  }

  return {
    merged,
    sourceToTargetIds
  };
}

function resolveCanonicalSessionNodeId(nodeId, dedupeResult) {
  let resolvedId = String(nodeId ?? "").trim();
  const mapping = dedupeResult?.sourceToTargetIds;

  if (!resolvedId || !(mapping instanceof Map) || !mapping.size) {
    return resolvedId;
  }

  const visited = new Set([resolvedId]);
  while (mapping.has(resolvedId)) {
    const nextId = String(mapping.get(resolvedId) ?? "").trim();
    if (!nextId || visited.has(nextId)) break;
    visited.add(nextId);
    resolvedId = nextId;
  }

  return resolvedId;
}

function resolveCanonicalSessionNode(db, sessionId, nodeId, dedupeResult) {
  const canonicalId = resolveCanonicalSessionNodeId(nodeId, dedupeResult);
  if (!canonicalId) return null;

  return db.data.nodes.find((node) => node.id === canonicalId && hasSessionMembership(node, sessionId) && !isRejectedForSession(node, sessionId))
    ?? db.data.nodes.find((node) => node.id === canonicalId && hasSessionMembership(node, sessionId))
    ?? null;
}

function resolveCanonicalNodeReference(db, sessionId, reference, dedupeResult) {
  if (!reference?.id) return reference;
  const canonicalNode = resolveCanonicalSessionNode(db, sessionId, reference.id, dedupeResult);
  if (!canonicalNode) return reference;
  return {
    id: canonicalNode.id,
    label: canonicalNode.label
  };
}

function dedupeNodeReferences(items) {
  const seen = new Set();
  const deduped = [];

  for (const item of Array.isArray(items) ? items : []) {
    const key = String(item?.id ?? item?.label ?? "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function buildRefineStatusMessage(summary) {
  const parts = [];
  if (summary.renamed) parts.push(`${summary.renamed} renamed`);
  if (summary.retyped) parts.push(`${summary.retyped} retyped`);
  if (summary.merged) parts.push(`${summary.merged} merged`);
  if (summary.addedEdges) parts.push(`${summary.addedEdges} links added`);
  if (summary.removedEdges) parts.push(`${summary.removedEdges} links removed`);
  return parts.length ? `Refined map: ${parts.join(", ")}.` : "The refine pass did not find any safe graph changes to apply.";
}

async function refineSessionGraph({ db, llmRuntime, sessionId }) {
  const session = getSession(db, sessionId);
  if (!session) {
    return {
      status: 404,
      body: { ok: false, error: "session not found" }
    };
  }

  const graph = buildSessionGraph(db, sessionId);
  const llmSelection = normalizeLlmSelection(llmRuntime?.llmProvider);
  const snapshots = buildRefineGraphSnapshots(graph, { llmProvider: llmSelection });
  const localRefineScopeNote = llmSelection.provider === "local"
    ? snapshots.length > 1
      ? "This is one cleanup-focused chunk from a larger map. Refine only the nodes, edges, and artifacts shown here."
      : "This snapshot is the cleanup-focused subset of a larger map. Refine only the nodes, edges, and artifacts shown here."
    : "";
  const localRefineOutputNote = llmSelection.provider === "local"
    ? "- choose only the highest-confidence cleanup changes from this chunk\n- return at most 2 rename_nodes, 2 merge_nodes, 3 add_edges, and 4 remove_edges"
    : "";

  if (!snapshots.some((snapshot) => snapshot.nodes.length >= 2)) {
    return {
      status: 400,
      body: { ok: false, error: "Add a few nodes before running refine." }
    };
  }

  const partialRefineWarnings = [];
  let skippedLocalRefineChunkCount = 0;
  const refinePlans = [];

  for (const [index, snapshot] of snapshots.entries()) {
    if (snapshot.nodes.length < 2) continue;

    try {
      refinePlans.push(await requestStructuredJson(llmRuntime, {
        model: "gpt-4o-mini",
        label: snapshots.length > 1 ? `Graph refinement chunk ${index + 1}` : "Graph refinement",
        timeoutMs: 22000,
        temperature: llmSelection.provider === "local" ? 0 : 0.2,
        max_completion_tokens: llmSelection.provider === "local" ? 420 : 700,
        schema: STRUCTURED_RESPONSE_SCHEMAS.graphRefinement,
        messages: [
          {
            role: "system",
            content: `You are refining a MindWeaver knowledge map.

Improve coherence conservatively:
- fix inaccurate, redundant, weak, or misplaced nodes when the current graph already provides enough evidence
- preserve useful information whenever possible
- prefer rename, retype, merge, and edge cleanup over destructive removal
- do not invent new facts that are not already supported by the graph snapshot
- do not output markdown fences
${localRefineOutputNote}

Return JSON only with this shape:
{
  "summary": "short explanation of the refinement pass",
  "rename_nodes": [
    {
      "id": "existing node id",
      "label": "better label",
      "description": "optional improved description",
      "type": "goal|domain|skill|concept"
    }
  ],
  "merge_nodes": [
    {
      "sourceId": "duplicate node id",
      "targetId": "canonical node id",
      "reason": "why the merge is safe"
    }
  ],
  "add_edges": [
    {
      "sourceId": "existing node id",
      "targetId": "existing node id",
      "type": "contains|builds_on|prerequisite|related|contrasts|supports|needs|focuses_on",
      "label": "edge label"
    }
  ],
  "remove_edges": [
    {
      "key": "existing edge key",
      "reason": "why the edge is weak, redundant, or misplaced"
    }
  ]
}`
          },
          {
            role: "user",
            content: `Refine this MindWeaver map without deleting useful information unnecessarily.

${localRefineScopeNote}

${JSON.stringify(snapshot, null, 2)}`
          }
        ]
      }));
    } catch (error) {
      if (error?.code === "LLM_UNAVAILABLE") {
        return {
          status: 400,
          body: { ok: false, error: error.message || "MindWeaver could not reach the selected language model." }
        };
      }

      if (llmSelection.provider !== "local" && snapshots.length === 1) {
        return {
          status: 502,
          body: { ok: false, error: error.message || "MindWeaver could not produce a refinement plan right now." }
        };
      }

      skippedLocalRefineChunkCount += 1;
    }
  }

  if (skippedLocalRefineChunkCount > 0) {
    partialRefineWarnings.push(`Skipped ${skippedLocalRefineChunkCount} local refine chunk${skippedLocalRefineChunkCount === 1 ? "" : "s"} because the model did not return valid structured cleanup output.`);
  }

  if (!refinePlans.length && llmSelection.provider === "local") {
    const deterministicFallbackPlan = buildDeterministicLocalRefinePlan(graph);
    if (deterministicFallbackPlan) {
      refinePlans.push(deterministicFallbackPlan);
      partialRefineWarnings.push("The local model did not return valid structured cleanup JSON, so MindWeaver applied conservative duplicate-label cleanup instead.");
    }
  }

  const refinePlan = mergeRefinePlans(refinePlans);
  if (!refinePlans.length || !refinePlan || typeof refinePlan !== "object") {
    return {
      status: 502,
      body: { ok: false, error: "MindWeaver could not produce a refinement plan right now." }
    };
  }

  const summary = {
    renamed: 0,
    retyped: 0,
    merged: 0,
    addedEdges: 0,
    removedEdges: 0,
    warnings: [...partialRefineWarnings]
  };
  const primaryGoal = getSessionGoal(db, sessionId);
  const primaryGoalId = primaryGoal?.id ?? null;
  const renameOps = Array.isArray(refinePlan.rename_nodes) ? refinePlan.rename_nodes.slice(0, 24) : [];
  const mergeOps = Array.isArray(refinePlan.merge_nodes) ? refinePlan.merge_nodes.slice(0, 12) : [];
  const addEdgeOps = Array.isArray(refinePlan.add_edges) ? refinePlan.add_edges.slice(0, 32) : [];
  const removeEdgeOps = Array.isArray(refinePlan.remove_edges) ? refinePlan.remove_edges.slice(0, 32) : [];

  for (const operation of renameOps) {
    const node = db.data.nodes.find((entry) => entry.id === String(operation?.id ?? "").trim() && hasSessionMembership(entry, sessionId));
    if (!node || !USER_CREATABLE_NODE_TYPES.has(node.type)) continue;

    const nextType = String(operation?.type ?? node.type).trim().toLowerCase();
    const nextLabel = sanitizeNodeLabelForType(nextType, operation?.label ?? node.label);
    const nextDescription = String(operation?.description ?? "").trim();

    if (!USER_CREATABLE_NODE_TYPES.has(nextType) || !nextLabel) continue;
    if (primaryGoalId && node.id === primaryGoalId && nextType !== "goal") {
      summary.warnings.push(`Skipped retyping the primary goal node "${node.label}".`);
      continue;
    }

    if (nextLabel !== node.label) {
      node.aliases ||= [];
      if (node.label && !node.aliases.includes(node.label)) node.aliases.push(node.label);
      node.label = nextLabel;
      node.canonicalLabel = normalizeLabel(nextLabel);
      summary.renamed += 1;
    }

    if (nextDescription) {
      node.description = nextDescription;
    }

    if (nextType !== node.type) {
      node.type = nextType;
      summary.retyped += 1;
    }

    if (primaryGoalId && node.id === primaryGoalId) {
      primaryGoal.title = node.label;
      session.goal = node.label;
    }

    addHistoryEntry(node, {
      kind: "graph-refined",
      sessionId,
      summary: String(refinePlan.summary ?? "").trim() || "Refined during map cleanup."
    });
  }

  for (const operation of removeEdgeOps) {
    const key = String(operation?.key ?? "").trim();
    if (!key) continue;
    const edge = db.data.edges.find((entry) => entry.key === key && hasSessionMembership(entry, sessionId));
    if (!edge) continue;

    edge.sessionIds = (edge.sessionIds ?? []).filter((entry) => entry !== sessionId);
    summary.removedEdges += 1;
  }

  db.data.edges = db.data.edges.filter((edge) => (edge.sessionIds ?? []).length > 0);

  for (const operation of addEdgeOps) {
    const sourceId = String(operation?.sourceId ?? "").trim();
    const targetId = String(operation?.targetId ?? "").trim();
    const type = String(operation?.type ?? "").trim().toLowerCase();
    const label = String(operation?.label ?? type).trim();
    if (!sourceId || !targetId || sourceId === targetId || !label || !RELATIONSHIP_TYPES.has(type)) continue;

    const source = db.data.nodes.find((entry) => entry.id === sourceId && hasSessionMembership(entry, sessionId));
    const target = db.data.nodes.find((entry) => entry.id === targetId && hasSessionMembership(entry, sessionId));
    if (!source || !target) continue;

    const edge = ensureEdge(db, sourceId, targetId, label, type, 0.82, "ai", sessionId);
    if (edge) summary.addedEdges += 1;
  }

  for (const operation of mergeOps) {
    const sourceId = String(operation?.sourceId ?? "").trim();
    const targetId = String(operation?.targetId ?? "").trim();
    if (!sourceId || !targetId || sourceId === targetId) continue;
    if (primaryGoalId && sourceId === primaryGoalId) {
      summary.warnings.push("Skipped merging the primary goal node into another node.");
      continue;
    }

    const result = mergeNodeIntoTarget(db, sessionId, sourceId, targetId);
    if (result.ok) summary.merged += 1;
  }

  const automaticCleanup = applyAutomaticDuplicateCleanup(db, sessionId);
  if (automaticCleanup.merged) {
    summary.merged += automaticCleanup.merged;
    summary.warnings.push("Applied exact duplicate-label cleanup after the map update.");
  }

  await db.write();

  return {
    status: 200,
    body: {
      ok: true,
      summary: String(refinePlan.summary ?? "").trim(),
      applied: summary,
      message: buildRefineStatusMessage(summary),
      graph: buildSessionGraph(db, sessionId)
    }
  };
}

export {
  buildRefineSnapshotNode,
  buildRefineSnapshotArtifact,
  buildRefineGraphSnapshotShape,
  buildFullRefineGraphSnapshot,
  buildRefineLabelKey,
  buildLocalRefineAdjacency,
  getLocalRefineNodePriority,
  getPrimaryLocalRefineContextKey,
  buildLocalRefineCandidateGroups,
  buildLocalRefineGroupSnapshot,
  buildLocalRefineGraphSnapshots,
  buildRefineGraphSnapshots,
  dedupeBy,
  mergeRefinePlans,
  buildDeterministicDuplicateMergeOperations,
  buildDeterministicLocalRefinePlan,
  applyAutomaticDuplicateCleanup,
  resolveCanonicalSessionNodeId,
  resolveCanonicalSessionNode,
  resolveCanonicalNodeReference,
  dedupeNodeReferences,
  buildRefineStatusMessage,
  refineSessionGraph
};
