import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MarkdownNotePreview from "../src/components/notes/MarkdownNotePreview.js";

test("MarkdownNotePreview renders common markdown structures for node notes", () => {
  const html = renderToStaticMarkup(createElement(MarkdownNotePreview, {
    content: [
      "# Retry Safety",
      "",
      "- dedupe tokens",
      "- idempotent writes",
      "",
      "| Signal | Meaning |",
      "| --- | --- |",
      "| key | dedupe token |",
      "",
      "```js",
      "const eventKey = \"evt-42\";",
      "```"
    ].join("\n")
  }));

  assert.match(html, /<h1>Retry Safety<\/h1>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<table>/);
  assert.match(html, /<code class="language-js">const eventKey = &quot;evt-42&quot;;/);
});

test("MarkdownNotePreview shows the empty message when the note is blank", () => {
  const html = renderToStaticMarkup(createElement(MarkdownNotePreview, {
    content: "   ",
    emptyMessage: "Nothing here yet."
  }));

  assert.match(html, /Nothing here yet\./);
  assert.doesNotMatch(html, /<p>/);
});
