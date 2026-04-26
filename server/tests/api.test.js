import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { createDb, initDb } from "../db.js";
import { createApp } from "../app.js";
import { resolveMindWeaverDataFile } from "../data-file.js";
import { createMindWeaverMcpServer } from "../mcp.js";
import { requestStructuredJson } from "../openai.js";

const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060,
  5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080
]);

function createClassificationSchema({ minConcepts = 1, maxConcepts = 8 } = {}) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["area", "domain", "topic", "skill", "concepts"],
    properties: {
      area: { type: "string" },
      domain: { type: "string", minLength: 1 },
      topic: { type: "string" },
      skill: { type: "string", minLength: 1 },
      concepts: {
        type: "array",
        items: { type: "string", minLength: 1 },
        minItems: minConcepts,
        maxItems: maxConcepts,
        uniqueItems: true
      }
    }
  };
}

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

          if (
            prompt.includes('Return only JSON: {"area":"...", "domain":"...", "topic":"...", "skill":"...", "concepts":["..."]}')
            || prompt.includes('Return only JSON: {"domain":"...", "skill":"...", "concepts":["..."]}')
          ) {
            if (prompt.includes("Octet Concepts")) {
              return {
                choices: [
                  {
                    message: {
                      content: '{"area":"technology","domain":"distributed systems","topic":"event-driven systems","skill":"message flow","concepts":["producer","broker","consumer","retry policy","consumer lag","dead letter queue","idempotency key","partition leader"]}'
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
                      content: '{"area":"technology","domain":"distributed systems","topic":"distributed coordination","skill":"consensus","concepts":["raft"]}'
                    }
                  }
                ]
              };
            }

            return {
              choices: [
                {
                  message: {
                    content: '{"area":"software engineering","domain":"javascript","topic":"functions","skill":"closures","concepts":["closure"]}'
                  }
                }
              ]
            };
          }

          if (prompt.includes('Return only JSON: {"bridge_concepts":["concept1"],"reasoning":"..."}')) {
            return {
              choices: [
                {
                  message: {
                    content: '{"bridge_concepts":["idempotency"],"reasoning":"Idempotency connects retries to safe consumer behavior."}'
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

async function startMockOllamaServer(options = {}) {
  const availableModels = Array.from(new Set(
    (Array.isArray(options.models) ? options.models : ["qwen3.5:4b"])
      .map((model) => String(model ?? "").trim())
      .filter(Boolean)
  ));
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const payload = rawBody ? JSON.parse(rawBody) : {};

    res.setHeader("Content-Type", "application/json; charset=utf-8");

    if (req.url === "/api/tags") {
      res.end(JSON.stringify({
        models: availableModels.map((name) => ({ name }))
      }));
      return;
    }

    if (req.url !== "/api/chat" || req.method !== "POST") {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    if (!availableModels.includes(payload.model)) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: `model "${payload.model}" not found` }));
      return;
    }

    requests.push({
      method: req.method,
      url: req.url,
      payload
    });

    const prompt = Array.isArray(payload.messages)
      ? payload.messages.map((message) => message.content).join("\n")
      : "";

    let content = "{}";

    if (prompt.includes("Refine this MindWeaver map")) {
      if (options.invalidRefineResponse) {
        content = '{"summary":"broken refine","rename_nodes":[],"merge_nodes":[';
      } else {
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

      content = JSON.stringify({
        summary: "Tightened the hierarchy for the local-model path.",
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
            reason: "The duplicate queue node should not hang directly off the goal after merge."
          }
        ] : []
      });
      }
    } else if (prompt.includes("should_ingest")) {
      if (options.failLongPageStructuredPrompts && prompt.includes("Title: Long page source") && !prompt.includes("condensed excerpt from a longer source")) {
        content = "This looks educational, but here is my prose analysis instead of JSON.";
      } else {
        content = '{"should_ingest":true,"reason":"substantive"}';
      }
    } else if (
      prompt.includes('Return only JSON: {"area":"...", "domain":"...", "topic":"...", "skill":"...", "concepts":["..."]}')
      || prompt.includes('Return only JSON: {"domain":"...", "skill":"...", "concepts":["..."]}')
    ) {
      if (options.failLongPageStructuredPrompts && prompt.includes("Title: Long page source") && !prompt.includes("condensed excerpt from a longer source")) {
        content = "The page covers retries, idempotence, and distributed systems, but I am not returning valid JSON.";
      } else if (options.requireFocusedLocalClassificationFallback && prompt.includes("Title: Focused fallback source")) {
        content = prompt.includes("MIDDLE NOISE")
          ? "I can explain this source, but I am still not returning valid JSON."
          : '{"area":"civics","domain":"government","topic":"federal systems","skill":"government structure","concepts":["federal republic","state governance","constitutional system"]}';
      } else if (options.tooManyClassificationConcepts && prompt.includes("Title: Overlong concepts source")) {
        content = '{"area":"technology","domain":"distributed systems","topic":"event-driven systems","skill":"message flow","concepts":["producer","broker","consumer","retry policy","consumer lag","dead letter queue","idempotency key","partition leader","outbox pattern","offset commit"]}';
      } else if (options.stringifiedClassificationConcepts && prompt.includes("Title: Stringified concepts source")) {
        content = '{"area":"technology","domain":"distributed systems","topic":"event-driven systems","skill":"message flow","concepts":"producer, broker, consumer, retry policy"}';
      } else {
        content = '{"area":"technology","domain":"distributed systems","topic":"delivery semantics","skill":"delivery guarantees","concepts":["at least once delivery"]}';
      }
    } else if (prompt.includes('Return only JSON: {"directly_covered": ["concept1", "concept2"]}')) {
      content = '{"directly_covered":["at least once delivery"]}';
    } else if (prompt.includes('Return only JSON: {"gaps":["concept1"],"pathway":["first step","second step"],"difficulty":"easy|medium|hard"}')) {
      content = '{"gaps":["idempotency"],"pathway":["review duplicate delivery","study idempotency keys"],"difficulty":"medium"}';
    } else if (prompt.includes('Return only JSON: {"questions":[{"concept":"exact concept label","q":"question","options":["a","b","c","d"],"correct":0}]}')) {
      content = options.malformedQuizResponse
        ? '[{"concept":"at least once delivery","question":"What risk comes with at least once delivery?","options":["Duplicate deliveries","No retries","No acknowledgements","Single partition only"],"correct":"0"}]'
        : '{"questions":[{"concept":"at least once delivery","q":"What risk comes with at least once delivery?","options":["Duplicate deliveries","No retries","No acknowledgements","Single partition only"],"correct":0}]}';
    } else if (prompt.includes('Return only JSON: {"bridge_concepts":["concept1"],"reasoning":"..."}')) {
      content = '{"bridge_concepts":["idempotency"],"reasoning":"Idempotency connects retries to safe consumer behavior."}';
    } else if (prompt.includes("Answer only from the provided MindWeaver graph evidence")) {
      content = "The graph shows that at least once delivery can retry messages and makes duplicate handling important.";
    } else if (prompt.includes('Explain "')) {
      content = "At least once delivery means a broker may redeliver a message until it is acknowledged, so consumers should be idempotent.";
    }

    res.end(JSON.stringify({
      model: payload.model,
      message: {
        role: "assistant",
        content
      },
      done: true
    }));
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
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
    openaiClient: options.openaiClient === undefined ? createMockOpenAI() : options.openaiClient,
    ollamaBaseUrl: options.ollamaBaseUrl,
    staticDir: options.staticDir ?? null,
    agentAccess: options.agentAccess ?? null
  });

  let server = null;
  let port = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    port = server.address().port;
    if (!FETCH_FORBIDDEN_PORTS.has(port)) break;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    server = null;
    port = null;
  }
  if (!server || !port) throw new Error("Could not allocate a fetch-safe test port.");
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

