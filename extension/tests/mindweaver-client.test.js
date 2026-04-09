import test from "node:test";
import assert from "node:assert/strict";
import { buildWebAppCandidates, createMindWeaverClient, readConfiguredApiBases } from "../lib/mindweaver-client.js";

test("readConfiguredApiBases prefers stored overrides before defaults", async () => {
  const storageArea = {
    async get() {
      return {
        mindweaverApiBase: "http://localhost:7777/",
        mindweaverApiBases: ["http://127.0.0.1:8888", "http://localhost:7777/"]
      };
    }
  };

  const bases = await readConfiguredApiBases(storageArea, ["http://localhost:3001"]);
  assert.deepEqual(bases, ["http://127.0.0.1:8888", "http://localhost:7777", "http://localhost:3001"]);
});

test("createMindWeaverClient falls back to the next local base on network failure", async () => {
  const calls = [];
  const client = createMindWeaverClient({
    storageArea: {
      async get() {
        return {
          mindweaverApiBases: ["http://127.0.0.1:3555", "http://localhost:3001"]
        };
      }
    },
    fetchImpl: async (url) => {
      calls.push(url);
      if (String(url).startsWith("http://127.0.0.1:3555")) {
        throw new TypeError("fetch failed");
      }

      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, from: "localhost" };
        }
      };
    }
  });

  const payload = await client.fetchJson("/api/health");
  assert.deepEqual(payload, { ok: true, from: "localhost" });
  assert.deepEqual(calls, [
    "http://127.0.0.1:3555/api/health",
    "http://localhost:3001/api/health"
  ]);
});

test("createMindWeaverClient stops on non-retryable API errors", async () => {
  const client = createMindWeaverClient({
    storageArea: {
      async get() {
        return {
          mindweaverApiBases: ["http://127.0.0.1:3001", "http://localhost:3001"]
        };
      }
    },
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      async json() {
        return { error: "session not found" };
      }
    })
  });

  await assert.rejects(() => client.fetchJson("/api/session-target"), /session not found/);
});

test("buildWebAppCandidates derives dev and fallback app URLs from the resolved API base", async () => {
  const candidates = buildWebAppCandidates("http://127.0.0.1:3001", "?sessionId=abc");
  assert.deepEqual(candidates, [
    "http://127.0.0.1:5197/?sessionId=abc",
    "http://127.0.0.1:3001/?sessionId=abc"
  ]);
});
