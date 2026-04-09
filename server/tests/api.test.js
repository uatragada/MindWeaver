import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { createDb, initDb } from "../db.js";
import { createApp } from "../app.js";

function createMockOpenAI() {
  return {
    chat: {
      completions: {
        async create({ messages }) {
          const prompt = messages.map((message) => message.content).join("\n");

          if (prompt.includes("should_ingest")) {
            return {
              choices: [
                {
                  message: {
                    content: '{"should_ingest":true,"reason":"substantive"}'
                  }
                }
              ]
            };
          }

          if (prompt.includes('Return only JSON: {"domain":"...", "skill":"...", "concepts":["..."]}')) {
            if (prompt.includes("Consensus")) {
              return {
                choices: [
                  {
                    message: {
                      content: '{"domain":"distributed systems","skill":"consensus","concepts":["raft"]}'
                    }
                  }
                ]
              };
            }

            return {
              choices: [
                {
                  message: {
                    content: '{"domain":"javascript","skill":"closures","concepts":["closure"]}'
                  }
                }
              ]
            };
          }

          return {
            choices: [
              {
                message: {
                  content: "{}"
                }
              }
            ]
          };
        }
      }
    }
  };
}

async function startTestServer(options = {}) {
  const tempDir = await mkdtemp(join(os.tmpdir(), "mindweaver-test-"));
  const dbPath = join(tempDir, "data.json");
  const db = createDb(dbPath);
  await initDb(db);

  const app = createApp({
    db,
    openaiClient: createMockOpenAI(),
    staticDir: options.staticDir ?? null
  });

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    db,
    baseUrl,
    tempDir,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

test("POST /api/sessions creates a session and goal node", async () => {
  const ctx = await startTestServer();

  try {
    const response = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Learn JavaScript Closures" })
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.id);
    assert.ok(body.goalId);
    assert.equal(ctx.db.data.sessions.length, 1);
    assert.equal(ctx.db.data.goals.length, 1);
    assert.equal(ctx.db.data.preferences.activeSessionId, body.id);
    assert.equal(ctx.db.data.nodes.some((node) => node.id === body.goalId && node.type === "goal"), true);
  } finally {
    await ctx.close();
  }
});

test("shared session target API tracks the active map across create, switch, and end", async () => {
  const ctx = await startTestServer();

  try {
    const firstResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "First map" })
    });
    const first = await firstResponse.json();

    const secondResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Second map" })
    });
    const second = await secondResponse.json();

    const initialTargetResponse = await fetch(`${ctx.baseUrl}/api/session-target`);
    const initialTarget = await initialTargetResponse.json();
    assert.equal(initialTargetResponse.status, 200);
    assert.equal(initialTarget.activeSessionId, second.id);
    assert.equal(initialTarget.sessions.some((session) => session.id === second.id && session.isActiveTarget), true);

    const switchResponse = await fetch(`${ctx.baseUrl}/api/session-target`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: first.id })
    });
    const switched = await switchResponse.json();
    assert.equal(switchResponse.status, 200);
    assert.equal(switched.activeSessionId, first.id);
    assert.equal(switched.lastSessionId, first.id);

    const endResponse = await fetch(`${ctx.baseUrl}/api/sessions/${first.id}/end`, { method: "POST" });
    assert.equal(endResponse.status, 200);

    const clearedResponse = await fetch(`${ctx.baseUrl}/api/session-target`);
    const cleared = await clearedResponse.json();
    assert.equal(clearedResponse.status, 200);
    assert.equal(cleared.activeSessionId, null);
    assert.equal(cleared.lastSessionId, first.id);
  } finally {
    await ctx.close();
  }
});

