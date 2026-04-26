import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import { z } from "zod";
import { config } from "dotenv";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDb, initDb } from "./db.js";
import { resolveMindWeaverDataFile } from "./data-file.js";
import * as services from "./services/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
if (process.env.MINDWEAVER_ENV_FILE) {
  config({ path: process.env.MINDWEAVER_ENV_FILE });
}

const {
  MAX_NODE_NOTE_LENGTH,
  RELATIONSHIP_TYPES,
  USER_CREATABLE_NODE_TYPES,
  addHistoryEntry,
  buildSessionGraph,
  createGoalForSession,
  createSessionNode,
  ensureEdge,
  ensureNode,
  ensureSessionWorkspace,
  findPreferredParentNode,
  getDefaultRelationshipType,
  getDefaultWorkspace,
  getSession,
  getSessionGoal,
  hasSessionMembership,
  repairSessionSelection,
  sanitizeDataShape,
  searchGraph,
  selectActiveSession,
  serializeEdgeForSession,
  serializeNodeForSession,
  setEdgeReview,
  setSessionNodeNote,
  syncNodeSemanticIdentity
} = services;

const MAX_GRAPH_NODES = 500;
const MAX_TRAVERSAL_DEPTH = 4;

function jsonText(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function compactNode(node) {
  return {
    id: node.id,
    label: node.label,
    type: node.type,
    primaryRole: node.primaryRole,
    secondaryRoles: node.secondaryRoles,
    confidence: node.confidence,
    reviewStatus: node.reviewStatus,
    masteryState: node.masteryState,
    evidenceCount: node.evidenceCount,
    summary: node.summary,
    hasNote: node.hasNote
  };
}

function compactEdge(edge) {
  return {
    key: edge.key,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    type: edge.type,
    confidence: edge.confidence,
    reviewStatus: edge.reviewStatus
  };
}

function summarizeSession(db, session) {
  const nodes = db.data.nodes.filter((node) => hasSessionMembership(node, session.id) && node.type !== "root");
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = db.data.edges.filter((edge) =>
    hasSessionMembership(edge, session.id) && nodeIds.has(edge.source) && nodeIds.has(edge.target)
  );
  const artifacts = db.data.artifacts.filter((artifact) => artifact.sessionId === session.id);
  const goal = getSessionGoal(db, session.id);

  return {
    id: session.id,
    title: session.goal || goal?.title || "Untitled MindWeaver map",
    goalId: goal?.id ?? null,
    startedAt: session.startedAt ?? null,
    endedAt: session.endedAt ?? null,
    workspaceId: session.workspaceId ?? null,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    sourceCount: artifacts.length,
    active: db.data.preferences?.activeSessionId === session.id
  };
}

function assertSession(db, sessionId) {
  const safeSessionId = String(sessionId ?? "").trim();
  if (!safeSessionId) throw new Error("sessionId is required");
  const session = getSession(db, safeSessionId);
  if (!session) throw new Error(`session not found: ${safeSessionId}`);
  return session;
}

function assertNodeInSession(db, sessionId, nodeId) {
  const safeNodeId = String(nodeId ?? "").trim();
  if (!safeNodeId) throw new Error("nodeId is required");
  const node = db.data.nodes.find((entry) => entry.id === safeNodeId && hasSessionMembership(entry, sessionId));
  if (!node) throw new Error(`node not found in session: ${safeNodeId}`);
  return node;
}

function normalizeLimit(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(parsed)));
}