async function createSessionWithManualNodes(ctx, goal, nodeSpecs) {
  const sessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal })
  });
  const session = await sessionResponse.json();
  assert.equal(sessionResponse.status, 200);

  const nodes = [];
  for (const nodeSpec of nodeSpecs) {
    const nodeResponse = await fetch(`${ctx.baseUrl}/api/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        ...nodeSpec
      })
    });
    const nodePayload = await nodeResponse.json();
    assert.equal(nodeResponse.status, 200);
    nodes.push(nodePayload.node);
  }

  return {
    session,
    nodes
  };
}

test("POST /api/sessions creates an empty map without a goal node", async () => {
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
    assert.equal(body.goalId, null);
    assert.equal(ctx.db.data.sessions.length, 1);
    assert.equal(ctx.db.data.goals.length, 0);
    assert.equal(ctx.db.data.preferences.activeSessionId, body.id);
    assert.equal(ctx.db.data.nodes.some((node) => node.type === "goal"), false);
  } finally {
    await ctx.close();
  }
});

test("PATCH /api/sessions/:id renames the map without retitling a manually created goal", async () => {
  const ctx = await startTestServer();

  try {
    const createResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Original map name" })
    });
    const created = await createResponse.json();

    const goalResponse = await fetch(`${ctx.baseUrl}/api/goals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: created.id,
        title: "Original learning target"
      })
    });
    const goal = await goalResponse.json();
    assert.equal(goalResponse.status, 200);

    const renameResponse = await fetch(`${ctx.baseUrl}/api/sessions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Renamed systems map" })
    });
    const renamed = await renameResponse.json();

    assert.equal(renameResponse.status, 200);
    assert.equal(renamed.ok, true);
    assert.equal(renamed.session.goal, "Renamed systems map");
    assert.equal(renamed.updatedPrimaryGoalNode, false);
    assert.equal(renamed.sessionTarget.activeSession?.goal, "Renamed systems map");

    const graphResponse = await fetch(`${ctx.baseUrl}/api/graph/${created.id}`);
    const graph = await graphResponse.json();
    assert.equal(graphResponse.status, 200);
    assert.equal(graph.goals[0]?.title, "Original learning target");
    assert.equal(graph.nodes.some((node) => node.id === goal.id && node.label === "Original learning target"), true);
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
    assert.deepEqual(initialTarget.tabSessions.map((session) => session.id), [first.id, second.id]);

    const tabsOnlyResponse = await fetch(`${ctx.baseUrl}/api/session-target`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openSessionIds: [second.id] })
    });
    const tabsOnly = await tabsOnlyResponse.json();
    assert.equal(tabsOnlyResponse.status, 200);
    assert.equal(tabsOnly.activeSessionId, second.id);
    assert.deepEqual(tabsOnly.tabSessions.map((session) => session.id), [second.id]);

    const switchResponse = await fetch(`${ctx.baseUrl}/api/session-target`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: first.id, openSessionIds: [second.id, first.id] })
    });
    const switched = await switchResponse.json();
    assert.equal(switchResponse.status, 200);
    assert.equal(switched.activeSessionId, first.id);
    assert.equal(switched.lastSessionId, first.id);
    assert.deepEqual(switched.tabSessions.map((session) => session.id), [second.id, first.id]);

    const closeActiveTabResponse = await fetch(`${ctx.baseUrl}/api/session-target`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: second.id, openSessionIds: [second.id] })
    });
    const closeActiveTab = await closeActiveTabResponse.json();
    assert.equal(closeActiveTabResponse.status, 200);
    assert.equal(closeActiveTab.activeSessionId, second.id);
    assert.deepEqual(closeActiveTab.tabSessions.map((session) => session.id), [second.id]);

    const endResponse = await fetch(`${ctx.baseUrl}/api/sessions/${second.id}/end`, { method: "POST" });
    assert.equal(endResponse.status, 200);

    const clearedResponse = await fetch(`${ctx.baseUrl}/api/session-target`);
    const cleared = await clearedResponse.json();
    assert.equal(clearedResponse.status, 200);
    assert.equal(cleared.activeSessionId, null);
    assert.equal(cleared.lastSessionId, second.id);
    assert.deepEqual(cleared.tabSessions.map((session) => session.id), [second.id]);
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

test("agent access endpoint returns MCP client configuration", async () => {
  const agentAccess = {
    available: true,
    transport: "stdio",
    launcherPath: "C:\\Users\\Example\\AppData\\Roaming\\MindWeaver\\start-mindweaver-mcp.bat",
    dataFilePath: "C:\\Users\\Example\\AppData\\Roaming\\MindWeaver\\mindweaver-data.json",
    codexConfig: {
      mcpServers: {
        mindweaver: {
          command: "cmd.exe",
          args: ["/d", "/s", "/c", "C:\\Users\\Example\\AppData\\Roaming\\MindWeaver\\start-mindweaver-mcp.bat"],
          env: {
            MINDWEAVER_DATA_FILE: "C:\\Users\\Example\\AppData\\Roaming\\MindWeaver\\mindweaver-data.json"
          }
        }
      }
    },
    claudeCodeConfig: {
      mcpServers: {
        mindweaver: {
          command: "cmd.exe",
          args: ["/d", "/s", "/c", "C:\\Users\\Example\\AppData\\Roaming\\MindWeaver\\start-mindweaver-mcp.bat"],
          env: {
            MINDWEAVER_DATA_FILE: "C:\\Users\\Example\\AppData\\Roaming\\MindWeaver\\mindweaver-data.json"
          }
        }
      }
    }
  };
  const ctx = await startTestServer({ agentAccess });

  try {
    const response = await fetch(`${ctx.baseUrl}/api/agent-access`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.transport, "stdio");
    assert.equal(payload.launcherPath, agentAccess.launcherPath);
    assert.equal(payload.codexConfig.mcpServers.mindweaver.command, "cmd.exe");
    assert.deepEqual(payload.claudeCodeConfig.mcpServers.mindweaver.env, agentAccess.claudeCodeConfig.mcpServers.mindweaver.env);
  } finally {
    await ctx.close();
  }
});

test("agent access can safely add MindWeaver to Codex config", async () => {
  const tempDir = await mkdtemp(join(os.tmpdir(), "mindweaver-codex-api-"));
  const codexConfigPath = join(tempDir, ".codex", "config.toml");
  const agentAccess = {
    available: true,
    transport: "stdio",
    launcherPath: "C:\\Users\\Example\\AppData\\Roaming\\MindWeaver\\start-mindweaver-mcp.bat",
    dataFilePath: "C:\\Users\\Example\\AppData\\Roaming\\MindWeaver\\mindweaver-data.json",
    codexConfigPath,
    codexConfig: {
      mcpServers: {
        mindweaver: {
          command: "cmd.exe",
          args: ["/d", "/s", "/c", "C:\\Users\\Example\\AppData\\Roaming\\MindWeaver\\start-mindweaver-mcp.bat"],
          env: {
            MINDWEAVER_DATA_FILE: "C:\\Users\\Example\\AppData\\Roaming\\MindWeaver\\mindweaver-data.json"
          }
        }
      }
    }
  };
  const ctx = await startTestServer({ agentAccess });

  try {
    const response = await fetch(`${ctx.baseUrl}/api/agent-access/codex-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    const payload = await response.json();
    const contents = await readFile(codexConfigPath, "utf8");

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.configPath, codexConfigPath);
    assert.match(contents, /\[mcp_servers\.mindweaver]/);
    assert.match(contents, /command = "cmd\.exe"/);
  } finally {
    await ctx.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveMindWeaverDataFile defaults to the shared MindWeaver app-data path", () => {
  const originalAppData = process.env.APPDATA;
  process.env.APPDATA = "C:\\Users\\Example\\AppData\\Roaming";

  try {
    assert.equal(
      resolveMindWeaverDataFile(),
      "C:\\Users\\Example\\AppData\\Roaming\\MindWeaver\\mindweaver-data.json"
    );
    assert.equal(
      resolveMindWeaverDataFile("G:\\Projects\\MindWeaver\\custom-data.json"),
      "G:\\Projects\\MindWeaver\\custom-data.json"
    );
  } finally {
    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }
  }
});