test("health endpoint allows chrome extension origins to reach the local API", async () => {
  const ctx = await startTestServer();

  try {
    const response = await fetch(`${ctx.baseUrl}/api/health`, {
      headers: {
        Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
      }
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(
      response.headers.get("access-control-allow-origin"),
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    );
  } finally {
    await ctx.close();
  }
});

test("POST /api/ingest dedupes repeated URLs within a session", async () => {
  const ctx = await startTestServer();

  try {
    const sessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Learn JavaScript Closures" })
    });
    const session = await sessionResponse.json();

    const payload = {
      sessionId: session.id,
      url: "https://example.com/closures",
      title: "Closures Explained",
      excerpt: "A guide to closures.",
      content: "Closures let a function remember variables from its lexical scope. ".repeat(12)
    };

    const firstResponse = await fetch(`${ctx.baseUrl}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const firstBody = await firstResponse.json();

    const secondResponse = await fetch(`${ctx.baseUrl}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const secondBody = await secondResponse.json();

    assert.equal(firstResponse.status, 200);
    assert.equal(firstBody.deduped, false);
    assert.equal(secondResponse.status, 200);
    assert.equal(secondBody.deduped, true);
    assert.equal(ctx.db.data.artifacts.length, 1);
  } finally {
    await ctx.close();
  }
});

test("GET /api/graph/:sessionId only returns nodes for that session", async () => {
  const ctx = await startTestServer();

  try {
    const firstSessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Learn JavaScript Closures" })
    });
    const secondSessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Learn Consensus" })
    });

    const firstSession = await firstSessionResponse.json();
    const secondSession = await secondSessionResponse.json();

    await fetch(`${ctx.baseUrl}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: firstSession.id,
        url: "https://example.com/closures",
        title: "Closures Explained",
        excerpt: "A guide to closures.",
        content: "Closures let a function remember variables from its lexical scope. ".repeat(12)
      })
    });

    await fetch(`${ctx.baseUrl}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: secondSession.id,
        url: "https://example.com/consensus",
        title: "Consensus Protocols",
        excerpt: "A guide to consensus.",
        content: "Consensus helps distributed systems agree on state across multiple nodes. ".repeat(12)
      })
    });

    const graphResponse = await fetch(`${ctx.baseUrl}/api/graph/${firstSession.id}`);
    const graph = await graphResponse.json();

    assert.equal(graphResponse.status, 200);
    assert.equal(graph.session.id, firstSession.id);
    assert.equal(graph.nodes.some((node) => node.label === "raft"), false);
    assert.equal(graph.nodes.some((node) => node.label === "closure"), true);
    assert.equal(graph.reviewQueue.some((node) => node.label === "closure"), true);
  } finally {
    await ctx.close();
  }
});

test("product endpoints expose health, recent sessions, and local deletion", async () => {
  const ctx = await startTestServer();

  try {
    const sessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Prepare a knowledge map launch" })
    });
    const session = await sessionResponse.json();

    await fetch(`${ctx.baseUrl}/api/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        sourceType: "note",
        title: "Launch Note",
        content: "Knowledge maps should be source grounded, easy to review, and safe for users to clean up locally. ".repeat(8)
      })
    });

    const healthResponse = await fetch(`${ctx.baseUrl}/api/health`);
    const health = await healthResponse.json();
    assert.equal(healthResponse.status, 200);
    assert.equal(health.ok, true);
    assert.equal(health.openaiConfigured, true);
    assert.equal(health.contentLimitChars, 16000);

    const sessionsResponse = await fetch(`${ctx.baseUrl}/api/sessions`);
    const sessionsBody = await sessionsResponse.json();
    assert.equal(sessionsResponse.status, 200);
    assert.equal(sessionsBody.sessions.some((entry) => entry.id === session.id && entry.sourceCount === 1), true);

    const sessionTargetResponse = await fetch(`${ctx.baseUrl}/api/session-target`);
    const sessionTarget = await sessionTargetResponse.json();
    assert.equal(sessionTargetResponse.status, 200);
    assert.equal(sessionTarget.activeSessionId, session.id);

    const exportJsonResponse = await fetch(`${ctx.baseUrl}/api/sessions/${session.id}/export`);
    const exportJson = await exportJsonResponse.json();
    assert.equal(exportJsonResponse.status, 200);
    assert.equal(exportJson.summary.id, session.id);
    assert.equal(exportJson.sources.length, 1);
    assert.equal(exportJson.concepts.some((concept) => concept.label === "closure"), true);

    const exportMarkdownResponse = await fetch(`${ctx.baseUrl}/api/sessions/${session.id}/export?format=markdown`);
    const exportMarkdown = await exportMarkdownResponse.text();
    assert.equal(exportMarkdownResponse.status, 200);
    assert.match(exportMarkdown, /# Prepare a knowledge map launch/);
    assert.match(exportMarkdown, /## Concepts/);

    const oversizedImportResponse = await fetch(`${ctx.baseUrl}/api/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        sourceType: "note",
        title: "Too Large",
        content: "x".repeat(80001)
      })
    });
    assert.equal(oversizedImportResponse.status, 400);

    const deleteResponse = await fetch(`${ctx.baseUrl}/api/sessions/${session.id}`, { method: "DELETE" });
    assert.equal(deleteResponse.status, 200);
    assert.equal(ctx.db.data.sessions.some((entry) => entry.id === session.id), false);
    assert.equal(ctx.db.data.artifacts.some((entry) => entry.sessionId === session.id), false);
  } finally {
    await ctx.close();
  }
});

