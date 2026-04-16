import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDomainMembership,
  buildGraphIndex,
  buildGraphLayout,
  collectCollapsedNodeIds,
  collectReachableSubgraph,
  getAncestorAtLevel,
  getBranchColorKey,
  getDescendants,
  getHierarchyPath,
  getSortedConnectedNodes,
  UNGROUPED_DOMAIN_ID
} from "../src/lib/graph-view.js";

function createGraphState() {
  return {
    nodes: [
      { id: "goal:systems", type: "goal", label: "Systems Mastery" },
      { id: "area:technology", type: "area", label: "Technology" },
      { id: "domain:messaging", type: "domain", label: "Messaging" },
      { id: "domain:policy", type: "domain", label: "Policy" },
      { id: "topic:async", type: "topic", label: "Async Messaging" },
      { id: "topic:diplomacy", type: "topic", label: "Diplomatic Systems" },
      { id: "skill:delivery", type: "skill", label: "Delivery Guarantees" },
      { id: "skill:diplomacy", type: "skill", label: "Diplomatic Modeling" },
      { id: "concept:idempotency", type: "concept", label: "Idempotency" },
      { id: "concept:retry", type: "concept", label: "Retry Queues" },
      { id: "concept:treaty", type: "concept", label: "Treaty Systems" },
      { id: "concept:bridge", type: "concept", label: "Bridge Concept" }
    ],
    edges: [
      { key: "goal-area-technology", source: "goal:systems", target: "area:technology", type: "focuses_on" },
      { key: "area-domain-messaging", source: "area:technology", target: "domain:messaging", type: "contains" },
      { key: "area-domain-policy", source: "area:technology", target: "domain:policy", type: "contains" },
      { key: "domain-topic-async", source: "domain:messaging", target: "topic:async", type: "contains" },
      { key: "domain-topic-diplomacy", source: "domain:policy", target: "topic:diplomacy", type: "contains" },
      { key: "topic-skill-delivery", source: "topic:async", target: "skill:delivery", type: "contains" },
      { key: "topic-skill-diplomacy", source: "topic:diplomacy", target: "skill:diplomacy", type: "contains" },
      { key: "skill-concept-idempotency", source: "skill:delivery", target: "concept:idempotency", type: "builds_on" },
      { key: "skill-concept-retry", source: "skill:delivery", target: "concept:retry", type: "builds_on" },
      { key: "skill-concept-treaty", source: "skill:diplomacy", target: "concept:treaty", type: "builds_on" },
      { key: "cross-domain-related", source: "concept:idempotency", target: "concept:bridge", type: "related" }
    ]
  };
}

test("reachable subgraph respects direction and hop depth", () => {
  const index = buildGraphIndex(createGraphState());

  const downstream = collectReachableSubgraph(index, "skill:delivery", {
    direction: "downstream",
    maxDepth: 1
  });
  assert.deepEqual(
    [...downstream.nodeIds].sort(),
    ["concept:idempotency", "concept:retry", "skill:delivery"]
  );

  const upstream = collectReachableSubgraph(index, "concept:idempotency", {
    direction: "upstream",
    maxDepth: 2
  });
  assert.deepEqual(
    [...upstream.nodeIds].sort(),
    ["concept:idempotency", "skill:delivery", "topic:async"]
  );

  const bothDirections = collectReachableSubgraph(index, "concept:idempotency", {
    direction: "both",
    maxDepth: 1
  });
  assert.deepEqual(
    [...bothDirections.nodeIds].sort(),
    ["concept:bridge", "concept:idempotency", "skill:delivery"]
  );
});

test("collapsed nodes hide only hierarchy descendants", () => {
  const index = buildGraphIndex(createGraphState());
  const collapsed = collectCollapsedNodeIds(index, ["domain:messaging"]);

  assert.ok(collapsed.hiddenNodeIds.has("skill:delivery"));
  assert.ok(collapsed.hiddenNodeIds.has("concept:idempotency"));
  assert.ok(collapsed.hiddenNodeIds.has("concept:retry"));
  assert.ok(!collapsed.hiddenNodeIds.has("concept:bridge"));
  assert.equal(collapsed.hiddenCountsByNodeId.get("domain:messaging"), 4);
});