test("desktop app requests do not overwrite maps created by the MCP server in another process", async () => {
  const tempDir = await mkdtemp(join(os.tmpdir(), "mindweaver-concurrency-"));
  const dbPath = join(tempDir, "data.json");
  const appDb = createDb(dbPath);
  await initDb(appDb);

  const app = createApp({
    db: appDb,
    openaiClient: createMockOpenAI()
  });
  const server = createServer(app);

  try {
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const { operations } = createMindWeaverMcpServer({ dataFile: dbPath });
    const createdMap = await operations.createMap({
      title: "Cross-process MCP map",
      description: "Map created by the MCP server while the desktop app is already running."
    });

    const sessionTargetResponse = await fetch(`${baseUrl}/api/session-target?limit=24`);
    const sessionTarget = await sessionTargetResponse.json();
    assert.equal(sessionTargetResponse.status, 200);
    assert.equal(sessionTarget.activeSessionId, createdMap.map.id);

    const maps = await operations.listMaps({ limit: 50, includeEnded: true });
    assert.ok(maps.maps.some((map) => map.id === createdMap.map.id));

    const graph = await operations.getGraph({ sessionId: createdMap.map.id, compact: true });
    assert.equal(graph.session.id, createdMap.map.id);
    assert.ok(graph.nodes.some((node) => node.id === `session:${createdMap.map.id}`));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("desktop app event stream emits a data-changed update when the MCP server mutates the shared graph", async () => {
  const tempDir = await mkdtemp(join(os.tmpdir(), "mindweaver-events-"));
  const dbPath = join(tempDir, "data.json");
  const appDb = createDb(dbPath);
  await initDb(appDb);

  const app = createApp({
    db: appDb,
    openaiClient: createMockOpenAI(),
    dataFilePath: dbPath
  });
  const server = createServer(app);

  try {
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const response = await fetch(`${baseUrl}/api/events`, {
      headers: {
        Accept: "text/event-stream"
      }
    });

    assert.equal(response.status, 200);
    assert.ok(response.body);

    const reader = response.body.getReader();
    const initialChunk = await reader.read();
    const initialText = Buffer.from(initialChunk.value ?? []).toString("utf8");
    assert.match(initialText, /"type":"connected"/);

    const { operations } = createMindWeaverMcpServer({ dataFile: dbPath });
    const createdMap = await operations.createMap({
      title: "Realtime MCP map",
      description: "Used to verify the desktop event stream updates when the MCP server writes."
    });

    let streamedText = "";
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !streamedText.includes('"type":"data-changed"')) {
      const nextChunk = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for data-changed event.")), 1000))
      ]);
      streamedText += Buffer.from(nextChunk.value ?? []).toString("utf8");
      if (nextChunk.done) break;
    }

    assert.match(streamedText, /"type":"data-changed"/);

    const graph = await operations.getGraph({ sessionId: createdMap.map.id, compact: true });
    assert.equal(graph.session.id, createdMap.map.id);

    let duplicateEventText = "";
    try {
      const nextChunk = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("No duplicate event received.")), 400))
      ]);
      duplicateEventText = Buffer.from(nextChunk.value ?? []).toString("utf8");
    } catch (error) {
      assert.equal(error.message, "No duplicate event received.");
    }

    assert.doesNotMatch(duplicateEventText, /"type":"data-changed"/);

    await reader.cancel();
  } finally {
    app.locals.closeRealtime?.();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("requestStructuredJson accepts schema-valid local JSON responses", async () => {
  const ollama = await startMockOllamaServer();

  try {
    const result = await requestStructuredJson({
      openaiClient: null,
      ollamaBaseUrl: ollama.baseUrl,
      llmProvider: {
        provider: "local",
        model: "qwen3.5:4b"
      }
    }, {
      label: "Local classification probe",
      schema: createClassificationSchema(),
      messages: [
        {
          role: "system",
            content: 'Return only JSON: {"area":"...", "domain":"...", "topic":"...", "skill":"...", "concepts":["..."]}'
        },
        {
          role: "user",
          content: "Title: Local delivery note\nContent: At least once delivery retries a message until it is acknowledged, so duplicate handling matters."
        }
      ]
    });

    assert.deepEqual(result, {
      area: "technology",
      domain: "distributed systems",
      topic: "delivery semantics",
      skill: "delivery guarantees",
      concepts: ["at least once delivery"]
    });
  } finally {
    await ollama.close();
  }
});

test("requestStructuredJson rejects local JSON that fails schema validation", async () => {
  const ollama = await startMockOllamaServer();

  try {
    await assert.rejects(
      requestStructuredJson({
        openaiClient: null,
        ollamaBaseUrl: ollama.baseUrl,
        llmProvider: {
          provider: "local",
          model: "qwen3.5:4b"
        }
      }, {
        label: "Local classification probe",
        schema: createClassificationSchema({ minConcepts: 2 }),
        messages: [
          {
            role: "system",
            content: 'Return only JSON: {"area":"...", "domain":"...", "topic":"...", "skill":"...", "concepts":["..."]}'
          },
          {
            role: "user",
            content: "Title: Local delivery note\nContent: At least once delivery retries a message until it is acknowledged, so duplicate handling matters."
          }
        ]
      }),
      (error) => {
        assert.equal(error?.code, "LLM_SCHEMA_INVALID");
        assert.match(error?.message ?? "", /Local classification probe did not match the expected schema/i);
        assert.match(error?.message ?? "", /\$\.concepts/i);
        return true;
      }
    );
  } finally {
    await ollama.close();
  }
});

test("local LLM settings persist and power Ollama-backed tasks", async () => {
  const ollama = await startMockOllamaServer({
    models: ["qwen3.5:4b", "llama3.2:3b"]
  });
  const ctx = await startTestServer({
    openaiClient: null,
    ollamaBaseUrl: ollama.baseUrl
  });

  try {
    const initialHealthResponse = await fetch(`${ctx.baseUrl}/api/health`);
    const initialHealth = await initialHealthResponse.json();
    assert.equal(initialHealthResponse.status, 200);
    assert.equal(initialHealth.openaiConfigured, false);
    assert.equal(initialHealth.llmProviders.local.available, true);
    assert.equal(initialHealth.contentLimitChars, 16000);
    assert.equal(initialHealth.maxPayloadContentChars, 80000);
    assert.deepEqual(
      initialHealth.llmProviders.local.models.map((model) => model.value).sort(),
      ["llama3.2:3b", "qwen3.5:4b"]
    );
    assert.equal(initialHealth.llmProviders.local.models.every((model) => model.installed), true);
    assert.equal(initialHealth.llmProviders.local.models.some((model) => model.value === "gemma4"), false);
    assert.equal(initialHealth.llmSettings.provider, "openai");

    const settingsResponse = await fetch(`${ctx.baseUrl}/api/settings/llm`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "local", model: "llama3.2:3b" })
    });
    const settings = await settingsResponse.json();
    assert.equal(settingsResponse.status, 200);
    assert.equal(settings.llmSettings.provider, "local");
    assert.equal(settings.llmSettings.localModel, "llama3.2:3b");
    assert.equal(settings.contentLimitChars, 128000);
    assert.equal(settings.maxPayloadContentChars, 128000);

    const sessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Reliable messaging map" })
    });
    const session = await sessionResponse.json();
    assert.equal(sessionResponse.status, 200);

    const importResponse = await fetch(`${ctx.baseUrl}/api/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        sourceType: "note",
        title: "Local delivery note",
        content: "At least once delivery retries a message until a consumer acknowledges it, which makes duplicate handling important. ".repeat(8)
      })
    });
    const imported = await importResponse.json();
    assert.equal(importResponse.status, 200);
    assert.equal(imported.classification.domain, "distributed system");
    assert.equal(imported.classification.skill, "delivery guarantee");
    assert.deepEqual(imported.classification.concepts, ["at least once delivery"]);

    const graphAfterImport = await (await fetch(`${ctx.baseUrl}/api/graph/${session.id}`)).json();
    assert.equal(graphAfterImport.nodes.some((node) => node.label === "at least once delivery"), true);

    const goalResponse = await fetch(`${ctx.baseUrl}/api/goals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        title: "Improve delivery guarantees"
      })
    });
    const goal = await goalResponse.json();
    assert.equal(goalResponse.status, 200);

    const learnMoreResponse = await fetch(`${ctx.baseUrl}/api/learn-more`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: "at least once delivery",
        type: "concept",
        upstream: [],
        downstream: []
      })
    });
    const learnMore = await learnMoreResponse.json();
    assert.equal(learnMoreResponse.status, 200);
    assert.match(learnMore.content, /broker may redeliver/i);

    const gapsResponse = await fetch(`${ctx.baseUrl}/api/gaps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        goalId: goal.id
      })
    });
    const gaps = await gapsResponse.json();
    assert.equal(gapsResponse.status, 200);
    assert.deepEqual(gaps.gaps, ["idempotency"]);

    const quizResponse = await fetch(`${ctx.baseUrl}/api/quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.id })
    });
    const quiz = await quizResponse.json();
    assert.equal(quizResponse.status, 200);
    assert.equal(quiz.quiz.length, 1);
    assert.equal(quiz.quiz[0].concept, "at least once delivery");

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
    assert.equal(refined.graph.nodes.some((node) => node.id === brokerNode.id && node.label === "message broker"), true);
    assert.equal(refined.graph.nodes.some((node) => node.id === queueNode.id), false);

    const chatResponse = await fetch(`${ctx.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        question: "Why does this map care about duplicate handling?"
      })
    });
    const chat = await chatResponse.json();
    assert.equal(chatResponse.status, 200);
    assert.match(chat.answer, /duplicate handling/i);

    const getPrompt = (entry) => Array.isArray(entry?.payload?.messages)
      ? entry.payload.messages.map((message) => message.content).join("\n")
      : "";
    const modelRequests = ollama.requests.filter((entry) => entry.url === "/api/chat");
    const structuredRequests = ollama.requests.filter((entry) => entry.payload?.format);

    assert.ok(structuredRequests.length >= 5);
    assert.equal(modelRequests.length >= structuredRequests.length, true);
    assert.equal(modelRequests.every((entry) => entry.payload.think === false), true);
    assert.equal(structuredRequests.every((entry) => entry.payload.model === "llama3.2:3b"), true);

    const worthinessRequest = structuredRequests.find((entry) => getPrompt(entry).includes('"should_ingest": true/false'));
    assert.ok(worthinessRequest);
    assert.deepEqual(worthinessRequest.payload.format.required, ["should_ingest", "reason"]);
    assert.equal(worthinessRequest.payload.format.properties.should_ingest.type, "boolean");

    const classificationRequest = structuredRequests.find((entry) => getPrompt(entry).includes("Classify this source into one domain, one skill, and 1-8 core concepts."));
    assert.ok(classificationRequest);
    assert.equal(classificationRequest.payload.format.additionalProperties, false);
    assert.deepEqual(classificationRequest.payload.format.required, ["area", "domain", "topic", "skill", "concepts"]);
    assert.equal(classificationRequest.payload.format.properties.area.type, "string");
    assert.equal(classificationRequest.payload.format.properties.domain.type, "string");
    assert.equal(classificationRequest.payload.format.properties.topic.type, "string");
    assert.equal(classificationRequest.payload.format.properties.skill.type, "string");
    assert.equal(classificationRequest.payload.format.properties.concepts.type, "array");
    assert.equal(classificationRequest.payload.format.properties.concepts.items.type, "string");

    const gapRequest = structuredRequests.find((entry) => getPrompt(entry).includes('"gaps":["concept1"],"pathway":["first step","second step"],"difficulty":"easy|medium|hard"}'));
    assert.ok(gapRequest);
    assert.deepEqual(gapRequest.payload.format.properties.difficulty.enum, ["easy", "medium", "hard"]);

    const quizRequest = structuredRequests.find((entry) => getPrompt(entry).includes('"questions":[{"concept":"exact concept label","q":"question","options":["a","b","c","d"],"correct":0}]}'));
    assert.ok(quizRequest);
    assert.equal(quizRequest.payload.format.properties.questions.items.properties.correct.type, "integer");

    const refineRequest = structuredRequests.find((entry) => getPrompt(entry).includes("Refine this MindWeaver map without deleting useful information unnecessarily."));
    assert.ok(refineRequest);
    assert.equal(refineRequest.payload.format.properties.rename_nodes.type, "array");
  } finally {
    await ctx.close();
    await ollama.close();
  }
});

test("local quiz repairs near-valid Ollama JSON before schema validation", async () => {
  const ollama = await startMockOllamaServer({
    malformedQuizResponse: true
  });
  const ctx = await startTestServer({
    openaiClient: null,
    ollamaBaseUrl: ollama.baseUrl
  });

  try {
    await fetch(`${ctx.baseUrl}/api/settings/llm`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "local", model: "qwen3.5:4b" })
    });

    const sessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Reliable messaging map" })
    });
    const session = await sessionResponse.json();

    await fetch(`${ctx.baseUrl}/api/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        sourceType: "note",
        title: "Local delivery note",
        content: "At least once delivery retries a message until a consumer acknowledges it, which makes duplicate handling important. ".repeat(6)
      })
    });

    const quizResponse = await fetch(`${ctx.baseUrl}/api/quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.id })
    });
    const quiz = await quizResponse.json();

    assert.equal(quizResponse.status, 200);
    assert.equal(quiz.quiz.length, 1);
    assert.equal(quiz.quiz[0].concept, "at least once delivery");
    assert.equal(quiz.quiz[0].correct, 0);
    assert.match(quiz.quiz[0].q, /risk comes with at least once delivery/i);
  } finally {
    await ctx.close();
    await ollama.close();
  }
});

test("local refine splits larger cleanup passes into multiple Ollama requests", async () => {
  const ollama = await startMockOllamaServer();
  const ctx = await startTestServer({
    openaiClient: null,
    ollamaBaseUrl: ollama.baseUrl
  });

  try {
    await fetch(`${ctx.baseUrl}/api/settings/llm`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "local", model: "qwen3.5:4b" })
    });

    const sessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Reliable messaging map" })
    });
    const session = await sessionResponse.json();

    await fetch(`${ctx.baseUrl}/api/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        sourceType: "note",
        title: "Local delivery note",
        content: "At least once delivery retries a message until a consumer acknowledges it, which makes duplicate handling important. ".repeat(6)
      })
    });

    for (const label of ["backpressure", "consumer lag", "event queue", "offset tracking", "partition ordering", "queue brokers", "retry budgets"]) {
      await fetch(`${ctx.baseUrl}/api/nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: session.id,
          type: "concept",
          label
        })
      });
    }

    const refineResponse = await fetch(`${ctx.baseUrl}/api/refine`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.id })
    });
    const refined = await refineResponse.json();

    const refineRequests = ollama.requests.filter((entry) => {
      const prompt = Array.isArray(entry?.payload?.messages)
        ? entry.payload.messages.map((message) => message.content).join("\n")
        : "";
      return entry.payload?.format && prompt.includes("Refine this MindWeaver map without deleting useful information unnecessarily.");
    });

    assert.equal(refineResponse.status, 200);
    assert.equal(refined.ok, true);
    assert.equal(refined.graph.nodes.some((node) => node.label === "message broker"), true);
    assert.ok(refineRequests.length >= 2);
  } finally {
    await ctx.close();
    await ollama.close();
  }
});

test("local refine falls back to conservative duplicate cleanup when Ollama refine JSON is invalid", async () => {
  const ollama = await startMockOllamaServer({
    invalidRefineResponse: true
  });
  const ctx = await startTestServer({
    openaiClient: null,
    ollamaBaseUrl: ollama.baseUrl
  });

  try {
    await fetch(`${ctx.baseUrl}/api/settings/llm`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "local", model: "qwen3.5:4b" })
    });

    const sessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Reliable messaging map" })
    });
    const session = await sessionResponse.json();

    ctx.db.data.nodes.push(
      {
        id: "concept:message-broker-a",
        label: "message broker",
        canonicalLabel: "message broker",
        aliases: [],
        type: "concept",
        createdBy: "user",
        verified: false,
        confidence: 0.72,
        createdAt: 1,
        sessionIds: [session.id],
        sessionReviews: {},
        history: []
      },
      {
        id: "concept:message-broker-b",
        label: "message broker",
        canonicalLabel: "message broker",
        aliases: [],
        type: "concept",
        createdBy: "user",
        verified: false,
        confidence: 0.71,
        createdAt: 2,
        sessionIds: [session.id],
        sessionReviews: {},
        history: []
      }
    );
    await ctx.db.write();

    const refineResponse = await fetch(`${ctx.baseUrl}/api/refine`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.id })
    });
    const refined = await refineResponse.json();

    assert.equal(refineResponse.status, 200);
    assert.equal(refined.ok, true);
    assert.equal(refined.applied.merged >= 1, true);
    assert.match(refined.summary, /conservative duplicate-label cleanup/i);
    assert.match(refined.applied.warnings.join(" "), /conservative duplicate-label cleanup/i);
    assert.equal(refined.graph.nodes.filter((node) => node.label === "message broker").length, 1);
  } finally {
    await ctx.close();
    await ollama.close();
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

test("POST /api/ingest queues concurrent page saves so later saves wait for the active one", async () => {
  let releaseFirstClassification = null;
  let firstClassificationStartedResolve = null;
  const firstClassificationStarted = new Promise((resolve) => {
    firstClassificationStartedResolve = resolve;
  });
  const classificationOrder = [];

  const openaiClient = {
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

          if (
            prompt.includes('Return only JSON: {"area":"...", "domain":"...", "topic":"...", "skill":"...", "concepts":["..."]}')
            || prompt.includes('Return only JSON: {"domain":"...", "skill":"...", "concepts":["..."]}')
          ) {
            if (prompt.includes("Title: First queued source")) {
              classificationOrder.push("first-start");
              firstClassificationStartedResolve?.();
              await new Promise((resolve) => {
                releaseFirstClassification = resolve;
              });
              classificationOrder.push("first-end");
              return {
                choices: [
                    {
                      message: {
                        content: '{"area":"technology","domain":"distributed systems","topic":"event-driven systems","skill":"message flow","concepts":["first queue item"]}'
                      }
                    }
                ]
              };
            }

            if (prompt.includes("Title: Second queued source")) {
              classificationOrder.push("second-start");
              classificationOrder.push("second-end");
              return {
                choices: [
                    {
                      message: {
                        content: '{"area":"technology","domain":"distributed systems","topic":"event-driven systems","skill":"message flow","concepts":["second queue item"]}'
                      }
                    }
                ]
              };
            }
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

  const ctx = await startTestServer({ openaiClient });

  try {
    const sessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Queued page saves" })
    });
    const session = await sessionResponse.json();

    const firstRequest = fetch(`${ctx.baseUrl}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        url: "https://example.com/queued-first",
        title: "First queued source",
        excerpt: "First queued page.",
        content: "First queued page content about distributed systems, retries, acknowledgements, and safe message handling. ".repeat(4)
      })
    });

    await firstClassificationStarted;

    const secondRequest = fetch(`${ctx.baseUrl}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        url: "https://example.com/queued-second",
        title: "Second queued source",
        excerpt: "Second queued page.",
        content: "Second queued page content about distributed systems, retries, acknowledgements, and safe message handling. ".repeat(4)
      })
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(classificationOrder, ["first-start"]);

    releaseFirstClassification?.();

    const [firstResponse, secondResponse] = await Promise.all([firstRequest, secondRequest]);
    const [firstBody, secondBody] = await Promise.all([firstResponse.json(), secondResponse.json()]);

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(firstBody.deduped, false);
    assert.equal(secondBody.deduped, false);
    assert.deepEqual(classificationOrder, ["first-start", "first-end", "second-start", "second-end"]);
    assert.deepEqual(
      ctx.db.data.artifacts.map((artifact) => artifact.title),
      ["First queued source", "Second queued source"]
    );
  } finally {
    releaseFirstClassification?.();
    await ctx.close();
  }
});

test("POST /api/ingest collapses exact duplicate labels after repeated saves", async () => {
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
    assert.equal(closureNodes.length, 1);
    assert.equal(javascriptNodes.length, 1);
    assert.equal(closureNodes[0]?.evidenceCount, 2);
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

test("local imports accept content beyond the OpenAI payload cap", async () => {
  const ollama = await startMockOllamaServer();
  const ctx = await startTestServer({
    openaiClient: null,
    ollamaBaseUrl: ollama.baseUrl
  });

  try {
    const settingsResponse = await fetch(`${ctx.baseUrl}/api/settings/llm`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "local", model: "qwen3.5:4b" })
    });
    assert.equal(settingsResponse.status, 200);

    const sessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Long local import map" })
    });
    const session = await sessionResponse.json();

    const longContent = Array.from(
      { length: 700 },
      (_, index) => `Section ${index}: at least once delivery, idempotency keys, retry policies, dead letter queues, and consumer lag matter in message broker systems.`
    ).join(" ");
    assert.equal(longContent.length > 80000 && longContent.length <= 128000, true);

    const importResponse = await fetch(`${ctx.baseUrl}/api/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        sourceType: "note",
        title: "Large local note",
        content: longContent
      })
    });
    const imported = await importResponse.json();

    assert.equal(importResponse.status, 200);
    assert.equal(imported.ok, true);
    assert.deepEqual(imported.classification, {
      area: "technology",
      domain: "distributed system",
      topic: "delivery semantic",
      skill: "delivery guarantee",
      concepts: ["at least once delivery"]
    });
  } finally {
    await ctx.close();
    await ollama.close();
  }
});