export function createMindWeaverMcpServer({ db = null, dataFile = resolveMindWeaverDataFile() } = {}) {
  const targetDb = db ?? createDb(dataFile);
  let ready = false;

  async function refresh() {
    if (!ready) {
      await initDb(targetDb);
      ready = true;
    } else {
      await targetDb.read();
      targetDb.data = sanitizeDataShape(targetDb.data);
      repairSessionSelection(targetDb);
    }
  }

  async function persist() {
    targetDb.data = sanitizeDataShape(targetDb.data);
    repairSessionSelection(targetDb);
    await targetDb.write();
  }

  async function listMaps({ limit = 25, includeEnded = true } = {}) {
    await refresh();
    const safeLimit = normalizeLimit(limit, 25, 200);
    const maps = [...targetDb.data.sessions]
      .filter((session) => includeEnded || !session.endedAt)
      .sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
      .slice(0, safeLimit)
      .map((session) => summarizeSession(targetDb, session));
    return {
      maps,
      activeSessionId: targetDb.data.preferences?.activeSessionId ?? null
    };
  }

  async function createMap({ title, description = "" }) {
    await refresh();
    const safeTitle = String(title ?? "").trim();
    if (!safeTitle) throw new Error("title is required");

    const workspace = getDefaultWorkspace(targetDb);
    const session = {
      id: nanoid(),
      startedAt: Date.now(),
      endedAt: null,
      goal: safeTitle,
      latestGapAnalysis: null,
      workspaceId: workspace.id,
      ownerId: workspace.ownerId
    };

    targetDb.data.sessions.push(session);
    ensureNode(targetDb, `session:${session.id}`, "Learning Session", "root", {
      sessionId: session.id,
      verified: true,
      confidence: 1,
      reason: "Created as the root node for this session."
    });
    ensureSessionWorkspace(targetDb, session);
    selectActiveSession(targetDb, session.id);

    if (description.trim()) {
      createGoalForSession(targetDb, session.id, safeTitle, description.trim(), { syncWithMapName: true });
    }

    await persist();
    return {
      ok: true,
      map: summarizeSession(targetDb, session)
    };
  }

  async function getGraph({ sessionId, compact = true, includeArtifacts = false, limit = MAX_GRAPH_NODES }) {
    await refresh();
    assertSession(targetDb, sessionId);
    const safeLimit = normalizeLimit(limit, MAX_GRAPH_NODES, 2000);
    const graph = buildSessionGraph(targetDb, sessionId);
    const nodes = graph.nodes.slice(0, safeLimit);
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));

    return {
      session: graph.session,
      goals: graph.goals,
      health: graph.health,
      nodes: compact ? nodes.map(compactNode) : nodes,
      edges: compact ? edges.map(compactEdge) : edges,
      artifacts: includeArtifacts ? graph.artifacts : undefined,
      reviewQueue: graph.reviewQueue,
      recommendations: graph.recommendations,
      truncated: graph.nodes.length > nodes.length
    };
  }

  async function getNode({ sessionId, nodeId, includeNeighbors = true }) {
    await refresh();
    assertSession(targetDb, sessionId);
    const node = serializeNodeForSession(assertNodeInSession(targetDb, sessionId, nodeId), sessionId);
    const graph = buildSessionGraph(targetDb, sessionId);
    const neighbors = includeNeighbors
      ? graph.edges
        .filter((edge) => edge.source === node.id || edge.target === node.id)
        .map((edge) => ({
          edge: compactEdge(edge),
          node: compactNode(graph.nodes.find((entry) => entry.id === (edge.source === node.id ? edge.target : edge.source)))
        }))
        .filter((entry) => entry.node)
      : [];

    return { node, neighbors };
  }

  async function traverseGraph({ sessionId, startNodeId, depth = 1, direction = "both" }) {
    await refresh();
    assertSession(targetDb, sessionId);
    assertNodeInSession(targetDb, sessionId, startNodeId);
    const safeDepth = normalizeLimit(depth, 1, MAX_TRAVERSAL_DEPTH);
    const safeDirection = ["both", "out", "in"].includes(direction) ? direction : "both";
    const graph = buildSessionGraph(targetDb, sessionId);
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const visited = new Set([startNodeId]);
    const traversedEdges = new Map();
    let frontier = [startNodeId];

    for (let level = 0; level < safeDepth && frontier.length; level += 1) {
      const next = [];
      for (const id of frontier) {
        const candidateEdges = graph.edges.filter((edge) => {
          if (safeDirection === "out") return edge.source === id;
          if (safeDirection === "in") return edge.target === id;
          return edge.source === id || edge.target === id;
        });

        for (const edge of candidateEdges) {
          traversedEdges.set(edge.key, edge);
          const neighborId = edge.source === id ? edge.target : edge.source;
          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            next.push(neighborId);
          }
        }
      }
      frontier = next;
    }

    return {
      startNodeId,
      depth: safeDepth,
      direction: safeDirection,
      nodes: [...visited].map((id) => compactNode(nodesById.get(id))).filter(Boolean),
      edges: [...traversedEdges.values()].map(compactEdge)
    };
  }

  async function addNode({ sessionId, type, label, description = "", parentId = "", note = "" }) {
    await refresh();
    assertSession(targetDb, sessionId);
    const safeType = String(type ?? "").trim().toLowerCase();
    const safeLabel = String(label ?? "").trim();
    const safeParentId = String(parentId ?? "").trim();
    if (!USER_CREATABLE_NODE_TYPES.has(safeType)) {
      throw new Error(`type must be one of: ${[...USER_CREATABLE_NODE_TYPES].join(", ")}`);
    }
    if (!safeLabel) throw new Error("label is required");

    let node = null;
    if (safeType === "goal" && !getSessionGoal(targetDb, sessionId)) {
      const goal = createGoalForSession(targetDb, sessionId, safeLabel, description);
      node = goal ? targetDb.data.nodes.find((entry) => entry.id === goal.id) ?? null : null;
    } else {
      node = createSessionNode(targetDb, {
        type: safeType,
        label: safeLabel,
        description,
        createdBy: "mcp",
        verified: safeType === "goal",
        confidence: safeType === "goal" ? 1 : 0.9,
        sessionId,
        reason: "Created through the MindWeaver MCP server."
      });

      const explicitParent = safeParentId ? assertNodeInSession(targetDb, sessionId, safeParentId) : null;
      const parentNode = explicitParent ?? findPreferredParentNode(targetDb, sessionId, safeType);
      if (node && parentNode && parentNode.id !== node.id) {
        const edgeType = getDefaultRelationshipType(parentNode.type, safeType);
        ensureEdge(targetDb, parentNode.id, node.id, edgeType, edgeType, 0.9, "mcp", sessionId);
      }
    }

    if (!node) throw new Error("could not create node");
    syncNodeSemanticIdentity(node, { primaryRole: node.primaryRole ?? node.type, secondaryRoles: node.secondaryRoles ?? [] });

    if (String(note ?? "").trim()) {
      setSessionNodeNote(node, sessionId, String(note).slice(0, MAX_NODE_NOTE_LENGTH));
    }

    addHistoryEntry(node, {
      kind: "mcp-node-created",
      sessionId,
      summary: `Created through the MindWeaver MCP server as a ${safeType} node.`
    });

    await persist();
    return {
      ok: true,
      node: serializeNodeForSession(node, sessionId)
    };
  }

  async function updateNode({ sessionId, nodeId, label, description, summary, note, primaryRole, secondaryRoles }) {
    await refresh();
    assertSession(targetDb, sessionId);
    const node = assertNodeInSession(targetDb, sessionId, nodeId);

    if (label !== undefined) {
      const safeLabel = String(label ?? "").trim();
      if (!safeLabel) throw new Error("label cannot be empty");
      node.label = safeLabel;
      node.canonicalLabel = services.normalizeLabel(safeLabel);
    }
    if (description !== undefined) node.description = String(description ?? "").trim();
    if (summary !== undefined) node.summary = String(summary ?? "").trim();
    if (primaryRole !== undefined || secondaryRoles !== undefined) {
      syncNodeSemanticIdentity(node, {
        primaryRole: primaryRole ?? node.primaryRole ?? node.type,
        secondaryRoles: Array.isArray(secondaryRoles) ? secondaryRoles : node.secondaryRoles ?? []
      });
    }
    if (note !== undefined) {
      setSessionNodeNote(node, sessionId, String(note ?? "").slice(0, MAX_NODE_NOTE_LENGTH));
    }

    addHistoryEntry(node, {
      kind: "mcp-node-updated",
      sessionId,
      summary: "Updated through the MindWeaver MCP server."
    });

    await persist();
    return {
      ok: true,
      node: serializeNodeForSession(node, sessionId)
    };
  }

  async function addEdge({ sessionId, sourceId, targetId, type = "related", label = "" }) {
    await refresh();
    assertSession(targetDb, sessionId);
    const safeType = String(type ?? "related").trim();
    const safeLabel = String(label ?? safeType).trim() || safeType;
    const source = assertNodeInSession(targetDb, sessionId, sourceId);
    const target = assertNodeInSession(targetDb, sessionId, targetId);
    if (source.id === target.id) throw new Error("sourceId and targetId must be different");
    if (!RELATIONSHIP_TYPES.has(safeType)) {
      throw new Error(`type must be one of: ${[...RELATIONSHIP_TYPES].join(", ")}`);
    }

    const edge = ensureEdge(targetDb, source.id, target.id, safeLabel, safeType, 0.9, "mcp", sessionId);
    setEdgeReview(edge, sessionId, "approved");
    addHistoryEntry(source, {
      kind: "mcp-edge-created",
      sessionId,
      summary: `Created ${safeType} relationship to ${target.label}.`
    });

    await persist();
    return {
      ok: true,
      edge: serializeEdgeForSession(edge, sessionId)
    };
  }

  async function search({ sessionId, query, limit = 20 }) {
    await refresh();
    assertSession(targetDb, sessionId);
    const result = searchGraph(targetDb, sessionId, String(query ?? ""));
    const safeLimit = normalizeLimit(limit, 20, 100);
    return {
      ...result,
      results: (result.results ?? []).slice(0, safeLimit),
      nodes: (result.nodes ?? []).slice(0, safeLimit),
      artifacts: (result.artifacts ?? []).slice(0, safeLimit)
    };
  }

  const server = new McpServer(
    {
      name: "mindweaver-graph",
      version: "1.0.0"
    },
    {
      instructions: "Read, search, traverse, and safely extend a local MindWeaver knowledge graph. Prefer search or get_graph before mutating the graph, and do not invent evidence."
    }
  );

  server.registerResource(
    "mindweaver-maps",
    "mindweaver://maps",
    {
      title: "MindWeaver maps",
      description: "List of local MindWeaver maps with graph counts.",
      mimeType: "application/json"
    },
    async () => ({
      contents: [
        {
          uri: "mindweaver://maps",
          mimeType: "application/json",
          text: JSON.stringify(await listMaps({ limit: 200 }), null, 2)
        }
      ]
    })
  );

  server.registerResource(
    "mindweaver-map-graph",
    new ResourceTemplate("mindweaver://maps/{sessionId}/graph", {
      list: async () => {
        const { maps } = await listMaps({ limit: 200 });
        return {
          resources: maps.map((map) => ({
            uri: `mindweaver://maps/${map.id}/graph`,
            name: `${map.title} graph`,
            mimeType: "application/json",
            description: `MindWeaver graph for map ${map.id}`
          }))
        };
      },
      complete: {
        sessionId: async (value) => {
          const { maps } = await listMaps({ limit: 200 });
          return maps
            .map((map) => map.id)
            .filter((id) => id.startsWith(String(value ?? "")))
            .slice(0, 20);
        }
      }
    }),
    {
      title: "MindWeaver map graph",
      description: "Session-scoped MindWeaver graph JSON.",
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const sessionId = String(variables.sessionId ?? "").trim();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(await getGraph({ sessionId, compact: false, includeArtifacts: true }), null, 2)
          }
        ]
      };
    }
  );

  server.registerPrompt(
    "mindweaver_graph_brief",
    {
      title: "MindWeaver graph brief",
      description: "Prepare a concise, evidence-aware briefing prompt for a graph map.",
      argsSchema: {
        sessionId: z.string(),
        focus: z.string().optional()
      }
    },
    async ({ sessionId, focus = "" }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Use the MindWeaver MCP tools to inspect map ${sessionId}${focus ? ` with focus: ${focus}` : ""}. Summarize the strongest nodes, weak evidence, useful relationships, and safe next additions.`
          }
        }
      ]
    })
  );

  server.registerTool(
    "mindweaver_list_maps",
    {
      title: "List MindWeaver maps",
      description: "List local MindWeaver maps and their graph counts.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional(),
        includeEnded: z.boolean().optional()
      })
    },
    async (args) => jsonText(await listMaps(args))
  );

  server.registerTool(
    "mindweaver_create_map",
    {
      title: "Create MindWeaver map",
      description: "Create a new local MindWeaver map and make it active.",
      inputSchema: z.object({
        title: z.string().min(1),
        description: z.string().optional()
      })
    },
    async (args) => jsonText(await createMap(args))
  );

  server.registerTool(
    "mindweaver_get_graph",
    {
      title: "Get MindWeaver graph",
      description: "Read a session-scoped graph. Use compact=true for agent-friendly summaries.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        compact: z.boolean().optional(),
        includeArtifacts: z.boolean().optional(),
        limit: z.number().int().min(1).max(2000).optional()
      })
    },
    async (args) => jsonText(await getGraph(args))
  );

  server.registerTool(
    "mindweaver_search_graph",
    {
      title: "Search MindWeaver graph",
      description: "Search node labels, summaries, notes, and source evidence in a map.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        query: z.string(),
        limit: z.number().int().min(1).max(100).optional()
      })
    },
    async (args) => jsonText(await search(args))
  );

  server.registerTool(
    "mindweaver_get_node",
    {
      title: "Get MindWeaver node",
      description: "Read one node with its session note, evidence summary, history, and optional neighbors.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        nodeId: z.string().min(1),
        includeNeighbors: z.boolean().optional()
      })
    },
    async (args) => jsonText(await getNode(args))
  );

  server.registerTool(
    "mindweaver_traverse_graph",
    {
      title: "Traverse MindWeaver graph",
      description: "Walk outward, inward, or both directions from a starting node for a bounded depth.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        startNodeId: z.string().min(1),
        depth: z.number().int().min(1).max(MAX_TRAVERSAL_DEPTH).optional(),
        direction: z.enum(["both", "out", "in"]).optional()
      })
    },
    async (args) => jsonText(await traverseGraph(args))
  );

  server.registerTool(
    "mindweaver_add_node",
    {
      title: "Add MindWeaver node",
      description: "Create a goal, area, domain, topic, skill, or concept node in a map.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        type: z.enum([...USER_CREATABLE_NODE_TYPES]),
        label: z.string().min(1),
        description: z.string().optional(),
        parentId: z.string().optional(),
        note: z.string().max(MAX_NODE_NOTE_LENGTH).optional()
      })
    },
    async (args) => jsonText(await addNode(args))
  );

  server.registerTool(
    "mindweaver_update_node",
    {
      title: "Update MindWeaver node",
      description: "Update node text fields, semantic roles, or the session-scoped Markdown note.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        nodeId: z.string().min(1),
        label: z.string().min(1).optional(),
        description: z.string().optional(),
        summary: z.string().optional(),
        note: z.string().max(MAX_NODE_NOTE_LENGTH).optional(),
        primaryRole: z.enum(["area", "domain", "topic", "skill"]).optional(),
        secondaryRoles: z.array(z.enum(["area", "domain", "topic", "skill"])).optional()
      })
    },
    async (args) => jsonText(await updateNode(args))
  );

  server.registerTool(
    "mindweaver_add_edge",
    {
      title: "Add MindWeaver edge",
      description: "Create and approve a relationship between two existing nodes in the same map.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        sourceId: z.string().min(1),
        targetId: z.string().min(1),
        type: z.enum([...RELATIONSHIP_TYPES]).optional(),
        label: z.string().optional()
      })
    },
    async (args) => jsonText(await addEdge(args))
  );

  return {
    server,
    db: targetDb,
    operations: {
      listMaps,
      createMap,
      getGraph,
      getNode,
      traverseGraph,
      addNode,
      updateNode,
      addEdge,
      search
    }
  };
}

export async function startMindWeaverMcpServer(options = {}) {
  const { server } = createMindWeaverMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startMindWeaverMcpServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
