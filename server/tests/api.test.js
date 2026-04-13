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

          if (prompt.includes("Refine this MindWeaver map")) {
            const marker = "Refine this MindWeaver map without deleting useful information unnecessarily.";
            const markerIndex = prompt.indexOf(marker);
            const jsonStart = markerIndex >= 0 ? prompt.indexOf("{", markerIndex) : -1;
            let snapshot = {};
            if (jsonStart >= 0) {
              try {
                snapshot = JSON.parse(prompt.slice(jsonStart));
              } catch {
                snapshot = {};
              }
            }
            const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
            const edges = Array.isArray(snapshot?.edges) ? snapshot.edges : [];
            const findNode = (label) => nodes.find((node) => String(node.label).toLowerCase() === label.toLowerCase());
            const brokerNode = findNode("message brokers") ?? findNode("queue brokers") ?? findNode("queue broker") ?? findNode("message broker");
            const queueNode = findNode("event queue");
            const goalNode = nodes.find((node) => node.type === "goal") ?? null;
            const goalToQueueEdge = goalNode && queueNode
              ? edges.find((edge) => edge.source === goalNode.id && edge.target === queueNode.id)
              : null;

            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: "Tightened the hierarchy by renaming the broker node, merging the duplicate queue concept, and cleaning up the misplaced top-level edge.",
                      rename_nodes: brokerNode ? [
                        {
                          id: brokerNode.id,
                          label: "message broker",
                          description: "Infrastructure that routes and buffers events between producers and consumers.",
                          type: "concept"
                        }
                      ] : [],
                      merge_nodes: brokerNode && queueNode ? [
                        {
                          sourceId: queueNode.id,
                          targetId: brokerNode.id,
                          reason: "These labels are redundant in this test fixture."
                        }
                      ] : [],
                      add_edges: [],
                      remove_edges: goalToQueueEdge ? [
                        {
                          key: goalToQueueEdge.key,
                          reason: "The queue node should not hang directly off the top-level goal once the duplicate is merged."
                        }
                      ] : []
                    })
                  }
                }
              ]
            };
          }

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
            if (prompt.includes("Octet Concepts")) {
              return {
                choices: [
                  {
                    message: {
                      content: '{"domain":"distributed systems","skill":"message flow","concepts":["producer","broker","consumer","retry policy","consumer lag","dead letter queue","idempotency key","partition leader","delivery guarantee","backpressure"]}'
                    }
                  }
                ]
              };
            }

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

test("PATCH /api/sessions/:id renames the map and syncs the matching primary goal node", async () => {
  const ctx = await startTestServer();

  try {
    const createResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Original map name" })
    });
    const created = await createResponse.json();

    const renameResponse = await fetch(`${ctx.baseUrl}/api/sessions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Renamed systems map" })
    });
    const renamed = await renameResponse.json();

    assert.equal(renameResponse.status, 200);
    assert.equal(renamed.ok, true);
    assert.equal(renamed.session.goal, "Renamed systems map");
    assert.equal(renamed.updatedPrimaryGoalNode, true);
    assert.equal(renamed.sessionTarget.activeSession?.goal, "Renamed systems map");

    const graphResponse = await fetch(`${ctx.baseUrl}/api/graph/${created.id}`);
    const graph = await graphResponse.json();
    assert.equal(graphResponse.status, 200);
    assert.equal(graph.goals[0]?.title, "Renamed systems map");
    assert.equal(graph.nodes.some((node) => node.id === created.goalId && node.label === "Renamed systems map"), true);
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

test("POST /api/ingest creates fresh nodes instead of reusing existing graph labels", async () => {
  const ctx = await startTestServer();

  try {
    const sessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Fresh extraction map" })
    });
    const session = await sessionResponse.json();

    const firstResponse = await fetch(`${ctx.baseUrl}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        url: "https://example.com/fresh-node-a",
        title: "Fresh Node Probe A",
        excerpt: "A closure guide.",
        content: "Closures let a function remember variables from its lexical scope. ".repeat(12)
      })
    });
    const secondResponse = await fetch(`${ctx.baseUrl}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        url: "https://example.com/fresh-node-b",
        title: "Fresh Node Probe B",
        excerpt: "Another closure guide.",
        content: "Closures let a function remember variables from its lexical scope. ".repeat(12)
      })
    });

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);

    const graphResponse = await fetch(`${ctx.baseUrl}/api/graph/${session.id}`);
    const graph = await graphResponse.json();
    const closureNodes = graph.nodes.filter((node) => node.label === "closure" && node.type === "concept");
    const javascriptNodes = graph.nodes.filter((node) => node.label === "javascript");

    assert.equal(graphResponse.status, 200);
    assert.equal(closureNodes.length, 2);
    assert.equal(new Set(closureNodes.map((node) => node.id)).size, 2);
    assert.equal(javascriptNodes.length, 2);
  } finally {
    await ctx.close();
  }
});

test("POST /api/ingest keeps at most 8 concepts from the classification pass", async () => {
  const ctx = await startTestServer();

  try {
    const sessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Octet classification map" })
    });
    const session = await sessionResponse.json();

    const ingestResponse = await fetch(`${ctx.baseUrl}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        url: "https://example.com/octet-concepts",
        title: "Octet Concepts",
        excerpt: "A dense systems article.",
        content: "Producers, brokers, consumers, retries, lag, dead letter queues, idempotency, partition leaders, delivery guarantees, and backpressure all matter here. ".repeat(10)
      })
    });
    const ingested = await ingestResponse.json();

    assert.equal(ingestResponse.status, 200);
    assert.equal(ingested.classification.concepts.length, 8);

    const graphResponse = await fetch(`${ctx.baseUrl}/api/graph/${session.id}`);
    const graph = await graphResponse.json();
    assert.equal(graphResponse.status, 200);
    assert.equal(graph.nodes.filter((node) => node.type === "concept").length, 8);
  } finally {
    await ctx.close();
  }
});