test("local ingest retries long structured page analysis with condensed content when full-page JSON fails", async () => {
  const ollama = await startMockOllamaServer({
    failLongPageStructuredPrompts: true
  });
  const ctx = await startTestServer({
    openaiClient: null,
    ollamaBaseUrl: ollama.baseUrl
  });

  try {
    await fetch(`${ctx.baseUrl}/api/settings/llm`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "local", model: "qwen3.5:4b" })
    });

    const sessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Long page ingest map" })
    });
    const session = await sessionResponse.json();

    const ingestResponse = await fetch(`${ctx.baseUrl}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        url: "https://example.com/long-page",
        title: "Long page source",
        excerpt: "A long page about retries and idempotency.",
        content: "At least once delivery, retries, idempotency keys, and dead-letter queues are all important in distributed systems. ".repeat(180)
      })
    });
    const ingested = await ingestResponse.json();

    const getPrompt = (entry) => Array.isArray(entry?.payload?.messages)
      ? entry.payload.messages.map((message) => message.content).join("\n")
      : "";
    const worthinessPrompts = ollama.requests
      .filter((entry) => getPrompt(entry).includes("Title: Long page source"))
      .filter((entry) => getPrompt(entry).includes("should_ingest"));
    const classificationPrompts = ollama.requests
      .filter((entry) => getPrompt(entry).includes("Title: Long page source"))
      .filter((entry) => getPrompt(entry).includes('Return only JSON: {"area":"...", "domain":"...", "topic":"...", "skill":"...", "concepts":["..."]}'));

    assert.equal(ingestResponse.status, 200);
    assert.deepEqual(ingested.classification, {
      area: "technology",
      domain: "distributed system",
      topic: "delivery semantic",
      skill: "delivery guarantee",
      concepts: ["at least once delivery"]
    });
    assert.equal(worthinessPrompts.length, 2);
    assert.equal(classificationPrompts.length, 2);
    assert.equal(
      worthinessPrompts.some((entry) => getPrompt(entry).includes("condensed excerpt from a longer source")),
      true
    );
    assert.equal(
      classificationPrompts.some((entry) => getPrompt(entry).includes("condensed excerpt from a longer source")),
      true
    );
  } finally {
    await ctx.close();
    await ollama.close();
  }
});

test("local ingest falls back to a focused lead excerpt when broader local classification attempts stay invalid", async () => {
  const ollama = await startMockOllamaServer({
    requireFocusedLocalClassificationFallback: true
  });
  const ctx = await startTestServer({
    openaiClient: null,
    ollamaBaseUrl: ollama.baseUrl
  });

  try {
    await fetch(`${ctx.baseUrl}/api/settings/llm`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "local", model: "qwen3.5:4b" })
    });

    const sessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Focused fallback map" })
    });
    const session = await sessionResponse.json();

    const longContent = [
      "The source explains how a federal republic divides powers between national and state governments.",
      "It introduces constitutions, representative institutions, and state governance responsibilities.",
      "MIDDLE NOISE ".repeat(900)
    ].join(" ");

    const ingestResponse = await fetch(`${ctx.baseUrl}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        url: "https://example.com/focused-fallback",
        title: "Focused fallback source",
        excerpt: "The source explains how a federal republic divides powers between national and state governments.",
        content: longContent
      })
    });
    const ingested = await ingestResponse.json();
    const getPrompt = (entry) => Array.isArray(entry?.payload?.messages)
      ? entry.payload.messages.map((message) => message.content).join("\n")
      : "";

    const classificationPrompts = ollama.requests
      .filter((entry) => getPrompt(entry).includes("Title: Focused fallback source"))
      .filter((entry) => getPrompt(entry).includes('Return only JSON: {"area":"...", "domain":"...", "topic":"...", "skill":"...", "concepts":["..."]}'));

    assert.equal(ingestResponse.status, 200);
    assert.equal(ingested.classification.area, "civic");
    assert.equal(ingested.classification.domain, "government");
    assert.equal(ingested.classification.topic, "federal system");
    assert.equal(ingested.classification.skill, "government structure");
    assert.deepEqual(ingested.classification.concepts, [
      "federal republic",
      "state governance",
      "constitutional system"
    ]);
    assert.equal(classificationPrompts.length >= 3, true);
    assert.equal(getPrompt(classificationPrompts[0]).includes("MIDDLE NOISE"), true);
    assert.equal(getPrompt(classificationPrompts[1]).includes("MIDDLE NOISE"), true);
    assert.equal(getPrompt(classificationPrompts.at(-1)).includes("MIDDLE NOISE"), false);
  } finally {
    await ctx.close();
    await ollama.close();
  }
});

