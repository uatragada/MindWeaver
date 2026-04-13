import assert from "node:assert/strict";
import test from "node:test";
import {
  createNodeCollisionForce,
  getNodeMetrics,
  getNodeVisualStyle,
  NODE_HIERARCHY_LEVELS
} from "../src/lib/graph-rendering.js";

function createMockContext() {
  return {
    font: "",
    save() {},
    restore() {},
    measureText(value) {
      return { width: String(value ?? "").length * 6 };
    }
  };
}

test("hierarchy levels stay stable for graph sizing rules", () => {
  assert.deepEqual(NODE_HIERARCHY_LEVELS, {
    goal: 0,
    domain: 1,
    skill: 2,
    concept: 3
  });
});

test("node visual style grows with hierarchy scale", () => {
  const base = getNodeVisualStyle({ type: "goal" });
  const scaled = getNodeVisualStyle({ type: "goal", hierarchyScale: 1.2 });

  assert.ok(scaled.width > base.width);
  assert.ok(scaled.height > base.height);
  assert.ok(scaled.fontSize >= base.fontSize);
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

test("collision force pushes overlapping nodes apart", () => {
  const nodes = [
    { type: "concept", x: 0, y: 0 },
    { type: "concept", x: 2, y: 0 }
  ];
  const force = createNodeCollisionForce();
  const startingDistance = Math.hypot(nodes[1].x - nodes[0].x, nodes[1].y - nodes[0].y);

  force.initialize(nodes);
  force();

  const endingDistance = Math.hypot(nodes[1].x - nodes[0].x, nodes[1].y - nodes[0].y);
  assert.ok(endingDistance > startingDistance);
});
