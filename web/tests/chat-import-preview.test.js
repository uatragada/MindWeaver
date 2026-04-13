import assert from "node:assert/strict";
import test from "node:test";
import { getChatHistoryImportPreview } from "../src/lib/chat-import-preview.js";

test("chat import preview stays idle for empty input", () => {
  assert.deepEqual(getChatHistoryImportPreview(""), { state: "idle" });
});

test("chat import preview parses fenced JSON and reports cleanup warnings", () => {
  const preview = getChatHistoryImportPreview(`
\`\`\`json
{
  "schema_version": "mindweaver.chat_import.v1",
  "provider": "chatgpt",
  "title": "System design history",
  "summary": "Covers architecture and event workflows.",
  "conversation_highlights": [
    { "title": "Kafka tradeoffs", "summary": "Compared queue semantics." }
  ],
  "nodes": [
    { "type": "domain", "label": "Distributed Systems" },
    { "type": "skill", "label": "distributed system" },
    { "type": "concept", "label": "Event handling" }
  ],
  "relationships": [
    { "source": "distributed systems", "target": "distributed systems", "type": "related" },
    { "source": "distributed systems", "target": "Event handling", "type": "supports" }
  ]
}
\`\`\`
  `);

  assert.equal(preview.state, "ready");
  assert.equal(preview.nodeCount, 3);
  assert.equal(preview.relationshipCount, 2);
  assert.equal(preview.highlightCount, 1);
  assert.ok(preview.warnings.some((warning) => warning.includes("duplicate node label")));
  assert.ok(preview.warnings.some((warning) => warning.includes("self-link relationship")));
  assert.deepEqual(preview.issues, []);
});

test("chat import preview surfaces missing schema requirements", () => {
  const preview = getChatHistoryImportPreview(JSON.stringify({
    provider: "mystery",
    title: "",
    summary: "",
    nodes: []
  }));

  assert.equal(preview.state, "ready");
  assert.ok(preview.issues.includes('schema_version must be "mindweaver.chat_import.v1".'));
  assert.ok(preview.issues.includes("provider must be chatgpt, claude, or other."));
  assert.ok(preview.issues.includes("title is required."));
  assert.ok(preview.issues.includes("summary is required."));
  assert.ok(preview.issues.includes("nodes must contain at least one item."));
});

test("chat import preview returns parse guidance for incomplete JSON", () => {
  const preview = getChatHistoryImportPreview("{ nope");

  assert.equal(preview.state, "error");
  assert.match(preview.message, /Could not parse JSON yet/i);
});
