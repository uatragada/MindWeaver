import assert from "node:assert/strict";
import test from "node:test";
import {
  describeReviewDate,
  formatSourceTypeLabel,
  getMapName,
  getSafeFileName,
  groupVerificationResults
} from "../src/lib/formatting.js";

test("groupVerificationResults buckets answers by correctness", () => {
  const result = groupVerificationResults(
    [
      { id: "q-1", conceptId: "concept-1", correct: 2 },
      { id: "q-2", conceptId: "concept-2", correct: 1 },
      { id: "q-3", conceptId: "concept-3", correct: 0 }
    ],
    {
      "q-1": 2,
      "q-2": 0
    }
  );

  assert.deepEqual(result, {
    correct: ["concept-1"],
    incorrect: ["concept-2"]
  });
});

test("getSafeFileName normalizes map exports", () => {
  assert.equal(getSafeFileName("  My MindWeaver Map!!! "), "my-mindweaver-map");
  assert.equal(getSafeFileName(""), "mindweaver-map");
});

test("getMapName prefers the stored session goal but falls back cleanly", () => {
  assert.equal(getMapName({ goal: "Distributed Systems" }), "Distributed Systems");
  assert.equal(getMapName({ goal: "   " }), "Untitled map");
  assert.equal(getMapName(null, "Fallback map"), "Fallback map");
});

test("formatSourceTypeLabel recognizes built-in and AI chat imports", () => {
  assert.equal(formatSourceTypeLabel("repo"), "Repository / Docs");
  assert.equal(formatSourceTypeLabel("chatgpt"), "ChatGPT History");
  assert.equal(formatSourceTypeLabel("custom-type"), "custom-type");
});

test("describeReviewDate reports due-now for past timestamps", () => {
  assert.equal(describeReviewDate(Date.now() - 5_000), "Due now");
  assert.match(describeReviewDate(Date.now() + 86_400_000), /^Next review:/);
});
