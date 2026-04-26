import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMindWeaverMcpServer } from "../mcp.js";

async function createTempDataFile() {
  const dir = await mkdtemp(join(os.tmpdir(), "mindweaver-mcp-"));
  return {
    dir,
    dataFile: join(dir, "data.json"),
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

function parseToolJson(result) {
  const text = result?.content?.find((part) => part.type === "text")?.text;
  assert.ok(text, "tool returned JSON text");
  return JSON.parse(text);
}

test("MCP operations create, read, search, update, and traverse graph data", async () => {
  const temp = await createTempDataFile();
  try {
    const { operations } = createMindWeaverMcpServer({ dataFile: temp.dataFile });

    const createdMap = await operations.createMap({
      title: "Agent memory map",
      description: "Shared graph for coding agents."
    });
    const sessionId = createdMap.map.id;

    const domain = await operations.addNode({
      sessionId,
      type: "domain",
      label: "MCP servers",
      description: "Tool servers exposed through the Model Context Protocol."
    });
    const concept = await operations.addNode({
      sessionId,
      type: "concept",
      label: "bounded writes",
      description: "Agents can add durable notes without destructive actions.",
      parentId: domain.node.id,
      note: "Prefer additive graph edits until a human reviews them."
    });
    const edge = await operations.addEdge({
      sessionId,
      sourceId: domain.node.id,
      targetId: concept.node.id,
      type: "supports",
      label: "supports safe shared memory"
    });

    assert.equal(edge.edge.reviewStatus, "approved");

    const graph = await operations.getGraph({ sessionId, compact: true });
    assert.ok(graph.nodes.some((node) => node.label === "bounded write"));
    assert.ok(graph.edges.some((entry) => entry.source === domain.node.id && entry.target === concept.node.id));

    const search = await operations.search({ sessionId, query: "bounded write" });
    assert.ok(search.results.some((result) => result.id === concept.node.id));

    const updated = await operations.updateNode({
      sessionId,
      nodeId: concept.node.id,
      summary: "Bounded writes keep agent-authored memory auditable.",
      note: "Updated MCP note."
    });
    assert.equal(updated.node.note, "Updated MCP note.");
    assert.equal(updated.node.summary, "Bounded writes keep agent-authored memory auditable.");

    const traversal = await operations.traverseGraph({
      sessionId,
      startNodeId: domain.node.id,
      depth: 1,
      direction: "out"
    });
    assert.ok(traversal.nodes.some((node) => node.id === concept.node.id));
    assert.ok(traversal.edges.some((entry) => entry.key === edge.edge.key));
  } finally {
    await temp.cleanup();
  }
});

test("MCP stdio server exposes tools and resources to a real MCP client", async () => {
  const temp = await createTempDataFile();
  const rootDir = join(process.cwd(), "..");
  const serverParams = process.platform === "win32"
    ? {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", join(rootDir, "start-mcp.bat")],
        cwd: rootDir
      }
    : {
        command: process.execPath,
        args: ["mcp.js"],
        cwd: process.cwd()
      };
  const transport = new StdioClientTransport({
    ...serverParams,
    env: {
      ...process.env,
      MINDWEAVER_DATA_FILE: temp.dataFile
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "mindweaver-mcp-test", version: "1.0.0" });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    assert.ok(toolNames.includes("mindweaver_create_map"));
    assert.ok(toolNames.includes("mindweaver_traverse_graph"));
    assert.ok(toolNames.includes("mindweaver_add_edge"));

    const createdMap = parseToolJson(await client.callTool({
      name: "mindweaver_create_map",
      arguments: {
        title: "Stdio MCP map"
      }
    }));
    const sessionId = createdMap.map.id;

    const node = parseToolJson(await client.callTool({
      name: "mindweaver_add_node",
      arguments: {
        sessionId,
        type: "concept",
        label: "stdio transport",
        description: "Claude Code and Codex launch this server as a child process."
      }
    }));
    assert.equal(node.node.label, "stdio transport");

    const graph = parseToolJson(await client.callTool({
      name: "mindweaver_get_graph",
      arguments: {
        sessionId,
        compact: true
      }
    }));
    assert.ok(graph.nodes.some((entry) => entry.id === node.node.id));

    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === "mindweaver://maps"));
    assert.ok(resources.resources.some((resource) => resource.uri === `mindweaver://maps/${sessionId}/graph`));

    const resource = await client.readResource({ uri: `mindweaver://maps/${sessionId}/graph` });
    const resourceJson = JSON.parse(resource.contents[0].text);
    assert.equal(resourceJson.session.id, sessionId);
    assert.ok(resourceJson.nodes.some((entry) => entry.id === node.node.id));
  } finally {
    await client.close().catch(() => {});
    await temp.cleanup();
  }
});