test("POST /api/demo-session creates a ready-to-explore map with health and study plan", async () => {
  const ctx = await startTestServer();

  try {
    const demoResponse = await fetch(`${ctx.baseUrl}/api/demo-session`, { method: "POST" });
    const demo = await demoResponse.json();

    assert.equal(demoResponse.status, 200);
    assert.ok(demo.id);
    assert.equal(demo.isDemo, true);

    const graphResponse = await fetch(`${ctx.baseUrl}/api/graph/${demo.id}`);
    const graph = await graphResponse.json();

    assert.equal(graphResponse.status, 200);
    assert.ok(graph.nodes.some((node) => node.label === "event producer"));
    assert.equal(graph.artifacts.length, 3);
    assert.ok(graph.health.score > 0);
    assert.ok(graph.health.evidenceCoverage > 0);
    assert.ok(graph.studyPlan.steps.length > 0);
    assert.ok(graph.recommendations.length > 0);
  } finally {
    await ctx.close();
  }
});

test("server can serve a built web app fallback for production mode", async () => {
  const tempDir = await mkdtemp(join(os.tmpdir(), "mindweaver-static-"));
  const staticDir = join(tempDir, "dist");
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><div id=\"root\">MindWeaver Built App</div>");

  const ctx = await startTestServer({ staticDir });

  try {
    const rootResponse = await fetch(`${ctx.baseUrl}/`);
    const rootHtml = await rootResponse.text();
    assert.equal(rootResponse.status, 200);
    assert.match(rootHtml, /MindWeaver Built App/);

    const fallbackResponse = await fetch(`${ctx.baseUrl}/session/deep-link`);
    const fallbackHtml = await fallbackResponse.text();
    assert.equal(fallbackResponse.status, 200);
    assert.match(fallbackHtml, /MindWeaver Built App/);

    const apiResponse = await fetch(`${ctx.baseUrl}/api/health`);
    assert.equal(apiResponse.status, 200);
  } finally {
    await ctx.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("remaining roadmap endpoints support progress, search, chat, summaries, pruning, relationships, and bulk import", async () => {
  const ctx = await startTestServer();

  try {
    const demoResponse = await fetch(`${ctx.baseUrl}/api/demo-session`, { method: "POST" });
    const demo = await demoResponse.json();

    const progressResponse = await fetch(`${ctx.baseUrl}/api/progress/${demo.id}`);
    const progress = await progressResponse.json();
    assert.equal(progressResponse.status, 200);
    assert.ok(progress.longTerm.sessionCount >= 1);
    assert.ok(progress.byMastery.seen || progress.byMastery.verified);

    const searchResponse = await fetch(`${ctx.baseUrl}/api/search/${demo.id}?q=${encodeURIComponent("producer")}`);
    const search = await searchResponse.json();
    assert.equal(searchResponse.status, 200);
    assert.equal(search.results.some((result) => result.label.includes("producer")), true);

    const chatResponse = await fetch(`${ctx.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: demo.id, question: "What should I study about producers?" })
    });
    const chat = await chatResponse.json();
    assert.equal(chatResponse.status, 200);
    assert.ok(chat.answer);
    assert.ok(Array.isArray(chat.citations));

    const summaryResponse = await fetch(`${ctx.baseUrl}/api/summary/${demo.id}`);
    const summary = await summaryResponse.json();
    assert.equal(summaryResponse.status, 200);
    assert.ok(summary.summary);

    const graphBeforeRelationship = await (await fetch(`${ctx.baseUrl}/api/graph/${demo.id}`)).json();
    const producer = graphBeforeRelationship.nodes.find((node) => node.label === "event producer");
    const consumer = graphBeforeRelationship.nodes.find((node) => node.label === "event consumer");

    const relationshipResponse = await fetch(`${ctx.baseUrl}/api/edges`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: demo.id,
        sourceId: producer.id,
        targetId: consumer.id,
        type: "related",
        label: "communicates with"
      })
    });
    const relationship = await relationshipResponse.json();
    assert.equal(relationshipResponse.status, 200);
    assert.equal(relationship.edge.reviewStatus, "approved");

    const rejectEdgeResponse = await fetch(`${ctx.baseUrl}/api/edges/${encodeURIComponent(relationship.edge.key)}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: demo.id, action: "reject" })
    });
    assert.equal(rejectEdgeResponse.status, 200);

    const bulkResponse = await fetch(`${ctx.baseUrl}/api/import-bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: demo.id,
        items: [
          {
            sourceType: "markdown",
            title: "Bulk Producer Note",
            content: "A producer publishes events to a broker so consumers can process them asynchronously and maintain loose coupling. ".repeat(4)
          }
        ]
      })
    });
    const bulk = await bulkResponse.json();
    assert.equal(bulkResponse.status, 200);
    assert.equal(bulk.importedCount, 1);

    const pruneResponse = await fetch(`${ctx.baseUrl}/api/prune`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: demo.id, dryRun: true })
    });
    const prune = await pruneResponse.json();
    assert.equal(pruneResponse.status, 200);
    assert.equal(typeof prune.count, "number");

    const highlightResponse = await fetch(`${ctx.baseUrl}/api/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: demo.id,
        sourceType: "highlight",
        title: "Short Highlight",
        content: "Event producer publishes messages."
      })
    });
    assert.equal(highlightResponse.status, 200);
  } finally {
    await ctx.close();
  }
});