test("chat history prompt and structured import turn third-party conversation context into map nodes", async () => {
  const ctx = await startTestServer();

  try {
    const sessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Build a reliable event-driven onboarding map" })
    });
    const session = await sessionResponse.json();

    const templateResponse = await fetch(`${ctx.baseUrl}/api/import-chat-history/template?provider=chatgpt&sessionId=${session.id}`);
    const template = await templateResponse.json();
    assert.equal(templateResponse.status, 200);
    assert.equal(template.provider, "chatgpt");
    assert.match(template.prompt, /Build a reliable event-driven onboarding map/);
    assert.match(template.prompt, /mindweaver\.chat_import\.v1/);
    assert.match(template.prompt, /ALL CONVERSATIONS/);
    assert.match(template.prompt, /as much useful user context as possible/i);

    const importPayload = {
      schema_version: "mindweaver.chat_import.v1",
      provider: "chatgpt",
      title: "Assistant onboarding context",
      summary: "The user repeatedly explores event-driven architecture, message handling, and operational blind spots that slow onboarding.",
      conversation_highlights: [
        {
          title: "Recurring event-systems questions",
          summary: "The user often comes back to brokers, consumers, and production debugging.",
          concepts: ["consumer lag", "event consumer"]
        }
      ],
      nodes: [
        {
          type: "domain",
          label: "event-driven architecture",
          description: "The user has durable interest in asynchronous services, brokers, and event flow design.",
          confidence: 0.9,
          evidence: ["Repeatedly asked about producers, consumers, and event delivery tradeoffs."]
        },
        {
          type: "skill",
          label: "message handling",
          description: "The user is actively learning how to design and operate message-driven systems.",
          confidence: 0.86,
          evidence: ["Frequently asked how messages move through brokers and consumer pipelines."]
        },
        {
          type: "concept",
          label: "consumer lag",
          description: "A recurring operational concept tied to slow or backlogged consumers.",
          confidence: 0.82,
          aliases: ["lag monitoring"],
          evidence: ["Asked how to detect when consumers fall behind real-time traffic."]
        },
        {
          type: "concept",
          label: "event consumer",
          description: "The user often reasons about services that subscribe to and process messages.",
          confidence: 0.8,
          evidence: ["Compared consumer responsibilities across several system-design conversations."]
        }
      ],
      relationships: [
        { source: "event-driven architecture", target: "message handling", type: "contains", label: "contains" },
        { source: "message handling", target: "consumer lag", type: "builds_on", label: "builds_on" },
        { source: "message handling", target: "event consumer", type: "builds_on", label: "builds_on" }
      ]
    };

    const importResponse = await fetch(`${ctx.baseUrl}/api/import-chat-history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        importData: importPayload
      })
    });
    const imported = await importResponse.json();
    assert.equal(importResponse.status, 200);
    assert.equal(imported.deduped, false);
    assert.equal(imported.importedNodeCount, 4);
    assert.equal(imported.importedRelationshipCount, 3);

    const graphResponse = await fetch(`${ctx.baseUrl}/api/graph/${session.id}`);
    const graph = await graphResponse.json();
    assert.equal(graphResponse.status, 200);
    assert.equal(graph.artifacts.some((artifact) => artifact.sourceType === "chatgpt"), true);
    assert.equal(graph.nodes.some((node) => node.label === "event driven architecture"), true);
    assert.equal(graph.nodes.some((node) => node.label === "message handling"), true);
    assert.equal(graph.nodes.some((node) => node.label === "consumer lag" && node.evidenceCount >= 1), true);
    assert.equal(graph.edges.some((edge) => edge.type === "builds_on" && (typeof edge.target === "object" ? edge.target.id : edge.target).includes("consumer lag")), true);

    const dedupeResponse = await fetch(`${ctx.baseUrl}/api/import-chat-history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        importData: importPayload
      })
    });
    const deduped = await dedupeResponse.json();
    assert.equal(dedupeResponse.status, 200);
    assert.equal(deduped.deduped, true);
    assert.equal(ctx.db.data.artifacts.filter((artifact) => artifact.sessionId === session.id && artifact.sourceType === "chatgpt").length, 1);
  } finally {
    await ctx.close();
  }
});

