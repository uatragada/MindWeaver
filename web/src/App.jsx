import { startTransition, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import SelectControl from "./components/controls/SelectControl.jsx";
import MapOverviewCard from "./components/panels/MapOverviewCard.jsx";
import MapStructurePanel from "./components/panels/MapStructurePanel.jsx";
import { useLocalStorageState } from "./hooks/useLocalStorageState.js";
import { useSessionRoute } from "./hooks/useSessionRoute.js";
import { API_BASE, fetchJson } from "./lib/api.js";
import {
  CHAT_IMPORT_PROVIDER_OPTIONS,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_LOCAL_LLM_MODEL,
  DEFAULT_TAB_VIEW,
  EMPTY_IMPORT_FORM,
  EMPTY_QUIZ_STATE,
  LLM_PROVIDER_OPTIONS,
  LOCAL_LLM_MODEL_OPTIONS,
  MASTERY_OPTIONS,
  NODE_TYPE_OPTIONS,
  RELATIONSHIP_TYPE_OPTIONS,
  RIGHT_PANEL_LABELS,
  SOURCE_TYPE_OPTIONS,
  TAB_VIEW_STORAGE_KEY,
  visibleNodeTypes
} from "./lib/app-constants.js";
import { getChatHistoryImportPreview } from "./lib/chat-import-preview.js";
import {
  createNodeCollisionForce,
  drawRoundedRect,
  getChargeStrength,
  getLinkDistance,
  getLinkVisualStyle,
  getNodeMetrics,
  NODE_HIERARCHY_LEVELS,
  NODE_TYPE_LEGEND
} from "./lib/graph-rendering.js";
import {
  describeReviewDate,
  downloadTextFile,
  formatSourceTypeLabel,
  formatTimestamp,
  getMapName,
  getSafeFileName,
  groupVerificationResults
} from "./lib/formatting.js";
import "./app.css";

export default function App() {
  const [sessionId, navigateToSession] = useSessionRoute();
  const fgRef = useRef(null);
  const graphContainerRef = useRef(null);
  const rightRailRef = useRef(null);
  const tabViewHydrationRef = useRef(null);
  const sessionCacheHydrationRef = useRef(null);
  const graphFitTimersRef = useRef([]);
  const pendingGraphFitRef = useRef(false);

  const [graphState, setGraphState] = useState(null);
  const [healthState, setHealthState] = useState(null);
  const [llmSettings, setLlmSettings] = useState({
    provider: DEFAULT_LLM_PROVIDER,
    localModel: DEFAULT_LOCAL_LLM_MODEL
  });
  const [recentSessions, setRecentSessions] = useState([]);
  const [sessionTargetState, setSessionTargetState] = useState({
    activeSessionId: null,
    lastSessionId: null,
    activeSession: null,
    lastSession: null,
    sessions: [],
    tabSessions: [],
    workspaces: []
  });
  const [openTabs, setOpenTabs] = useState([]);
  const [tabViewState, setTabViewState] = useLocalStorageState(TAB_VIEW_STORAGE_KEY, {});
  const [sessionCache, setSessionCache] = useState({});
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [rightPanel, setRightPanel] = useState("inspector");
  const [leftRailMinimized, setLeftRailMinimized] = useState(false);
  const [rightRailMinimized, setRightRailMinimized] = useState(true);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [homeErrorMessage, setHomeErrorMessage] = useState("");
  const [isSavingLlmSettings, setIsSavingLlmSettings] = useState(false);
  const [isLoadingGraph, setIsLoadingGraph] = useState(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [isCreatingGoalNode, setIsCreatingGoalNode] = useState(false);
  const [isCreatingDemo, setIsCreatingDemo] = useState(false);
  const [isRenamingMap, setIsRenamingMap] = useState(false);
  const [isEditingMapName, setIsEditingMapName] = useState(false);
  const [isDeletingSession, setIsDeletingSession] = useState(false);
  const [isEndingSession, setIsEndingSession] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isLearningMore, setIsLearningMore] = useState(false);
  const [learnMoreCopy, setLearnMoreCopy] = useState("");
  const [isReviewing, setIsReviewing] = useState(false);
  const [isLoadingGaps, setIsLoadingGaps] = useState(false);
  const [isRefiningMap, setIsRefiningMap] = useState(false);
  const [gapSummary, setGapSummary] = useState(null);
  const [isLoadingQuiz, setIsLoadingQuiz] = useState(false);
  const [quizState, setQuizState] = useState(EMPTY_QUIZ_STATE);
  const [quizAnswers, setQuizAnswers] = useState({});
  const [quizResult, setQuizResult] = useState(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isImportingChatHistory, setIsImportingChatHistory] = useState(false);
  const [isLoadingChatImportPrompt, setIsLoadingChatImportPrompt] = useState(false);
  const [importForm, setImportForm] = useState(EMPTY_IMPORT_FORM);
  const [chatImportProvider, setChatImportProvider] = useState("chatgpt");
  const [chatImportPrompt, setChatImportPrompt] = useState("");
  const [chatImportSchemaVersion, setChatImportSchemaVersion] = useState("mindweaver.chat_import.v1");
  const [chatImportJson, setChatImportJson] = useState("");
  const [chatImportErrorMessage, setChatImportErrorMessage] = useState("");
  const [startGoal, setStartGoal] = useState("");
  const [tabComposerGoal, setTabComposerGoal] = useState("");
  const [mapNameDraft, setMapNameDraft] = useState("");
  const [goalNodeDraft, setGoalNodeDraft] = useState("");
  const [graphSize, setGraphSize] = useState({ width: 900, height: 640 });
  const [nodeSearch, setNodeSearch] = useState("");
  const [nodeTypeFilter, setNodeTypeFilter] = useState("all");
  const [searchResults, setSearchResults] = useState([]);
  const [isSearchingGraph, setIsSearchingGraph] = useState(false);
  const [chatQuestion, setChatQuestion] = useState("");
  const [chatAnswer, setChatAnswer] = useState(null);
  const [isChatting, setIsChatting] = useState(false);
  const [learningSummary, setLearningSummary] = useState(null);
  const [isLoadingSummary, setIsLoadingSummary] = useState(false);
  const [progressState, setProgressState] = useState(null);
  const [isPruning, setIsPruning] = useState(false);
  const [bulkImportText, setBulkImportText] = useState("");
  const [isBulkImporting, setIsBulkImporting] = useState(false);
  const [relationshipForm, setRelationshipForm] = useState({ targetId: "", type: "related", label: "" });
  const [isSavingRelationship, setIsSavingRelationship] = useState(false);
  const [intersectionTargetId, setIntersectionTargetId] = useState("");
  const [intersectionResult, setIntersectionResult] = useState(null);
  const [isIntersecting, setIsIntersecting] = useState(false);
  const [nodeEditForm, setNodeEditForm] = useState({ label: "", description: "", summary: "", masteryState: "new" });
  const [isSavingNode, setIsSavingNode] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [isMergingNode, setIsMergingNode] = useState(false);
  const [isRestoringBackup, setIsRestoringBackup] = useState(false);
  const [isDeletingArtifact, setIsDeletingArtifact] = useState(false);
  const [isGraphViewportReady, setIsGraphViewportReady] = useState(false);
  const deferredNodeSearch = useDeferredValue(nodeSearch);
  const chatHistoryImportPreview = useMemo(() => getChatHistoryImportPreview(chatImportJson), [chatImportJson]);

  const dropSessionLocally = useCallback((removedSessionId) => {
    if (!removedSessionId) return;

    setOpenTabs((current) => current.filter((entry) => entry !== removedSessionId));
    setTabViewState((current) => {
      const next = { ...current };
      delete next[removedSessionId];
      return next;
    });
    setSessionCache((current) => {
      const next = { ...current };
      delete next[removedSessionId];
      return next;
    });
  }, [setOpenTabs, setTabViewState]);

  const applyTargetStateSnapshot = useCallback((targetState, { preserveSessionId = null } = {}) => {
    const normalizedState = {
      activeSessionId: targetState?.activeSessionId ?? null,
      lastSessionId: targetState?.lastSessionId ?? null,
      activeSession: targetState?.activeSession ?? null,
      lastSession: targetState?.lastSession ?? null,
      sessions: targetState?.sessions ?? [],
      tabSessions: targetState?.tabSessions ?? [],
      workspaces: targetState?.workspaces ?? []
    };
    const validSessionIds = new Set(normalizedState.sessions.map((session) => session.id));
    for (const session of normalizedState.tabSessions) validSessionIds.add(session.id);
    if (normalizedState.activeSessionId) validSessionIds.add(normalizedState.activeSessionId);
    if (normalizedState.lastSessionId) validSessionIds.add(normalizedState.lastSessionId);
    if (preserveSessionId) validSessionIds.add(preserveSessionId);

    setRecentSessions(normalizedState.sessions);
    setSessionTargetState(normalizedState);
    setOpenTabs(normalizedState.tabSessions.map((session) => session.id).filter((entry) => validSessionIds.has(entry)));
    setTabViewState((current) => Object.fromEntries(
      Object.entries(current).filter(([entry]) => validSessionIds.has(entry))
    ));
    setSessionCache((current) => Object.fromEntries(
      Object.entries(current).filter(([entry]) => validSessionIds.has(entry))
    ));

    return normalizedState;
  }, [setOpenTabs, setTabViewState]);

  const loadHomeData = useCallback(async () => {
    setHomeErrorMessage("");

    try {
      const [health, targetState] = await Promise.all([
        fetchJson(`${API_BASE}/api/health`),
        fetchJson(`${API_BASE}/api/session-target?limit=24`)
      ]);
      setHealthState(health);
      applyTargetStateSnapshot(targetState, { preserveSessionId: sessionId });
    } catch (error) {
      setHomeErrorMessage(`${error.message}. Start the MindWeaver app, then refresh this page.`);
    }
  }, [applyTargetStateSnapshot, sessionId]);

  const syncSessionTargetState = useCallback(async ({ nextSessionId, openSessionIds, preserveSessionId = null } = {}) => {
    const body = { limit: 24 };
    if (openSessionIds) {
      body.openSessionIds = openSessionIds;
    }
    if (nextSessionId !== undefined) {
      body.sessionId = nextSessionId ?? null;
    }

    const targetState = await fetchJson(`${API_BASE}/api/session-target`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    applyTargetStateSnapshot(targetState, { preserveSessionId: preserveSessionId ?? nextSessionId ?? sessionId ?? null });
    return targetState;
  }, [applyTargetStateSnapshot, sessionId]);

  useEffect(() => {
    void loadHomeData();
  }, [loadHomeData]);

  useEffect(() => {
    const nextSettings = healthState?.llmSettings;
    if (!nextSettings) return;

    setLlmSettings({
      provider: nextSettings.provider === "local" ? "local" : DEFAULT_LLM_PROVIDER,
      localModel: nextSettings.localModel || DEFAULT_LOCAL_LLM_MODEL
    });
  }, [healthState?.llmSettings?.localModel, healthState?.llmSettings?.provider]);

  const updateLlmSettings = useCallback(async (nextSettings) => {
    setLlmSettings(nextSettings);
    setHomeErrorMessage("");
    setIsSavingLlmSettings(true);

    try {
      const nextHealth = await fetchJson(`${API_BASE}/api/settings/llm`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: nextSettings.provider,
          model: nextSettings.localModel
        })
      });
      setHealthState(nextHealth);
    } catch (error) {
      setHomeErrorMessage(error.message);
      const nextHealth = await fetchJson(`${API_BASE}/api/health`).catch(() => null);
      if (nextHealth) setHealthState(nextHealth);
    } finally {
      setIsSavingLlmSettings(false);
    }
  }, []);

  const openSessionTab = useCallback((nextSessionId) => {
    if (!nextSessionId) return;
    setOpenTabs((current) => (current.includes(nextSessionId) ? current : [...current, nextSessionId]));
    startTransition(() => {
      navigateToSession(nextSessionId);
    });
  }, [navigateToSession, setOpenTabs]);

  const closeSessionTab = useCallback((closingSessionId) => {
    const remainingTabs = openTabs.filter((entry) => entry !== closingSessionId);
    setOpenTabs(remainingTabs);
    setTabViewState((current) => {
      const next = { ...current };
      delete next[closingSessionId];
      return next;
    });
    setSessionCache((current) => {
      const next = { ...current };
      delete next[closingSessionId];
      return next;
    });

    if (closingSessionId !== sessionId) {
      void syncSessionTargetState({
        openSessionIds: remainingTabs,
        preserveSessionId: sessionId ?? null
      }).catch(() => {
        // A failed sync should not block closing a non-active tab inside the local app.
      });
      return;
    }

    const closingIndex = openTabs.indexOf(closingSessionId);
    const fallbackSessionId = remainingTabs[closingIndex] ?? remainingTabs[closingIndex - 1] ?? null;
    if (!fallbackSessionId) {
      void syncSessionTargetState({
        nextSessionId: null,
        openSessionIds: remainingTabs,
        preserveSessionId: null
      }).catch(() => {
        // A failed sync should not block closing the final tab inside the local app.
      });
    }
    startTransition(() => {
      navigateToSession(fallbackSessionId);
    });
  }, [navigateToSession, openTabs, sessionId, setTabViewState, syncSessionTargetState]);

  useEffect(() => {
    if (!sessionId) return;

    const nextOpenTabs = openTabs.includes(sessionId) ? openTabs : [...openTabs, sessionId];
    if (nextOpenTabs !== openTabs) {
      setOpenTabs(nextOpenTabs);
    }

    void syncSessionTargetState({
      nextSessionId: sessionId,
      openSessionIds: nextOpenTabs
    }).catch(() => {
      // A failed sync should not block switching tabs inside the local app.
    });
  }, [sessionId, syncSessionTargetState]);

  useLayoutEffect(() => {
    const element = graphContainerRef.current;
    if (!element) return undefined;

    const updateGraphSize = () => {
      const rect = element.getBoundingClientRect();
      setGraphSize({
        width: Math.max(320, Math.floor(rect.width)),
        height: Math.max(420, Math.floor(rect.height))
      });
    };

    updateGraphSize();
    const observer = new ResizeObserver(() => {
      updateGraphSize();
    });
    observer.observe(element);

    let secondFrame = null;
    const initialFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(updateGraphSize);
    });

    window.addEventListener("resize", updateGraphSize);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateGraphSize);
      window.cancelAnimationFrame(initialFrame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
    };
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setMapNameDraft("");
      setIsEditingMapName(false);
      setGraphState(null);
      setProgressState(null);
      setGapSummary(null);
      setQuizState(EMPTY_QUIZ_STATE);
      setQuizAnswers({});
      setQuizResult(null);
      setImportForm(EMPTY_IMPORT_FORM);
      setChatQuestion("");
      setChatAnswer(null);
      setLearningSummary(null);
      setBulkImportText("");
      setSelectedNodeId(null);
      setRightPanel(DEFAULT_TAB_VIEW.rightPanel);
      setLeftRailMinimized(DEFAULT_TAB_VIEW.leftRailMinimized);
      setRightRailMinimized(DEFAULT_TAB_VIEW.rightRailMinimized);
      setNodeSearch(DEFAULT_TAB_VIEW.nodeSearch);
      setNodeTypeFilter(DEFAULT_TAB_VIEW.nodeTypeFilter);
      setChatImportPrompt("");
      setChatImportJson("");
      setChatImportErrorMessage("");
      setGoalNodeDraft("");
      setIsGraphViewportReady(false);
      return;
    }

    sessionCacheHydrationRef.current = sessionId;
    const cachedSession = sessionCache[sessionId] ?? {};
    const cachedTabView = tabViewState[sessionId] ?? DEFAULT_TAB_VIEW;
    setGraphState(cachedSession.graphState ?? null);
    setProgressState(cachedSession.progressState ?? null);
    setGapSummary(cachedSession.gapSummary ?? cachedSession.graphState?.latestGapAnalysis ?? null);
    setQuizState(cachedSession.quizState ?? EMPTY_QUIZ_STATE);
    setQuizAnswers(cachedSession.quizAnswers ?? {});
    setQuizResult(cachedSession.quizResult ?? null);
    setImportForm(cachedSession.importForm ?? EMPTY_IMPORT_FORM);
    setChatQuestion(cachedSession.chatQuestion ?? "");
    setChatAnswer(cachedSession.chatAnswer ?? null);
    setLearningSummary(cachedSession.learningSummary ?? null);
    setBulkImportText(cachedSession.bulkImportText ?? "");
    tabViewHydrationRef.current = sessionId;
    setSelectedNodeId(cachedTabView.selectedNodeId ?? null);
    setRightPanel(cachedTabView.rightPanel ?? DEFAULT_TAB_VIEW.rightPanel);
    setLeftRailMinimized(cachedTabView.leftRailMinimized ?? DEFAULT_TAB_VIEW.leftRailMinimized);
    setRightRailMinimized(cachedTabView.rightRailMinimized ?? DEFAULT_TAB_VIEW.rightRailMinimized);
    setNodeSearch(cachedTabView.nodeSearch ?? DEFAULT_TAB_VIEW.nodeSearch);
    setNodeTypeFilter(cachedTabView.nodeTypeFilter ?? DEFAULT_TAB_VIEW.nodeTypeFilter);
    setChatImportPrompt("");
    setChatImportJson("");
    setChatImportErrorMessage("");
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    if (tabViewHydrationRef.current === sessionId) {
      tabViewHydrationRef.current = null;
      return;
    }

    setTabViewState((current) => ({
      ...current,
      [sessionId]: {
        selectedNodeId,
        rightPanel,
        leftRailMinimized,
        rightRailMinimized,
        nodeSearch,
        nodeTypeFilter
      }
    }));
  }, [leftRailMinimized, nodeSearch, nodeTypeFilter, rightPanel, rightRailMinimized, selectedNodeId, sessionId, setTabViewState]);

  useEffect(() => {
    if (!sessionId) return;
    if (sessionCacheHydrationRef.current === sessionId) {
      sessionCacheHydrationRef.current = null;
      return;
    }

    setSessionCache((current) => ({
      ...current,
      [sessionId]: {
        ...(current[sessionId] ?? {}),
        graphState,
        progressState,
        gapSummary,
        quizState,
        quizAnswers,
        quizResult,
        importForm,
        chatQuestion,
        chatAnswer,
        learningSummary,
        bulkImportText
      }
    }));
  }, [bulkImportText, chatAnswer, chatQuestion, gapSummary, graphState, importForm, learningSummary, progressState, quizAnswers, quizResult, quizState, sessionId]);

  const loadGraph = useCallback(async (targetSessionId = sessionId) => {
    if (!targetSessionId) return;
    setIsLoadingGraph(true);
    setErrorMessage("");

    try {
      const [data, progress] = await Promise.all([
        fetchJson(`${API_BASE}/api/graph/${encodeURIComponent(targetSessionId)}`),
        fetchJson(`${API_BASE}/api/progress/${encodeURIComponent(targetSessionId)}`).catch(() => null)
      ]);

      setSessionCache((current) => ({
        ...current,
        [targetSessionId]: {
          ...(current[targetSessionId] ?? {}),
          graphState: data,
          progressState: progress,
          gapSummary: current[targetSessionId]?.gapSummary ?? data.latestGapAnalysis ?? null
        }
      }));

      if (targetSessionId !== sessionId) return;

      setGraphState(data);
      if (progress) setProgressState(progress);
      setGapSummary((current) => current ?? data.latestGapAnalysis ?? null);
      setSelectedNodeId((current) => {
        if (!current) return data.reviewQueue?.[0]?.id ?? data.nodes?.[0]?.id ?? null;
        return data.nodes.some((node) => node.id === current) ? current : data.reviewQueue?.[0]?.id ?? data.nodes?.[0]?.id ?? null;
      });
    } catch (error) {
      if (error.status === 404) {
        dropSessionLocally(targetSessionId);

        try {
          const targetState = await fetchJson(`${API_BASE}/api/session-target?limit=24`);
          const nextTarget = applyTargetStateSnapshot(targetState);
          if (targetSessionId === sessionId) {
            setGraphState(null);
            setProgressState(null);
            setGapSummary(null);
            setSelectedNodeId(null);
            setStatusMessage("That map was removed, so MindWeaver switched you to an available map.");
            startTransition(() => {
              navigateToSession(nextTarget.activeSessionId ?? nextTarget.lastSessionId ?? null, { replace: true });
            });
          }
        } catch {
          if (targetSessionId === sessionId) {
            startTransition(() => {
              navigateToSession(null, { replace: true });
            });
          }
        }
        return;
      }

      setErrorMessage(error.message);
    } finally {
      setIsLoadingGraph(false);
    }
  }, [applyTargetStateSnapshot, dropSessionLocally, navigateToSession, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    void loadGraph(sessionId);
  }, [loadGraph, sessionId]);

  const handleRefreshGraph = useCallback(async () => {
    if (!sessionId) return;
    await Promise.all([
      loadHomeData(),
      loadGraph(sessionId)
    ]);
  }, [loadGraph, loadHomeData, sessionId]);

  const handleCreateSession = async (event, { fromTabs = false } = {}) => {
    event?.preventDefault?.();
    setIsCreatingSession(true);
    if (fromTabs) {
      setErrorMessage("");
    } else {
      setHomeErrorMessage("");
    }

    try {
      const goalValue = (fromTabs ? tabComposerGoal : startGoal).trim();
      const session = await fetchJson(`${API_BASE}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: goalValue || null })
      });
      setStartGoal("");
      setTabComposerGoal("");
      await loadHomeData();
      openSessionTab(session.id);
    } catch (error) {
      if (fromTabs) {
        if (sessionId) {
          setErrorMessage(error.message);
        } else {
          setHomeErrorMessage(error.message);
        }
      } else {
        setHomeErrorMessage(error.message);
      }
    } finally {
      setIsCreatingSession(false);
    }
  };

  const handleCreateDemoSession = async () => {
    setIsCreatingDemo(true);
    setHomeErrorMessage("");

    try {
      const session = await fetchJson(`${API_BASE}/api/demo-session`, { method: "POST" });
      await loadHomeData();
      openSessionTab(session.id);
    } catch (error) {
      setHomeErrorMessage(error.message);
    } finally {
      setIsCreatingDemo(false);
    }
  };

  const handleRenameMap = async () => {
    if (!sessionId || !hasMapNameChanges) return;

    setIsRenamingMap(true);
    setErrorMessage("");

    try {
      const result = await fetchJson(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: trimmedMapNameDraft || null })
      });
      setMapNameDraft(String(result.session?.goal ?? ""));
      setIsEditingMapName(false);
      setStatusMessage(
        result.updatedPrimaryGoalNode
          ? "Map name updated and synced with the primary goal node."
          : "Map name updated."
      );
      applyTargetStateSnapshot(result.sessionTarget ?? {}, { preserveSessionId: sessionId });
      await loadGraph(sessionId);
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsRenamingMap(false);
    }
  };

  const handleEndSession = async () => {
    if (!sessionId) return;
    setIsEndingSession(true);
    setErrorMessage("");

    try {
      await fetchJson(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/end`, { method: "POST" });
      setStatusMessage("Map ended. You can still review it here, and extension capture is no longer targeting this map.");
      await loadGraph(sessionId);
      await loadHomeData();
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsEndingSession(false);
    }
  };

  const handleDeleteSession = async () => {
    if (!sessionId) return;
    const deletingSessionId = sessionId;
    const confirmed = window.confirm("Delete this local session, its sources, and session-specific graph data? This cannot be undone.");
    if (!confirmed) return;

    setIsDeletingSession(true);
    setErrorMessage("");

    try {
      const result = await fetchJson(`${API_BASE}/api/sessions/${encodeURIComponent(deletingSessionId)}`, { method: "DELETE" });
      dropSessionLocally(deletingSessionId);
      const nextTarget = applyTargetStateSnapshot(result.sessionTarget ?? {});
      setStatusMessage("Map deleted.");
      startTransition(() => {
        navigateToSession(nextTarget.activeSessionId ?? nextTarget.lastSessionId ?? null, { replace: true });
      });
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsDeletingSession(false);
    }
  };

  const handleExport = async (format) => {
    if (!sessionId) return;
    setIsExporting(true);
    setErrorMessage("");

    try {
      const response = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/export?format=${encodeURIComponent(format)}`);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Export failed with status ${response.status}`);
      }

      const isJson = format === "json";
      const content = isJson ? JSON.stringify(await response.json(), null, 2) : await response.text();
      const fileBase = getSafeFileName(getMapName(graphState?.session, "mindweaver-map"));
      downloadTextFile(content, `${fileBase}.${isJson ? "json" : "md"}`, isJson ? "application/json" : "text/markdown");
      setStatusMessage(`Exported ${isJson ? "JSON" : "Markdown"} map.`);
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsExporting(false);
    }
  };

  const handleDownloadBackup = async () => {
    setErrorMessage("");

    try {
      const backup = await fetchJson(`${API_BASE}/api/backup`);
      downloadTextFile(JSON.stringify(backup, null, 2), `mindweaver-backup-${new Date().toISOString().slice(0, 10)}.json`, "application/json");
      setStatusMessage("Local backup downloaded.");
    } catch (error) {
      setErrorMessage(error.message);
    }
  };

  const handleRestoreBackup = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const confirmed = window.confirm("Restore this MindWeaver backup? This replaces local sessions, sources, and graph data.");
    if (!confirmed) return;

    setIsRestoringBackup(true);
    setErrorMessage("");

    try {
      const backup = JSON.parse(await file.text());
      await fetchJson(`${API_BASE}/api/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, backup })
      });
      setStatusMessage("Backup restored.");
      setOpenTabs([]);
      setTabViewState({});
      setSessionCache({});
      navigateToSession(null, { replace: true });
      await loadHomeData();
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsRestoringBackup(false);
    }
  };

  const selectedNode = useMemo(
    () => graphState?.nodes?.find((node) => node.id === selectedNodeId) ?? null,
    [graphState, selectedNodeId]
  );
  const currentMapNameValue = String(graphState?.session?.goal ?? "");
  const primaryGoalNode = useMemo(() => {
    const storedGoalId = graphState?.goals?.[0]?.id ?? null;
    if (storedGoalId) {
      return graphState?.nodes?.find((node) => node.id === storedGoalId) ?? null;
    }
    return graphState?.nodes?.find((node) => node.type === "goal") ?? null;
  }, [graphState]);

  useEffect(() => {
    setIsEditingMapName(false);
    setMapNameDraft(currentMapNameValue);
  }, [graphState?.session?.id]);

  useEffect(() => {
    if (isEditingMapName) return;
    setMapNameDraft(currentMapNameValue);
  }, [currentMapNameValue, isEditingMapName]);

  const trimmedMapNameDraft = mapNameDraft.trim();
  const hasMapNameChanges = trimmedMapNameDraft !== currentMapNameValue.trim();

  useEffect(() => {
    if (!selectedNode) return;
    setNodeEditForm({
      label: selectedNode.label || "",
      description: selectedNode.description || "",
      summary: selectedNode.summary || "",
      masteryState: selectedNode.masteryState || "new"
    });
    setMergeTargetId("");
    setIntersectionTargetId("");
    setIntersectionResult(null);
  }, [selectedNode?.id]);

  const nodeHierarchyById = useMemo(() => {
    if (!graphState) return new Map();

    const visibleNodes = graphState.nodes.filter((node) => visibleNodeTypes.includes(node.type));
    if (!visibleNodes.length) return new Map();

    const nodeIds = new Set(visibleNodes.map((node) => node.id));
    const outgoingById = new Map(visibleNodes.map((node) => [node.id, []]));
    const incomingCountById = new Map(visibleNodes.map((node) => [node.id, 0]));

    graphState.edges.forEach((edge) => {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return;
      outgoingById.get(edge.source)?.push(edge.target);
      incomingCountById.set(edge.target, (incomingCountById.get(edge.target) ?? 0) + 1);
    });

    let rootIds = visibleNodes.filter((node) => node.type === "goal").map((node) => node.id);
    if (!rootIds.length) {
      rootIds = visibleNodes
        .filter((node) => (incomingCountById.get(node.id) ?? 0) === 0)
        .map((node) => node.id);
    }
    if (!rootIds.length) {
      const shallowestLevel = Math.min(...visibleNodes.map((node) => NODE_HIERARCHY_LEVELS[node.type] ?? 99));
      rootIds = visibleNodes
        .filter((node) => (NODE_HIERARCHY_LEVELS[node.type] ?? 99) === shallowestLevel)
        .map((node) => node.id);
    }

    const depthById = new Map();
    const queue = [];
    rootIds.forEach((nodeId) => {
      depthById.set(nodeId, 0);
      queue.push(nodeId);
    });

    for (let index = 0; index < queue.length; index += 1) {
      const sourceId = queue[index];
      const sourceDepth = depthById.get(sourceId) ?? 0;

      (outgoingById.get(sourceId) ?? []).forEach((targetId) => {
        const nextDepth = sourceDepth + 1;
        const currentDepth = depthById.get(targetId);
        if (currentDepth === undefined || nextDepth < currentDepth) {
          depthById.set(targetId, nextDepth);
          queue.push(targetId);
        }
      });
    }

    return new Map(
      visibleNodes.map((node) => {
        const incomingCount = incomingCountById.get(node.id) ?? 0;
        const outgoingCount = (outgoingById.get(node.id) ?? []).length;
        const fallbackDepth = NODE_HIERARCHY_LEVELS[node.type] ?? 3;
        const hierarchyDepth = depthById.get(node.id) ?? fallbackDepth;
        const depthScale = 1.14 - hierarchyDepth * 0.05;
        const branchBonus = Math.min(0.16, outgoingCount * 0.028);
        const rootBoost = incomingCount === 0 ? 0.04 : 0;
        const hierarchyScale = Math.max(0.9, Math.min(1.32, depthScale + branchBonus + rootBoost));

        return [
          node.id,
          {
            hierarchyDepth,
            hierarchyScale,
            hierarchyInDegree: incomingCount,
            hierarchyOutDegree: outgoingCount
          }
        ];
      })
    );
  }, [graphState]);

  const graphData = useMemo(() => {
    if (!graphState) return { nodes: [], links: [] };

    const query = deferredNodeSearch.trim().toLowerCase();
    const nodes = graphState.nodes
      .filter((node) => {
        if (!visibleNodeTypes.includes(node.type)) return false;
        if (nodeTypeFilter !== "all" && node.type !== nodeTypeFilter) return false;
        if (query && !node.label.toLowerCase().includes(query)) return false;
        return true;
      })
      .map((node) => ({
        ...node,
        ...(nodeHierarchyById.get(node.id) ?? {
          hierarchyDepth: NODE_HIERARCHY_LEVELS[node.type] ?? 3,
          hierarchyScale: 1,
          hierarchyInDegree: 0,
          hierarchyOutDegree: 0
        })
      }));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const links = graphState.edges
      .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
      .map((edge) => ({
        ...edge,
        source: edge.source,
        target: edge.target
      }));

    return { nodes, links };
  }, [deferredNodeSearch, graphState, nodeHierarchyById, nodeTypeFilter]);

  const graphTopologySignature = useMemo(() => {
    if (!graphData.nodes.length) return "empty";

    const nodeIds = graphData.nodes
      .map((node) => String(node.id))
      .sort();
    const linkKeys = graphData.links
      .map((link) => {
        const sourceId = typeof link.source === "object" ? link.source.id : link.source;
        const targetId = typeof link.target === "object" ? link.target.id : link.target;
        return `${sourceId}->${targetId}:${link.type ?? ""}:${link.key ?? ""}`;
      })
      .sort();

    return `${nodeIds.join("|")}::${linkKeys.join("|")}`;
  }, [graphData.links, graphData.nodes]);

  const localModelOptions = useMemo(() => {
    const providerModels = healthState?.llmProviders?.local?.models;
    if (Array.isArray(providerModels) && providerModels.length) {
      return providerModels.map((model) => ({ value: model.value, label: model.label }));
    }
    return LOCAL_LLM_MODEL_OPTIONS;
  }, [healthState?.llmProviders?.local?.models]);
  const activeLlmRequest = useMemo(
    () => (llmSettings.provider === "local"
      ? { provider: "local", model: llmSettings.localModel || DEFAULT_LOCAL_LLM_MODEL }
      : { provider: "openai" }),
    [llmSettings.localModel, llmSettings.provider]
  );
  const activeLlmProviderLabel = LLM_PROVIDER_OPTIONS.find((option) => option.value === llmSettings.provider)?.label ?? "OpenAI";
  const activeLocalModelLabel = localModelOptions.find((option) => option.value === (llmSettings.localModel || DEFAULT_LOCAL_LLM_MODEL))?.label ?? "Qwen3.5 4B";
  const selectedLocalModelHealth = useMemo(
    () => healthState?.llmProviders?.local?.models?.find((model) => model.value === (llmSettings.localModel || DEFAULT_LOCAL_LLM_MODEL)) ?? null,
    [healthState?.llmProviders?.local?.models, llmSettings.localModel]
  );
  const canUseSelectedLlm = llmSettings.provider === "local"
    ? Boolean(healthState?.llmProviders?.local?.available) && selectedLocalModelHealth?.installed !== false
    : Boolean(healthState?.llmProviders?.openai?.available);
  const llmStatusMessage = useMemo(() => {
    if (llmSettings.provider === "local") {
      const localProvider = healthState?.llmProviders?.local;
      if (!localProvider?.available) {
        return `Ollama is not reachable at ${localProvider?.baseUrl ?? "http://127.0.0.1:11434"}. Start Ollama to use local mode.`;
      }
      if (selectedLocalModelHealth?.installed === false) {
        return `${activeLocalModelLabel} is not installed in Ollama yet. Run "ollama pull ${llmSettings.localModel || DEFAULT_LOCAL_LLM_MODEL}" to enable it.`;
      }
      return `Ollama is ready. MindWeaver will use ${activeLocalModelLabel} for graph tasks, imports, and extension captures.`;
    }

    return healthState?.llmProviders?.openai?.available
      ? `OpenAI is configured. MindWeaver will use ${healthState.llmProviders.openai.defaultModel ?? "its default OpenAI model"} for graph tasks and imports.`
      : "OpenAI is not configured on the local MindWeaver server. Add an API key or switch to Local (Ollama).";
  }, [
    activeLocalModelLabel,
    healthState?.llmProviders?.local,
    healthState?.llmProviders?.openai?.available,
    healthState?.llmProviders?.openai?.defaultModel,
    llmSettings.localModel,
    llmSettings.provider,
    selectedLocalModelHealth?.installed
  ]);
  const withLlmSelection = useCallback((payload = {}) => ({
    ...payload,
    llmProvider: activeLlmRequest
  }), [activeLlmRequest]);
  const contentLimitChars = healthState?.contentLimitChars ?? (llmSettings.provider === "local" ? 128000 : 16000);
  const maxImportChars = healthState?.maxPayloadContentChars ?? (llmSettings.provider === "local" ? 128000 : 80000);
  const importContentLength = importForm.content.length;
  const importIsTooLong = importContentLength > maxImportChars;
  const chatImportProviderLabel = CHAT_IMPORT_PROVIDER_OPTIONS.find((option) => option.value === chatImportProvider)?.label ?? "ChatGPT";

  const fitGraphToViewport = useCallback((duration = 260) => {
    if (!fgRef.current || !graphData.nodes.length) return;
    const fitPadding = Math.max(104, Math.min(188, Math.round(graphSize.height * 0.26)));
    fgRef.current.zoomToFit(duration, fitPadding);
  }, [graphData.nodes.length, graphSize.height]);

  const finalizeGraphViewport = useCallback((duration = 260) => {
    fitGraphToViewport(duration);
    setIsGraphViewportReady(true);
  }, [fitGraphToViewport]);

  useEffect(() => {
    if (!fgRef.current || !graphData.nodes.length) {
      pendingGraphFitRef.current = false;
      setIsGraphViewportReady(graphData.nodes.length === 0);
      return;
    }

    setIsGraphViewportReady(false);
    fgRef.current.d3Force("nodeCollision", createNodeCollisionForce());
    fgRef.current.d3Force("charge").strength(getChargeStrength(graphData.nodes.length));
    fgRef.current.d3Force("link").distance(getLinkDistance);
    pendingGraphFitRef.current = true;
    fgRef.current.d3ReheatSimulation();
  }, [graphData.nodes.length, graphTopologySignature, sessionId]);

  useEffect(() => {
    if (!graphData.nodes.length) return;

    graphFitTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    graphFitTimersRef.current = [
      window.setTimeout(() => {
        if (!pendingGraphFitRef.current) {
          finalizeGraphViewport(320);
        }
      }, 220),
      window.setTimeout(() => {
        if (!pendingGraphFitRef.current) {
          finalizeGraphViewport(420);
        }
      }, 760)
    ];

    return () => {
      graphFitTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      graphFitTimersRef.current = [];
    };
  }, [fitGraphToViewport, graphSize.width, graphSize.height, leftRailMinimized, rightRailMinimized]);

  useEffect(() => {
    if (!graphData.nodes.length) return;

    const fallbackTimer = window.setTimeout(() => {
      if (!pendingGraphFitRef.current) return;
      pendingGraphFitRef.current = false;
      finalizeGraphViewport(440);
    }, 1400);

    return () => window.clearTimeout(fallbackTimer);
  }, [finalizeGraphViewport, graphTopologySignature, graphData.nodes.length, sessionId]);

  const handleGraphEngineStop = useCallback(() => {
    if (!pendingGraphFitRef.current) return;
    pendingGraphFitRef.current = false;
    finalizeGraphViewport(400);
  }, [finalizeGraphViewport]);

  const selectedNodeConnections = useMemo(() => {
    if (!selectedNode) return { upstream: [], downstream: [] };

    const resolveNode = (value) => {
      const id = typeof value === "object" ? value.id : value;
      return graphData.nodes.find((node) => node.id === id) ?? null;
    };

    return {
      upstream: graphData.links
        .filter((link) => (typeof link.target === "object" ? link.target.id : link.target) === selectedNode.id)
        .map((link) => ({
          node: resolveNode(link.source),
          label: link.label,
          type: link.type,
          key: link.key
        }))
        .filter((entry) => entry.node),
      downstream: graphData.links
        .filter((link) => (typeof link.source === "object" ? link.source.id : link.source) === selectedNode.id)
        .map((link) => ({
          node: resolveNode(link.target),
          label: link.label,
          type: link.type,
          key: link.key
        }))
        .filter((entry) => entry.node)
    };
  }, [graphData, selectedNode]);

  const mergeCandidateNodes = useMemo(() => {
    if (!selectedNode) return [];
    return (graphState?.nodes ?? [])
      .filter((node) => node.id !== selectedNode.id && node.type === selectedNode.type && visibleNodeTypes.includes(node.type))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [graphState, selectedNode?.id, selectedNode?.type]);

  const openTabSessions = useMemo(
    () => sessionTargetState.tabSessions ?? [],
    [sessionTargetState.tabSessions]
  );
  const openTabIds = useMemo(
    () => openTabSessions.map((session) => session.id),
    [openTabSessions]
  );
  const reopenableSessions = useMemo(
    () => recentSessions.filter((session) => !openTabIds.includes(session.id)).slice(0, 6),
    [openTabIds, recentSessions]
  );
  const activeWorkspaceName = sessionTargetState.workspaces?.[0]?.name ?? "Personal Learning";

  const handleLlmProviderChange = useCallback((provider) => {
    const nextProvider = provider === "local" ? "local" : DEFAULT_LLM_PROVIDER;
    if (nextProvider === llmSettings.provider) return;
    void updateLlmSettings({
      provider: nextProvider,
      localModel: llmSettings.localModel || DEFAULT_LOCAL_LLM_MODEL
    });
  }, [llmSettings.localModel, llmSettings.provider, updateLlmSettings]);

  const handleLocalModelChange = useCallback((model) => {
    if (model === llmSettings.localModel) return;
    void updateLlmSettings({
      provider: "local",
      localModel: model || DEFAULT_LOCAL_LLM_MODEL
    });
  }, [llmSettings.localModel, updateLlmSettings]);

  const handleReview = async (nodeId, action) => {
    if (!sessionId) return;
    setIsReviewing(true);
    setErrorMessage("");

    try {
      await fetchJson(`${API_BASE}/api/nodes/${encodeURIComponent(nodeId)}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, action })
      });
      setStatusMessage(action === "approve" ? "Concept approved and moved forward in the review schedule." : "Concept rejected and removed from this map.");
      await loadGraph();
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsReviewing(false);
    }
  };

  const handleLearnMore = async () => {
    if (!selectedNode) return;
    setIsLearningMore(true);
    setLearnMoreCopy("");
    setErrorMessage("");

    try {
      const result = await fetchJson(`${API_BASE}/api/learn-more`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withLlmSelection({
          label: selectedNode.label,
          type: selectedNode.type,
          upstream: selectedNodeConnections.upstream.map((entry) => entry.node.label),
          downstream: selectedNodeConnections.downstream.map((entry) => entry.node.label)
        }))
      });
      setLearnMoreCopy(result.content ?? "");
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsLearningMore(false);
    }
  };

  const handleRunGapAnalysis = async () => {
    if (!sessionId || !primaryGoalNode?.id) return;
    setIsLoadingGaps(true);
    setGapSummary(null);
    setErrorMessage("");

    try {
      const result = await fetchJson(`${API_BASE}/api/gaps`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withLlmSelection({
          sessionId,
          goalId: primaryGoalNode.id
        }))
      });
      setGapSummary(result);
      setStatusMessage("Gap analysis updated from the current map.");
      await loadGraph();
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsLoadingGaps(false);
    }
  };

  const handleGenerateQuiz = async () => {
    if (!sessionId) return;
    setIsLoadingQuiz(true);
    setQuizState({ quiz: [], message: "" });
    setQuizAnswers({});
    setQuizResult(null);
    setErrorMessage("");

    try {
      const result = await fetchJson(`${API_BASE}/api/quiz`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withLlmSelection({ sessionId }))
      });
      setQuizState(result);
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsLoadingQuiz(false);
    }
  };

  const handleSubmitQuiz = async () => {
    if (!sessionId || !quizState.quiz.length) return;

    const { correct, incorrect } = groupVerificationResults(quizState.quiz, quizAnswers);
    const answeredCount = correct.length + incorrect.length;

    if (!answeredCount) {
      setErrorMessage("Pick at least one answer before checking the quiz.");
      return;
    }

    setErrorMessage("");

    try {
      if (correct.length) {
        await fetchJson(`${API_BASE}/api/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, conceptIds: correct, correct: true })
        });
      }

      if (incorrect.length) {
        await fetchJson(`${API_BASE}/api/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, conceptIds: incorrect, correct: false })
        });
      }

      setQuizResult({
        answeredCount,
        correctCount: correct.length
      });
      setStatusMessage("Quiz results applied to confidence and next-review dates.");
      await loadGraph();
    } catch (error) {
      setErrorMessage(error.message);
    }
  };

  const loadChatImportTemplate = useCallback(async () => {
    if (!sessionId) return;

    const result = await fetchJson(
      `${API_BASE}/api/import-chat-history/template?provider=${encodeURIComponent(chatImportProvider)}&sessionId=${encodeURIComponent(sessionId)}`
    );
    const nextPrompt = result.prompt ?? "";
    setChatImportPrompt(nextPrompt);
    setChatImportSchemaVersion(result.schemaVersion ?? "mindweaver.chat_import.v1");
    return nextPrompt;
  }, [chatImportProvider, sessionId]);

  useEffect(() => {
    if (!sessionId || rightPanel !== "import") return;

    let cancelled = false;
    setIsLoadingChatImportPrompt(true);

    loadChatImportTemplate()
      .catch((error) => {
        if (cancelled) return;
        setChatImportPrompt("");
        setChatImportErrorMessage(error.message);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingChatImportPrompt(false);
      });

    return () => {
      cancelled = true;
    };
  }, [loadChatImportTemplate, rightPanel, sessionId]);

  const handleCopyChatImportPrompt = async () => {
    const providerLabel = CHAT_IMPORT_PROVIDER_OPTIONS.find((option) => option.value === chatImportProvider)?.label ?? "ChatGPT";

    try {
      let promptToCopy = chatImportPrompt;
      if (!promptToCopy.trim()) {
        setIsLoadingChatImportPrompt(true);
        promptToCopy = await loadChatImportTemplate();
      }

      await navigator.clipboard.writeText(promptToCopy);
      setChatImportErrorMessage("");
      setStatusMessage(`${providerLabel} import prompt copied. Paste it into ${providerLabel}, then bring the JSON response back here.`);
    } catch (error) {
      setChatImportErrorMessage(error.message || "Could not copy the import prompt automatically.");
    } finally {
      setIsLoadingChatImportPrompt(false);
    }
  };

  const handleChatHistoryImportSubmit = async () => {
    if (!sessionId) return;

    const jsonText = extractJsonObjectString(chatImportJson);
    if (!jsonText) {
      setChatImportErrorMessage("Paste the JSON response from ChatGPT or Claude before importing.");
      return;
    }

    let importData;
    try {
      importData = JSON.parse(jsonText);
    } catch {
      setChatImportErrorMessage("The pasted response is not valid JSON yet. Copy the JSON block and try again.");
      return;
    }

    if (chatHistoryImportPreview.state === "ready" && chatHistoryImportPreview.issues?.length) {
      setChatImportErrorMessage(chatHistoryImportPreview.issues.join(" "));
      return;
    }

    setIsImportingChatHistory(true);
    setErrorMessage("");
    setChatImportErrorMessage("");

    try {
      const result = await fetchJson(`${API_BASE}/api/import-chat-history`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          importData
        })
      });

      setChatImportJson("");
      setChatImportErrorMessage("");
      setStatusMessage(
        result.deduped
          ? "That chat-history import was already added to this map."
          : `Imported ${result.importedNodeCount} nodes and ${result.importedRelationshipCount} relationships from chat history.${Array.isArray(result.warnings) && result.warnings.length ? ` ${result.warnings.join(" ")}` : ""}`
      );
      await loadGraph();
    } catch (error) {
      setChatImportErrorMessage(error.message);
    } finally {
      setIsImportingChatHistory(false);
    }
  };

  const handleImportChange = (field, value) => {
    setImportForm((current) => ({
      ...current,
      [field]: value
    }));
  };

  const handleImportFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const content = await file.text();
    setImportForm((current) => ({
      ...current,
      title: current.title || file.name.replace(/\.[^.]+$/, ""),
      content
    }));
  };

  const handleImportSubmit = async (submitEvent) => {
    submitEvent.preventDefault();
    if (!sessionId) return;

    if (!importForm.title.trim() || !importForm.content.trim()) {
      setErrorMessage("A title and content are required for manual imports.");
      return;
    }

    setIsImporting(true);
    setErrorMessage("");

    try {
      await fetchJson(`${API_BASE}/api/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withLlmSelection({
          sessionId,
          sourceType: importForm.sourceType,
          title: importForm.title.trim(),
          url: importForm.url.trim() || undefined,
          excerpt: importForm.content.trim().slice(0, 280),
          content: importForm.content.trim()
        }))
      });
      setImportForm((current) => ({
        ...current,
        title: "",
        url: "",
        content: ""
      }));
      setStatusMessage("Imported source added to this map.");
      await loadGraph();
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsImporting(false);
    }
  };

  const handleBulkImport = async () => {
    if (!sessionId || !bulkImportText.trim()) return;
    const chunks = bulkImportText
      .split(/\n---+\n/g)
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .slice(0, 20);

    if (!chunks.length) {
      setErrorMessage("Paste at least one note. Separate multiple imports with a line containing ---.");
      return;
    }

    setIsBulkImporting(true);
    setErrorMessage("");

    try {
      const result = await fetchJson(`${API_BASE}/api/import-bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withLlmSelection({
          sessionId,
          items: chunks.map((content, index) => ({
            sourceType: "markdown",
            title: `Bulk note ${index + 1}`,
            content
          }))
        }))
      });
      setBulkImportText("");
      setStatusMessage(`Bulk import complete: ${result.importedCount} imported, ${result.dedupedCount} deduped, ${result.failedCount} failed.`);
      await loadGraph();
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsBulkImporting(false);
    }
  };

  const handleGraphSearch = async () => {
    if (!sessionId || !nodeSearch.trim()) return;
    setIsSearchingGraph(true);
    setErrorMessage("");

    try {
      const result = await fetchJson(`${API_BASE}/api/search/${encodeURIComponent(sessionId)}?q=${encodeURIComponent(nodeSearch.trim())}`);
      setSearchResults(result.results ?? []);
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsSearchingGraph(false);
    }
  };

  const handleChat = async () => {
    if (!sessionId || !chatQuestion.trim()) return;
    setIsChatting(true);
    setErrorMessage("");

    try {
      const result = await fetchJson(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withLlmSelection({ sessionId, question: chatQuestion.trim() }))
      });
      setChatAnswer(result);
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsChatting(false);
    }
  };

  const handleLoadSummary = async () => {
    if (!sessionId) return;
    setIsLoadingSummary(true);
    setErrorMessage("");

    try {
      const result = await fetchJson(`${API_BASE}/api/summary/${encodeURIComponent(sessionId)}`);
      setLearningSummary(result);
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsLoadingSummary(false);
    }
  };

  const handlePrune = async () => {
    if (!sessionId) return;
    setIsPruning(true);
    setErrorMessage("");

    try {
      const preview = await fetchJson(`${API_BASE}/api/prune`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, dryRun: true })
      });
      if (!preview.count) {
        setStatusMessage("No low-confidence, no-evidence concepts are ready to prune.");
        return;
      }
      const confirmed = window.confirm(`Prune ${preview.count} low-confidence concept${preview.count === 1 ? "" : "s"} with no direct evidence?`);
      if (!confirmed) return;
      await fetchJson(`${API_BASE}/api/prune`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, dryRun: false })
      });
      setStatusMessage(`Pruned ${preview.count} low-confidence concept${preview.count === 1 ? "" : "s"}.`);
      await loadGraph();
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsPruning(false);
    }
  };

  const handleSaveRelationship = async () => {
    if (!sessionId || !selectedNode || !relationshipForm.targetId) return;
    setIsSavingRelationship(true);
    setErrorMessage("");

    try {
      await fetchJson(`${API_BASE}/api/edges`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          sourceId: selectedNode.id,
          targetId: relationshipForm.targetId,
          type: relationshipForm.type,
          label: relationshipForm.label || relationshipForm.type
        })
      });
      setRelationshipForm({ targetId: "", type: "related", label: "" });
      setStatusMessage("Relationship added to the map.");
      await loadGraph();
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsSavingRelationship(false);
    }
  };

  const handleEdgeReview = async (edgeKey, action) => {
    if (!sessionId) return;
    setErrorMessage("");

    try {
      await fetchJson(`${API_BASE}/api/edges/${encodeURIComponent(edgeKey)}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, action })
      });
      setStatusMessage(action === "approve" ? "Relationship approved." : "Relationship rejected.");
      await loadGraph();
    } catch (error) {
      setErrorMessage(error.message);
    }
  };

  const handleSaveNodeEdits = async () => {
    if (!sessionId || !selectedNode) return;
    if (!nodeEditForm.label.trim()) {
      setErrorMessage("A node label is required.");
      return;
    }
    setIsSavingNode(true);
    setErrorMessage("");

    try {
      await fetchJson(`${API_BASE}/api/nodes/${encodeURIComponent(selectedNode.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, ...nodeEditForm })
      });
      setStatusMessage("Node updated.");
      await loadGraph();
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsSavingNode(false);
    }
  };

  const handleMergeNode = async () => {
    if (!sessionId || !selectedNode || !mergeTargetId) return;
    const confirmed = window.confirm(`Merge "${selectedNode.label}" into the selected target? The source node will be hidden from this session.`);
    if (!confirmed) return;

    setIsMergingNode(true);
    setErrorMessage("");

    try {
      await fetchJson(`${API_BASE}/api/nodes/${encodeURIComponent(selectedNode.id)}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, targetId: mergeTargetId })
      });
      setStatusMessage("Nodes merged.");
      setSelectedNodeId(mergeTargetId);
      openRightPanel("inspector");
      await loadGraph();
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsMergingNode(false);
    }
  };

  const handleDeleteArtifact = async (artifactId) => {
    if (!sessionId) return;
    const confirmed = window.confirm("Remove this source from the map? Related concept evidence will be detached.");
    if (!confirmed) return;

    setIsDeletingArtifact(true);
    setErrorMessage("");

    try {
      await fetchJson(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}`, {
        method: "DELETE"
      });
      setStatusMessage("Source removed from this map.");
      await loadGraph();
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsDeletingArtifact(false);
    }
  };

  const handleCreateGoalNode = async () => {
    if (!sessionId || !goalNodeDraft.trim()) return;

    setIsCreatingGoalNode(true);
    setErrorMessage("");

    try {
      const result = await fetchJson(`${API_BASE}/api/nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          type: "goal",
          label: goalNodeDraft.trim()
        })
      });
      setGoalNodeDraft("");
      setSelectedNodeId(result.node?.id ?? null);
      openRightPanel("inspector");
      setStatusMessage(result.goalCreated ? "Primary goal node added to this map." : "Top-level goal node added to this map.");
      await loadHomeData();
      await loadGraph();
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsCreatingGoalNode(false);
    }
  };

  const handleRefineMap = async () => {
    if (!sessionId) return;
    const activeRefineLabel = llmSettings.provider === "local"
      ? `${activeLocalModelLabel} via Ollama`
      : "OpenAI";
    const confirmed = window.confirm(`Refine this map with ${activeRefineLabel}? MindWeaver will rename, merge, and reconnect nodes conservatively to improve clarity.`);
    if (!confirmed) return;

    setIsRefiningMap(true);
    setErrorMessage("");

    try {
      const result = await fetchJson(`${API_BASE}/api/refine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withLlmSelection({ sessionId }))
      });
      const warningCopy = result.applied?.warnings?.length ? ` ${result.applied.warnings.join(" ")}` : "";
      setStatusMessage(`${result.message || "Map refined."}${warningCopy}`);
      await loadHomeData();
      await loadGraph();
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsRefiningMap(false);
    }
  };

  const handleIntersect = async () => {
    if (!selectedNode || !intersectionTargetId) return;
    setIsIntersecting(true);
    setErrorMessage("");

    try {
      const result = await fetchJson(`${API_BASE}/api/intersect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withLlmSelection({ nodeId1: selectedNode.id, nodeId2: intersectionTargetId }))
      });
      setIntersectionResult(result);
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsIntersecting(false);
    }
  };

  const revealRightPanel = useCallback(() => {
    if (!window.matchMedia("(max-width: 1180px)").matches) return;

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        rightRailRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start"
        });
      });
    });
  }, []);

  const openRightPanel = (panel) => {
    setRightPanel(panel);
    setRightRailMinimized(false);
    revealRightPanel();
  };

  const handleFocusGraph = () => {
    setLeftRailMinimized(true);
    setRightRailMinimized(true);
  };

  const handleRecommendation = (recommendation) => {
    if (recommendation.nodeId) {
      setSelectedNodeId(recommendation.nodeId);
      openRightPanel("inspector");
      return;
    }

    openRightPanel("import");
  };

  const handleNodeRender = (node, ctx) => {
    const isSelected = node.id === selectedNodeId;
    const metrics = getNodeMetrics(node, ctx);

    ctx.save();
    drawRoundedRect(ctx, metrics.x, metrics.y, metrics.width, metrics.height, 8);
    ctx.fillStyle = metrics.fill;
    ctx.shadowColor = isSelected ? metrics.shadowColor : "transparent";
    ctx.shadowBlur = isSelected ? 18 : 0;
    ctx.fill();
    ctx.lineWidth = isSelected ? 3 : 1.6;
    ctx.strokeStyle = isSelected ? metrics.selectedStroke : metrics.stroke;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = metrics.textFill;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${metrics.fontSize}px Segoe UI`;
    metrics.lines.forEach((line, index) => {
      ctx.fillText(line, node.x, metrics.textY + index * metrics.lineHeight);
    });
    ctx.restore();
  };

  const handlePointerPaint = (node, color, ctx) => {
    const metrics = getNodeMetrics(node, ctx);
    ctx.fillStyle = color;
    drawRoundedRect(ctx, metrics.x - 4, metrics.y - 4, metrics.width + 8, metrics.height + 8, 10);
    ctx.fill();
  };

  const handleLinkRender = (link, ctx) => {
    const style = getLinkVisualStyle(link);
    ctx.save();
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = style.lineWidth;
    if (style.dash.length) ctx.setLineDash(style.dash);
    ctx.beginPath();
    ctx.moveTo(link.source.x, link.source.y);
    ctx.lineTo(link.target.x, link.target.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  };

  const mapTabsChrome = (
    <section className="map-tabs-shell panel">
      <div className="map-tabs-header">
        <div>
          <p className="panel-title">Map Tabs</p>
          <h2>{activeWorkspaceName}</h2>
        </div>
        <div className="map-tabs-meta">
          <span>{sessionTargetState.activeSession ? `Extension target: ${getMapName(sessionTargetState.activeSession)}` : "Extension target is idle"}</span>
          <span>{openTabSessions.length} open tab{openTabSessions.length === 1 ? "" : "s"}</span>
        </div>
      </div>

      <div className="map-tabs-row">
        <button
          type="button"
          className={`map-home-tab ${!sessionId ? "is-active" : ""}`}
          onClick={() => navigateToSession(null)}
        >
          All Maps
        </button>

        {openTabSessions.map((session) => (
          <div key={session.id} className={`map-tab ${sessionId === session.id ? "is-active" : ""}`}>
            <button type="button" className="map-tab-main" onClick={() => openSessionTab(session.id)}>
              <strong>{getMapName(session)}</strong>
              <span>
                {session.id === sessionTargetState.activeSessionId ? "capture target" : session.endedAt ? "ended" : "live"} • {session.sourceCount} sources
              </span>
            </button>
            <button
              type="button"
              className="map-tab-close"
              aria-label={`Close ${getMapName(session)} tab`}
              onClick={() => closeSessionTab(session.id)}
            >
              ×
            </button>
          </div>
        ))}

        <form className="map-tab-create-form" onSubmit={(event) => handleCreateSession(event, { fromTabs: true })}>
          <input
            className="text-input map-tab-input"
                    placeholder="Map name"
            value={tabComposerGoal}
            onChange={(event) => setTabComposerGoal(event.target.value)}
          />
          <button className="secondary-button" type="submit" disabled={isCreatingSession}>
            {isCreatingSession ? "Creating..." : "New Map"}
          </button>
        </form>
      </div>

        {reopenableSessions.length ? (
          <div className="map-reopen-row">
            <span>Reopen recent</span>
            {reopenableSessions.map((session) => (
              <button key={session.id} type="button" className="map-reopen-chip" onClick={() => openSessionTab(session.id)}>
                {getMapName(session)}
              </button>
            ))}
          </div>
      ) : null}
    </section>
  );

  if (!sessionId) {
    return (
      <div className="page-shell">
        {mapTabsChrome}
        <div className="landing-shell">
          <section className="landing-hero panel">
            <p className="panel-title">MindWeaver</p>
            <h1>Build a knowledge map from what you are actually learning.</h1>
            <p>
              Start a map, save the current page from the extension, or paste notes and transcripts directly.
              MindWeaver turns the work into a source-grounded map you can review, quiz, and improve.
            </p>
            <div className="llm-settings-panel">
              <div className="llm-settings-header">
                <div>
                  <span className="panel-title">AI Provider</span>
                  <strong>{activeLlmProviderLabel}{llmSettings.provider === "local" ? ` • ${activeLocalModelLabel}` : ""}</strong>
                </div>
                <p>The same setting is shared across the homepage, the graph workspace, and extension captures.</p>
              </div>
              <div className="llm-settings-grid">
                <label className="llm-settings-field">
                  <span>Provider</span>
                  <SelectControl
                    value={llmSettings.provider}
                    onChange={handleLlmProviderChange}
                    options={LLM_PROVIDER_OPTIONS}
                    ariaLabel="AI provider"
                  />
                </label>
                {llmSettings.provider === "local" ? (
                  <label className="llm-settings-field">
                    <span>Model</span>
                    <SelectControl
                      value={llmSettings.localModel}
                      onChange={handleLocalModelChange}
                      options={localModelOptions}
                      ariaLabel="Local AI model"
                    />
                  </label>
                ) : null}
              </div>
              <div className={`toolbar-note llm-status-note ${canUseSelectedLlm ? "" : "is-warning"}`.trim()}>
                {isSavingLlmSettings ? "Saving AI provider preference..." : llmStatusMessage}
              </div>
            </div>
            <form className="start-form" onSubmit={handleCreateSession}>
              <label>
                <span>Map name</span>
                <textarea
                  className="text-area compact-area"
                  placeholder="Example: Event-driven systems knowledge map"
                  value={startGoal}
                  onChange={(event) => setStartGoal(event.target.value)}
                />
              </label>
              <button className="primary-button jumbo-button" type="submit" disabled={isCreatingSession}>
                {isCreatingSession ? "Starting..." : "Start A Knowledge Map"}
              </button>
              <button className="secondary-button jumbo-button" type="button" onClick={handleCreateDemoSession} disabled={isCreatingDemo}>
                {isCreatingDemo ? "Building demo..." : "Try A Demo Map"}
              </button>
            </form>
            {homeErrorMessage ? <div className="message-banner error-banner">{homeErrorMessage}</div> : null}
          </section>

          <section className="landing-grid">
            <div className="panel">
              <p className="panel-title">How It Works</p>
              <div className="step-list">
                <div className="step-card"><strong>1. Name the map</strong><span>Start with a clear map name, then add goal nodes only when they help the structure.</span></div>
                <div className="step-card"><strong>2. Capture sources</strong><span>Browse with the extension or import notes, PDF text, docs, and transcripts.</span></div>
                <div className="step-card"><strong>3. Review the map</strong><span>Approve good concepts, reject noisy ones, and use quizzes to strengthen memory.</span></div>
              </div>
            </div>

            <div className="panel">
              <p className="panel-title">Safety</p>
              <div className="safety-stack">
                <div><strong>Local-first storage</strong><span>Your graph is stored in the local server data file.</span></div>
                <div><strong>AI visibility</strong><span>{llmStatusMessage} Up to {contentLimitChars.toLocaleString()} characters per source can be sent to the selected model for classification.</span></div>
                <div><strong>Human control</strong><span>Every inferred concept can be approved, rejected, or deleted with the session.</span></div>
              </div>
            </div>

            <div className="panel recent-panel">
              <p className="panel-title">Recent Maps</p>
              <div className="review-list">
                {recentSessions.length ? recentSessions.map((session) => (
                  <button
                    key={session.id}
                    className="session-card"
                    onClick={() => openSessionTab(session.id)}
                  >
                    <strong>{getMapName(session)}</strong>
                    <span>{session.conceptCount} concepts • {session.sourceCount} sources • {session.endedAt ? "ended" : "live"}</span>
                  </button>
                )) : (
                  <div className="queue-item">
                    <h3>No maps yet</h3>
                    <div className="queue-meta">Start your first map above. The extension is optional for getting started.</div>
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    );
  }

  const rightPanelLabel = RIGHT_PANEL_LABELS[rightPanel] ?? "Inspector";
  const appShellClassName = [
    "app-shell",
    leftRailMinimized ? "is-left-minimized" : "",
    rightRailMinimized ? "is-right-minimized" : ""
  ].filter(Boolean).join(" ");

  return (
    <div className="page-shell is-workspace">
      {mapTabsChrome}
      <div className={appShellClassName}>
        <aside className={`left-rail ${leftRailMinimized ? "is-minimized" : ""}`} aria-label="Map navigation">
          {leftRailMinimized ? (
            <button className="rail-tab rail-tab-left" type="button" onClick={() => setLeftRailMinimized(false)} aria-label="Expand workspaces">
              <span className="rail-tab-label">Workspaces</span>
              <span className="rail-tab-mark" aria-hidden="true" />
            </button>
          ) : (
            <>
          <section className="panel workspace-nav">
            <div className="panel-heading-row">
              <p className="panel-title">Workspaces</p>
              <button className="rail-toggle-button" type="button" onClick={() => setLeftRailMinimized(true)} aria-label="Collapse workspaces">
                Collapse
              </button>
            </div>
            <div className="workspace-list">
              <button className={`workspace-button ${rightPanel === "inspector" ? "is-active" : ""}`} onClick={() => openRightPanel("inspector")}>
                <strong>Inspector</strong>
                <span>{selectedNode ? selectedNode.label : "Select and clean up a node"}</span>
              </button>
              <button className={`workspace-button ${rightPanel === "assistant" ? "is-active" : ""}`} onClick={() => openRightPanel("assistant")}>
                <strong>Graph Assistant</strong>
                <span>Ask questions against this map</span>
              </button>
              <button className={`workspace-button ${rightPanel === "actions" ? "is-active" : ""}`} onClick={() => openRightPanel("actions")}>
                <strong>Next Actions</strong>
                <span>{graphState?.recommendations?.length ?? 0} recommendations</span>
              </button>
              <button className={`workspace-button ${rightPanel === "review" ? "is-active" : ""}`} onClick={() => openRightPanel("review")}>
                <strong>Review Queue</strong>
                <span>{graphState?.reviewQueue?.length ?? 0} concepts waiting</span>
              </button>
              <button className={`workspace-button ${rightPanel === "plan" ? "is-active" : ""}`} onClick={() => openRightPanel("plan")}>
                <strong>{graphState?.studyPlan?.title ?? "Study Plan"}</strong>
                <span>{graphState?.studyPlan?.totalMinutes ?? 15} minute next session</span>
              </button>
              <button className={`workspace-button ${rightPanel === "progress" ? "is-active" : ""}`} onClick={() => openRightPanel("progress")}>
                <strong>Progress Report</strong>
                <span>{progressState?.longTerm?.sessionCount ?? 0} maps tracked</span>
              </button>
              <button className={`workspace-button ${rightPanel === "import" ? "is-active" : ""}`} onClick={() => openRightPanel("import")}>
                <strong>Import Sources</strong>
                <span>Notes, transcripts, docs, and highlights</span>
              </button>
              <button className={`workspace-button ${rightPanel === "gaps" ? "is-active" : ""}`} onClick={() => openRightPanel("gaps")}>
                <strong>Gap Analysis</strong>
                <span>{gapSummary?.gaps?.length ? `${gapSummary.gaps.length} gaps found` : "Find missing concepts"}</span>
              </button>
              <button className={`workspace-button ${rightPanel === "quiz" ? "is-active" : ""}`} onClick={() => openRightPanel("quiz")}>
                <strong>Quiz Loop</strong>
                <span>{quizState.quiz?.length ? `${quizState.quiz.length} questions ready` : "Generate spaced review"}</span>
              </button>
            </div>
          </section>

          <MapStructurePanel
            mapNameDraft={mapNameDraft}
            onMapNameChange={(value) => {
              setIsEditingMapName(true);
              setMapNameDraft(value);
            }}
            onSaveMapName={handleRenameMap}
            isRenamingMap={isRenamingMap}
            hasMapNameChanges={hasMapNameChanges}
            goalNodeDraft={goalNodeDraft}
            onGoalNodeDraftChange={setGoalNodeDraft}
            onCreateGoalNode={handleCreateGoalNode}
            isCreatingGoalNode={isCreatingGoalNode}
            primaryGoalNode={primaryGoalNode}
            isRefiningMap={isRefiningMap}
            onRefineMap={handleRefineMap}
            canUseLlm={canUseSelectedLlm}
            llmProviderLabel={llmSettings.provider === "local" ? `${activeLocalModelLabel} via Ollama` : "OpenAI"}
            llmStatusMessage={llmStatusMessage}
            nodeCount={graphData.nodes.length}
          />

          <MapOverviewCard
            mapName={getMapName(graphState?.session)}
            nodeCount={graphData.nodes.length}
            sourceCount={graphState?.artifacts?.length ?? 0}
            reviewCount={graphState?.reviewQueue?.length ?? 0}
            onRunGapAnalysis={() => {
              openRightPanel("gaps");
              handleRunGapAnalysis();
            }}
            isLoadingGaps={isLoadingGaps}
            canRunGapAnalysis={Boolean(primaryGoalNode?.id)}
            onGenerateQuiz={() => {
              openRightPanel("quiz");
              handleGenerateQuiz();
            }}
            isLoadingQuiz={isLoadingQuiz}
            onEndSession={handleEndSession}
            isEndingSession={isEndingSession}
            isEnded={Boolean(graphState?.session?.endedAt)}
            statusMessage={statusMessage}
            errorMessage={errorMessage}
          />

          <section className="panel safety-panel">
            <p className="panel-title">Privacy & Control</p>
            <p className="panel-subtitle">
              Local storage is used for the graph. AI tasks currently follow the homepage provider setting: {activeLlmProviderLabel}{llmSettings.provider === "local" ? ` (${activeLocalModelLabel})` : ""}. Source classification reads up to {contentLimitChars.toLocaleString()} characters per source.
            </p>
            <div className="queue-actions">
              <button className="small-button" onClick={() => navigateToSession(null)}>All Maps</button>
              <button className="small-button" disabled={isExporting} onClick={() => handleExport("markdown")}>
                {isExporting ? "Exporting..." : "Export Markdown"}
              </button>
              <button className="small-button" disabled={isExporting} onClick={() => handleExport("json")}>
                Export JSON
              </button>
              <button className="small-button" type="button" onClick={handleDownloadBackup}>
                Backup Data
              </button>
              <label className={`small-button file-button ${isRestoringBackup ? "is-disabled" : ""}`}>
                {isRestoringBackup ? "Restoring..." : "Restore Backup"}
                <input type="file" accept=".json,application/json" disabled={isRestoringBackup} onChange={handleRestoreBackup} />
              </label>
              <button className="small-button is-reject" disabled={isDeletingSession} onClick={handleDeleteSession}>
                {isDeletingSession ? "Deleting..." : "Delete This Map"}
              </button>
            </div>
          </section>

          <section className="panel health-panel">
            <p className="panel-title">Map Health</p>
            <div className="health-score">
              <strong>{graphState?.health?.score ?? 0}</strong>
              <span>/ 100</span>
            </div>
            <div className="health-bars">
              <div>
                <span>Evidence</span>
                <div className="confidence-bar"><div className="confidence-fill" style={{ width: `${Math.round((graphState?.health?.evidenceCoverage ?? 0) * 100)}%` }} /></div>
              </div>
              <div>
                <span>Reviewed</span>
                <div className="confidence-bar"><div className="confidence-fill" style={{ width: `${Math.round((graphState?.health?.reviewCoverage ?? 0) * 100)}%` }} /></div>
              </div>
            </div>
            <div className="review-list compact-list">
              {(graphState?.health?.risks?.length ? graphState.health.risks : ["Keep adding source-backed concepts and reviewing them over time."]).slice(0, 3).map((risk) => (
                <div key={risk} className="mini-note">{risk}</div>
              ))}
            </div>
          </section>

            </>
          )}
        </aside>

        <main className="graph-card">
          <div className="graph-toolbar">
            <div>
              <h2>Knowledge Graph</h2>
              <p>{isLoadingGraph ? "Refreshing graph..." : `${graphData.nodes.length} visible nodes`}</p>
            </div>
            <div className="graph-controls">
              <input
                className="text-input graph-search"
                placeholder="Search nodes..."
                value={nodeSearch}
                onChange={(event) => setNodeSearch(event.target.value)}
              />
              <SelectControl
                className="graph-filter"
                value={nodeTypeFilter}
                onChange={setNodeTypeFilter}
                options={NODE_TYPE_OPTIONS}
                ariaLabel="Filter node type"
              />
              <button className="small-button" onClick={handleGraphSearch} disabled={isSearchingGraph || !nodeSearch.trim()}>
                {isSearchingGraph ? "Searching..." : "Find Evidence"}
              </button>
              <button className="small-button" type="button" onClick={handleFocusGraph}>
                Focus Graph
              </button>
            </div>
            <div className="status-pill">
              <span>{graphState?.session?.endedAt ? "Ended" : "Live map"}</span>
              <span>•</span>
              <span>{graphState?.artifacts?.length ?? 0} sources</span>
              <span>•</span>
              <span>Manual refresh</span>
            </div>
          </div>
          {searchResults.length ? (
            <div className="search-results-strip">
              {searchResults.slice(0, 6).map((result) => (
                <button
                  key={`${result.kind}-${result.id}`}
                  className="search-chip"
                  onClick={() => {
                    if (result.kind !== "node") return;
                    setSelectedNodeId(result.id);
                    openRightPanel("inspector");
                  }}
                >
                  <strong>{result.label}</strong>
                  <span>{result.kind} • {result.type}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="graph-canvas" ref={graphContainerRef}>
            <button
              className="graph-refresh-button"
              type="button"
              onClick={handleRefreshGraph}
              disabled={isLoadingGraph}
              title="Reload this map and the shared map state"
            >
              {isLoadingGraph ? "Refreshing..." : "Refresh map"}
            </button>
            {graphData.nodes.length ? (
              <div className="graph-legend" aria-label="Graph node type legend">
                {NODE_TYPE_LEGEND.map((item) => (
                  <span key={item.type} className="graph-legend-item">
                    <span
                      className="graph-legend-swatch"
                      aria-hidden="true"
                      style={{ background: item.fill, borderColor: item.stroke }}
                    />
                    {item.label}
                  </span>
                ))}
              </div>
            ) : null}
            {graphData.nodes.length > 0 && !isGraphViewportReady ? (
              <div className="graph-loading-overlay">
                <p className="panel-title">Preparing View</p>
                <h3>Fitting your map to the workspace</h3>
                <p>MindWeaver is settling the graph so it opens at a usable zoom level.</p>
              </div>
            ) : null}
            {!isLoadingGraph && graphData.nodes.length === 0 ? (
              <div className="graph-empty">
                <p className="panel-title">Start Building</p>
                <h3>No visible map nodes yet</h3>
                <p>Name the map, import a note, or browse with the extension. Once sources are classified, your knowledge map will appear here.</p>
                <button className="primary-button" onClick={() => openRightPanel("import")}>
                  Import First Source
                </button>
              </div>
            ) : null}
            <ForceGraph2D
              ref={fgRef}
              graphData={graphData}
              width={graphSize.width}
              height={graphSize.height}
              minZoom={0.08}
              maxZoom={6}
              backgroundColor="rgba(0,0,0,0)"
              nodeCanvasObject={handleNodeRender}
              nodePointerAreaPaint={handlePointerPaint}
              linkCanvasObject={handleLinkRender}
              linkWidth={() => 1}
              linkColor={() => "rgba(255,255,255,0.18)"}
              onNodeClick={(node) => {
                setSelectedNodeId(node.id);
                openRightPanel("inspector");
              }}
              nodeRelSize={4}
              warmupTicks={140}
              cooldownTicks={110}
              d3VelocityDecay={0.22}
              onEngineStop={handleGraphEngineStop}
            />
          </div>
        </main>

        <aside ref={rightRailRef} className={`right-rail ${rightRailMinimized ? "is-minimized" : ""}`} aria-label="Workspace details">
          {rightRailMinimized ? (
            <button className="rail-tab rail-tab-right" type="button" onClick={() => setRightRailMinimized(false)} aria-label={`Expand ${rightPanelLabel}`}>
              <span className="rail-tab-label">{rightPanelLabel}</span>
              <span className="rail-tab-mark" aria-hidden="true" />
            </button>
          ) : (
            <section className="panel scroll-panel workspace-panel">
              <div className="workspace-panel-chrome">
                <span>{rightPanelLabel}</span>
                <button className="rail-toggle-button" type="button" onClick={() => setRightRailMinimized(true)} aria-label="Collapse right panel">
                  Collapse
                </button>
              </div>
            {rightPanel === "plan" ? (
              <>
                <div className="workspace-panel-header">
                  <p className="panel-title">{graphState?.studyPlan?.title ?? "Study Plan"}</p>
                  <h2>Next session plan</h2>
                  <p className="panel-subtitle">
                    A realistic next session, sized to about {graphState?.studyPlan?.totalMinutes ?? 15} minutes.
                  </p>
                </div>
                <div className="study-steps workspace-list-large">
                  {graphState?.studyPlan?.steps?.length ? graphState.studyPlan.steps.map((step, index) => (
                    <div key={`${step.title}-${index}`} className="study-step">
                      <span>{step.minutes}m</span>
                      <div>
                        <strong>{step.title}</strong>
                        <p>{step.detail}</p>
                      </div>
                    </div>
                  )) : (
                    <div className="queue-item">
                      <h3>No plan yet</h3>
                      <div className="queue-meta">Add or review more source-backed concepts to generate a useful next session.</div>
                    </div>
                  )}
                </div>
              </>
            ) : null}

            {rightPanel === "progress" ? (
              <>
                <div className="workspace-panel-header">
                  <p className="panel-title">Progress Report</p>
                  <h2>Learning health</h2>
                  <p className="panel-subtitle">
                    Map and long-term learning health, based on concepts, evidence, and verification.
                  </p>
                </div>
                <div className="progress-grid workspace-progress-grid">
                  <div><strong>{progressState?.byMastery?.verified ?? 0}</strong><span>Verified</span></div>
                  <div><strong>{progressState?.byMastery?.understood ?? 0}</strong><span>Understood</span></div>
                  <div><strong>{progressState?.byMastery?.seen ?? 0}</strong><span>Seen</span></div>
                  <div><strong>{progressState?.longTerm?.sessionCount ?? 0}</strong><span>Sessions</span></div>
                </div>
                <div className="queue-actions">
                  <button className="small-button" onClick={handleLoadSummary} disabled={isLoadingSummary}>
                    {isLoadingSummary ? "Summarizing..." : "Generate Summary"}
                  </button>
                  <button className="small-button is-reject" onClick={handlePrune} disabled={isPruning}>
                    {isPruning ? "Checking..." : "Prune Weak Nodes"}
                  </button>
                </div>
                {learningSummary ? (
                  <div className="summary-card">
                    <h3>{learningSummary.title}</h3>
                    <div className="queue-meta">{learningSummary.summary}</div>
                    {learningSummary.topConcepts?.length ? <div className="queue-meta">Top concepts: {learningSummary.topConcepts.join(", ")}</div> : null}
                  </div>
                ) : null}
              </>
            ) : null}

            {rightPanel === "assistant" ? (
              <>
                <div className="workspace-panel-header">
                  <p className="panel-title">Graph Assistant</p>
                  <h2>Ask the graph</h2>
                  <p className="panel-subtitle">Answers use matching concepts and sources from this map.</p>
                </div>
                <div className="import-form workspace-form">
                  <textarea
                    className="text-area workspace-area"
                    placeholder="Example: What should I study next and why?"
                    value={chatQuestion}
                    onChange={(event) => setChatQuestion(event.target.value)}
                  />
                  <button className="primary-button" onClick={handleChat} disabled={isChatting || !chatQuestion.trim()}>
                    {isChatting ? "Thinking..." : "Ask The Graph"}
                  </button>
                </div>
                {chatAnswer ? (
                  <div className="summary-card">
                    <h3>Answer</h3>
                    <div className="learn-more-copy">{chatAnswer.answer}</div>
                    {chatAnswer.citations?.length ? (
                      <div className="review-list compact-list">
                        {chatAnswer.citations.map((citation) => (
                          <div key={citation.id} className="mini-note">{citation.label}</div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}

            {rightPanel === "actions" ? (
              <>
                <div className="workspace-panel-header">
                  <p className="panel-title">Next Actions</p>
                  <h2>Recommended moves</h2>
                  <p className="panel-subtitle">Built from review dates, low-evidence concepts, and the latest gap analysis.</p>
                </div>
                <div className="review-list workspace-list-large">
                  {graphState?.recommendations?.length ? graphState.recommendations.map((recommendation) => (
                    <div key={`${recommendation.kind}-${recommendation.title}`} className="queue-item">
                      <h3>{recommendation.title}</h3>
                      <div className="queue-meta">{recommendation.reason}</div>
                      <div className="queue-actions">
                        <button className="small-button" onClick={() => handleRecommendation(recommendation)}>
                          {recommendation.nodeId ? "Open Node" : "Open Import"}
                        </button>
                      </div>
                    </div>
                  )) : <div className="queue-item"><h3>No recommendations yet</h3><div className="queue-meta">Capture more sources or run gap analysis to generate next-step suggestions.</div></div>}
                </div>
              </>
            ) : null}

            {rightPanel === "review" ? (
              <>
                <div className="workspace-panel-header">
                  <p className="panel-title">Review Queue</p>
                  <h2>Concepts to check</h2>
                  <p className="panel-subtitle">Approve concepts that look right, or reject noisy ones to clean the map.</p>
                </div>
                <div className="review-list workspace-list-large">
                  {graphState?.reviewQueue?.length ? graphState.reviewQueue.map((node) => (
                    <div key={node.id} className="queue-item">
                      <h3>{node.label}</h3>
                      <div className="queue-meta">
                        Confidence {Math.round((node.confidence ?? 0) * 100)}% • Evidence {node.evidenceCount} • {describeReviewDate(node.nextReviewAt)}
                      </div>
                      <div className="queue-actions">
                        <button className="small-button" onClick={() => { setSelectedNodeId(node.id); openRightPanel("inspector"); }}>Inspect</button>
                        <button className="small-button is-approve" disabled={isReviewing} onClick={() => handleReview(node.id, "approve")}>Approve</button>
                        <button className="small-button is-reject" disabled={isReviewing} onClick={() => handleReview(node.id, "reject")}>Reject</button>
                      </div>
                    </div>
                  )) : <div className="queue-item"><h3>Queue cleared</h3><div className="queue-meta">Nothing is waiting for review right now.</div></div>}
                </div>
              </>
            ) : null}

            {rightPanel === "import" ? (
              <>
                <div className="workspace-panel-header">
                  <p className="panel-title">Import Sources</p>
                  <h2>Add source material</h2>
                  <p className="panel-subtitle">Bring in manual notes, or bootstrap a map from the user's ChatGPT or Claude history with structured JSON.</p>
                </div>
                <div className="summary-card onboarding-import-card">
                  <h3>Import Chat History Context</h3>
                  <div className="queue-meta">
                    Copy the prompt below, paste it into {chatImportProviderLabel}, then paste the JSON response back into MindWeaver. The import adds source-backed domain, skill, and concept nodes to this map without needing another classification pass.
                  </div>
                  <div className="import-form workspace-form">
                    <SelectControl
                      value={chatImportProvider}
                      onChange={setChatImportProvider}
                      options={CHAT_IMPORT_PROVIDER_OPTIONS}
                      ariaLabel="Chat import provider"
                    />
                    <textarea
                      className="text-area chat-import-prompt-area"
                      readOnly
                      value={chatImportPrompt}
                      placeholder={isLoadingChatImportPrompt ? `Preparing a ${chatImportProviderLabel} prompt for this map...` : "Prompt will appear here."}
                    />
                    <div className="chat-import-actions">
                      <button className="secondary-button" type="button" onClick={handleCopyChatImportPrompt} disabled={isLoadingChatImportPrompt || !sessionId}>
                        {isLoadingChatImportPrompt ? "Preparing Prompt..." : `Copy ${chatImportProviderLabel} Prompt`}
                      </button>
                      <div className="queue-meta">
                        The prompt is tuned to the current map and requests strict JSON only.
                      </div>
                    </div>
                    <textarea
                      className="text-area workspace-area chat-import-json-area"
                      placeholder="Paste the JSON response from ChatGPT or Claude here..."
                      value={chatImportJson}
                      onChange={(event) => {
                        setChatImportJson(event.target.value);
                        setChatImportErrorMessage("");
                      }}
                    />
                    {chatHistoryImportPreview.state === "error" ? (
                      <div className="message-banner error-banner">{chatHistoryImportPreview.message}</div>
                    ) : null}
                    {chatHistoryImportPreview.state === "ready" ? (
                      <div className="chat-import-preview">
                        <div className="chat-import-preview-header">
                          <strong>{chatHistoryImportPreview.title}</strong>
                          <span>{chatHistoryImportPreview.provider || "provider not set"}</span>
                        </div>
                        <div className="chat-import-pill-row">
                          <span className="chat-import-pill">{chatHistoryImportPreview.nodeCount} nodes</span>
                          <span className="chat-import-pill">{chatHistoryImportPreview.relationshipCount} relationships</span>
                          <span className="chat-import-pill">{chatHistoryImportPreview.highlightCount} highlights</span>
                        </div>
                        <div className="queue-meta">
                          Schema: {chatHistoryImportPreview.schemaVersion || "missing"}
                          {chatImportSchemaVersion && chatHistoryImportPreview.schemaVersion !== chatImportSchemaVersion ? " - this will be rejected until the schema version matches." : ""}
                        </div>
                        {chatHistoryImportPreview.summary ? (
                          <div className="queue-meta chat-import-preview-summary">{chatHistoryImportPreview.summary}</div>
                        ) : null}
                      </div>
                    ) : null}
                    {chatHistoryImportPreview.state === "ready" && chatHistoryImportPreview.issues?.length ? (
                      <div className="message-banner error-banner">{chatHistoryImportPreview.issues.join(" ")}</div>
                    ) : null}
                    {chatHistoryImportPreview.state === "ready" && chatHistoryImportPreview.warnings?.length ? (
                      <div className="message-banner">{chatHistoryImportPreview.warnings.join(" ")}</div>
                    ) : null}
                    {chatImportErrorMessage ? <div className="message-banner error-banner">{chatImportErrorMessage}</div> : null}
                    <button
                      className="primary-button"
                      type="button"
                      disabled={isImportingChatHistory || !chatImportJson.trim() || (chatHistoryImportPreview.state === "ready" && chatHistoryImportPreview.issues?.length)}
                      onClick={handleChatHistoryImportSubmit}
                    >
                      {isImportingChatHistory ? "Importing Chat History..." : "Import Chat History JSON"}
                    </button>
                  </div>
                </div>
                <div className="summary-card">
                  <h3>Manual Source Import</h3>
                  <div className="queue-meta">Paste notes, transcripts, docs, or extracted text directly into the current map.</div>
                  <form className="import-form workspace-form" onSubmit={handleImportSubmit}>
                    <SelectControl
                      value={importForm.sourceType}
                      onChange={(value) => handleImportChange("sourceType", value)}
                      options={SOURCE_TYPE_OPTIONS}
                      ariaLabel="Source type"
                    />
                    <input className="text-input" placeholder="Title" value={importForm.title} onChange={(event) => handleImportChange("title", event.target.value)} />
                    <input className="text-input" placeholder="Optional source URL" value={importForm.url} onChange={(event) => handleImportChange("url", event.target.value)} />
                    <textarea
                      className="text-area workspace-area import-content-area"
                      placeholder="Paste the note, transcript, or extracted PDF text here..."
                      value={importForm.content}
                      onChange={(event) => handleImportChange("content", event.target.value)}
                    />
                    <input className="text-input" type="file" accept=".txt,.md,.text" onChange={handleImportFile} />
                    <div className={`char-meter ${importIsTooLong ? "is-danger" : ""}`}>
                      {importContentLength.toLocaleString()} / {maxImportChars.toLocaleString()} characters. The selected AI provider reads up to {contentLimitChars.toLocaleString()} characters for classification.
                    </div>
                    {importIsTooLong ? <div className="message-banner error-banner">This import is too large. Trim it or split it into multiple sources before importing.</div> : null}
                    <button className="primary-button" type="submit" disabled={isImporting || importIsTooLong}>
                      {isImporting ? "Importing..." : "Import Into Map"}
                    </button>
                  </form>
                </div>
                <div className="summary-card">
                  <h3>Bulk Markdown / Reading List Import</h3>
                  <div className="queue-meta">Paste multiple notes or saved-reading extracts. Separate each item with a line containing ---.</div>
                  <div className="import-form">
                    <textarea
                      className="text-area workspace-area"
                      placeholder={"Note one...\n---\nNote two..."}
                      value={bulkImportText}
                      onChange={(event) => setBulkImportText(event.target.value)}
                    />
                    <button className="secondary-button" type="button" disabled={isBulkImporting || !bulkImportText.trim()} onClick={handleBulkImport}>
                      {isBulkImporting ? "Bulk importing..." : "Bulk Import"}
                    </button>
                  </div>
                </div>
                <div className="review-list workspace-list-large">
                  {(graphState?.artifacts ?? []).slice(-4).reverse().map((artifact) => (
                    <div key={artifact.id} className="queue-item">
                      <h3>{artifact.title}</h3>
                      <div className="queue-meta">{formatSourceTypeLabel(artifact.sourceType)} • {artifact.contentLength} chars</div>
                      <div className="queue-actions">
                        <button className="small-button is-reject" type="button" disabled={isDeletingArtifact} onClick={() => handleDeleteArtifact(artifact.id)}>
                          Remove Source
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {rightPanel === "gaps" ? (
              <>
                <div className="workspace-panel-header">
                  <p className="panel-title">Gap Analysis</p>
                  <h2>Missing concepts</h2>
                  <p className="panel-subtitle">Use the current map structure and primary goal node to choose the next learning move.</p>
                </div>
                <button className="primary-button workspace-primary-action" onClick={handleRunGapAnalysis} disabled={isLoadingGaps || !primaryGoalNode?.id}>
                  {isLoadingGaps ? "Finding gaps..." : "Run Gap Analysis"}
                </button>
                {gapSummary ? (
                  <div className="summary-card">
                    <h3>{gapSummary.gaps?.length ? `${gapSummary.gaps.length} gap${gapSummary.gaps.length === 1 ? "" : "s"} found` : "No explicit gaps yet"}</h3>
                    <div className="quiz-meta">Difficulty: {gapSummary.difficulty || "unknown"}</div>
                    {gapSummary.gaps?.length ? (
                      <div className="queue-meta">Missing concepts: {gapSummary.gaps.join(", ")}</div>
                    ) : (
                      <div className="queue-meta">The current map already covers the obvious next concepts. Keep verifying what you know.</div>
                    )}
                    {gapSummary.pathway?.length ? (
                      <ol className="pathway-list">
                        {gapSummary.pathway.map((step) => <li key={step}>{step}</li>)}
                      </ol>
                    ) : null}
                  </div>
                ) : (
                  <div className="queue-item">
                    <h3>No gap report yet</h3>
                    <div className="queue-meta">Run analysis after a few ingested pages to get a more useful pathway.</div>
                  </div>
                )}
              </>
            ) : null}

            {rightPanel === "quiz" ? (
              <>
                <div className="workspace-panel-header">
                  <p className="panel-title">Quiz Loop</p>
                  <h2>Spaced review</h2>
                  <p className="panel-subtitle">Generate a short quiz and feed results back into confidence.</p>
                </div>
                <button className="primary-button workspace-primary-action" onClick={handleGenerateQuiz} disabled={isLoadingQuiz}>
                  {isLoadingQuiz ? "Building quiz..." : "Generate Quiz"}
                </button>
                {quizState.message ? <div className="summary-card"><h3>Quiz status</h3><div className="queue-meta">{quizState.message}</div></div> : null}
                {quizState.quiz?.length ? (
                  <>
                    <div className="quiz-list workspace-list-large">
                      {quizState.quiz.map((question, index) => (
                        <div key={question.id} className="quiz-card">
                          <h3>{index + 1}. {question.q}</h3>
                          <div className="quiz-meta">Concept: {question.concept}</div>
                          {question.options.map((option, optionIndex) => (
                            <label key={`${question.id}-${optionIndex}`} className="quiz-option">
                              <input
                                type="radio"
                                name={question.id}
                                checked={quizAnswers[question.id] === optionIndex}
                                onChange={() => setQuizAnswers((current) => ({ ...current, [question.id]: optionIndex }))}
                              />
                              <span>{option}</span>
                            </label>
                          ))}
                        </div>
                      ))}
                    </div>
                    <div className="quiz-actions">
                      <button className="primary-button" onClick={handleSubmitQuiz}>Check Quiz And Update Confidence</button>
                      <button className="ghost-button" onClick={handleGenerateQuiz} disabled={isLoadingQuiz}>Refresh Quiz</button>
                    </div>
                    {quizResult ? (
                      <div className="summary-card">
                        <h3>Quiz complete</h3>
                        <div className="queue-meta">
                          {quizResult.correctCount} of {quizResult.answeredCount} answered concepts were correct.
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="queue-item">
                    <h3>No quiz loaded</h3>
                    <div className="queue-meta">Generate a quiz to turn this graph into a feedback loop instead of a static picture.</div>
                  </div>
                )}
              </>
            ) : null}

            {rightPanel === "inspector" ? (
              <>
            <p className="panel-title">Inspector</p>
            {selectedNode ? (
              <>
                <div className="inspector-header">
                  <span className="type-pill">{selectedNode.type}</span>
                  <h2 style={{ margin: 0 }}>{selectedNode.label}</h2>
                  <p className="panel-subtitle">
                    {selectedNode.description || selectedNode.whyThisExists || "This node came from your session and can be manually reviewed from here."}
                  </p>
                </div>
                <div className="confidence-row">
                  <span className="muted-copy">Confidence</span>
                  <div className="confidence-bar">
                    <div className="confidence-fill" style={{ width: `${Math.round((selectedNode.confidence ?? 0) * 100)}%` }} />
                  </div>
                  <strong>{Math.round((selectedNode.confidence ?? 0) * 100)}%</strong>
                </div>
                <div className="metadata-grid">
                  <div>
                    <strong>Created</strong>
                    <span>{selectedNode.createdAt ? new Date(selectedNode.createdAt).toLocaleDateString() : "Unknown"}</span>
                  </div>
                  <div>
                    <strong>Evidence</strong>
                    <span>{selectedNode.evidenceCount ?? selectedNode.sources?.length ?? 0} sources</span>
                  </div>
                  <div>
                    <strong>Mastery</strong>
                    <span>{selectedNode.masteryState || "new"}</span>
                  </div>
                  <div>
                    <strong>Incoming</strong>
                    <span>{selectedNodeConnections.upstream.length}</span>
                  </div>
                  <div>
                    <strong>Next Review</strong>
                    <span>{describeReviewDate(selectedNode.nextReviewAt)}</span>
                  </div>
                </div>
                <div className="summary-card">
                  <h3>Why this exists</h3>
                  <div className="queue-meta">{selectedNode.whyThisExists}</div>
                </div>
                <div className="summary-card">
                  <h3>Clean Up This Node</h3>
                  <div className="queue-meta">Fix classifier labels, add your own summary, or mark mastery after review. Edits stay local and are recorded in the timeline.</div>
                  <div className="import-form">
                    <input
                      className="text-input"
                      value={nodeEditForm.label}
                      onChange={(event) => setNodeEditForm((current) => ({ ...current, label: event.target.value }))}
                      placeholder="Node label"
                    />
                    <textarea
                      className="text-area compact-area"
                      value={nodeEditForm.description}
                      onChange={(event) => setNodeEditForm((current) => ({ ...current, description: event.target.value }))}
                      placeholder="Short description or correction"
                    />
                    <textarea
                      className="text-area compact-area"
                      value={nodeEditForm.summary}
                      onChange={(event) => setNodeEditForm((current) => ({ ...current, summary: event.target.value }))}
                      placeholder="What this concept means in your own words"
                    />
                    <SelectControl
                      value={nodeEditForm.masteryState}
                      onChange={(value) => setNodeEditForm((current) => ({ ...current, masteryState: value }))}
                      options={MASTERY_OPTIONS}
                      ariaLabel="Mastery state"
                    />
                    <button className="secondary-button" type="button" disabled={isSavingNode || !nodeEditForm.label.trim()} onClick={handleSaveNodeEdits}>
                      {isSavingNode ? "Saving..." : "Save Node Edits"}
                    </button>
                  </div>
                  <div className="merge-box">
                    <div>
                      <strong>Merge duplicate</strong>
                      <span>Use this when two {selectedNode.type} nodes describe the same thing. The current node is hidden from this session after merge.</span>
                    </div>
                    <div className="import-form">
                      <SelectControl
                        value={mergeTargetId}
                        onChange={setMergeTargetId}
                        options={[
                          { value: "", label: "Merge into..." },
                          ...mergeCandidateNodes.map((node) => ({ value: node.id, label: node.label }))
                        ]}
                        ariaLabel="Merge target"
                      />
                      <button className="danger-button" type="button" disabled={isMergingNode || !mergeTargetId} onClick={handleMergeNode}>
                        {isMergingNode ? "Merging..." : "Merge Into Target"}
                      </button>
                    </div>
                  </div>
                </div>
                <div className="inspector-actions">
                  <button className="primary-button" disabled={isReviewing} onClick={() => handleReview(selectedNode.id, "approve")}>Approve Node</button>
                  <button className="danger-button" disabled={isReviewing} onClick={() => handleReview(selectedNode.id, "reject")}>Reject Node</button>
                  <button className="ghost-button" disabled={isLearningMore} onClick={handleLearnMore}>
                    {isLearningMore ? "Generating..." : "Explain This"}
                  </button>
                </div>
                {learnMoreCopy ? <div className="learn-more-copy">{learnMoreCopy}</div> : null}
                <div className="summary-card">
                  <h3>Relationships</h3>
                  <div className="relationship-list">
                    {[...selectedNodeConnections.upstream, ...selectedNodeConnections.downstream].length ? [...selectedNodeConnections.upstream, ...selectedNodeConnections.downstream].map((entry) => (
                      <div key={`${entry.key}-${entry.node.id}`} className="relationship-item">
                        <div>
                          <strong>{entry.node.label}</strong>
                          <span>{entry.type} • {entry.label}</span>
                        </div>
                        {entry.key ? (
                          <div className="queue-actions">
                            <button className="small-button is-approve" onClick={() => handleEdgeReview(entry.key, "approve")}>Approve Edge</button>
                            <button className="small-button is-reject" onClick={() => handleEdgeReview(entry.key, "reject")}>Reject Edge</button>
                          </div>
                        ) : null}
                      </div>
                    )) : <div className="queue-meta">No visible relationships beyond the current hierarchy.</div>}
                  </div>
                  <div className="import-form">
                    <SelectControl
                      value={relationshipForm.targetId}
                      onChange={(value) => setRelationshipForm((current) => ({ ...current, targetId: value }))}
                      options={[
                        { value: "", label: "Connect to..." },
                        ...(graphState?.nodes ?? [])
                          .filter((node) => node.id !== selectedNode.id && visibleNodeTypes.includes(node.type))
                          .map((node) => ({ value: node.id, label: node.label }))
                      ]}
                      ariaLabel="Relationship target"
                    />
                    <SelectControl
                      value={relationshipForm.type}
                      onChange={(value) => setRelationshipForm((current) => ({ ...current, type: value }))}
                      options={RELATIONSHIP_TYPE_OPTIONS}
                      ariaLabel="Relationship type"
                    />
                    <input className="text-input" placeholder="Optional relationship label" value={relationshipForm.label} onChange={(event) => setRelationshipForm((current) => ({ ...current, label: event.target.value }))} />
                    <button className="secondary-button" disabled={isSavingRelationship || !relationshipForm.targetId} onClick={handleSaveRelationship}>
                      {isSavingRelationship ? "Saving..." : "Add Relationship"}
                    </button>
                  </div>
                </div>
                <div className="summary-card">
                  <h3>Concept Bridge</h3>
                  <div className="queue-meta">Find how this node connects to another part of the graph.</div>
                  <div className="import-form">
                    <SelectControl
                      value={intersectionTargetId}
                      onChange={setIntersectionTargetId}
                      options={[
                        { value: "", label: "Compare with..." },
                        ...(graphState?.nodes ?? [])
                          .filter((node) => node.id !== selectedNode.id && visibleNodeTypes.includes(node.type))
                          .map((node) => ({ value: node.id, label: node.label }))
                      ]}
                      ariaLabel="Bridge comparison target"
                    />
                    <button className="secondary-button" disabled={isIntersecting || !intersectionTargetId} onClick={handleIntersect}>
                      {isIntersecting ? "Finding bridge..." : "Find Bridge"}
                    </button>
                  </div>
                  {intersectionResult ? (
                    <div className="learn-more-copy">
                      {intersectionResult.reasoning || "Bridge generated."}
                      {intersectionResult.bridge_concepts?.length ? `\n\nBridge concepts: ${intersectionResult.bridge_concepts.join(", ")}` : ""}
                    </div>
                  ) : null}
                </div>
                <div className="summary-card">
                  <h3>Activity Timeline</h3>
                  <div className="timeline-list">
                    {selectedNode.history?.length ? selectedNode.history.map((event) => (
                      <div key={`${event.kind}-${event.createdAt}-${event.summary}`} className="timeline-item">
                        <strong>{event.summary}</strong>
                        <span>{formatTimestamp(event.createdAt)}</span>
                      </div>
                    )) : <div className="queue-meta">No activity has been recorded for this node yet.</div>}
                  </div>
                </div>
                <div className="evidence-list">
                  {selectedNode.sources?.length ? selectedNode.sources.map((source) => (
                    <div key={`${source.artifactId ?? source.url}-${source.sessionId}`} className="evidence-item">
                      <a className="evidence-link" href={source.url} target="_blank" rel="noreferrer">
                        <strong>{source.title}</strong>
                        <div className="muted-copy">{formatSourceTypeLabel(source.sourceType)} • {source.url}</div>
                      </a>
                      {source.artifactId ? (
                        <button className="small-button is-reject" type="button" disabled={isDeletingArtifact} onClick={() => handleDeleteArtifact(source.artifactId)}>
                          Remove Source
                        </button>
                      ) : null}
                    </div>
                  )) : <div className="queue-item"><h3>No evidence yet</h3><div className="queue-meta">This node exists in the graph, but no direct source evidence has been attached yet.</div></div>}
                </div>
              </>
            ) : (
              <div className="inspector-empty">
                <div>
                  <h2>Select a node</h2>
                  <p className="panel-subtitle">Pick a node in the graph or the review queue to inspect it here.</p>
                </div>
              </div>
            )}
              </>
            ) : null}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