test("local ingest trims overlong concept lists before schema validation", async () => {
  const ollama = await startMockOllamaServer({
    tooManyClassificationConcepts: true
  });
  const ctx = await startTestServer({
    openaiClient: null,
    ollamaBaseUrl: ollama.baseUrl
  });

  try {
    await fetch(`${ctx.baseUrl}/api/settings/llm`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "local", model: "qwen3.5:4b" })
    });

    const sessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Overlong concepts map" })
    });
    const session = await sessionResponse.json();

    const ingestResponse = await fetch(`${ctx.baseUrl}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        url: "https://example.com/overlong-concepts",
        title: "Overlong concepts source",
        excerpt: "A source with too many concepts.",
        content: "Producers, brokers, consumers, retries, dead-letter queues, and idempotency keys all matter in distributed systems. ".repeat(40)
      })
    });
    const ingested = await ingestResponse.json();

    assert.equal(ingestResponse.status, 200);
    assert.equal(ingested.classification.domain, "distributed system");
    assert.equal(ingested.classification.skill, "message flow");
    assert.equal(ingested.classification.concepts.length, 8);
    assert.deepEqual(ingested.classification.concepts, [
      "producer",
      "broker",
      "consumer",
      "retry policy",
      "consumer lag",
      "dead letter queue",
      "idempotency key",
      "partition leader"
    ]);
  } finally {
    await ctx.close();
    await ollama.close();
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
          type: "area",
          label: "technology",
          description: "Broad umbrella for the user's systems and software interests.",
          confidence: 0.92,
          evidence: ["The user repeatedly explores technical systems and implementation tradeoffs."]
        },
        {
          type: "domain",
          label: "event-driven architecture",
          description: "The user has durable interest in asynchronous services, brokers, and event flow design.",
          confidence: 0.9,
          evidence: ["Repeatedly asked about producers, consumers, and event delivery tradeoffs."]
        },
        {
          type: "topic",
          label: "asynchronous messaging",
          description: "Subarea focused on brokers, consumers, and message-driven design.",
          confidence: 0.87,
          evidence: ["Frequently revisits event flow, brokers, and queue behavior."]
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
        { source: "technology", target: "event-driven architecture", type: "contains", label: "contains" },
        { source: "event-driven architecture", target: "message handling", type: "contains", label: "contains" },
        { source: "event-driven architecture", target: "asynchronous messaging", type: "contains", label: "contains" },
        { source: "asynchronous messaging", target: "message handling", type: "contains", label: "contains" },
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
    assert.equal(imported.importedNodeCount, 6);
    assert.equal(imported.importedRelationshipCount, 6);

    const graphResponse = await fetch(`${ctx.baseUrl}/api/graph/${session.id}`);
    const graph = await graphResponse.json();
    assert.equal(graphResponse.status, 200);
    assert.equal(graph.artifacts.some((artifact) => artifact.sourceType === "chatgpt"), true);
    assert.equal(graph.nodes.some((node) => node.label === "technology" && node.type === "area"), true);
    assert.equal(graph.nodes.some((node) => node.label === "event driven architecture"), true);
    assert.equal(graph.nodes.some((node) => node.label === "asynchronous messaging" && node.type === "topic"), true);
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
    assert.equal(ctx.db.data.sessions.find((entry) => entry.id === session.id)?.goal, null);
  } finally {
    await ctx.close();
  }
});

test("POST /api/nodes supports area and topic with hierarchy-aware default parents", async () => {
  const ctx = await startTestServer();

  try {
    const sessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Understand distributed systems" })
    });
    const session = await sessionResponse.json();

    const areaResponse = await fetch(`${ctx.baseUrl}/api/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        type: "area",
        label: "technology"
      })
    });
    const createdArea = await areaResponse.json();

    const domainResponse = await fetch(`${ctx.baseUrl}/api/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        type: "domain",
        label: "distributed systems"
      })
    });
    const createdDomain = await domainResponse.json();

    const topicResponse = await fetch(`${ctx.baseUrl}/api/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        type: "topic",
        label: "asynchronous messaging"
      })
    });
    const createdTopic = await topicResponse.json();

    assert.equal(areaResponse.status, 200);
    assert.equal(domainResponse.status, 200);
    assert.equal(topicResponse.status, 200);
    assert.equal(createdArea.node.type, "area");
    assert.equal(createdDomain.node.type, "domain");
    assert.equal(createdTopic.node.type, "topic");

    const graphResponse = await fetch(`${ctx.baseUrl}/api/graph/${session.id}`);
    const graph = await graphResponse.json();
    assert.equal(graphResponse.status, 200);
    assert.equal(graph.edges.some((edge) => edge.source === `session:${session.id}` && edge.target === createdArea.node.id && edge.type === "contains"), true);
    assert.equal(graph.edges.some((edge) => edge.source === createdArea.node.id && edge.target === createdDomain.node.id && edge.type === "contains"), true);
    assert.equal(graph.edges.some((edge) => edge.source === createdDomain.node.id && edge.target === createdTopic.node.id && edge.type === "contains"), true);
  } finally {
    await ctx.close();
  }
});