test("hierarchy paths recover root and domain breadcrumbs", () => {
  const index = buildGraphIndex(createGraphState());

  const toGoal = getHierarchyPath(index, "concept:idempotency", ["goal"]);
  assert.deepEqual(toGoal.nodeIds, [
    "goal:systems",
    "area:technology",
    "domain:messaging",
    "topic:async",
    "skill:delivery",
    "concept:idempotency"
  ]);
  assert.deepEqual(toGoal.edgeKeys, [
    "goal-area-technology",
    "area-domain-messaging",
    "domain-topic-async",
    "topic-skill-delivery",
    "skill-concept-idempotency"
  ]);

  const toDomain = getHierarchyPath(index, "concept:idempotency", ["domain"]);
  assert.deepEqual(toDomain.nodeIds, [
    "domain:messaging",
    "topic:async",
    "skill:delivery",
    "concept:idempotency"
  ]);
});

test("domain membership groups descendants and preserves ungrouped nodes", () => {
  const index = buildGraphIndex(createGraphState());
  const membership = buildDomainMembership(index);

  assert.equal(membership.domainIdByNodeId.get("domain:messaging"), "domain:messaging");
  assert.equal(membership.domainIdByNodeId.get("topic:async"), "domain:messaging");
  assert.equal(membership.domainIdByNodeId.get("skill:delivery"), "domain:messaging");
  assert.equal(membership.domainIdByNodeId.get("concept:idempotency"), "domain:messaging");
  assert.equal(membership.domainIdByNodeId.get("concept:bridge"), UNGROUPED_DOMAIN_ID);
  assert.ok(membership.groups.get("domain:messaging").nodeIds.includes("concept:retry"));
  assert.ok(membership.groups.get(UNGROUPED_DOMAIN_ID).nodeIds.includes("concept:bridge"));
});

test("graph layout assigns domain lanes and stable per-domain ordering", () => {
  const state = createGraphState();
  const index = buildGraphIndex(state);
  const membership = buildDomainMembership(index);
  const layout = buildGraphLayout(state.nodes, membership);

  assert.ok(layout.laneCount >= 2);
  assert.ok(layout.domainLaneById.has("domain:messaging"));
  assert.ok(layout.domainLaneById.has("domain:policy"));
  assert.equal(typeof layout.nodeVerticalOrderById.get("concept:idempotency"), "number");
  assert.equal(typeof layout.nodeVerticalOrderById.get("concept:treaty"), "number");
});

test("ancestor and branch helpers resolve the nearest valid hierarchy lineage", () => {
  const index = buildGraphIndex(createGraphState());

  assert.equal(getAncestorAtLevel(index, "concept:idempotency", "area")?.id, "area:technology");
  assert.equal(getAncestorAtLevel(index, "topic:async", "topic")?.id, "topic:async");
  assert.equal(getBranchColorKey(index, "concept:idempotency", "domain"), "domain:domain:messaging");
  assert.deepEqual(getDescendants(index, "domain:messaging"), [
    "topic:async",
    "skill:delivery",
    "concept:idempotency",
    "concept:retry"
  ]);
});

test("connected nodes are sorted by graph hierarchy for keyboard navigation", () => {
  const index = buildGraphIndex(createGraphState());
  const downstream = getSortedConnectedNodes(index, "domain:messaging", { direction: "downstream" });

  assert.deepEqual(
    downstream.map((node) => node.id),
    ["topic:async"]
  );

  const bothDirections = getSortedConnectedNodes(index, "concept:idempotency", { direction: "both" });
  assert.deepEqual(
    bothDirections.map((node) => node.id),
    ["skill:delivery", "concept:bridge"]
  );
});
