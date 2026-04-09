import test from "node:test";
import assert from "node:assert/strict";
import { createBackgroundController } from "../lib/background-controller.js";

function createChromeMock() {
  const storageState = {};
  return {
    storageState,
    storage: {
      local: {
        async set(values) {
          Object.assign(storageState, values);
        }
      }
    },
    tabs: {
      async query() {
        return [{ id: 17, title: "Article", url: "https://docs.example/article" }];
      }
    },
    scripting: {
      async executeScript() {
        return [];
      }
    },
    contextMenus: {
      create() {},
      onClicked: { addListener() {} }
    },
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: { addListener() {} }
    }
  };
}

test("sendToMindWeaver skips capture when no map is active", async () => {
  const chromeApi = createChromeMock();
  const controller = createBackgroundController({
    chromeApi,
    client: {
      async fetchJson() {
        return { activeSessionId: null, activeSession: null };
      }
    },
    now: () => 1234
  });

  const result = await controller.sendToMindWeaver({
    sourceType: "page",
    title: "Example",
    url: "https://example.com"
  });

  assert.deepEqual(result, { ok: false, skipped: true, reason: "No active map." });
  assert.deepEqual(chromeApi.storageState, {
    lastCaptureAt: 1234,
    lastCaptureTitle: "Example",
    lastCaptureStatus: "skipped",
    lastCaptureMessage: "Choose or create a destination map before saving evidence.",
    lastCaptureTarget: ""
  });
});

test("sendToMindWeaver posts highlights through the import endpoint and records the target", async () => {
  const chromeApi = createChromeMock();
  const requests = [];
  const controller = createBackgroundController({
    chromeApi,
    client: {
      async fetchJson(path) {
        assert.equal(path, "/api/session-target?limit=24");
        return {
          activeSessionId: "session-b",
          activeSession: { id: "session-b", goal: "Queue patterns" }
        };
      },
      async request(path, options) {
        requests.push({ path, options });
        return {
          status: 200,
          payload: { ok: true, deduped: false }
        };
      }
    },
    now: () => 4567
  });

  const result = await controller.sendToMindWeaver({
    sourceType: "highlight",
    title: "Highlight: Delivery guarantees",
    url: "https://example.com/highlight",
    content: "At least once delivery retries until acknowledged."
  });

  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/api/import");
  assert.match(requests[0].options.body, /session-b/);
  assert.equal(chromeApi.storageState.lastCaptureStatus, "captured");
  assert.equal(chromeApi.storageState.lastCaptureTarget, "Queue patterns");
});

test("captureActiveTab injects the extractor and saves the resulting page payload", async () => {
  const chromeApi = createChromeMock();
  chromeApi.scripting.executeScript = async () => ([
    {
      result: {
        ok: true,
        payload: {
          sourceType: "page",
          title: "Consensus Notes",
          url: "https://example.com/consensus",
          excerpt: "Consensus keeps replicas aligned.",
          content: "Consensus keeps replicas aligned across failures."
        }
      }
    }
  ]);

  const controller = createBackgroundController({
    chromeApi,
    client: {
      async fetchJson() {
        return {
          activeSessionId: "session-a",
          activeSession: { id: "session-a", goal: "Distributed systems" }
        };
      },
      async request(path, options) {
        assert.equal(path, "/api/ingest");
        assert.match(options.body, /session-a/);
        return {
          status: 200,
          payload: { ok: true, deduped: true }
        };
      }
    }
  });

  const result = await controller.captureActiveTab();
  assert.equal(result.ok, true);
  assert.equal(result.body.deduped, true);
  assert.equal(chromeApi.storageState.lastCaptureStatus, "deduped");
});
