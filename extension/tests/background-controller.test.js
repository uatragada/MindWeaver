import test from "node:test";
import assert from "node:assert/strict";
import { createBackgroundController } from "../lib/background-controller.js";

function createChromeMock() {
  const storageState = {};
  return {
    storageState,
    storage: {
      local: {
        async get(keys) {
          const keyList = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(keyList.map((key) => [key, storageState[key]]));
        },
        async set(values) {
          Object.assign(storageState, values);
        }
      }
    },
    tabs: {
      async get(tabId) {
        return { id: tabId, active: true, title: "Article", url: "https://docs.example/article" };
      },
      async query() {
        return [{ id: 17, active: true, title: "Article", url: "https://docs.example/article" }];
      },
      onUpdated: { addListener() {} },
      onActivated: { addListener() {} }
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
    lastCaptureTarget: "",
    lastCaptureTargetId: ""
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
  assert.equal(chromeApi.storageState.lastCaptureTargetId, "session-b");
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
      async fetchJson(path) {
        if (path === "/api/health") {
          return { contentLimitChars: 128000 };
        }
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
  assert.equal(chromeApi.storageState.mindweaverCaptureContentLimitChars, 128000);
  assert.equal(chromeApi.storageState.lastCaptureStatus, "deduped");
  assert.equal(chromeApi.storageState.lastCaptureTargetId, "session-a");
});

test("auto-save captures a newly visited page once when the toggle is enabled", async () => {
  const chromeApi = createChromeMock();
  chromeApi.storageState.mindweaverAutoCaptureEnabled = true;
  chromeApi.scripting.executeScript = async () => ([
    {
      result: {
        ok: true,
        payload: {
          sourceType: "page",
          title: "Auto-saved Article",
          url: "https://docs.example/auto",
          excerpt: "Auto-saved excerpt.",
          content: "Auto-saved content."
        }
      }
    }
  ]);

  const requests = [];
  const controller = createBackgroundController({
    chromeApi,
    client: {
      async fetchJson(path) {
        if (path === "/api/health") {
          return { contentLimitChars: 16000 };
        }
        return {
          activeSessionId: "session-auto",
          activeSession: { id: "session-auto", goal: "Auto capture map" }
        };
      },
      async request(path, options) {
        requests.push({ path, options });
        return {
          status: 200,
          payload: { ok: true, deduped: false }
        };
      }
    }
  });

  const tab = {
    id: 21,
    active: true,
    status: "complete",
    title: "Auto-saved Article",
    url: "https://docs.example/auto"
  };
  const firstResult = await controller.maybeAutoCaptureTab(tab);
  const secondResult = await controller.maybeAutoCaptureTab(tab);

  assert.equal(firstResult.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/api/ingest");
  assert.equal(secondResult.skipped, true);
  assert.equal(chromeApi.storageState.lastCaptureTargetId, "session-auto");
});

test("auto-save ignores tab updates while the toggle is off", async () => {
  const chromeApi = createChromeMock();
  const requests = [];
  const controller = createBackgroundController({
    chromeApi,
    client: {
      async fetchJson(path) {
        if (path === "/api/health") {
          return { contentLimitChars: 16000 };
        }
        return {
          activeSessionId: "session-auto",
          activeSession: { id: "session-auto", goal: "Auto capture map" }
        };
      },
      async request(path, options) {
        requests.push({ path, options });
        return {
          status: 200,
          payload: { ok: true, deduped: false }
        };
      }
    }
  });

  const result = await controller.maybeAutoCaptureTab({
    id: 22,
    active: true,
    status: "complete",
    title: "Ignored Article",
    url: "https://docs.example/ignored"
  });

  assert.equal(result.skipped, true);
  assert.equal(requests.length, 0);
});