test("local production controls support backup, restore, node edits, merges, and source deletion", async () => {
  const ctx = await startTestServer();

  try {
    const demoResponse = await fetch(`${ctx.baseUrl}/api/demo-session`, { method: "POST" });
    const demo = await demoResponse.json();
    const graphBefore = await (await fetch(`${ctx.baseUrl}/api/graph/${demo.id}`)).json();

    const consumerLag = graphBefore.nodes.find((node) => node.label === "consumer lag");
    const schemaVersioning = graphBefore.nodes.find((node) => node.label === "schema versioning");
    assert.ok(consumerLag);
    assert.ok(schemaVersioning);

    const editResponse = await fetch(`${ctx.baseUrl}/api/nodes/${encodeURIComponent(consumerLag.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: demo.id,
        label: "consumer lag monitoring",
        description: "Tracks delayed consumers.",
        summary: "Use consumer lag to notice when downstream systems fall behind.",
        masteryState: "verified"
      })
    });
    const edit = await editResponse.json();
    assert.equal(editResponse.status, 200);
    assert.equal(edit.node.label, "consumer lag monitoring");
    assert.equal(edit.node.reviewStatus, "approved");
    assert.equal(edit.node.confidence, 1);

    const mergeResponse = await fetch(`${ctx.baseUrl}/api/nodes/${encodeURIComponent(schemaVersioning.id)}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: demo.id,
        targetId: consumerLag.id
      })
    });
    const merge = await mergeResponse.json();
    assert.equal(mergeResponse.status, 200);
    assert.equal(merge.source.reviewStatus, "rejected");
    assert.equal(merge.target.aliases.includes("schema versioning"), true);
    assert.equal(merge.graph.nodes.some((node) => node.id === schemaVersioning.id), false);

    const targetAfterMerge = merge.graph.nodes.find((node) => node.id === consumerLag.id);
    const sourceArtifactId = targetAfterMerge.sources[0].artifactId;
    const sourceDeleteResponse = await fetch(`${ctx.baseUrl}/api/sessions/${encodeURIComponent(demo.id)}/artifacts/${encodeURIComponent(sourceArtifactId)}`, {
      method: "DELETE"
    });
    const sourceDelete = await sourceDeleteResponse.json();
    assert.equal(sourceDeleteResponse.status, 200);
    assert.equal(sourceDelete.graph.artifacts.some((artifact) => artifact.id === sourceArtifactId), false);
    assert.equal(sourceDelete.graph.nodes.find((node) => node.id === consumerLag.id).evidenceCount, 0);

    const backupResponse = await fetch(`${ctx.baseUrl}/api/backup`);
    const backup = await backupResponse.json();
    assert.equal(backupResponse.status, 200);
    assert.equal(backup.app, "MindWeaver");
    assert.equal(backup.data.sessions.some((session) => session.id === demo.id), true);

    const deleteResponse = await fetch(`${ctx.baseUrl}/api/sessions/${demo.id}`, { method: "DELETE" });
    assert.equal(deleteResponse.status, 200);
    assert.equal(ctx.db.data.sessions.some((session) => session.id === demo.id), false);

    const restoreResponse = await fetch(`${ctx.baseUrl}/api/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true, backup })
    });
    const restore = await restoreResponse.json();
    assert.equal(restoreResponse.status, 200);
    assert.equal(restore.ok, true);

    const restoredGraphResponse = await fetch(`${ctx.baseUrl}/api/graph/${demo.id}`);
    const restoredGraph = await restoredGraphResponse.json();
    assert.equal(restoredGraphResponse.status, 200);
    assert.equal(restoredGraph.nodes.some((node) => node.label === "consumer lag monitoring"), true);
    assert.equal(restoredGraph.nodes.some((node) => node.label === "schema versioning"), false);
    assert.equal(restoredGraph.artifacts.length, 2);
  } finally {
    await ctx.close();
  }
});