test("PATCH /api/nodes/:id returns the surviving node after an exact-label merge", async () => {
  const ctx = await startTestServer();

  try {
    const sessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Deduped editing map" })
    });
    const session = await sessionResponse.json();

    const firstNodeResponse = await fetch(`${ctx.baseUrl}/api/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        type: "concept",
        label: "closure"
      })
    });
    const firstNode = (await firstNodeResponse.json()).node;

    const secondNodeResponse = await fetch(`${ctx.baseUrl}/api/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        type: "concept",
        label: "lexical scope"
      })
    });
    const secondNode = (await secondNodeResponse.json()).node;

    const updateResponse = await fetch(`${ctx.baseUrl}/api/nodes/${encodeURIComponent(secondNode.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        label: "closure"
      })
    });
    const updated = await updateResponse.json();

    assert.equal(updateResponse.status, 200);
    assert.equal(updated.node.id, firstNode.id);
    assert.equal(updated.node.label, "closure");
    assert.equal(updated.graph.nodes.filter((node) => node.label === "closure" && node.type === "concept").length, 1);
  } finally {
    await ctx.close();
  }
});

test("PATCH /api/nodes/:id stores markdown notes, records timeline entries, and exports them", async () => {
  const ctx = await startTestServer();

  try {
    const { session, nodes } = await createSessionWithManualNodes(ctx, "Note export map", [
      { type: "concept", label: "idempotency" }
    ]);
    const node = nodes[0];
    const note = [
      "# Idempotency",
      "",
      "- Handles retry safety",
      "- Prevents duplicate side effects",
      "",
      "| Signal | Meaning |",
      "| --- | --- |",
      "| key | dedupe token |"
    ].join("\n");

    const noteResponse = await fetch(`${ctx.baseUrl}/api/nodes/${encodeURIComponent(node.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        note
      })
    });
    const notePayload = await noteResponse.json();

    assert.equal(noteResponse.status, 200);
    assert.equal(notePayload.node.note, note);
    assert.equal(notePayload.node.hasNote, true);
    assert.equal(typeof notePayload.node.noteUpdatedAt, "number");
    assert.equal(notePayload.node.history.some((event) => event.summary === "Added a note."), true);

    const updatedNote = `${note}\n\n\`\`\`js\nconst key = "event-42";\n\`\`\``;
    const updateResponse = await fetch(`${ctx.baseUrl}/api/nodes/${encodeURIComponent(node.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        note: updatedNote
      })
    });
    const updatePayload = await updateResponse.json();

    assert.equal(updateResponse.status, 200);
    assert.equal(updatePayload.node.note, updatedNote);
    assert.equal(updatePayload.node.history.some((event) => event.summary === "Updated the note."), true);

    const graphResponse = await fetch(`${ctx.baseUrl}/api/graph/${encodeURIComponent(session.id)}`);
    const graph = await graphResponse.json();
    assert.equal(graphResponse.status, 200);
    assert.equal(graph.nodes.find((entry) => entry.id === node.id)?.note, updatedNote);

    const exportResponse = await fetch(`${ctx.baseUrl}/api/sessions/${encodeURIComponent(session.id)}/export`);
    const exportData = await exportResponse.json();
    assert.equal(exportResponse.status, 200);
    assert.equal(exportData.notes.length, 1);
    assert.equal(exportData.notes[0].note, updatedNote);
    assert.equal(exportData.concepts[0].note, updatedNote);

    const markdownExportResponse = await fetch(`${ctx.baseUrl}/api/sessions/${encodeURIComponent(session.id)}/export?format=md`);
    const markdownExport = await markdownExportResponse.text();
    assert.equal(markdownExportResponse.status, 200);
    assert.equal(markdownExport.includes("## Node Notes"), true);
    assert.equal(markdownExport.includes("# Idempotency"), true);
    assert.equal(markdownExport.includes("| Signal | Meaning |"), true);
  } finally {
    await ctx.close();
  }
});

test("PATCH /api/nodes/:id keeps notes scoped per session and can clear them", async () => {
  const ctx = await startTestServer();

  try {
    const sessionOneResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Session one" })
    });
    const sessionOne = await sessionOneResponse.json();
    const sessionTwoResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Session two" })
    });
    const sessionTwo = await sessionTwoResponse.json();

    const areaResponse = await fetch(`${ctx.baseUrl}/api/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: sessionOne.id,
        type: "area",
        label: "distributed systems"
      })
    });
    const createdArea = await areaResponse.json();
    assert.equal(areaResponse.status, 200);

    const storedArea = ctx.db.data.nodes.find((entry) => entry.id === createdArea.node.id);
    storedArea.sessionIds.push(sessionTwo.id);
    await ctx.db.write();

    const sessionOneNote = "Shared area note for **session one**.";
    const sessionTwoNote = "Shared area note for _session two_.";

    const sessionOneNoteResponse = await fetch(`${ctx.baseUrl}/api/nodes/${encodeURIComponent(createdArea.node.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: sessionOne.id,
        note: sessionOneNote
      })
    });
    assert.equal(sessionOneNoteResponse.status, 200);

    const sessionOneGraphResponse = await fetch(`${ctx.baseUrl}/api/graph/${encodeURIComponent(sessionOne.id)}`);
    const sessionOneGraph = await sessionOneGraphResponse.json();
    const sessionTwoGraphBeforeResponse = await fetch(`${ctx.baseUrl}/api/graph/${encodeURIComponent(sessionTwo.id)}`);
    const sessionTwoGraphBefore = await sessionTwoGraphBeforeResponse.json();
    assert.equal(sessionOneGraph.nodes.find((entry) => entry.id === createdArea.node.id)?.note, sessionOneNote);
    assert.equal(sessionTwoGraphBefore.nodes.find((entry) => entry.id === createdArea.node.id)?.note ?? "", "");

    const sessionTwoNoteResponse = await fetch(`${ctx.baseUrl}/api/nodes/${encodeURIComponent(createdArea.node.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: sessionTwo.id,
        note: sessionTwoNote
      })
    });
    assert.equal(sessionTwoNoteResponse.status, 200);

    const sessionTwoGraphAfterResponse = await fetch(`${ctx.baseUrl}/api/graph/${encodeURIComponent(sessionTwo.id)}`);
    const sessionTwoGraphAfter = await sessionTwoGraphAfterResponse.json();
    assert.equal(sessionTwoGraphAfter.nodes.find((entry) => entry.id === createdArea.node.id)?.note, sessionTwoNote);

    const clearResponse = await fetch(`${ctx.baseUrl}/api/nodes/${encodeURIComponent(createdArea.node.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: sessionOne.id,
        note: "   "
      })
    });
    const clearPayload = await clearResponse.json();
    assert.equal(clearResponse.status, 200);
    assert.equal(clearPayload.node.note, "");
    assert.equal(clearPayload.node.hasNote, false);
    assert.equal(clearPayload.node.history.some((event) => event.summary === "Cleared the note."), true);

    const finalSessionOneGraph = await (await fetch(`${ctx.baseUrl}/api/graph/${encodeURIComponent(sessionOne.id)}`)).json();
    const finalSessionTwoGraph = await (await fetch(`${ctx.baseUrl}/api/graph/${encodeURIComponent(sessionTwo.id)}`)).json();
    assert.equal(finalSessionOneGraph.nodes.find((entry) => entry.id === createdArea.node.id)?.note ?? "", "");
    assert.equal(finalSessionTwoGraph.nodes.find((entry) => entry.id === createdArea.node.id)?.note, sessionTwoNote);
  } finally {
    await ctx.close();
  }
});

test("PATCH /api/nodes/:id rejects notes above the supported size limit", async () => {
  const ctx = await startTestServer();

  try {
    const { session, nodes } = await createSessionWithManualNodes(ctx, "Large note map", [
      { type: "concept", label: "retry queues" }
    ]);

    const response = await fetch(`${ctx.baseUrl}/api/nodes/${encodeURIComponent(nodes[0].id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        note: "a".repeat(20001)
      })
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.error, /note must be 20000 characters or fewer/i);
  } finally {
    await ctx.close();
  }
});