test("chat history imports accept payloads larger than the old node cap", async () => {
  const ctx = await startTestServer();

  try {
    const sessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Import a full cross-conversation context map" })
    });
    const session = await sessionResponse.json();

    const nodes = [
      {
        type: "domain",
        label: "full conversation context",
        description: "Top-level domain that represents the user's imported cross-conversation context.",
        confidence: 0.92,
        evidence: ["The user wants to import as much durable context as possible."]
      },
      {
        type: "skill",
        label: "conversation synthesis",
        description: "The user repeatedly consolidates broad conversation history into structured knowledge.",
        confidence: 0.9,
        evidence: ["The user asked for a comprehensive cross-conversation import."]
      }
    ];
    const relationships = [
      {
        source: "full conversation context",
        target: "conversation synthesis",
        type: "contains",
        label: "contains"
      }
    ];

    for (let index = 0; index < 175; index += 1) {
      const label = `history concept ${index + 1}`;
      nodes.push({
        type: "concept",
        label,
        description: `Imported concept ${index + 1} from the user's broader conversation history.`,
        confidence: 0.79,
        evidence: [`Conversation thread ${index + 1} reinforces this durable concept.`]
      });
      relationships.push({
        source: "conversation synthesis",
        target: label,
        type: "builds_on",
        label: "builds_on"
      });
    }

    const importResponse = await fetch(`${ctx.baseUrl}/api/import-chat-history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        importData: {
          schema_version: "mindweaver.chat_import.v1",
          provider: "chatgpt",
          title: "Large assistant context import",
          summary: "A deliberately large import payload to confirm the backend accepts rich conversation-history maps without schema-level node caps.",
          conversation_highlights: [],
          nodes,
          relationships
        }
      })
    });
    const imported = await importResponse.json();

    assert.equal(importResponse.status, 200);
    assert.equal(imported.importedNodeCount, nodes.length);
    assert.equal(imported.importedRelationshipCount, relationships.length);
  } finally {
    await ctx.close();
  }
});

test("chat history imports merge duplicate labels and skip self-links", async () => {
  const ctx = await startTestServer();

  try {
    const sessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Import resilient chat history context" })
    });
    const session = await sessionResponse.json();

    const importResponse = await fetch(`${ctx.baseUrl}/api/import-chat-history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        importData: {
          schema_version: "mindweaver.chat_import.v1",
          provider: "chatgpt",
          title: "Duplicate-heavy assistant context",
          summary: "This payload intentionally includes duplicate labels and self-link edges so the importer can prove it normalizes noisy LLM output.",
          conversation_highlights: [
            {
              title: "Context synthesis",
              summary: "The user wants to import conversation history cleanly."
            }
          ],
          nodes: [
            {
              type: "domain",
              label: "distributed systems",
              description: "Primary domain node.",
              confidence: 0.92,
              evidence: ["The user repeatedly explores asynchronous architectures."]
            },
            {
              type: "domain",
              label: "distributed-system",
              description: "Duplicate normalized label with extra evidence.",
              confidence: 0.88,
              aliases: ["event systems"],
              evidence: ["The user compares brokers, queues, and consumers."]
            },
            {
              type: "skill",
              label: "event handling",
              description: "Skill connected to the domain.",
              confidence: 0.85,
              evidence: ["The user asks about delivery guarantees and message flow."]
            }
          ],
          relationships: [
            { source: "distributed systems", target: "event handling", type: "contains", label: "contains" },
            { source: "distributed-system", target: "distributed systems", type: "related", label: "related" }
          ]
        }
      })
    });
    const imported = await importResponse.json();

    assert.equal(importResponse.status, 200);
    assert.equal(imported.importedNodeCount, 2);
    assert.equal(imported.importedRelationshipCount, 1);
    assert.equal(Array.isArray(imported.warnings), true);
    assert.equal(imported.warnings.some((warning) => /Merged 1 duplicate node label/i.test(warning)), true);
    assert.equal(imported.warnings.some((warning) => /Skipped 1 self-link relationship/i.test(warning)), true);

    const graphResponse = await fetch(`${ctx.baseUrl}/api/graph/${session.id}`);
    const graph = await graphResponse.json();
    assert.equal(graphResponse.status, 200);
    assert.equal(graph.nodes.filter((node) => node.label === "distributed system").length, 1);
    assert.equal(graph.edges.filter((edge) => edge.type === "contains").length >= 1, true);
  } finally {
    await ctx.close();
  }
});

