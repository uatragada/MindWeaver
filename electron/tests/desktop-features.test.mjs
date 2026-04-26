import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildProtocolWindowParams,
  extractProtocolUrl
} from "../protocol-utils.mjs";
import {
  decodeXmlText,
  extractImportFile,
  extractTextFromPptx
} from "../import-extractors.mjs";
import { makeQuickNoteSubmitter } from "../quick-note-actions.mjs";
import { trayMenuLabels } from "../tray-menu-model.mjs";

test("custom protocol launch picks the MindWeaver URL and converts query values to app params", () => {
  const protocolUrl = extractProtocolUrl([
    "MindWeaver.exe",
    "--flag",
    "mindweaver://open?panel=agents&sourceType=pdf&sessionId=session-1"
  ]);

  assert.equal(protocolUrl, "mindweaver://open?panel=agents&sourceType=pdf&sessionId=session-1");
  assert.deepEqual(buildProtocolWindowParams(protocolUrl), {
    rightPanel: "agents",
    sourceType: "pdf",
    sessionId: "session-1"
  });
});

test("tray menu model includes the user-facing background service actions", () => {
  assert.deepEqual(trayMenuLabels, [
    "Open MindWeaver",
    "Create Note",
    "Paste Clipboard Text",
    "Import PDF / Office / Text",
    "Agent Access",
    "Extension Setup",
    "Quit MindWeaver"
  ]);
});

test("tray import extraction supports text, markdown, pdf, docx, pptx, and rejects unsupported files", async () => {
  const reads = [];
  const readFileImpl = async (filePath, encoding) => {
    reads.push([filePath, encoding]);
    if (String(filePath).endsWith(".pdf")) return Buffer.from("pdf bytes");
    if (String(filePath).endsWith(".pptx")) return Buffer.from("pptx bytes");
    return `contents of ${filePath}`;
  };
  const pdfParseImpl = async (buffer) => {
    assert.equal(buffer.toString(), "pdf bytes");
    return { text: "PDF text" };
  };
  const mammothImpl = {
    async extractRawText({ path }) {
      assert.equal(path, "C:\\docs\\notes.docx");
      return { value: "Word text" };
    }
  };
  const zipImpl = {
    async loadAsync(buffer) {
      assert.equal(buffer.toString(), "pptx bytes");
      return {
        files: {
          "ppt/slides/slide10.xml": {
            async: async () => "<a:t>Later</a:t>"
          },
          "ppt/slides/slide2.xml": {
            async: async () => "<a:t>Earlier &amp; clearer</a:t>"
          },
          "ppt/notesSlides/notesSlide1.xml": {
            async: async () => "<a:t>ignored</a:t>"
          }
        }
      };
    }
  };
  const deps = { readFileImpl, pdfParseImpl, mammothImpl, zipImpl };

  assert.deepEqual(await extractImportFile("C:\\docs\\plain.txt", deps), {
    title: "plain.txt",
    content: "contents of C:\\docs\\plain.txt",
    sourceType: "note"
  });
  assert.deepEqual(await extractImportFile("C:\\docs\\outline.md", deps), {
    title: "outline.md",
    content: "contents of C:\\docs\\outline.md",
    sourceType: "markdown"
  });
  assert.deepEqual(await extractImportFile("C:\\docs\\paper.pdf", deps), {
    title: "paper.pdf",
    content: "PDF text",
    sourceType: "pdf"
  });
  assert.deepEqual(await extractImportFile("C:\\docs\\notes.docx", deps), {
    title: "notes.docx",
    content: "Word text",
    sourceType: "doc"
  });
  assert.deepEqual(await extractImportFile("C:\\docs\\deck.pptx", deps), {
    title: "deck.pptx",
    content: "Earlier & clearer\n\nLater",
    sourceType: "doc"
  });
  await assert.rejects(() => extractImportFile("C:\\docs\\sheet.xlsx", deps), /not a supported tray import format/);
  assert.ok(reads.some(([filePath]) => filePath === "C:\\docs\\plain.txt"));
});

test("pptx text extraction sorts slides numerically and decodes XML entities", async () => {
  const content = await extractTextFromPptx("deck.pptx", {
    readFileImpl: async () => Buffer.from("zip"),
    zipImpl: {
      async loadAsync() {
        return {
          files: {
            "ppt/slides/slide11.xml": { async: async () => "<a:t>third</a:t>" },
            "ppt/slides/slide1.xml": { async: async () => "<a:t>first &lt;ok&gt;</a:t>" },
            "ppt/slides/slide2.xml": { async: async () => "<a:t>second &quot;quoted&quot;</a:t>" }
          }
        };
      }
    }
  });

  assert.equal(content, "first <ok>\n\nsecond \"quoted\"\n\nthird");
  assert.equal(decodeXmlText("&amp;&lt;&gt;&quot;&apos;"), "&<>\"'");
});

test("quick note creates a labeled node and attaches the note body", async () => {
  const calls = [];
  const submitQuickNote = makeQuickNoteSubmitter({
    getRuntimeUrl: () => "http://127.0.0.1:3001",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/api/nodes")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ node: { id: "node 1", label: "Thread pool" } })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ node: { id: "node 1" } })
      };
    }
  });

  const result = await submitQuickNote({
    sessionId: "session-1",
    label: "Thread pool",
    type: "concept",
    description: "Executor notes",
    content: "Bounded work queue."
  });

  assert.equal(result.message, "Created concept node: Thread pool");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "http://127.0.0.1:3001/api/nodes");
  assert.equal(calls[1].url, "http://127.0.0.1:3001/api/nodes/node%201");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    sessionId: "session-1",
    type: "concept",
    label: "Thread pool",
    description: "Executor notes",
    note: "Bounded work queue."
  });
});

test("quick note imports note text when no new node label is provided", async () => {
  const calls = [];
  const fixedDate = new Date("2026-04-25T12:00:00-04:00");
  const submitQuickNote = makeQuickNoteSubmitter({
    getRuntimeUrl: () => "http://127.0.0.1:3001",
    now: () => fixedDate,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true })
      };
    }
  });

  const result = await submitQuickNote({
    sessionId: "session-2",
    content: "A loose note from the tray."
  });

  assert.match(result.message, /^Imported note: Tray note - /);
  assert.equal(calls[0].url, "http://127.0.0.1:3001/api/import");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    sessionId: "session-2",
    sourceType: "note",
    title: result.message.replace("Imported note: ", ""),
    content: "A loose note from the tray."
  });
});

test("quick note validation keeps empty and destinationless notes out of the graph", async () => {
  const submitQuickNote = makeQuickNoteSubmitter({
    getRuntimeUrl: () => "http://127.0.0.1:3001",
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    }
  });

  await assert.rejects(() => submitQuickNote({ label: "No map" }), /Choose a destination map/);
  await assert.rejects(() => submitQuickNote({ sessionId: "session-1" }), /Add note text or a node label/);
});

test("setup UI contains agent connection, launcher test, extension setup, and checklist controls", async () => {
  const html = await readFile(resolve("electron", "setup.html"), "utf8");
  for (const requiredText of [
    "Connect Coding Agent",
    "Copy Codex Config",
    "Add to Codex Config",
    "Copy Claude Code Config",
    "Open Config Help",
    "Test Agent Launcher",
    "Copy Chrome Extension Folder",
    "Open Chrome Setup",
    "Post-install checklist"
  ]) {
    assert.match(html, new RegExp(requiredText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
