import assert from "node:assert/strict";
import test from "node:test";
import {
  createNodeCollisionForce,
  getBranchVisualStyle,
  getChargeStrength,
  getLinkDistance,
  getLinkVisualStyle,
  getNodeMetrics,
  getNodeRenderDetail,
  getNodeVisualStyle,
  NODE_HIERARCHY_LEVELS,
  NODE_TYPE_LEGEND
} from "../src/lib/graph-rendering.js";

function createMockContext() {
  let measureCount = 0;
  return {
    font: "",
    get measureCount() {
      return measureCount;
    },
    save() {},
    restore() {},
    measureText(value) {
      measureCount += 1;
      return { width: String(value ?? "").length * 6 };
    }
  };
}

test("hierarchy levels stay stable for graph sizing rules", () => {
  assert.deepEqual(NODE_HIERARCHY_LEVELS, {
    goal: 0,
    area: 1,
    domain: 2,
    topic: 3,
    skill: 4,
    concept: 5
  });
});

test("node visual style grows with hierarchy scale", () => {
  const base = getNodeVisualStyle({ type: "goal" });
  const scaled = getNodeVisualStyle({ type: "goal", hierarchyScale: 1.2 });

  assert.ok(scaled.width > base.width);
  assert.ok(scaled.height > base.height);
  assert.ok(scaled.fontSize >= base.fontSize);
});

test("node types keep a clear visual hierarchy with unique legend colors", () => {
  const goal = getNodeVisualStyle({ type: "goal" });
  const area = getNodeVisualStyle({ type: "area" });
  const domain = getNodeVisualStyle({ type: "domain" });
  const topic = getNodeVisualStyle({ type: "topic" });
  const skill = getNodeVisualStyle({ type: "skill" });
  const concept = getNodeVisualStyle({ type: "concept" });

  assert.ok(goal.width > area.width);
  assert.ok(area.width > domain.width);
  assert.ok(domain.width > topic.width);
  assert.ok(topic.width > skill.width);
  assert.ok(skill.width > concept.width);
  assert.ok(goal.width - concept.width >= 100);
  assert.equal(new Set(NODE_TYPE_LEGEND.map((item) => item.fill)).size, 6);
});

test("branch palettes stay deterministic and provide a neutral fallback", () => {
  assert.deepEqual(getBranchVisualStyle("area:technology"), getBranchVisualStyle("area:technology"));
  assert.ok(new Set([
    JSON.stringify(getBranchVisualStyle("area:technology")),
    JSON.stringify(getBranchVisualStyle("domain:messaging")),
    JSON.stringify(getBranchVisualStyle("topic:async"))
  ]).size >= 2);
  assert.ok(getBranchVisualStyle(null).fill);
});

test("node metrics wrap long labels into bounded card dimensions", () => {
  const metrics = getNodeMetrics(
    {
      type: "domain",
      label: "Event driven systems for production pipelines",
      hierarchyScale: 1,
      x: 120,
      y: 80
    },
    createMockContext()
  );

  assert.equal(metrics.fill, metrics.style.fill);
  assert.equal(metrics.stroke, metrics.style.stroke);
  assert.ok(metrics.width >= metrics.style.width);
  assert.ok(metrics.height >= metrics.style.height);
  assert.ok(metrics.lines.length >= 1);
  assert.ok(metrics.lines.length <= metrics.style.maxLines);
  assert.equal(typeof metrics.textY, "number");
});

test("node metrics cache repeated layout work for the same label and style", () => {
  const ctx = createMockContext();
  const first = getNodeMetrics(
    {
      type: "skill",
      label: "Queue backed continuous page ingestion",
      hierarchyScale: 1,
      x: 20,
      y: 24
    },
    ctx
  );
  const measureCountAfterFirstPass = ctx.measureCount;
  const second = getNodeMetrics(
    {
      type: "skill",
      label: "Queue backed continuous page ingestion",
      hierarchyScale: 1,
      x: 44,
      y: 60
    },
    ctx
  );

  assert.equal(ctx.measureCount, measureCountAfterFirstPass);
  assert.equal(first.width, second.width);
  assert.equal(second.x, 44 - second.width / 2);
  assert.equal(second.y, 60 - second.height / 2);
});

test("collision force pushes overlapping nodes apart", () => {
  const nodes = [
    { type: "concept", x: 0, y: 0, vx: 0, vy: 0, index: 0 },
    { type: "concept", x: 2, y: 0, vx: 0, vy: 0, index: 1 }
  ];
  const force = createNodeCollisionForce();
  const startingDistance = Math.hypot(nodes[1].x - nodes[0].x, nodes[1].y - nodes[0].y);

  force.initialize(nodes);
  force(1);
  for (const node of nodes) {
    node.x += node.vx ?? 0;
    node.y += node.vy ?? 0;
  }

  const endingDistance = Math.hypot(nodes[1].x - nodes[0].x, nodes[1].y - nodes[0].y);
  assert.ok(endingDistance > startingDistance);
});

test("graph physics helpers restore the committed spacing behavior", () => {
  assert.ok(Math.abs(getChargeStrength(60)) > Math.abs(getChargeStrength(12)));
  assert.equal(getNodeRenderDetail(0.3), "minimal");
  assert.equal(getNodeRenderDetail(0.5), "compact");
  assert.equal(getNodeRenderDetail(1), "full");

  const topLevelDistance = getLinkDistance({
    type: "focuses_on",
    source: { type: "goal" },
    target: { type: "domain" }
  });
  const conceptDistance = getLinkDistance({
    type: "builds_on",
    source: { type: "skill" },
    target: { type: "concept" }
  });

  assert.ok(topLevelDistance > conceptDistance);
  assert.ok(getLinkVisualStyle({ type: "needs" }).dash.length > 0);
  assert.notEqual(getLinkVisualStyle({ type: "focuses_on" }).stroke, getLinkVisualStyle({ type: "builds_on" }).stroke);
});