test("POST /api/nodes can create a primary goal node for a map that started unnamed", async () => {
  const ctx = await startTestServer();

  try {
    const sessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    const session = await sessionResponse.json();

    const nodeResponse = await fetch(`${ctx.baseUrl}/api/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        type: "goal",
        label: "Build a reliable systems map"
      })
    });
    const created = await nodeResponse.json();

    assert.equal(nodeResponse.status, 200);
    assert.equal(created.goalCreated, true);
    assert.equal(created.node.type, "goal");
    assert.equal(created.node.label, "Build a reliable systems map");
    assert.equal(created.graph.goals.length, 1);
    assert.equal(ctx.db.data.sessions.find((entry) => entry.id === session.id)?.goal, "Build a reliable systems map");
  } finally {
    await ctx.close();
  }
});

test("POST /api/refine renames, merges, and cleans weak edges conservatively", async () => {
  const ctx = await startTestServer();

  try {
    const sessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Distributed systems map" })
    });
    const session = await sessionResponse.json();

    const brokerResponse = await fetch(`${ctx.baseUrl}/api/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        type: "concept",
        label: "queue brokers"
      })
    });
    const brokerNode = (await brokerResponse.json()).node;

    const queueResponse = await fetch(`${ctx.baseUrl}/api/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        type: "concept",
        label: "event queue"
      })
    });
    const queueNode = (await queueResponse.json()).node;

    const refineResponse = await fetch(`${ctx.baseUrl}/api/refine`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.id })
    });
    const refined = await refineResponse.json();

    assert.equal(refineResponse.status, 200);
    assert.equal(refined.ok, true);
    assert.equal(refined.applied.renamed, 1);
    assert.equal(refined.applied.merged, 1);
    assert.equal(refined.applied.removedEdges, 1);
    assert.equal(refined.graph.nodes.some((node) => node.id === brokerNode.id && node.label === "message broker"), true);
    assert.equal(refined.graph.nodes.some((node) => node.id === queueNode.id), false);
  } finally {
    await ctx.close();
  }
});

test("DELETE /api/sessions/:id returns fresh target state without the deleted map", async () => {
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

    const deleteResponse = await fetch(`${ctx.baseUrl}/api/sessions/${second.id}`, { method: "DELETE" });
    const deleted = await deleteResponse.json();

    assert.equal(deleteResponse.status, 200);
    assert.equal(deleted.deletedSessionId, second.id);
    assert.equal(deleted.sessionTarget.sessions.some((entry) => entry.id === second.id), false);
    assert.equal(deleted.sessionTarget.activeSessionId, null);
    assert.equal(deleted.sessionTarget.lastSessionId, first.id);
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