test("POST /api/nodes reuses one semantic node across roles and PATCH /api/nodes/:id can edit the role set", async () => {
  const ctx = await startTestServer();

  try {
    const sessionResponse = await fetch(`${ctx.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Political theory map" })
    });
    const session = await sessionResponse.json();

    const domainResponse = await fetch(`${ctx.baseUrl}/api/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        type: "domain",
        label: "political science"
      })
    });
    const createdDomain = await domainResponse.json();
    assert.equal(domainResponse.status, 200);
    assert.equal(createdDomain.node.type, "domain");
    assert.deepEqual(createdDomain.node.roles, ["domain"]);

    const skillResponse = await fetch(`${ctx.baseUrl}/api/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        type: "skill",
        label: "political science"
      })
    });
    const createdSkill = await skillResponse.json();

    assert.equal(skillResponse.status, 200);
    assert.equal(createdSkill.node.id, createdDomain.node.id);
    assert.equal(createdSkill.node.type, "domain");
    assert.equal(createdSkill.node.primaryRole, "domain");
    assert.deepEqual(createdSkill.node.secondaryRoles, ["skill"]);
    assert.deepEqual(createdSkill.node.roles, ["domain", "skill"]);
    assert.equal(createdSkill.graph.nodes.filter((node) => node.label === "political science").length, 1);

    const updateResponse = await fetch(`${ctx.baseUrl}/api/nodes/${encodeURIComponent(createdDomain.node.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        primaryRole: "skill",
        secondaryRoles: ["domain"]
      })
    });
    const updated = await updateResponse.json();

    assert.equal(updateResponse.status, 200);
    assert.equal(updated.node.id, createdDomain.node.id);
    assert.equal(updated.node.type, "skill");
    assert.equal(updated.node.primaryRole, "skill");
    assert.deepEqual(updated.node.secondaryRoles, ["domain"]);
    assert.deepEqual(updated.node.roles, ["skill", "domain"]);
    assert.equal(updated.graph.nodes.filter((node) => node.label === "political science").length, 1);
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
    assert.equal(refined.applied.removedEdges, 0);
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
    assert.equal(deleted.sessionTarget.tabSessions.some((entry) => entry.id === second.id), false);
    assert.equal(deleted.sessionTarget.activeSessionId, null);
    assert.equal(deleted.sessionTarget.lastSessionId, first.id);
    assert.equal(ctx.db.data.preferences.openSessionIds.includes(second.id), false);
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
    assert.equal(health.maxPayloadContentChars, 80000);

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
    assert.ok(graph.nodes.some((node) => node.type === "area" && node.label === "technology"));
    assert.ok(graph.nodes.some((node) => node.type === "topic" && node.label === "asynchronous messaging"));
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

    const naturalLanguageSearchResponse = await fetch(`${ctx.baseUrl}/api/search/${demo.id}?q=${encodeURIComponent("What should I study about producers?")}`);
    const naturalLanguageSearch = await naturalLanguageSearchResponse.json();
    assert.equal(naturalLanguageSearchResponse.status, 200);
    assert.equal(naturalLanguageSearch.results.some((result) => result.label.includes("producer")), true);

    const chatResponse = await fetch(`${ctx.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: demo.id, question: "What should I study about producers?" })
    });
    const chat = await chatResponse.json();
    assert.equal(chatResponse.status, 200);
    assert.ok(chat.answer);
    assert.ok(Array.isArray(chat.citations));
    assert.ok(chat.citations.length > 0);

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

test("POST /api/restore collapses exact semantic duplicates across roles", async () => {
  const ctx = await startTestServer();

  try {
    const sessionId = "session:semantic-role-cleanup";
    const goalId = "goal:semantic-role-cleanup";
    const backup = {
      app: "MindWeaver",
      data: {
        sessions: [
          {
            id: sessionId,
            goal: "Political theory map",
            createdAt: Date.now()
          }
        ],
        goals: [
          {
            id: goalId,
            sessionId,
            title: "Political theory map",
            createdAt: Date.now()
          }
        ],
        nodes: [
          {
            id: `session:${sessionId}`,
            label: "Learning Session",
            type: "root",
            createdAt: Date.now(),
            sessionIds: [sessionId],
            sessionReviews: {},
            aliases: [],
            history: []
          },
          {
            id: goalId,
            label: "Political theory map",
            type: "goal",
            createdAt: Date.now(),
            sessionIds: [sessionId],
            sessionReviews: {},
            aliases: [],
            history: []
          },
          {
            id: "domain:political-science",
            label: "political science",
            canonicalLabel: "political science",
            type: "domain",
            createdAt: Date.now(),
            sessionIds: [sessionId],
            sessionReviews: {},
            aliases: [],
            history: [],
            confidence: 0.86
          },
          {
            id: "skill:political-science",
            label: "political science",
            canonicalLabel: "political science",
            type: "skill",
            createdAt: Date.now() + 1,
            sessionIds: [sessionId],
            sessionReviews: {},
            aliases: [],
            history: [],
            confidence: 0.72
          }
        ],
        edges: [
          {
            key: `session:${sessionId}__pursues__${goalId}`,
            source: `session:${sessionId}`,
            target: goalId,
            label: "pursues",
            type: "pursues",
            createdAt: Date.now(),
            sessionIds: [sessionId],
            sessionReviews: {}
          },
          {
            key: `${goalId}__focuses_on__domain:political-science`,
            source: goalId,
            target: "domain:political-science",
            label: "focuses_on",
            type: "focuses_on",
            createdAt: Date.now(),
            sessionIds: [sessionId],
            sessionReviews: {}
          },
          {
            key: "domain:political-science__contains__skill:political-science",
            source: "domain:political-science",
            target: "skill:political-science",
            label: "contains",
            type: "contains",
            createdAt: Date.now(),
            sessionIds: [sessionId],
            sessionReviews: {}
          }
        ],
        preferences: {
          activeSessionId: sessionId,
          lastSessionId: sessionId
        }
      }
    };

    const restoreResponse = await fetch(`${ctx.baseUrl}/api/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirm: true,
        backup
      })
    });
    const restore = await restoreResponse.json();
    assert.equal(restoreResponse.status, 200);
    assert.equal(restore.ok, true);

    const graphResponse = await fetch(`${ctx.baseUrl}/api/graph/${encodeURIComponent(sessionId)}`);
    const graph = await graphResponse.json();
    assert.equal(graphResponse.status, 200);

    const politicalScienceNodes = graph.nodes.filter((node) => node.label === "political science");
    assert.equal(politicalScienceNodes.length, 1);
    assert.equal(politicalScienceNodes[0].type, "domain");
    assert.equal(politicalScienceNodes[0].primaryRole, "domain");
    assert.deepEqual(politicalScienceNodes[0].secondaryRoles, ["skill"]);
    assert.equal(graph.edges.some((edge) => edge.source === edge.target), false);
  } finally {
    await ctx.close();
  }
});

