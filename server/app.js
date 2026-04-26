import express from "express";
import cors from "cors";
import { nanoid } from "nanoid";
import { existsSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { syncDbFromDisk } from "./db.js";
import { requestStructuredJson, requestText } from "./openai.js";
import { getDefaultCodexConfigPath, installMindWeaverCodexConfig } from "./codex-config.js";
import * as services from "./services/index.js";

const {
  CHAT_IMPORT_PROVIDERS,
  CHAT_IMPORT_SCHEMA_VERSION,
  MAX_NODE_NOTE_LENGTH,
  RELATIONSHIP_TYPES,
  SEMANTIC_ROLE_TYPES,
  STRUCTURED_RESPONSE_SCHEMAS,
  USER_CREATABLE_NODE_TYPES,
  addHistoryEntry,
  applyAutomaticDuplicateCleanup,
  applyReviewOutcome,
  buildChatHistoryImportPrompt,
  buildExtractiveAnswer,
  buildGraphContext,
  buildHealthPayload,
  buildLearningSummary,
  buildMarkdownExport,
  buildProgressReport,
  buildRecommendedActions,
  buildReviewQueue,
  buildRecommendations,
  buildSessionExport,
  buildSessionGraph,
  buildSessionSummary,
  buildSessionTargetPayload,
  clearActiveSession,
  createDemoSession,
  createFallbackGapResponse,
  createGoalForSession,
  createSequentialTaskQueue,
  createSessionNode,
  deleteArtifactFromSession,
  deleteSessionData,
  ensureEdge,
  ensureNode,
  ensureSessionWorkspace,
  findPreferredParentNode,
  findVisibleSessionNodes,
  getDefaultRelationshipType,
  getDefaultWorkspace,
  getSession,
  getSessionGoal,
  hasSessionMembership,
  ingestChatHistoryImport,
  ingestSource,
  isAllowedCorsOrigin,
  mergeNodeIntoTarget,
  normalizeLabel,
  normalizeQuizGenerationPayload,
  normalizeSessionIdList,
  refineSessionGraph,
  repairSessionSelection,
  renameSessionMap,
  resolveCanonicalSessionNode,
  resolveRequestLlmSelection,
  sanitizeDataShape,
  searchGraph,
  selectActiveSession,
  serializeEdgeForSession,
  serializeNodeForSession,
  setEdgeReview,
  setSessionNodeNote,
  setNodeReview,
  setStoredLlmSettings,
  slugify,
  syncNodeSemanticIdentity,
  validateChatHistoryImportPayload,
  validateIngestPayload
} = services;
function createDefaultAgentAccessPayload(dataFilePath = process.env.MINDWEAVER_DATA_FILE || null) {
  const launcherPath = process.env.MINDWEAVER_MCP_LAUNCHER_PATH || null;
  const command = launcherPath ? "cmd.exe" : "node";
  const args = launcherPath ? ["/d", "/s", "/c", launcherPath] : ["server/mcp.js"];
  const env = dataFilePath ? { MINDWEAVER_DATA_FILE: dataFilePath } : {};

  return {
    available: true,
    transport: "stdio",
    launcherPath,
    dataFilePath,
    packaged: false,
    codexConfigPath: getDefaultCodexConfigPath(),
    codexConfig: {
      mcpServers: {
        mindweaver: {
          command,
          args,
          env
        }
      }
    },
    claudeCodeConfig: {
      mcpServers: {
        mindweaver: {
          command,
          args,
          env
        }
      }
    }
  };
}

export function createApp({ db, openaiClient = null, ollamaBaseUrl = null, staticDir = null, agentAccess = null, dataFilePath = null } = {}) {
  if (!db) throw new Error("createApp requires a db instance");
  db.data = sanitizeDataShape(db.data);
  repairSessionSelection(db);
  const agentAccessPayload = agentAccess ?? createDefaultAgentAccessPayload(dataFilePath);

  const app = express();
  const eventClients = new Set();
  let dataFileWatcher = null;
  let dataFileEventTimer = null;
  let lastBroadcastDataSnapshot = null;
  const defaultJsonParser = express.json({ limit: "2mb" });
  const enqueuePageSave = createSequentialTaskQueue();
  const buildRequestLlmRuntime = (rawSelection) => ({
    openaiClient,
    ollamaBaseUrl,
    llmProvider: resolveRequestLlmSelection(db, rawSelection)
  });
  const broadcastDataChange = (reason = "data-file-changed") => {
    if (!eventClients.size) return;
    const payload = `data: ${JSON.stringify({
      type: "data-changed",
      reason,
      at: Date.now()
    })}\n\n`;
    for (const client of eventClients) {
      client.write(payload);
    }
  };
  if (dataFilePath && existsSync(dataFilePath)) {
    try {
      lastBroadcastDataSnapshot = readFileSync(dataFilePath, "utf8");
    } catch {
      lastBroadcastDataSnapshot = null;
    }
    dataFileWatcher = watch(dataFilePath, { persistent: false }, () => {
      clearTimeout(dataFileEventTimer);
      dataFileEventTimer = setTimeout(() => {
        let nextSnapshot = null;
        try {
          nextSnapshot = readFileSync(dataFilePath, "utf8");
        } catch {
          nextSnapshot = null;
        }

        if (nextSnapshot === lastBroadcastDataSnapshot) {
          return;
        }

        lastBroadcastDataSnapshot = nextSnapshot;
        broadcastDataChange();
      }, 75);
    });
    dataFileWatcher.on("error", (error) => {
      console.warn("MindWeaver realtime watch failed:", error);
    });
  }
  app.locals.closeRealtime = () => {
    clearTimeout(dataFileEventTimer);
    dataFileEventTimer = null;
    if (dataFileWatcher) {
      dataFileWatcher.close();
      dataFileWatcher = null;
    }
    for (const client of eventClients) {
      client.end();
    }
    eventClients.clear();
  };
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });
  app.use(cors({
    origin(origin, callback) {
      return callback(null, isAllowedCorsOrigin(origin));
    }
  }));
  app.use((req, res, next) => {
    if (req.method === "POST" && req.path === "/api/import-chat-history") {
      let rawBody = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        rawBody += chunk;
      });
      req.on("end", () => {
        if (!rawBody) {
          req.body = {};
          next();
          return;
        }

        try {
          req.body = JSON.parse(rawBody);
          next();
        } catch {
          res.status(400).json({ ok: false, error: "Request body must be valid JSON." });
        }
      });
      req.on("error", next);
      return;
    }

    defaultJsonParser(req, res, next);
  });
  app.use(async (req, res, next) => {
    if (!["GET", "HEAD"].includes(req.method)) {
      next();
      return;
    }

    try {
      await syncDbFromDisk(db);
      db.data = sanitizeDataShape(db.data);
      repairSessionSelection(db);
      next();
    } catch (error) {
      res.status(500).json({ error: error.message || "Could not synchronize MindWeaver state from disk." });
    }
  });

  app.get("/api/health", async (req, res) => {
    res.json(await buildHealthPayload({ db, openaiClient, ollamaBaseUrl }));
  });

  app.get("/api/agent-access", async (req, res) => {
    res.json(agentAccessPayload);
  });

  app.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 15000);

    eventClients.add(res);
    res.write(`data: ${JSON.stringify({ type: "connected", at: Date.now() })}\n\n`);

    req.on("close", () => {
      clearInterval(heartbeat);
      eventClients.delete(res);
      res.end();
    });
  });

  app.post("/api/agent-access/codex-config", async (req, res) => {
    try {
      res.json(installMindWeaverCodexConfig({
        codexConfig: agentAccessPayload.codexConfig,
        configPath: agentAccessPayload.codexConfigPath
      }));
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message || "Could not update Codex config."
      });
    }
  });

  app.put("/api/settings/llm", async (req, res) => {
    setStoredLlmSettings(db, req.body?.llmProvider ?? req.body ?? {});
    await db.write();
    res.json(await buildHealthPayload({ db, openaiClient, ollamaBaseUrl }));
  });

  app.get("/api/workspaces", async (req, res) => {
    const workspace = getDefaultWorkspace(db);
    await db.write();
    res.json({ workspaces: [workspace] });
  });

  app.post("/api/workspaces", async (req, res) => {
    const name = String(req.body?.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "name required" });
    getDefaultWorkspace(db);
    const user = db.data.users.find((entry) => entry.id === "local-user");
    const workspace = {
      id: `workspace:${nanoid()}`,
      name,
      ownerId: user?.id ?? "local-user",
      visibility: "private",
      createdAt: Date.now()
    };
    db.data.workspaces.push(workspace);
    await db.write();
    res.json(workspace);
  });

  app.get("/api/backup", async (req, res) => {
    res.json({
      app: "MindWeaver",
      version: 1,
      exportedAt: Date.now(),
      data: sanitizeDataShape(db.data)
    });
  });

  app.post("/api/restore", async (req, res) => {
    const confirm = req.body?.confirm === true;
    const backup = req.body?.backup;
    if (!confirm) return res.status(400).json({ error: "confirm=true required for restore" });
    if (!backup?.data || backup.app !== "MindWeaver") return res.status(400).json({ error: "valid MindWeaver backup required" });

    db.data = sanitizeDataShape(backup.data);
    repairSessionSelection(db);
    await db.write();
    res.json({
      ok: true,
      counts: {
        sessions: db.data.sessions.length,
        nodes: db.data.nodes.length,
        artifacts: db.data.artifacts.length
      }
    });
  });

  app.get("/api/sessions", async (req, res) => {
    const limit = Math.max(1, Math.min(24, Number(req.query.limit ?? 8)));
    const sessions = [...db.data.sessions]
      .sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
      .slice(0, limit)
      .map((session) => buildSessionSummary(db, session));

    res.json({ sessions });
  });

  app.get("/api/session-target", async (req, res) => {
    const payload = buildSessionTargetPayload(db, req.query.limit ?? 24);
    await db.write();
    res.json(payload);
  });

  app.put("/api/session-target", async (req, res) => {
    const hasSessionId = Object.prototype.hasOwnProperty.call(req.body ?? {}, "sessionId");
    const sessionId = req.body?.sessionId === null ? null : String(req.body?.sessionId ?? "").trim() || null;
    const hasOpenSessionIds = Array.isArray(req.body?.openSessionIds);

    if (hasOpenSessionIds) {
      const preferences = repairSessionSelection(db);
      preferences.openSessionIds = normalizeSessionIdList(
        req.body.openSessionIds,
        new Set(db.data.sessions.map((session) => session.id))
      );
    }

    if (hasSessionId) {
      if (sessionId) {
        const session = getSession(db, sessionId);
        if (!session) return res.status(404).json({ error: "session not found" });
        selectActiveSession(db, sessionId);
      } else {
        clearActiveSession(db);
      }
    }

    await db.write();
    res.json(buildSessionTargetPayload(db, req.body?.limit ?? 24));
  });

  app.post("/api/sessions", async (req, res) => {
    const goalTitle = String(req.body?.goal ?? "").trim();
    const workspace = getDefaultWorkspace(db);
    const session = {
      id: nanoid(),
      startedAt: Date.now(),
      endedAt: null,
      goal: goalTitle || null,
      latestGapAnalysis: null,
      workspaceId: workspace.id,
      ownerId: workspace.ownerId
    };

    db.data.sessions.push(session);
    ensureNode(db, `session:${session.id}`, "Learning Session", "root", {
      sessionId: session.id,
      verified: true,
      confidence: 1,
      reason: "Created as the root node for this session."
    });

    selectActiveSession(db, session.id);

    await db.write();
    res.json({
      ...session,
      goalId: null
    });
  });

  app.post("/api/demo-session", async (req, res) => {
    const session = createDemoSession(db);
    ensureSessionWorkspace(db, session);
    selectActiveSession(db, session.id);
    await db.write();
    res.json({
      ...session,
      goalId: getSessionGoal(db, session.id)?.id ?? null
    });
  });

  app.post("/api/goals", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const title = String(req.body?.title ?? "").trim();
    const description = String(req.body?.description ?? "").trim();

    if (!sessionId || !title) {
      return res.status(400).json({ error: "sessionId and title required" });
    }

    const session = getSession(db, sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });

    const goal = createGoalForSession(db, sessionId, title, description);

    await db.write();
    res.json(goal);
  });

  app.patch("/api/sessions/:id", async (req, res) => {
    const result = renameSessionMap(db, req.params.id, req.body?.goal);
    if (!result.ok) return res.status(404).json({ error: result.error });

    await db.write();
    res.json({
      ok: true,
      session: buildSessionSummary(db, result.session),
      updatedPrimaryGoalNode: result.updatedPrimaryGoalNode,
      sessionTarget: buildSessionTargetPayload(db)
    });
  });

  app.get("/api/goals/:sessionId", async (req, res) => {
    res.json(db.data.goals.filter((goal) => goal.sessionId === req.params.sessionId));
  });

  app.post("/api/sessions/:id/end", async (req, res) => {
    const session = getSession(db, req.params.id);
    if (!session) return res.status(404).json({ error: "session not found" });

    session.endedAt = Date.now();
    clearActiveSession(db, session.id);
    await db.write();
    res.json(session);
  });

  app.delete("/api/sessions/:id", async (req, res) => {
    const removed = deleteSessionData(db, req.params.id);
    if (!removed) return res.status(404).json({ error: "session not found" });

    repairSessionSelection(db);
    await db.write();
    res.json({
      ok: true,
      deletedSessionId: req.params.id,
      sessionTarget: buildSessionTargetPayload(db)
    });
  });

  app.delete("/api/sessions/:sessionId/artifacts/:artifactId", async (req, res) => {
    const removed = deleteArtifactFromSession(db, req.params.sessionId, req.params.artifactId);
    if (!removed) return res.status(404).json({ error: "artifact not found in session" });

    await db.write();
    res.json({ ok: true, graph: buildSessionGraph(db, req.params.sessionId) });
  });

  app.get("/api/sessions/:id/export", async (req, res) => {
    const exportData = buildSessionExport(db, req.params.id);
    if (!exportData) return res.status(404).json({ error: "session not found" });

    const format = String(req.query.format ?? "json").toLowerCase();
    const fileBase = slugify(exportData.goal || exportData.summary.id);

    if (format === "markdown" || format === "md") {
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${fileBase}.md"`);
      return res.send(buildMarkdownExport(exportData));
    }

    res.setHeader("Content-Disposition", `attachment; filename="${fileBase}.json"`);
    res.json(exportData);
  });

  app.post("/api/ingest", async (req, res) => {
    const requestLlmSelection = resolveRequestLlmSelection(db, req.body?.llmProvider);
    const validation = validateIngestPayload(req.body, { llmProvider: requestLlmSelection });
    if (!validation.ok) {
      return res.status(400).json({ ok: false, errors: validation.errors });
    }

    const result = await enqueuePageSave(() => ingestSource({
      db,
      llmRuntime: buildRequestLlmRuntime(requestLlmSelection),
      payload: {
        ...req.body,
        sourceType: "page"
      }
    }));

    res.status(result.status).json(result.body);
  });

  app.post("/api/import", async (req, res) => {
    const requestLlmSelection = resolveRequestLlmSelection(db, req.body?.llmProvider);
    const validation = validateIngestPayload(req.body, {
      allowSyntheticUrl: true,
      llmProvider: requestLlmSelection
    });
    if (!validation.ok) {
      return res.status(400).json({ ok: false, errors: validation.errors });
    }

    const result = await ingestSource({
      db,
      llmRuntime: buildRequestLlmRuntime(requestLlmSelection),
      payload: {
        ...req.body,
        sourceType: req.body.sourceType ?? "note"
      }
    });

    res.status(result.status).json(result.body);
  });

  app.get("/api/import-chat-history/template", async (req, res) => {
    const provider = String(req.query.provider ?? "chatgpt").trim().toLowerCase();
    if (!CHAT_IMPORT_PROVIDERS.has(provider)) {
      return res.status(400).json({ error: `provider must be one of: ${[...CHAT_IMPORT_PROVIDERS].join(", ")}` });
    }

    const sessionId = String(req.query.sessionId ?? "").trim();
    if (sessionId && !getSession(db, sessionId)) {
      return res.status(404).json({ error: "session not found" });
    }

    const sessionGoal = sessionId
      ? getSessionGoal(db, sessionId)?.title ?? getSession(db, sessionId)?.goal ?? ""
      : "";

    res.json({
      ok: true,
      provider,
      schemaVersion: CHAT_IMPORT_SCHEMA_VERSION,
      prompt: buildChatHistoryImportPrompt({ provider, sessionGoal })
    });
  });

  app.post("/api/import-chat-history", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    if (!sessionId) return res.status(400).json({ ok: false, errors: ["sessionId is required."] });

    const validation = validateChatHistoryImportPayload(req.body?.importData);
    if (!validation.ok) {
      return res.status(400).json({ ok: false, errors: validation.errors });
    }

    const result = await ingestChatHistoryImport({
      db,
      sessionId,
      importData: validation.data
    });

    if (result.body?.ok && validation.warnings?.length) {
      result.body.warnings = validation.warnings;
    }

    res.status(result.status).json(result.body);
  });

  app.post("/api/import-bulk", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 20) : [];
    const requestLlmSelection = resolveRequestLlmSelection(db, req.body?.llmProvider);
    const llmRuntime = buildRequestLlmRuntime(requestLlmSelection);
    if (!sessionId || !items.length) return res.status(400).json({ error: "sessionId and items[] required" });
    if (!getSession(db, sessionId)) return res.status(404).json({ error: "session not found" });

    const results = [];
    for (const [index, item] of items.entries()) {
      const payload = {
        sessionId,
        sourceType: item.sourceType ?? "markdown",
        title: item.title ?? `Bulk import ${index + 1}`,
        url: item.url,
        excerpt: String(item.content ?? "").slice(0, 280),
        content: item.content
      };
      const validation = validateIngestPayload(payload, {
        allowSyntheticUrl: true,
        llmProvider: requestLlmSelection
      });
      if (!validation.ok) {
        results.push({ ok: false, index, errors: validation.errors });
        continue;
      }
      const result = await ingestSource({ db, llmRuntime, payload });
      results.push({ index, status: result.status, ...result.body });
    }

    res.json({
      ok: results.some((result) => result.ok),
      importedCount: results.filter((result) => result.ok && !result.deduped).length,
      dedupedCount: results.filter((result) => result.ok && result.deduped).length,
      failedCount: results.filter((result) => !result.ok).length,
      results,
      graph: buildSessionGraph(db, sessionId)
    });
  });

  app.get("/api/graph/:sessionId", async (req, res) => {
    const session = getSession(db, req.params.sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });
    res.json(buildSessionGraph(db, req.params.sessionId));
  });

  app.get("/api/review/:sessionId", async (req, res) => {
    const session = getSession(db, req.params.sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });
    res.json({ reviewQueue: buildReviewQueue(db, req.params.sessionId) });
  });

  app.get("/api/recommendations/:sessionId", async (req, res) => {
    const session = getSession(db, req.params.sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });
    res.json({ recommendations: buildRecommendations(db, req.params.sessionId) });
  });

  app.get("/api/progress/:sessionId", async (req, res) => {
    const session = getSession(db, req.params.sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });
    res.json(buildProgressReport(db, req.params.sessionId));
  });

  app.get("/api/search/:sessionId", async (req, res) => {
    const session = getSession(db, req.params.sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });
    res.json(searchGraph(db, req.params.sessionId, String(req.query.q ?? "")));
  });

  app.post("/api/chat", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const question = String(req.body?.question ?? "").trim();
    if (!sessionId || !question) return res.status(400).json({ error: "sessionId and question required" });
    const session = getSession(db, sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });
    const llmRuntime = buildRequestLlmRuntime(req.body?.llmProvider);

    const fallback = buildExtractiveAnswer(db, sessionId, question);
    const content = await requestText(llmRuntime, {
      model: "gpt-4o-mini",
      label: "Graph chat",
      timeoutMs: 15000,
      temperature: 0.2,
      max_completion_tokens: 340,
      messages: [
        {
          role: "system",
          content: "Answer only from the provided MindWeaver graph evidence. If evidence is weak, say what evidence is missing. Keep the answer concise and cite the labels you used."
        },
        {
          role: "user",
          content: `Question: ${question}

Evidence:
${fallback.citations.map((citation) => `- ${citation.label}: ${citation.snippet ?? ""}`).join("\n") || "No matching evidence."}`
        }
      ]
    }).catch(() => null);

    res.json({
      answer: content ?? fallback.answer,
      citations: fallback.citations
    });
  });

  app.get("/api/summary/:sessionId", async (req, res) => {
    const session = getSession(db, req.params.sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });
    const summary = buildLearningSummary(db, req.params.sessionId);
    db.data.reports ||= [];
    db.data.reports.push({
      id: `report:${nanoid()}`,
      sessionId: req.params.sessionId,
      kind: "learning-summary",
      createdAt: Date.now(),
      summary
    });
    await db.write();
    res.json(summary);
  });

  app.post("/api/refine", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    const result = await refineSessionGraph({
      db,
      llmRuntime: buildRequestLlmRuntime(req.body?.llmProvider),
      sessionId
    });

    res.status(result.status).json(result.body);
  });

  app.post("/api/prune", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const dryRun = req.body?.dryRun !== false;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    const session = getSession(db, sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });

    const candidates = findVisibleSessionNodes(db, sessionId)
      .map((node) => serializeNodeForSession(node, sessionId))
      .filter((node) => node.type === "concept" && (node.confidence ?? 0) < 0.6 && node.evidenceCount === 0);

    if (!dryRun) {
      for (const candidate of candidates) {
        const node = db.data.nodes.find((entry) => entry.id === candidate.id);
        if (!node) continue;
        setNodeReview(node, sessionId, "rejected");
        addHistoryEntry(node, {
          kind: "graph-pruned",
          sessionId,
          summary: "Pruned because it had low confidence and no direct evidence."
        });
      }
      await db.write();
    }

    res.json({
      dryRun,
      count: candidates.length,
      candidates,
      graph: dryRun ? null : buildSessionGraph(db, sessionId)
    });
  });

  app.post("/api/nodes", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const type = String(req.body?.type ?? "").trim().toLowerCase();
    const label = String(req.body?.label ?? "").trim();
    const description = String(req.body?.description ?? "").trim();
    const parentId = String(req.body?.parentId ?? "").trim();

    if (!sessionId || !type || !label) {
      return res.status(400).json({ error: "sessionId, type, and label required" });
    }

    if (!USER_CREATABLE_NODE_TYPES.has(type)) {
      return res.status(400).json({ error: `type must be one of: ${[...USER_CREATABLE_NODE_TYPES].join(", ")}` });
    }

    const session = getSession(db, sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });

    let node = null;
    let goal = null;

    if (type === "goal" && !getSessionGoal(db, sessionId)) {
      goal = createGoalForSession(db, sessionId, label, description);
      node = goal ? db.data.nodes.find((entry) => entry.id === goal.id) ?? null : null;
    } else {
      node = createSessionNode(db, {
        type,
        label,
        description,
        createdBy: "user",
        verified: type === "goal",
        confidence: type === "goal" ? 1 : 0.92,
        sessionId,
        reason: `Created manually as a ${type} node from the map toolbar.`
      });

      const explicitParent = parentId
        ? db.data.nodes.find((entry) => entry.id === parentId && hasSessionMembership(entry, sessionId))
        : null;
      const parentNode = explicitParent ?? findPreferredParentNode(db, sessionId, type);

      if (node && parentNode && parentNode.id !== node.id) {
        const edgeType = getDefaultRelationshipType(parentNode.type, type);
        ensureEdge(db, parentNode.id, node.id, edgeType, edgeType, type === "goal" ? 1 : 0.95, "user", sessionId);
      }
    }

    if (!node) {
      return res.status(400).json({ error: "Could not create the requested node." });
    }

    addHistoryEntry(node, {
      kind: "manual-node-created",
      sessionId,
      summary: `Created manually as a ${type} node.`
    });

    const automaticCleanup = applyAutomaticDuplicateCleanup(db, sessionId);
    const visibleNode = resolveCanonicalSessionNode(db, sessionId, node.id, automaticCleanup) ?? node;

    await db.write();
    res.json({
      ok: true,
      goalCreated: Boolean(goal),
      node: serializeNodeForSession(visibleNode, sessionId),
      graph: buildSessionGraph(db, sessionId)
    });
  });

  app.post("/api/edges", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const sourceId = String(req.body?.sourceId ?? "").trim();
    const targetId = String(req.body?.targetId ?? "").trim();
    const type = String(req.body?.type ?? "related").trim();
    const label = String(req.body?.label ?? type).trim();

    if (!sessionId || !sourceId || !targetId) return res.status(400).json({ error: "sessionId, sourceId, and targetId required" });
    if (sourceId === targetId) return res.status(400).json({ error: "sourceId and targetId must be different" });
    if (!RELATIONSHIP_TYPES.has(type)) return res.status(400).json({ error: `type must be one of: ${[...RELATIONSHIP_TYPES].join(", ")}` });
    const source = db.data.nodes.find((node) => node.id === sourceId && hasSessionMembership(node, sessionId));
    const target = db.data.nodes.find((node) => node.id === targetId && hasSessionMembership(node, sessionId));
    if (!source || !target) return res.status(404).json({ error: "source or target not found in session" });

    const edge = ensureEdge(db, sourceId, targetId, label, type, 0.95, "user", sessionId);
    setEdgeReview(edge, sessionId, "approved");
    await db.write();
    res.json({ ok: true, edge: serializeEdgeForSession(edge, sessionId), graph: buildSessionGraph(db, sessionId) });
  });

  app.post("/api/edges/:key/review", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const action = String(req.body?.action ?? "").trim();
    if (!sessionId || !["approve", "reject"].includes(action)) return res.status(400).json({ error: "sessionId and action=approve|reject required" });
    const edge = db.data.edges.find((entry) => entry.key === req.params.key && hasSessionMembership(entry, sessionId));
    if (!edge) return res.status(404).json({ error: "edge not found in session" });

    setEdgeReview(edge, sessionId, action === "approve" ? "approved" : "rejected");
    edge.verified = action === "approve";
    edge.confidence = action === "approve" ? 1 : Math.min(edge.confidence ?? 0.5, 0.2);
    await db.write();
    res.json({ ok: true, edge: serializeEdgeForSession(edge, sessionId), graph: buildSessionGraph(db, sessionId) });
  });

  app.post("/api/nodes/:id/review", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const action = String(req.body?.action ?? "").trim();
    const node = db.data.nodes.find((entry) => entry.id === req.params.id);

    if (!sessionId || !["approve", "reject"].includes(action)) {
      return res.status(400).json({ error: "sessionId and action=approve|reject required" });
    }

    if (!node || !hasSessionMembership(node, sessionId)) {
      return res.status(404).json({ error: "node not found in session" });
    }

    if (action === "approve") {
      setNodeReview(node, sessionId, "approved");
      node.verified = true;
      node.confidence = 1;
      applyReviewOutcome(node, "success");
      addHistoryEntry(node, {
        kind: "review-approved",
        sessionId,
        summary: "Approved during manual review."
      });
    } else {
      setNodeReview(node, sessionId, "rejected");
      node.confidence = Math.min(node.confidence ?? 0.7, 0.2);
      applyReviewOutcome(node, "reset");
      addHistoryEntry(node, {
        kind: "review-rejected",
        sessionId,
        summary: "Rejected during manual review."
      });
    }

    await db.write();
    res.json({
      ok: true,
      node: serializeNodeForSession(node, sessionId),
      reviewQueue: buildReviewQueue(db, sessionId),
      recommendations: buildRecommendations(db, sessionId)
    });
  });

  app.patch("/api/nodes/:id", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const node = db.data.nodes.find((entry) => entry.id === req.params.id);
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    if (!node || !hasSessionMembership(node, sessionId)) return res.status(404).json({ error: "node not found in session" });

    const label = req.body?.label === undefined ? null : String(req.body.label).trim();
    const description = req.body?.description === undefined ? null : String(req.body.description).trim();
    const summary = req.body?.summary === undefined ? null : String(req.body.summary).trim();
    const note = req.body?.note === undefined ? undefined : String(req.body.note ?? "").replace(/\r\n?/g, "\n");
    const masteryState = req.body?.masteryState === undefined ? null : String(req.body.masteryState).trim();
    const primaryRole = req.body?.primaryRole === undefined ? null : String(req.body.primaryRole).trim().toLowerCase();
    const secondaryRoles = req.body?.secondaryRoles === undefined
      ? null
      : Array.from(new Set(
        (Array.isArray(req.body.secondaryRoles) ? req.body.secondaryRoles : [])
          .map((role) => String(role ?? "").trim().toLowerCase())
          .filter((role) => SEMANTIC_ROLE_TYPES.has(role))
      ));
    if (note !== undefined && note.length > MAX_NODE_NOTE_LENGTH) {
      return res.status(400).json({ error: `note must be ${MAX_NODE_NOTE_LENGTH} characters or fewer` });
    }

    let metadataEdited = false;
    if (label) {
      if (label !== node.label) {
        metadataEdited = true;
        node.aliases ||= [];
        if (node.label && !node.aliases.includes(node.label)) node.aliases.push(node.label);
      }
      node.label = label;
      node.canonicalLabel = normalizeLabel(label);
    }
    if (description !== null && description !== (node.description ?? "")) metadataEdited = true;
    if (description !== null) node.description = description;
    if (summary !== null && summary !== (node.summary ?? "")) metadataEdited = true;
    if (summary !== null) node.summary = summary;
    const previousPrimaryRole = node.primaryRole ?? node.type;
    const previousSecondaryRoles = JSON.stringify(node.secondaryRoles ?? []);
    const nextPrimaryRole = SEMANTIC_ROLE_TYPES.has(primaryRole) ? primaryRole : node.primaryRole ?? node.type;
    const nextSecondaryRoles = secondaryRoles ?? node.secondaryRoles ?? [];
    if (nextPrimaryRole !== previousPrimaryRole || JSON.stringify(nextSecondaryRoles) !== previousSecondaryRoles) {
      metadataEdited = true;
    }
    syncNodeSemanticIdentity(node, {
      primaryRole: nextPrimaryRole,
      secondaryRoles: nextSecondaryRoles
    });
    if (masteryState && ["new", "seen", "understood", "verified"].includes(masteryState)) {
      metadataEdited = true;
      if (masteryState === "verified") {
        node.verified = true;
        node.confidence = 1;
        setNodeReview(node, sessionId, "approved");
        applyReviewOutcome(node, "success");
      } else if (masteryState === "understood") {
        node.confidence = Math.max(node.confidence ?? 0, 0.86);
      } else if (masteryState === "seen") {
        node.confidence = Math.max(node.confidence ?? 0, 0.65);
      }
    }

    const noteChange = note === undefined ? "unchanged" : setSessionNodeNote(node, sessionId, note);
    if (metadataEdited) {
      addHistoryEntry(node, {
        kind: "node-edited",
        sessionId,
        summary: "Edited manually in the inspector."
      });
    }
    if (noteChange !== "unchanged") {
      addHistoryEntry(node, {
        kind: noteChange === "cleared" ? "note-cleared" : "note-edited",
        sessionId,
        summary: noteChange === "added"
          ? "Added a note."
          : noteChange === "updated"
            ? "Updated the note."
            : "Cleared the note."
      });
    }
    const automaticCleanup = applyAutomaticDuplicateCleanup(db, sessionId);
    const visibleNode = resolveCanonicalSessionNode(db, sessionId, node.id, automaticCleanup) ?? node;

    await db.write();
    res.json({ ok: true, node: serializeNodeForSession(visibleNode, sessionId), graph: buildSessionGraph(db, sessionId) });
  });

  app.post("/api/nodes/:id/merge", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const targetId = String(req.body?.targetId ?? "").trim();
    if (!sessionId || !targetId) return res.status(400).json({ error: "sessionId and targetId required" });
    const result = mergeNodeIntoTarget(db, sessionId, req.params.id, targetId);
    if (!result.ok) return res.status(400).json({ error: result.error });

    await db.write();
    res.json({
      ok: true,
      source: serializeNodeForSession(result.source, sessionId),
      target: serializeNodeForSession(result.target, sessionId),
      graph: buildSessionGraph(db, sessionId)
    });
  });

  app.post("/api/gaps", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    const goalId = String(req.body?.goalId ?? "").trim();

    if (!sessionId || !goalId) {
      return res.status(400).json({ error: "goalId and sessionId required" });
    }

    const goalNode = db.data.nodes.find((node) => node.id === goalId && hasSessionMembership(node, sessionId));
    if (!goalNode) return res.status(404).json({ error: "goal not found" });

    const knownConcepts = findVisibleSessionNodes(db, sessionId)
      .filter((node) => node.type === "concept")
      .map((node) => node.label);
    const llmRuntime = buildRequestLlmRuntime(req.body?.llmProvider);

    let safeGapData = createFallbackGapResponse(goalNode.label, knownConcepts);

    const gapData = await requestStructuredJson(llmRuntime, {
      model: "gpt-4o-mini",
      label: "Gap analysis",
      timeoutMs: 16000,
      temperature: 0.2,
      max_completion_tokens: 320,
      schema: STRUCTURED_RESPONSE_SCHEMAS.gapAnalysis,
      messages: [
        {
          role: "system",
          content: `${buildGraphContext(db)}

Goal: "${goalNode.label}"
Known concepts in this session: ${knownConcepts.join(", ") || "none"}

Return only JSON: {"gaps":["concept1"],"pathway":["first step","second step"],"difficulty":"easy|medium|hard"}`
        },
        {
          role: "user",
          content: `What concepts are missing to reach the goal "${goalNode.label}"?`
        }
      ]
    }).catch(() => null);

    if (gapData) {
      safeGapData = {
        ...gapData,
        recommendedActions: buildRecommendedActions(gapData)
      };
    }

    for (const gap of safeGapData.gaps ?? []) {
      const label = normalizeLabel(gap);
      if (!label) continue;
      const gapNode = ensureNode(db, `concept:${label}`, label, "concept", {
        createdBy: "ai",
        verified: false,
        confidence: 0.55,
        sessionId,
        reason: `Gap analysis flagged ${label} as missing for the goal "${goalNode.label}".`
      });
      ensureEdge(db, goalNode.id, gapNode.id, "needs", "needs", 0.55, "ai", sessionId);
    }

    const session = getSession(db, sessionId);
    session.latestGapAnalysis = {
      ...safeGapData,
      runAt: Date.now()
    };

    await db.write();
    res.json(safeGapData);
  });

  app.post("/api/quiz", async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "").trim();
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    const llmRuntime = buildRequestLlmRuntime(req.body?.llmProvider);

    const concepts = findVisibleSessionNodes(db, sessionId)
      .map((node) => serializeNodeForSession(node, sessionId))
      .filter((node) => node.type === "concept")
      .filter((node) => !node.verified || node.dueForReview || node.confidence < 1)
      .sort((left, right) => Number(right.dueForReview) - Number(left.dueForReview) || left.confidence - right.confidence)
      .slice(0, 5);

    if (concepts.length === 0) {
      return res.json({ quiz: [], message: "No review-worthy concepts in this session." });
    }
    const quizData = await requestStructuredJson(llmRuntime, {
      model: "gpt-4o-mini",
      label: "Quiz generation",
      timeoutMs: 18000,
      temperature: 0.2,
      max_completion_tokens: 480,
      schema: STRUCTURED_RESPONSE_SCHEMAS.quizGeneration,
      normalizeResult: (payload) => normalizeQuizGenerationPayload(payload, concepts.map((concept) => concept.label)),
      messages: [
        {
          role: "system",
          content: `Generate 1 multiple-choice question per concept from this exact list: ${concepts.map((concept) => `"${concept.label}"`).join(", ")}.
Return only JSON: {"questions":[{"concept":"exact concept label","q":"question","options":["a","b","c","d"],"correct":0}]}
- Use the property name "q", not "question".
- Keep "correct" as an integer 0-3.
- Keep "correct" outside the options array.
- Each options array must contain exactly 4 answer strings.
- Do not wrap the response in a bare array.
- Do not add markdown fences or commentary.`
        },
        {
          role: "user",
          content: `Create a short spaced-review quiz covering these concepts: ${concepts.map((concept) => concept.label).join(", ")}`
        }
      ]
    }).catch((error) => {
      if (error?.code === "LLM_UNAVAILABLE") {
        res.json({ quiz: [], message: error.message });
        return null;
      }
      return null;
    });

    if (res.headersSent) return;

    const questions = Array.isArray(quizData?.questions) ? quizData.questions : [];
    const conceptMap = new Map(concepts.map((concept) => [concept.label, concept.id]));
    const quiz = questions
      .map((question, index) => {
        const conceptLabel = normalizeLabel(question.concept);
        const conceptId = conceptMap.get(conceptLabel);
        if (!conceptId || !Array.isArray(question.options) || typeof question.correct !== "number") return null;
        return {
          id: `quiz:${index + 1}`,
          concept: conceptLabel,
          conceptId,
          q: question.q,
          options: question.options.slice(0, 4),
          correct: question.correct
        };
      })
      .filter(Boolean);

    res.json({
      quiz,
      message: quiz.length ? "" : "MindWeaver could not build a quiz right now.",
      concepts: concepts.map((concept) => ({ id: concept.id, label: concept.label }))
    });
  });

  app.post("/api/verify", async (req, res) => {
    const conceptIds = Array.isArray(req.body?.conceptIds) ? req.body.conceptIds : null;
    const correct = Boolean(req.body?.correct);
    const sessionId = String(req.body?.sessionId ?? "").trim() || null;

    if (!conceptIds) {
      return res.status(400).json({ error: "conceptIds array required" });
    }

    for (const conceptId of conceptIds) {
      const node = db.data.nodes.find((entry) => entry.id === conceptId);
      if (!node) continue;

      node.verified = correct;
      node.confidence = correct ? 1 : Math.max(0.3, (node.confidence ?? 0.7) - 0.2);
      applyReviewOutcome(node, correct ? "success" : "reset");

      if (sessionId && hasSessionMembership(node, sessionId)) {
        setNodeReview(node, sessionId, correct ? "approved" : "pending");
      }

      addHistoryEntry(node, {
        kind: "quiz-verification",
        sessionId,
        summary: correct ? "Answered a review question correctly." : "Missed a review question and confidence dropped."
      });

      db.data.verifications.push({
        id: `verification:${nanoid()}`,
        conceptId,
        correct,
        sessionId,
        createdAt: Date.now()
      });
    }

    await db.write();
    res.json({
      ok: true,
      reviewQueue: sessionId ? buildReviewQueue(db, sessionId) : [],
      recommendations: sessionId ? buildRecommendations(db, sessionId) : []
    });
  });

  app.post("/api/intersect", async (req, res) => {
    const requestedNodeIds = Array.isArray(req.body?.nodeIds)
      ? req.body.nodeIds
      : [req.body?.nodeId1, req.body?.nodeId2];
    const nodeIds = [...new Set(requestedNodeIds.map((value) => String(value ?? "").trim()).filter(Boolean))];

    if (nodeIds.length < 2) {
      return res.status(400).json({ error: "Provide at least two nodeIds or nodeId1/nodeId2 values." });
    }

    const nodes = nodeIds
      .map((nodeId) => db.data.nodes.find((node) => node.id === nodeId) ?? null);
    if (nodes.some((node) => !node)) return res.status(404).json({ error: "node not found" });

    const promptSummary = nodes.map((node) => `"${node.label}" (${node.type})`).join(", ");
    const fallbackReasoning = nodes.length === 2
      ? `A bridge between ${nodes[0].label} and ${nodes[1].label} could not be generated right now.`
      : `A bridge across ${nodes.map((node) => node.label).join(", ")} could not be generated right now.`;
    const llmRuntime = buildRequestLlmRuntime(req.body?.llmProvider);
    const result = await requestStructuredJson(llmRuntime, {
      model: "gpt-4o-mini",
      label: "Intersection discovery",
      timeoutMs: 15000,
      temperature: 0.2,
      max_completion_tokens: 220,
      schema: STRUCTURED_RESPONSE_SCHEMAS.intersectionDiscovery,
      messages: [
        {
          role: "system",
          content: 'Return only JSON: {"bridge_concepts":["concept1"],"reasoning":"..."}'
        },
        {
          role: "user",
          content: nodes.length === 2
            ? `How do ${promptSummary} relate?`
            : `How do these selected nodes connect as one knowledge bridge: ${promptSummary}? Explain the shared thread and the progression between them.`
        }
      ]
    }).catch((error) => ({
      bridge_concepts: [],
      reasoning: error?.message || fallbackReasoning
    }));

    res.json({
      ...(result ?? {
      bridge_concepts: [],
      reasoning: fallbackReasoning
      }),
      nodeIds
    });
  });

  app.post("/api/learn-more", async (req, res) => {
    const label = String(req.body?.label ?? "").trim();
    const type = String(req.body?.type ?? "").trim();
    const upstream = Array.isArray(req.body?.upstream) ? req.body.upstream : [];
    const downstream = Array.isArray(req.body?.downstream) ? req.body.downstream : [];

    if (!label || !type) {
      return res.status(400).json({ error: "label and type required" });
    }
    const llmRuntime = buildRequestLlmRuntime(req.body?.llmProvider);
    const content = await requestText(llmRuntime, {
      model: "gpt-4o-mini",
      label: "Learn more",
      timeoutMs: 14000,
      temperature: 0.4,
      max_completion_tokens: 260,
      messages: [
        {
          role: "user",
          content: `Explain "${label}" in about 100 words.
Context: ${type} node. Upstream: ${upstream.join(", ") || "none"}. Downstream: ${downstream.join(", ") || "none"}.
Briefly explain what it is, why it matters, and how it fits into the graph.`
        }
      ]
    }).catch(() => null);

    res.json({
      content: content ?? `${label} is a ${type} in your graph. Upstream concepts: ${upstream.join(", ") || "none"}. Downstream concepts: ${downstream.join(", ") || "none"}.`
    });
  });

  if (staticDir && existsSync(staticDir)) {
    app.use(express.static(staticDir, {
      index: false,
      maxAge: "1h",
      setHeaders(res, path) {
        if (path.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-cache");
        }
      }
    }));

    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
      res.sendFile(join(staticDir, "index.html"));
    });
  }

  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

