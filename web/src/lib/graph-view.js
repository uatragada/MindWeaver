import { NODE_HIERARCHY_LEVELS } from "./graph-rendering.js";

export const HIERARCHY_EDGE_TYPES = new Set(["pursues", "focuses_on", "contains", "builds_on"]);
export const UNGROUPED_DOMAIN_ID = "__ungrouped__";

function normalizeNodeId(value) {
  if (typeof value === "object" && value) {
    return String(value.id ?? "").trim();
  }
  return String(value ?? "").trim();
}

function getNormalizedDepth(rawDepth) {
  return Number.isFinite(rawDepth) ? Math.max(0, Math.floor(rawDepth)) : Number.POSITIVE_INFINITY;
}

function compareNodes(left, right) {
  return (NODE_HIERARCHY_LEVELS[left?.type] ?? 99) - (NODE_HIERARCHY_LEVELS[right?.type] ?? 99)
    || String(left?.label ?? "").localeCompare(String(right?.label ?? ""))
    || String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

function getTraversalSpecs(index, nodeId, direction) {
  const specs = [];

  if (direction === "downstream" || direction === "both") {
    specs.push({
      edges: index.outgoingEdgesById.get(nodeId) ?? [],
      getNextNodeId: (edge) => edge.targetId
    });
  }

  if (direction === "upstream" || direction === "both") {
    specs.push({
      edges: index.incomingEdgesById.get(nodeId) ?? [],
      getNextNodeId: (edge) => edge.sourceId
    });
  }

  return specs;
}

export function isHierarchyLinkType(rawType) {
  return HIERARCHY_EDGE_TYPES.has(String(rawType ?? "").trim().toLowerCase());
}

function getSortedHierarchyParentEdges(index, nodeId) {
  return [...(index.incomingEdgesById.get(nodeId) ?? [])]
    // If multiple hierarchy parents exist, prefer the lexicographically stable path
    // through the shallowest parent type, then label, then node id.
    .filter((edge) => isHierarchyLinkType(edge.type))
    .sort((left, right) => compareNodes(index.nodesById.get(left.sourceId), index.nodesById.get(right.sourceId)));
}

export function buildGraphIndex(graphState) {
  const nodes = Array.isArray(graphState?.nodes) ? graphState.nodes : [];
  const edges = Array.isArray(graphState?.edges) ? graphState.edges : [];
  const nodesById = new Map(nodes.map((node) => [String(node.id), node]));
  const outgoingById = new Map(nodes.map((node) => [String(node.id), []]));
  const incomingById = new Map(nodes.map((node) => [String(node.id), []]));
  const outgoingEdgesById = new Map(nodes.map((node) => [String(node.id), []]));
  const incomingEdgesById = new Map(nodes.map((node) => [String(node.id), []]));
  const edgesByKey = new Map();
  const normalizedEdges = [];

  edges.forEach((edge, index) => {
    const sourceId = normalizeNodeId(edge.source);
    const targetId = normalizeNodeId(edge.target);
    if (!sourceId || !targetId || !nodesById.has(sourceId) || !nodesById.has(targetId)) return;

    const key = String(edge.key ?? `${sourceId}:${targetId}:${edge.type ?? "edge"}:${index}`);
    const normalizedEdge = {
      ...edge,
      key,
      sourceId,
      targetId
    };

    normalizedEdges.push(normalizedEdge);
    edgesByKey.set(key, normalizedEdge);
    outgoingById.get(sourceId)?.push(targetId);
    incomingById.get(targetId)?.push(sourceId);
    outgoingEdgesById.get(sourceId)?.push(normalizedEdge);
    incomingEdgesById.get(targetId)?.push(normalizedEdge);
  });

  return {
    nodes,
    normalizedEdges,
    nodesById,
    edgesByKey,
    outgoingById,
    incomingById,
    outgoingEdgesById,
    incomingEdgesById
  };
}

export function collectReachableSubgraph(index, startNodeIds, {
  direction = "both",
  maxDepth = Number.POSITIVE_INFINITY,
  edgeFilter = null
} = {}) {
  const normalizedStartIds = [...new Set(
    (Array.isArray(startNodeIds) ? startNodeIds : [startNodeIds])
      .map(normalizeNodeId)
      .filter((nodeId) => nodeId && index.nodesById.has(nodeId))
  )];

  const visitedNodeIds = new Set(normalizedStartIds);
  const traversedEdgeKeys = new Set();
  const depthByNodeId = new Map(normalizedStartIds.map((nodeId) => [nodeId, 0]));
  const queue = normalizedStartIds.map((nodeId) => ({ nodeId, depth: 0 }));
  const safeMaxDepth = getNormalizedDepth(maxDepth);

  for (let indexOffset = 0; indexOffset < queue.length; indexOffset += 1) {
    const { nodeId, depth } = queue[indexOffset];
    if (depth >= safeMaxDepth) continue;

    for (const traversal of getTraversalSpecs(index, nodeId, direction)) {
      for (const edge of traversal.edges) {
        if (edgeFilter && !edgeFilter(edge)) continue;
        const nextNodeId = traversal.getNextNodeId(edge);
        if (!nextNodeId || !index.nodesById.has(nextNodeId)) continue;

        traversedEdgeKeys.add(edge.key);
        if (visitedNodeIds.has(nextNodeId)) continue;

        visitedNodeIds.add(nextNodeId);
        depthByNodeId.set(nextNodeId, depth + 1);
        queue.push({ nodeId: nextNodeId, depth: depth + 1 });
      }
    }
  }

  return {
    nodeIds: visitedNodeIds,
    edgeKeys: traversedEdgeKeys,
    depthByNodeId
  };
}

export function collectCollapsedNodeIds(index, collapsedNodeIds = []) {
  const hiddenNodeIds = new Set();
  const hiddenCountsByNodeId = new Map();

  for (const collapsedNodeId of [...new Set((Array.isArray(collapsedNodeIds) ? collapsedNodeIds : []).map(normalizeNodeId).filter(Boolean))]) {
    const descendants = collectReachableSubgraph(index, collapsedNodeId, {
      direction: "downstream",
      edgeFilter: (edge) => isHierarchyLinkType(edge.type)
    });

    let hiddenCount = 0;
    for (const descendantNodeId of descendants.nodeIds) {
      if (descendantNodeId === collapsedNodeId) continue;
      hiddenNodeIds.add(descendantNodeId);
      hiddenCount += 1;
    }
    hiddenCountsByNodeId.set(collapsedNodeId, hiddenCount);
  }

  return {
    hiddenNodeIds,
    hiddenCountsByNodeId
  };
}

export function getHierarchyPath(index, startNodeId, targetTypes = ["goal"]) {
  const normalizedStartNodeId = normalizeNodeId(startNodeId);
  if (!normalizedStartNodeId || !index.nodesById.has(normalizedStartNodeId)) {
    return { nodeIds: [], edgeKeys: [] };
  }

  const normalizedTargetTypes = new Set((Array.isArray(targetTypes) ? targetTypes : [targetTypes]).map((type) => String(type ?? "").trim().toLowerCase()));
  const startNode = index.nodesById.get(normalizedStartNodeId);
  if (normalizedTargetTypes.has(String(startNode?.type ?? "").trim().toLowerCase())) {
    return { nodeIds: [normalizedStartNodeId], edgeKeys: [] };
  }

  const queue = [normalizedStartNodeId];
  const visitedNodeIds = new Set(queue);
  const previousByNodeId = new Map();
  let targetNodeId = null;

  for (let offset = 0; offset < queue.length && !targetNodeId; offset += 1) {
    const currentNodeId = queue[offset];
    const candidateEdges = getSortedHierarchyParentEdges(index, currentNodeId);

    for (const edge of candidateEdges) {
      const parentNodeId = edge.sourceId;
      if (!parentNodeId || visitedNodeIds.has(parentNodeId)) continue;

      visitedNodeIds.add(parentNodeId);
      previousByNodeId.set(parentNodeId, {
        childNodeId: currentNodeId,
        edgeKey: edge.key
      });

      const parentNode = index.nodesById.get(parentNodeId);
      if (normalizedTargetTypes.has(String(parentNode?.type ?? "").trim().toLowerCase())) {
        targetNodeId = parentNodeId;
        break;
      }

      queue.push(parentNodeId);
    }
  }

  if (!targetNodeId) {
    return { nodeIds: [normalizedStartNodeId], edgeKeys: [] };
  }

  const nodeIds = [targetNodeId];
  const edgeKeys = [];
  let cursor = targetNodeId;

  while (previousByNodeId.has(cursor)) {
    const step = previousByNodeId.get(cursor);
    edgeKeys.push(step.edgeKey);
    nodeIds.push(step.childNodeId);
    cursor = step.childNodeId;
  }

  return {
    nodeIds,
    edgeKeys
  };
}

export function getAncestorAtLevel(index, startNodeId, targetType) {
  const normalizedTargetType = String(targetType ?? "").trim().toLowerCase();
  if (!normalizedTargetType) return null;

  const hierarchyPath = getHierarchyPath(index, startNodeId, [normalizedTargetType]);
  const ancestorNodeId = hierarchyPath.nodeIds.find((nodeId) => index.nodesById.get(nodeId)?.type === normalizedTargetType) ?? null;
  return ancestorNodeId ? index.nodesById.get(ancestorNodeId) ?? null : null;
}

export function getBranchColorKey(index, startNodeId, targetType) {
  const ancestor = getAncestorAtLevel(index, startNodeId, targetType);
  return ancestor ? `${targetType}:${ancestor.id}` : null;
}

export function getDescendants(index, startNodeId) {
  const traversal = collectReachableSubgraph(index, startNodeId, {
    direction: "downstream",
    edgeFilter: (edge) => isHierarchyLinkType(edge.type)
  });

  return [...traversal.nodeIds]
    .filter((nodeId) => nodeId !== normalizeNodeId(startNodeId))
    .sort((left, right) => compareNodes(index.nodesById.get(left), index.nodesById.get(right)));
}

export function buildDomainMembership(index) {
  const domainIdByNodeId = new Map();
  const groups = new Map();

  for (const node of index.nodes) {
    let domainId = null;

    if (node.type === "domain") {
      domainId = node.id;
    } else if (!["goal", "area"].includes(node.type)) {
      domainId = getAncestorAtLevel(index, node.id, "domain")?.id ?? null;
      if (!domainId) domainId = UNGROUPED_DOMAIN_ID;
    }

    domainIdByNodeId.set(node.id, domainId);
    if (!domainId) continue;

    if (!groups.has(domainId)) {
      groups.set(domainId, {
        id: domainId,
        label: domainId === UNGROUPED_DOMAIN_ID ? "Ungrouped" : String(index.nodesById.get(domainId)?.label ?? "Domain"),
        nodeIds: []
      });
    }
    groups.get(domainId).nodeIds.push(node.id);
  }

  const orderedGroupIds = [...groups.keys()].sort((left, right) => {
    if (left === UNGROUPED_DOMAIN_ID) return 1;
    if (right === UNGROUPED_DOMAIN_ID) return -1;
    return String(groups.get(left)?.label ?? "").localeCompare(String(groups.get(right)?.label ?? ""));
  });

  return {
    domainIdByNodeId,
    groups,
    orderedGroupIds
  };
}

export function buildGraphLayout(nodes, domainMembership) {
  const visibleNodes = Array.isArray(nodes) ? nodes : [];
  const domainLaneById = new Map(domainMembership?.orderedGroupIds?.map((domainId, index) => [domainId, index]) ?? []);
  const groupedNodes = new Map();

  for (const node of visibleNodes) {
    if (["goal", "area"].includes(node.type)) continue;
    const domainId = domainMembership?.domainIdByNodeId?.get(node.id) ?? UNGROUPED_DOMAIN_ID;
    const currentNodes = groupedNodes.get(domainId) ?? [];
    currentNodes.push(node);
    groupedNodes.set(domainId, currentNodes);
  }

  const nodeVerticalOrderById = new Map();

  for (const [domainId, domainNodes] of groupedNodes.entries()) {
    const orderedNodes = [...domainNodes].sort(compareNodes);
    const centeredOffset = (orderedNodes.length - 1) / 2;
    orderedNodes.forEach((node, index) => {
      nodeVerticalOrderById.set(node.id, index - centeredOffset);
    });
    if (!domainLaneById.has(domainId)) {
      domainLaneById.set(domainId, domainLaneById.size);
    }
  }

  return {
    domainLaneById,
    nodeVerticalOrderById,
    laneCount: Math.max(domainLaneById.size, 1)
  };
}

export function getSortedConnectedNodes(index, nodeId, {
  direction = "both",
  edgeFilter = null
} = {}) {
  const normalizedNodeId = normalizeNodeId(nodeId);
  if (!normalizedNodeId || !index.nodesById.has(normalizedNodeId)) return [];

  const connectedNodeIds = new Set();

  for (const traversal of getTraversalSpecs(index, normalizedNodeId, direction)) {
    for (const edge of traversal.edges) {
      if (edgeFilter && !edgeFilter(edge)) continue;
      const nextNodeId = traversal.getNextNodeId(edge);
      if (!nextNodeId || !index.nodesById.has(nextNodeId)) continue;
      connectedNodeIds.add(nextNodeId);
    }
  }

  return [...connectedNodeIds]
    .map((connectedNodeId) => index.nodesById.get(connectedNodeId))
    .sort(compareNodes);
}