test("POST /api/intersect bridges two selected nodes", async () => {
  const ctx = await startTestServer();

  try {
    const { nodes } = await createSessionWithManualNodes(ctx, "Bridge map", [
      { type: "domain", label: "Political Science" },
      { type: "skill", label: "International Relations" }
    ]);

    const intersectResponse = await fetch(`${ctx.baseUrl}/api/intersect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodeId1: nodes[0].id,
        nodeId2: nodes[1].id
      })
    });
    const intersection = await intersectResponse.json();

    assert.equal(intersectResponse.status, 200);
    assert.deepEqual(intersection.nodeIds, [nodes[0].id, nodes[1].id]);
    assert.deepEqual(intersection.bridge_concepts, ["idempotency"]);
    assert.match(intersection.reasoning, /Idempotency connects retries to safe consumer behavior\./);
  } finally {
    await ctx.close();
  }
});

test("POST /api/intersect accepts nodeIds arrays for multi-select bridges", async () => {
  const ctx = await startTestServer();

  try {
    const { nodes } = await createSessionWithManualNodes(ctx, "Geopolitics map", [
      { type: "domain", label: "Political Science" },
      { type: "skill", label: "International Relations" },
      { type: "concept", label: "Geography" }
    ]);

    const intersectResponse = await fetch(`${ctx.baseUrl}/api/intersect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodeIds: nodes.map((node) => node.id)
      })
    });
    const intersection = await intersectResponse.json();

    assert.equal(intersectResponse.status, 200);
    assert.deepEqual(intersection.nodeIds, nodes.map((node) => node.id));
    assert.deepEqual(intersection.bridge_concepts, ["idempotency"]);
    assert.match(intersection.reasoning, /Idempotency connects retries to safe consumer behavior\./);
  } finally {
    await ctx.close();
  }
});
