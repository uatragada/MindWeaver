import { startTransition, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import SelectControl from "./components/controls/SelectControl.jsx";
import GraphMiniMap from "./components/graph/GraphMiniMap.jsx";
import MarkdownNotePreview from "./components/notes/MarkdownNotePreview.js";
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
  GRAPH_COLOR_MODE_OPTIONS,
  GRAPH_FOCUS_DEPTH_OPTIONS,
  GRAPH_FOCUS_MODE_OPTIONS,
  GRAPH_VIEW_PRESET_OPTIONS,
  LLM_PROVIDER_OPTIONS,
  LOCAL_LLM_MODEL_OPTIONS,
  MASTERY_OPTIONS,
  NODE_TYPE_OPTIONS,
  RELATIONSHIP_TYPE_OPTIONS,
  RIGHT_PANEL_LABELS,
  SEMANTIC_ROLE_OPTIONS,
  SOURCE_TYPE_OPTIONS,
  TAB_VIEW_STORAGE_KEY,
  visibleNodeTypes
} from "./lib/app-constants.js";
import { getChatHistoryImportPreview } from "./lib/chat-import-preview.js";
import {
  drawArrowHead,
  createNodeCollisionForce,
  drawRoundedRect,
  getChargeStrength,
  getLinkDistance,
  getLinkVisualStyle,
  getNodeFont,
  getNodeMetrics,
  getNodeRenderDetail,
  getBranchVisualStyle,
  getNodeVisualStyle,
  NODE_HIERARCHY_LEVELS,
  NODE_TYPE_LEGEND,
  withAlpha
} from "./lib/graph-rendering.js";
import {
  buildDomainMembership,
  buildGraphIndex,
  collectCollapsedNodeIds,
  collectReachableSubgraph,
  getAncestorAtLevel,
  getBranchColorKey,
  getHierarchyPath,
  getSortedConnectedNodes,
  isHierarchyLinkType,
  UNGROUPED_DOMAIN_ID
} from "./lib/graph-view.js";
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

const SEMANTIC_ROLE_VALUES = SEMANTIC_ROLE_OPTIONS.map((option) => option.value);

function areStringArraysEqual(left, right) {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export default function App() {
  const [sessionId, navigateToSession] = useSessionRoute();
  const fgRef = useRef(null);
  const graphContainerRef = useRef(null);
  const nodeNoteTextareaRef = useRef(null);
  const rightRailRef = useRef(null);
  const tabViewHydrationRef = useRef(null);
  const sessionCacheHydrationRef = useRef(null);
  const graphFitTimersRef = useRef([]);
  const pendingGraphFitRef = useRef(false);
  const lastCompletedViewportFitKeyRef = useRef("");

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
  const [selectedNodeIds, setSelectedNodeIds] = useState([]);
  const [rightPanel, setRightPanel] = useState("inspector");
  const [leftRailMinimized, setLeftRailMinimized] = useState(false);
  const [rightRailMinimized, setRightRailMinimized] = useState(true);
  const [mapTabsCollapsed, setMapTabsCollapsed] = useState(false);
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
  const [quickAddNodeType, setQuickAddNodeType] = useState("area");
  const [mapNameDraft, setMapNameDraft] = useState("");
  const [goalNodeDraft, setGoalNodeDraft] = useState("");
  const [graphSize, setGraphSize] = useState({ width: 900, height: 640 });
  const [graphViewport, setGraphViewport] = useState({ centerX: 0, centerY: 0, zoom: 1 });
  const [nodeSearch, setNodeSearch] = useState("");
  const [nodeTypeFilter, setNodeTypeFilter] = useState("all");
  const [graphColorMode, setGraphColorMode] = useState(DEFAULT_TAB_VIEW.graphColorMode);
  const [graphPreset, setGraphPreset] = useState(DEFAULT_TAB_VIEW.graphPreset);
  const [focusMode, setFocusMode] = useState(DEFAULT_TAB_VIEW.focusMode);
  const [focusDepth, setFocusDepth] = useState(DEFAULT_TAB_VIEW.focusDepth);
  const [hideUnrelated, setHideUnrelated] = useState(DEFAULT_TAB_VIEW.hideUnrelated);
  const [collapsedNodeIds, setCollapsedNodeIds] = useState(DEFAULT_TAB_VIEW.collapsedNodeIds);
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
  const [nodeEditForm, setNodeEditForm] = useState({
    label: "",
    description: "",
    summary: "",
    masteryState: "new",
    primaryRole: "concept",
    secondaryRoles: []
  });
  const [isSavingNode, setIsSavingNode] = useState(false);
  const [nodeNoteDraft, setNodeNoteDraft] = useState("");
  const [isNodeNoteEditorOpen, setIsNodeNoteEditorOpen] = useState(false);
  const [nodeNoteEditorMode, setNodeNoteEditorMode] = useState("edit");
  const [isNodeNoteFullscreen, setIsNodeNoteFullscreen] = useState(false);
  const [isSavingNodeNote, setIsSavingNodeNote] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [isMergingNode, setIsMergingNode] = useState(false);
  const [isRestoringBackup, setIsRestoringBackup] = useState(false);
  const [isDeletingArtifact, setIsDeletingArtifact] = useState(false);
  const [isGraphViewportReady, setIsGraphViewportReady] = useState(false);
  const [pinnedNodePositions, setPinnedNodePositions] = useState({});
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

  const clearGraphSelection = useCallback(() => {
    setSelectedNodeId(null);
    setSelectedNodeIds([]);
    setIntersectionTargetId("");
    setIntersectionResult(null);
  }, []);

  const selectGraphNode = useCallback((nextNodeId, { additive = false } = {}) => {
    let nextSelectedNodeId = nextNodeId ? String(nextNodeId) : null;
    let nextSelectedNodeIds = nextSelectedNodeId ? [nextSelectedNodeId] : [];

    setSelectedNodeIds((current) => {
      const normalizedCurrent = [...new Set((Array.isArray(current) ? current : []).filter(Boolean))];
      if (!additive) {
        nextSelectedNodeIds = nextSelectedNodeId ? [nextSelectedNodeId] : [];
        return nextSelectedNodeIds;
      }

      if (!nextSelectedNodeId) {
        nextSelectedNodeIds = [];
        return nextSelectedNodeIds;
      }

      if (normalizedCurrent.includes(nextSelectedNodeId)) {
        nextSelectedNodeIds = normalizedCurrent.filter((nodeId) => nodeId !== nextSelectedNodeId);
        nextSelectedNodeId = nextSelectedNodeIds[nextSelectedNodeIds.length - 1] ?? null;
        return nextSelectedNodeIds;
      }

      nextSelectedNodeIds = [...normalizedCurrent, nextSelectedNodeId];
      return nextSelectedNodeIds;
    });

    setSelectedNodeId(nextSelectedNodeId);
    setIntersectionTargetId("");
    setIntersectionResult(null);
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
      setSelectedNodeIds(DEFAULT_TAB_VIEW.selectedNodeIds);
      setRightPanel(DEFAULT_TAB_VIEW.rightPanel);
      setLeftRailMinimized(DEFAULT_TAB_VIEW.leftRailMinimized);
      setRightRailMinimized(DEFAULT_TAB_VIEW.rightRailMinimized);
      setNodeSearch(DEFAULT_TAB_VIEW.nodeSearch);
      setNodeTypeFilter(DEFAULT_TAB_VIEW.nodeTypeFilter);
      setGraphColorMode(DEFAULT_TAB_VIEW.graphColorMode);
      setGraphPreset(DEFAULT_TAB_VIEW.graphPreset);
      setFocusMode(DEFAULT_TAB_VIEW.focusMode);
      setFocusDepth(DEFAULT_TAB_VIEW.focusDepth);
      setHideUnrelated(DEFAULT_TAB_VIEW.hideUnrelated);
      setCollapsedNodeIds(DEFAULT_TAB_VIEW.collapsedNodeIds);
      setChatImportPrompt("");
      setChatImportJson("");
      setChatImportErrorMessage("");
      setQuickAddNodeType("area");
      setGoalNodeDraft("");
      setIsGraphViewportReady(false);
      setGraphViewport({ centerX: 0, centerY: 0, zoom: 1 });
      setPinnedNodePositions({});
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
    setSelectedNodeIds(Array.isArray(cachedTabView.selectedNodeIds) ? cachedTabView.selectedNodeIds : DEFAULT_TAB_VIEW.selectedNodeIds);
    setRightPanel(cachedTabView.rightPanel ?? DEFAULT_TAB_VIEW.rightPanel);
    setLeftRailMinimized(cachedTabView.leftRailMinimized ?? DEFAULT_TAB_VIEW.leftRailMinimized);
    setRightRailMinimized(cachedTabView.rightRailMinimized ?? DEFAULT_TAB_VIEW.rightRailMinimized);
    setNodeSearch(cachedTabView.nodeSearch ?? DEFAULT_TAB_VIEW.nodeSearch);
    setNodeTypeFilter(cachedTabView.nodeTypeFilter ?? DEFAULT_TAB_VIEW.nodeTypeFilter);
    setGraphColorMode(cachedTabView.graphColorMode ?? DEFAULT_TAB_VIEW.graphColorMode);
    setGraphPreset(cachedTabView.graphPreset ?? DEFAULT_TAB_VIEW.graphPreset);
    setFocusMode(cachedTabView.focusMode ?? DEFAULT_TAB_VIEW.focusMode);
    setFocusDepth(cachedTabView.focusDepth ?? DEFAULT_TAB_VIEW.focusDepth);
    setHideUnrelated(cachedTabView.hideUnrelated ?? DEFAULT_TAB_VIEW.hideUnrelated);
    setCollapsedNodeIds(Array.isArray(cachedTabView.collapsedNodeIds) ? cachedTabView.collapsedNodeIds : DEFAULT_TAB_VIEW.collapsedNodeIds);
    setChatImportPrompt("");
    setChatImportJson("");
    setChatImportErrorMessage("");
    setGraphViewport({ centerX: 0, centerY: 0, zoom: 1 });
    setPinnedNodePositions({});
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
        selectedNodeIds,
        rightPanel,
        leftRailMinimized,
        rightRailMinimized,
        nodeSearch,
        nodeTypeFilter,
        graphColorMode,
        graphPreset,
        focusMode,
        focusDepth,
        hideUnrelated,
        collapsedNodeIds
      }
    }));
  }, [
    collapsedNodeIds,
    focusDepth,
    focusMode,
    graphColorMode,
    graphPreset,
    hideUnrelated,
    leftRailMinimized,
    nodeSearch,
    nodeTypeFilter,
    rightPanel,
    rightRailMinimized,
    selectedNodeId,
    selectedNodeIds,
    sessionId,
    setTabViewState
  ]);

  useEffect(() => {
    setSelectedNodeIds((current) => {
      const normalizedCurrent = [...new Set((Array.isArray(current) ? current : []).filter(Boolean))];
      if (!selectedNodeId) {
        return normalizedCurrent.length ? [] : normalizedCurrent;
      }
      if (!normalizedCurrent.length) return [selectedNodeId];
      if (normalizedCurrent.includes(selectedNodeId)) return normalizedCurrent;
      return [selectedNodeId];
    });
  }, [selectedNodeId]);

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
      const visibleGraphNodeIds = new Set((data.nodes ?? [])
        .filter((node) => visibleNodeTypes.includes(node.type))
        .map((node) => node.id));
      const firstVisibleNodeId = data.reviewQueue?.find((node) => visibleGraphNodeIds.has(node.id))?.id
        ?? (data.nodes ?? []).find((node) => visibleGraphNodeIds.has(node.id))?.id
        ?? null;
      setSelectedNodeId((current) => {
        if (!current) return firstVisibleNodeId;
        return visibleGraphNodeIds.has(current) ? current : firstVisibleNodeId;
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
  const graphIndex = useMemo(() => buildGraphIndex(graphState), [graphState]);
  const domainMembership = useMemo(() => buildDomainMembership(graphIndex), [graphIndex]);
  const selectedNodeIdList = useMemo(
    () => [...new Set((Array.isArray(selectedNodeIds) ? selectedNodeIds : []).filter((nodeId) => graphIndex.nodesById.has(nodeId)))],
    [graphIndex, selectedNodeIds]
  );
  const selectedNodeIdSet = useMemo(() => new Set(selectedNodeIdList), [selectedNodeIdList]);
  const selectedGroupNodes = useMemo(
    () => selectedNodeIdList.map((nodeId) => graphIndex.nodesById.get(nodeId)).filter(Boolean),
    [graphIndex, selectedNodeIdList]
  );
  const focusTraversal = useMemo(() => {
    if (!selectedNodeId || focusMode === "none") {
      return { nodeIds: new Set(), edgeKeys: new Set(), depthByNodeId: new Map() };
    }

    return collectReachableSubgraph(graphIndex, selectedNodeId, {
      direction: focusMode,
      maxDepth: focusDepth === "neighbors" ? 1 : Number.POSITIVE_INFINITY
    });
  }, [focusDepth, focusMode, graphIndex, selectedNodeId]);
  const collapsedState = useMemo(
    () => collectCollapsedNodeIds(graphIndex, collapsedNodeIds),
    [collapsedNodeIds, graphIndex]
  );
  const pathToRoot = useMemo(
    () => getHierarchyPath(graphIndex, selectedNodeId, ["goal", "area", "domain"]),
    [graphIndex, selectedNodeId]
  );
  const pathToDomain = useMemo(
    () => getHierarchyPath(graphIndex, selectedNodeId, ["domain"]),
    [graphIndex, selectedNodeId]
  );
  const breadcrumbNodes = useMemo(
    () => pathToRoot.nodeIds.map((nodeId) => graphIndex.nodesById.get(nodeId)).filter(Boolean),
    [graphIndex, pathToRoot]
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
    if (!graphState) return;

    const validNodeIds = new Set((graphState.nodes ?? []).map((node) => node.id));
    setSelectedNodeIds((current) => {
      const next = current.filter((nodeId) => validNodeIds.has(nodeId));
      return areStringArraysEqual(current, next) ? current : next;
    });
    setCollapsedNodeIds((current) => {
      const next = current.filter((nodeId) => validNodeIds.has(nodeId));
      return areStringArraysEqual(current, next) ? current : next;
    });
    setPinnedNodePositions((current) => {
      const nextEntries = Object.entries(current).filter(([nodeId]) => validNodeIds.has(nodeId));
      return nextEntries.length === Object.keys(current).length ? current : Object.fromEntries(nextEntries);
    });
  }, [graphState]);

  useEffect(() => {
    if (!selectedNode) return;
    setNodeEditForm({
      label: selectedNode.label || "",
      description: selectedNode.description || "",
      summary: selectedNode.summary || "",
      masteryState: selectedNode.masteryState || "new",
      primaryRole: selectedNode.primaryRole || selectedNode.type || "concept",
      secondaryRoles: Array.isArray(selectedNode.secondaryRoles) ? selectedNode.secondaryRoles : []
    });
    setMergeTargetId("");
    setIntersectionTargetId("");
    setIntersectionResult(null);
  }, [selectedNode?.id]);

  useEffect(() => {
    const nextNote = selectedNode?.note || "";
    const hasSelectedNote = Boolean(nextNote.trim());
    setNodeNoteDraft(nextNote);
    setNodeNoteEditorMode((current) => {
      if (isNodeNoteEditorOpen) {
        return current === "preview" && !hasSelectedNote ? "edit" : current;
      }
      return hasSelectedNote ? "preview" : "edit";
    });
  }, [isNodeNoteEditorOpen, selectedNode?.id, selectedNode?.note]);

  useEffect(() => {
    if (!isNodeNoteEditorOpen || nodeNoteEditorMode !== "edit") return;
    nodeNoteTextareaRef.current?.focus();
  }, [isNodeNoteEditorOpen, nodeNoteEditorMode, selectedNode?.id]);

  const nodeHierarchyById = useMemo(() => {
    if (!graphState) return new Map();

    const visibleNodes = graphState.nodes.filter((node) => visibleNodeTypes.includes(node.type));
    if (!visibleNodes.length) return new Map();

    const nodeIds = new Set(visibleNodes.map((node) => node.id));
    const outgoingById = new Map(visibleNodes.map((node) => [node.id, []]));
    const incomingCountById = new Map(visibleNodes.map((node) => [node.id, 0]));

    graphState.edges.forEach((edge) => {
      if (!isHierarchyLinkType(edge.type)) return;
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return;
      outgoingById.get(edge.source)?.push(edge.target);
      incomingCountById.set(edge.target, (incomingCountById.get(edge.target) ?? 0) + 1);
    });

    let rootIds = visibleNodes.filter((node) => ["goal", "area"].includes(node.type)).map((node) => node.id);
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
        const fallbackDepth = NODE_HIERARCHY_LEVELS[node.type] ?? 5;
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

  const pathNodeIds = useMemo(
    () => new Set([...pathToRoot.nodeIds, ...pathToDomain.nodeIds]),
    [pathToDomain, pathToRoot]
  );
  const pathEdgeKeys = useMemo(
    () => new Set([...pathToRoot.edgeKeys, ...pathToDomain.edgeKeys]),
    [pathToDomain, pathToRoot]
  );
  const reviewNodeIds = useMemo(
    () => new Set((graphState?.reviewQueue ?? []).map((node) => node.id)),
    [graphState?.reviewQueue]
  );
  const focusIsActive = Boolean(selectedNodeId && focusMode !== "none");
  const highlightedNodeIds = useMemo(
    () => new Set([...selectedNodeIdSet, ...focusTraversal.nodeIds, ...pathNodeIds]),
    [focusTraversal, pathNodeIds, selectedNodeIdSet]
  );
  const highlightedEdgeKeys = useMemo(
    () => new Set([...focusTraversal.edgeKeys, ...pathEdgeKeys]),
    [focusTraversal, pathEdgeKeys]
  );
  const selectionVisibilitySignature = useMemo(() => {
    if (!focusIsActive || !hideUnrelated) return "";
    return [...new Set([
      ...focusTraversal.nodeIds,
      ...selectedNodeIdSet,
      ...pathNodeIds
    ])]
      .sort()
      .join("|");
  }, [focusIsActive, focusTraversal, hideUnrelated, pathNodeIds, selectedNodeIdSet]);

  const graphData = useMemo(() => {
    if (!graphState) {
      return {
        nodes: [],
        links: [],
        domainGroups: []
      };
    }

    const query = deferredNodeSearch.trim().toLowerCase();
    const persistedNodeStateById = new Map(
      ((fgRef.current?.graphData?.().nodes) ?? [])
        .filter((node) => node?.id)
        .map((node) => [
          node.id,
          {
            ...(Number.isFinite(node.x) ? { x: node.x } : {}),
            ...(Number.isFinite(node.y) ? { y: node.y } : {}),
            ...(Number.isFinite(node.vx) ? { vx: node.vx } : {}),
            ...(Number.isFinite(node.vy) ? { vy: node.vy } : {}),
            ...(Number.isFinite(node.fx) ? { fx: node.fx } : {}),
            ...(Number.isFinite(node.fy) ? { fy: node.fy } : {})
          }
        ])
    );
    const visibleFocusNodeIds = selectionVisibilitySignature
      ? new Set(selectionVisibilitySignature.split("|").filter(Boolean))
      : null;
    const nodes = graphState.nodes
      .filter((node) => {
        if (!visibleNodeTypes.includes(node.type)) return false;
        if (nodeTypeFilter !== "all" && node.type !== nodeTypeFilter) return false;
        if (query && !node.label.toLowerCase().includes(query)) return false;
        if (collapsedState.hiddenNodeIds.has(node.id)) return false;
        if (visibleFocusNodeIds && !visibleFocusNodeIds.has(node.id)) return false;
        return true;
      })
      .map((node) => {
        const branchColorKey = graphColorMode === "type" ? null : getBranchColorKey(graphIndex, node.id, graphColorMode);
        const branchAncestor = graphColorMode === "type" ? null : getAncestorAtLevel(graphIndex, node.id, graphColorMode);
        const branchStyle = graphColorMode === "type" ? null : getBranchVisualStyle(branchColorKey);
        const persistedNodeState = persistedNodeStateById.get(node.id) ?? null;
        return {
          ...node,
          ...(persistedNodeState ?? {}),
          domainId: domainMembership.domainIdByNodeId.get(node.id) ?? (["goal", "area"].includes(node.type) ? null : UNGROUPED_DOMAIN_ID),
          domainLabel: node.type === "goal"
            ? "Goals"
            : node.type === "area"
              ? "Areas"
              : domainMembership.groups.get(domainMembership.domainIdByNodeId.get(node.id) ?? UNGROUPED_DOMAIN_ID)?.label ?? "Ungrouped",
          branchColorKey,
          branchAncestorLabel: branchAncestor?.label ?? null,
          colorOverrideFill: branchStyle?.fill,
          colorOverrideStroke: branchStyle?.stroke,
          colorOverrideShadowColor: branchStyle?.shadowColor,
          colorOverrideSelectedStroke: branchStyle ? withAlpha("#ffffff", 0.98) : undefined,
          collapsedDescendantCount: collapsedState.hiddenCountsByNodeId.get(node.id) ?? 0,
          ...(nodeHierarchyById.get(node.id) ?? {
            hierarchyDepth: NODE_HIERARCHY_LEVELS[node.type] ?? 5,
            hierarchyScale: 1,
            hierarchyInDegree: 0,
            hierarchyOutDegree: 0
          }),
          ...(Number.isFinite(pinnedNodePositions[node.id]?.x) && Number.isFinite(pinnedNodePositions[node.id]?.y)
            ? {
                fx: pinnedNodePositions[node.id].x,
                fy: pinnedNodePositions[node.id].y
              }
            : {})
        };
      })
      .sort((left, right) => (NODE_HIERARCHY_LEVELS[left.type] ?? 99) - (NODE_HIERARCHY_LEVELS[right.type] ?? 99)
        || left.label.localeCompare(right.label));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const links = graphState.edges
      .map((edge) => ({
        ...edge,
        sourceId: typeof edge.source === "object" ? edge.source.id : edge.source,
        targetId: typeof edge.target === "object" ? edge.target.id : edge.target
      }))
      .filter((edge) => nodeIds.has(edge.sourceId) && nodeIds.has(edge.targetId))
      .map((edge) => ({
        ...edge,
        source: edge.sourceId,
        target: edge.targetId
      }));
    const domainGroups = Array.from(
      nodes.reduce((groups, node) => {
        if (!node.domainId) return groups;
        const domainNode = nodes.find((entry) => entry.id === node.domainId) ?? graphIndex.nodesById.get(node.domainId) ?? null;
        const visualNode = domainNode ?? { type: node.type };
        const style = getNodeVisualStyle(visualNode);
          const group = groups.get(node.domainId) ?? {
            id: node.domainId,
            label: node.domainLabel,
            fill: style.fill,
            stroke: style.stroke,
            nodes: []
          };

          group.nodes.push(node);
          groups.set(node.domainId, group);
          return groups;
        }, new Map()).values()
    ).filter((group) => group.nodes.length > 1);

    return {
      nodes,
      links,
      domainGroups
    };
  }, [
    collapsedState,
    deferredNodeSearch,
    domainMembership,
    graphColorMode,
    graphIndex,
    graphState,
    nodeHierarchyById,
    nodeTypeFilter,
    pinnedNodePositions,
    selectionVisibilitySignature
  ]);
  const graphTopologySignature = useMemo(() => {
    if (!graphData.nodes.length) return "empty";

    const nodeIds = graphData.nodes
      .map((node) => `${String(node.id)}:${String(node.type)}:${Number.isFinite(node.hierarchyDepth) ? node.hierarchyDepth : ""}`)
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
  const graphViewportFitKey = `${sessionId ?? "none"}:${graphTopologySignature}`;

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

  const syncGraphViewport = useCallback(() => {
    if (!fgRef.current) return;
    const center = fgRef.current.centerAt();
    const zoom = fgRef.current.zoom();
    setGraphViewport({
      centerX: center.x,
      centerY: center.y,
      zoom
    });
  }, []);

  const fitGraphToViewport = useCallback((duration = 260) => {
    if (!fgRef.current || !graphData.nodes.length) return;
    const fitPadding = Math.max(104, Math.min(188, Math.round(graphSize.height * 0.26)));
    fgRef.current.zoomToFit(duration, fitPadding);
  }, [graphData.nodes.length, graphSize.height]);

  const finalizeGraphViewport = useCallback((duration = 260) => {
    fitGraphToViewport(duration);
    lastCompletedViewportFitKeyRef.current = graphViewportFitKey;
    setIsGraphViewportReady(true);
  }, [fitGraphToViewport, graphViewportFitKey]);

  useEffect(() => {
    if (!fgRef.current || !graphData.nodes.length) {
      pendingGraphFitRef.current = false;
      lastCompletedViewportFitKeyRef.current = graphViewportFitKey;
      setIsGraphViewportReady(graphData.nodes.length === 0);
      return;
    }

    const collisionIterations = graphData.nodes.length >= 96 ? 1 : 2;
    lastCompletedViewportFitKeyRef.current = "";
    setIsGraphViewportReady(false);
    fgRef.current.d3Force("nodeCollision", createNodeCollisionForce({ iterations: collisionIterations }));
    fgRef.current.d3Force("charge").strength(getChargeStrength(graphData.nodes.length));
    fgRef.current.d3Force("link").distance(getLinkDistance);
    pendingGraphFitRef.current = true;
    fgRef.current.d3ReheatSimulation();
  }, [graphData.nodes.length, graphViewportFitKey]);

  useEffect(() => {
    if (!graphData.nodes.length) return;
    if (lastCompletedViewportFitKeyRef.current === graphViewportFitKey) return;

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
  }, [finalizeGraphViewport, graphData.nodes.length, graphViewportFitKey]);

  useEffect(() => {
    if (!graphData.nodes.length) return;

    const fallbackTimer = window.setTimeout(() => {
      if (!pendingGraphFitRef.current) return;
      pendingGraphFitRef.current = false;
      finalizeGraphViewport(440);
    }, 1400);

    return () => window.clearTimeout(fallbackTimer);
  }, [finalizeGraphViewport, graphData.nodes.length, graphViewportFitKey]);

  const handleGraphEngineStop = useCallback(() => {
    if (!pendingGraphFitRef.current) {
      syncGraphViewport();
      return;
    }
    pendingGraphFitRef.current = false;
    finalizeGraphViewport(400);
  }, [finalizeGraphViewport, syncGraphViewport]);

  const selectedNodeConnections = useMemo(() => {
    if (!selectedNode) return { upstream: [], downstream: [] };

    const resolveNode = (nodeId) => graphIndex.nodesById.get(nodeId) ?? null;

    return {
      upstream: (graphIndex.incomingEdgesById.get(selectedNode.id) ?? [])
        .map((edge) => ({
          node: resolveNode(edge.sourceId),
          label: edge.label,
          type: edge.type,
          key: edge.key
        }))
        .filter((entry) => entry.node && visibleNodeTypes.includes(entry.node.type))
        .sort((left, right) => left.node.label.localeCompare(right.node.label)),
      downstream: (graphIndex.outgoingEdgesById.get(selectedNode.id) ?? [])
        .map((edge) => ({
          node: resolveNode(edge.targetId),
          label: edge.label,
          type: edge.type,
          key: edge.key
        }))
        .filter((entry) => entry.node && visibleNodeTypes.includes(entry.node.type))
        .sort((left, right) => left.node.label.localeCompare(right.node.label))
    };
  }, [graphIndex, selectedNode]);
  const selectedDomainNode = useMemo(() => {
    if (!selectedNode) return null;
    const domainId = domainMembership.domainIdByNodeId.get(selectedNode.id);
    if (!domainId || domainId === UNGROUPED_DOMAIN_ID) return null;
    return graphIndex.nodesById.get(domainId) ?? null;
  }, [domainMembership, graphIndex, selectedNode]);
  const selectedHierarchyTraversal = useMemo(() => {
    if (!selectedNode) return { nodeIds: new Set(), edgeKeys: new Set(), depthByNodeId: new Map() };
    return collectReachableSubgraph(graphIndex, selectedNode.id, {
      direction: "downstream",
      edgeFilter: (edge) => isHierarchyLinkType(edge.type)
    });
  }, [graphIndex, selectedNode]);
  const selectedDescendantCount = Math.max(0, selectedHierarchyTraversal.nodeIds.size - 1);
  const selectedBranchNodeIds = useMemo(() => [...new Set([
    ...selectedHierarchyTraversal.nodeIds,
    ...focusTraversal.nodeIds,
    ...selectedNodeIdSet,
    ...pathNodeIds
  ])], [focusTraversal, pathNodeIds, selectedHierarchyTraversal, selectedNodeIdSet]);
  const isSelectedBranchPinned = useMemo(
    () => selectedBranchNodeIds.length > 0 && selectedBranchNodeIds.every((nodeId) => pinnedNodePositions[nodeId]),
    [pinnedNodePositions, selectedBranchNodeIds]
  );
  const whyThisHereSummary = useMemo(() => {
    if (!selectedNode) return null;

    return {
      domainLabel: selectedDomainNode?.label ?? (selectedNode.type === "goal" ? "Goals" : selectedNode.type === "area" ? "Areas" : "Ungrouped"),
      breadcrumb: breadcrumbNodes.map((node) => node.label).join(" -> "),
      sourceCount: selectedNode.evidenceCount ?? selectedNode.sources?.length ?? 0,
      upstreamLabels: selectedNodeConnections.upstream.slice(0, 4).map((entry) => entry.node.label),
      downstreamLabels: selectedNodeConnections.downstream.slice(0, 4).map((entry) => entry.node.label)
    };
  }, [breadcrumbNodes, selectedDomainNode, selectedNode, selectedNodeConnections]);
  const currentBridgeNodeIds = useMemo(
    () => (selectedNodeIdList.length > 1 ? selectedNodeIdList : [selectedNode?.id, intersectionTargetId].filter(Boolean)),
    [intersectionTargetId, selectedNode?.id, selectedNodeIdList]
  );
  const currentBridgeNodes = useMemo(
    () => currentBridgeNodeIds.map((nodeId) => graphIndex.nodesById.get(nodeId)).filter(Boolean),
    [currentBridgeNodeIds, graphIndex]
  );
  const canRunBridge = currentBridgeNodes.length >= 2;
  const isSelectedNodeCollapsed = Boolean(selectedNode && collapsedNodeIds.includes(selectedNode.id));
  const selectedNodeNote = selectedNode?.note || "";
  const hasNodeNoteChanges = nodeNoteDraft !== selectedNodeNote;
  const nodeNoteActionLabel = isNodeNoteEditorOpen
    ? "Hide Notes"
    : selectedNode?.hasNote
      ? "Open Notes"
      : "Add Note";

  const mergeCandidateNodes = useMemo(() => {
    if (!selectedNode) return [];
    const selectedEntityId = selectedNode.entityId ?? null;
    const selectedCanonicalLabel = selectedNode.canonicalLabel ?? null;
    return (graphState?.nodes ?? [])
      .filter((node) => node.id !== selectedNode.id && visibleNodeTypes.includes(node.type))
      .filter((node) =>
        node.type === selectedNode.type
        || (selectedEntityId && node.entityId === selectedEntityId)
        || (selectedCanonicalLabel && node.canonicalLabel === selectedCanonicalLabel)
      )
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [graphState, selectedNode?.canonicalLabel, selectedNode?.entityId, selectedNode?.id, selectedNode?.type]);

  const canEditSelectedNodeRoles = Boolean(
    selectedNode && SEMANTIC_ROLE_VALUES.includes(selectedNode.primaryRole || selectedNode.type)
  );

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

  const closeNodeNoteEditor = useCallback(() => {
    setIsNodeNoteEditorOpen(false);
    setIsNodeNoteFullscreen(false);
  }, []);

  useEffect(() => {
    if (!isNodeNoteFullscreen) return;

    const handleKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeNodeNoteEditor();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeNodeNoteEditor, isNodeNoteFullscreen]);

  const openNodeNoteEditor = useCallback(({ fullscreen = false } = {}) => {
    if (!selectedNode) return;

    setIsNodeNoteEditorOpen(true);
    setIsNodeNoteFullscreen(fullscreen);
    setNodeNoteEditorMode((selectedNode.note || "").trim() ? "preview" : "edit");
  }, [selectedNode]);

  const handleToggleNodeNoteEditor = useCallback(() => {
    if (!selectedNode) return;
    if (isNodeNoteEditorOpen) {
      closeNodeNoteEditor();
      return;
    }
    openNodeNoteEditor();
  }, [closeNodeNoteEditor, isNodeNoteEditorOpen, openNodeNoteEditor, selectedNode]);

  const handleOpenNodeNoteFullscreen = useCallback(() => {
    if (!selectedNode) return;
    if (isNodeNoteEditorOpen) {
      setIsNodeNoteFullscreen(true);
      return;
    }
    openNodeNoteEditor({ fullscreen: true });
  }, [isNodeNoteEditorOpen, openNodeNoteEditor, selectedNode]);

  const handleSaveNodeNote = async () => {
    if (!sessionId || !selectedNode) return;

    setIsSavingNodeNote(true);
    setErrorMessage("");

    try {
      await fetchJson(`${API_BASE}/api/nodes/${encodeURIComponent(selectedNode.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, note: nodeNoteDraft })
      });
      setStatusMessage(nodeNoteDraft.trim() ? "Note saved." : "Note cleared.");
      setNodeNoteEditorMode(nodeNoteDraft.trim() ? "preview" : "edit");
      await loadGraph();
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsSavingNodeNote(false);
    }
  };

  const renderNodeNoteEditor = (presentation = "inline") => {
    const isFullscreenPresentation = presentation === "fullscreen";

    return (
      <div className={`node-note-editor ${isFullscreenPresentation ? "is-fullscreen" : ""}`.trim()}>
        <div className="node-note-editor-toolbar">
          <button
            className={`small-button ${nodeNoteEditorMode === "edit" ? "is-active" : ""}`.trim()}
            type="button"
            onClick={() => setNodeNoteEditorMode("edit")}
          >
            Write
          </button>
          <button
            className={`small-button ${nodeNoteEditorMode === "preview" ? "is-active" : ""}`.trim()}
            type="button"
            onClick={() => setNodeNoteEditorMode("preview")}
          >
            Preview
          </button>
          {!isFullscreenPresentation ? (
            <button className="small-button" type="button" onClick={handleOpenNodeNoteFullscreen}>
              Fullscreen
            </button>
          ) : (
            <button className="small-button" type="button" onClick={() => setIsNodeNoteFullscreen(false)}>
              Exit Fullscreen
            </button>
          )}
          <span className="muted-copy">Markdown supported.</span>
        </div>
        {nodeNoteEditorMode === "edit" ? (
          <textarea
            ref={nodeNoteTextareaRef}
            className={`text-area node-note-editor-area ${isFullscreenPresentation ? "is-fullscreen" : ""}`.trim()}
            value={nodeNoteDraft}
            onChange={(event) => setNodeNoteDraft(event.target.value)}
            placeholder="Write a markdown note attached to this node in the current map..."
          />
        ) : (
          <MarkdownNotePreview
            content={nodeNoteDraft}
            emptyMessage="Nothing to preview yet."
            className={`node-note-markdown node-note-markdown-editor ${isFullscreenPresentation ? "is-fullscreen" : ""}`.trim()}
          />
        )}
        <div className="queue-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={isSavingNodeNote || !hasNodeNoteChanges}
            onClick={handleSaveNodeNote}
          >
            {isSavingNodeNote ? "Saving..." : "Save Note"}
          </button>
          <button
            className="ghost-button"
            type="button"
            disabled={isSavingNodeNote || !hasNodeNoteChanges}
            onClick={() => {
              setNodeNoteDraft(selectedNodeNote);
              setNodeNoteEditorMode(selectedNodeNote.trim() ? "preview" : "edit");
            }}
          >
            Reset
          </button>
          <button className="ghost-button" type="button" onClick={isFullscreenPresentation ? closeNodeNoteEditor : handleToggleNodeNoteEditor}>
            {isFullscreenPresentation ? "Done" : "Close"}
          </button>
        </div>
      </div>
    );
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
      selectGraphNode(mergeTargetId);
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

  const handleCreateQuickAddNode = async () => {
    if (!sessionId || !goalNodeDraft.trim()) return;

    setIsCreatingGoalNode(true);
    setErrorMessage("");

    try {
      const result = await fetchJson(`${API_BASE}/api/nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          type: quickAddNodeType,
          label: goalNodeDraft.trim()
        })
      });
      setGoalNodeDraft("");
      selectGraphNode(result.node?.id ?? null);
      openRightPanel("inspector");
      setStatusMessage(result.goalCreated
        ? "Primary goal node added to this map."
        : `${quickAddNodeType.charAt(0).toUpperCase()}${quickAddNodeType.slice(1)} node added to this map.`);
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
    const bridgeNodeIds = selectedNodeIdList.length > 1
      ? selectedNodeIdList
      : [selectedNode?.id, intersectionTargetId].filter(Boolean);
    if (bridgeNodeIds.length < 2) return;
    setIsIntersecting(true);
    setErrorMessage("");

    try {
      const result = await fetchJson(`${API_BASE}/api/intersect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withLlmSelection({ nodeIds: bridgeNodeIds }))
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

  const openRightPanel = useCallback((panel, { reveal = true } = {}) => {
    setRightPanel(panel);
    setRightRailMinimized(false);
    if (reveal && rightRailMinimized) {
      revealRightPanel();
    }
  }, [revealRightPanel, rightRailMinimized]);

  const handleCenterGraphOnNode = useCallback((nodeId, zoomLevel = 1.38) => {
    if (!fgRef.current) return;
    const graphNode = graphData.nodes.find((node) => node.id === nodeId);
    if (!graphNode || !Number.isFinite(graphNode.x) || !Number.isFinite(graphNode.y)) return;

    fgRef.current.centerAt(graphNode.x, graphNode.y, 320);
    fgRef.current.zoom(zoomLevel, 320);
    window.setTimeout(() => {
      syncGraphViewport();
    }, 340);
  }, [graphData.nodes, syncGraphViewport]);

  const handleApplyGraphPreset = useCallback((preset) => {
    setGraphPreset(preset);

    if (preset === "overview") {
      setFocusMode("none");
      setFocusDepth(DEFAULT_TAB_VIEW.focusDepth);
      setHideUnrelated(false);
      setNodeTypeFilter("all");
      setCollapsedNodeIds([]);
      setPinnedNodePositions({});
      return;
    }

    if (preset === "focused") {
      if (!selectedNodeId) {
        setStatusMessage("Select a node to open the focused branch view.");
        return;
      }
      setFocusMode("both");
      setFocusDepth("branch");
      setHideUnrelated(false);
      handleCenterGraphOnNode(selectedNodeId, 1.44);
      return;
    }

    if (preset === "review") {
      setFocusMode("none");
      setHideUnrelated(false);
      setNodeTypeFilter("concept");
      if (graphState?.reviewQueue?.[0]?.id) {
        selectGraphNode(graphState.reviewQueue[0].id);
        handleCenterGraphOnNode(graphState.reviewQueue[0].id, 1.34);
      }
      openRightPanel("review");
      return;
    }

    if (preset === "gaps") {
      setFocusMode("none");
      setHideUnrelated(false);
      setNodeTypeFilter("all");
      if (primaryGoalNode?.id) {
        selectGraphNode(primaryGoalNode.id);
        handleCenterGraphOnNode(primaryGoalNode.id, 1.24);
      }
      openRightPanel("gaps");
    }
  }, [graphState?.reviewQueue, handleCenterGraphOnNode, openRightPanel, primaryGoalNode?.id, selectedNodeId, selectGraphNode]);

  const handleShowSelectedBranch = useCallback(() => {
    if (!selectedNodeId) return;
    setFocusMode("both");
    setFocusDepth("branch");
    setHideUnrelated(false);
    setGraphPreset("custom");
  }, [selectedNodeId]);

  const handleShowImmediateNeighbors = useCallback(() => {
    if (!selectedNodeId) return;
    setFocusMode("both");
    setFocusDepth("neighbors");
    setHideUnrelated(false);
    setGraphPreset("custom");
  }, [selectedNodeId]);

  const handleShowPathToRoot = useCallback(() => {
    if (!selectedNodeId) return;
    setFocusMode("upstream");
    setFocusDepth("branch");
    setHideUnrelated(false);
    setGraphPreset("custom");
  }, [selectedNodeId]);

  const handleToggleHideUnrelated = useCallback(() => {
    if (!selectedNodeId) return;
    if (focusMode === "none") {
      setFocusMode("both");
      setFocusDepth("branch");
    }
    setHideUnrelated((current) => !current);
    setGraphPreset("custom");
  }, [focusMode, selectedNodeId]);

  const handleToggleCollapsedBranch = useCallback(() => {
    if (!selectedNode || !selectedDescendantCount) return;
    setCollapsedNodeIds((current) => (
      current.includes(selectedNode.id)
        ? current.filter((nodeId) => nodeId !== selectedNode.id)
        : [...current, selectedNode.id]
    ));
    setGraphPreset("custom");
  }, [selectedDescendantCount, selectedNode]);

  const handleTogglePinnedBranch = useCallback(() => {
    if (!selectedBranchNodeIds.length) return;
    if (isSelectedBranchPinned) {
      setPinnedNodePositions((current) => Object.fromEntries(
        Object.entries(current).filter(([nodeId]) => !selectedBranchNodeIds.includes(nodeId))
      ));
      setGraphPreset("custom");
      return;
    }

    const nextPinnedPositions = Object.fromEntries(
      graphData.nodes
        .filter((node) => selectedBranchNodeIds.includes(node.id) && Number.isFinite(node.x) && Number.isFinite(node.y))
        .map((node) => [node.id, { x: node.x, y: node.y }])
    );
    setPinnedNodePositions((current) => ({
      ...current,
      ...nextPinnedPositions
    }));
    setGraphPreset("custom");
  }, [graphData.nodes, isSelectedBranchPinned, selectedBranchNodeIds]);

  const handleFocusGraph = () => {
    setLeftRailMinimized(true);
    setRightRailMinimized(true);
    if (selectedNodeId) {
      handleCenterGraphOnNode(selectedNodeId, 1.32);
    }
  };

  const handleRecommendation = (recommendation) => {
    if (recommendation.nodeId) {
      selectGraphNode(recommendation.nodeId);
      handleCenterGraphOnNode(recommendation.nodeId, 1.36);
      openRightPanel("inspector");
      return;
    }

    openRightPanel("import");
  };

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (!selectedNodeId || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;

      const target = event.target;
      const tagName = target?.tagName?.toLowerCase?.();
      if (target?.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select" || tagName === "button") {
        return;
      }

      if (event.key === "Escape") {
        if (selectedNodeIdList.length > 1 || focusMode !== "none" || hideUnrelated) {
          event.preventDefault();
          setFocusMode("none");
          setHideUnrelated(false);
          setGraphPreset("custom");
          selectGraphNode(selectedNodeId);
        }
        return;
      }

      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        handleShowSelectedBranch();
        return;
      }

      const direction = event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? "upstream"
        : event.key === "ArrowRight" || event.key === "ArrowDown"
          ? "downstream"
          : null;
      if (!direction) return;

      const nextNode = getSortedConnectedNodes(graphIndex, selectedNodeId, { direction })[0] ?? null;
      if (!nextNode) return;

      event.preventDefault();
      selectGraphNode(nextNode.id);
      handleCenterGraphOnNode(nextNode.id, 1.34);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    graphIndex,
    focusMode,
    handleCenterGraphOnNode,
    handleShowSelectedBranch,
    hideUnrelated,
    openRightPanel,
    selectGraphNode,
    selectedNodeId,
    selectedNodeIdList.length
  ]);

  const handleGraphFramePre = useCallback((ctx, globalScale) => {
    if (!isGraphViewportReady || !graphData.domainGroups.length) return;

    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    for (const group of graphData.domainGroups) {
      const positionedNodes = group.nodes.filter((node) => Number.isFinite(node.x) && Number.isFinite(node.y));
      if (positionedNodes.length < 2) continue;
      const isHighlighted = group.nodes.some((node) => highlightedNodeIds.has(node.id));
      const containsDimmedNodes = focusIsActive && !hideUnrelated
        ? group.nodes.some((node) => !highlightedNodeIds.has(node.id))
        : false;

      let left = Number.POSITIVE_INFINITY;
      let top = Number.POSITIVE_INFINITY;
      let right = Number.NEGATIVE_INFINITY;
      let bottom = Number.NEGATIVE_INFINITY;

      for (const node of positionedNodes) {
        const metrics = getNodeMetrics(node, ctx);
        left = Math.min(left, metrics.x - 26);
        top = Math.min(top, metrics.y - 24);
        right = Math.max(right, metrics.x + metrics.width + 26);
        bottom = Math.max(bottom, metrics.y + metrics.height + 24);
      }

      const labelHeight = Math.max(16, 16 / Math.max(globalScale, 0.72));
      ctx.fillStyle = withAlpha(group.fill, containsDimmedNodes ? 0.04 : 0.08);
      ctx.strokeStyle = withAlpha(group.stroke, isHighlighted ? 0.42 : 0.18);
      ctx.lineWidth = (isHighlighted ? 2.1 : 1.15) / Math.max(globalScale, 0.7);
      drawRoundedRect(ctx, left, top, right - left, bottom - top, 20);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = withAlpha(group.stroke, isHighlighted ? 0.96 : 0.74);
      ctx.font = `700 ${labelHeight}px "Aptos", "Segoe UI", sans-serif`;
      ctx.fillText(group.label, left + 16, top + 16);
    }

    ctx.restore();
  }, [focusIsActive, graphData.domainGroups, hideUnrelated, highlightedNodeIds, isGraphViewportReady]);

  const handleNodeRender = useCallback((node, ctx, globalScale) => {
    const isSelected = node.id === selectedNodeId;
    const isGroupSelected = selectedNodeIdSet.has(node.id) && !isSelected;
    const isFocused = focusTraversal.nodeIds.has(node.id);
    const isPath = pathNodeIds.has(node.id);
    const isReviewNode = reviewNodeIds.has(node.id);
    const isDimmed = focusIsActive && !hideUnrelated ? !highlightedNodeIds.has(node.id) : false;
    const isEmphasized = isSelected || isGroupSelected || isFocused || isPath;
    const metrics = getNodeMetrics(node, ctx);
    const detail = getNodeRenderDetail(globalScale);

    ctx.save();
    drawRoundedRect(ctx, metrics.x, metrics.y, metrics.width, metrics.height, 8);
    ctx.fillStyle = isDimmed ? withAlpha(metrics.fill, 0.24) : withAlpha(metrics.fill, isEmphasized ? 0.98 : 1);
    ctx.shadowColor = isSelected
      ? metrics.shadowColor
      : isEmphasized
        ? withAlpha(metrics.shadowColor, 0.72)
        : "transparent";
    ctx.shadowBlur = isSelected ? 20 : isEmphasized ? 12 : 0;
    ctx.fill();
    ctx.lineWidth = isSelected ? 3.2 : isGroupSelected || isPath ? 2.5 : isReviewNode ? 2.1 : 1.6;
    ctx.strokeStyle = isSelected
      ? metrics.selectedStroke
      : isGroupSelected || isPath
        ? withAlpha(metrics.selectedStroke, 0.88)
        : isFocused
          ? withAlpha(metrics.stroke, 0.92)
          : isDimmed
            ? withAlpha(metrics.stroke, 0.24)
            : metrics.stroke;
    ctx.stroke();
    ctx.shadowBlur = 0;

    if (isReviewNode && !isSelected) {
      ctx.fillStyle = withAlpha("#ffffff", isDimmed ? 0.2 : 0.54);
      drawRoundedRect(ctx, metrics.x + 10, metrics.y + 8, 18, 6, 3);
      ctx.fill();
    }

    if (detail !== "minimal") {
      const lines = detail === "compact" ? [metrics.compactLine] : metrics.lines;
      const textY = detail === "compact" ? node.y : metrics.textY;
      ctx.fillStyle = isDimmed ? withAlpha(metrics.textFill, 0.42) : metrics.textFill;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = getNodeFont(metrics);
      lines.forEach((line, index) => {
        ctx.fillText(line, node.x, textY + index * metrics.lineHeight);
      });
    }

    if (node.collapsedDescendantCount > 0) {
      const badgeLabel = `${node.collapsedDescendantCount}`;
      ctx.font = `700 ${Math.max(9, metrics.fontSize - 1.4)}px "Aptos", "Segoe UI", sans-serif`;
      const badgeWidth = ctx.measureText(badgeLabel).width + 14;
      const badgeHeight = 18;
      const badgeX = metrics.x + metrics.width - badgeWidth - 10;
      const badgeY = metrics.y + 8;
      ctx.fillStyle = withAlpha("#050505", 0.82);
      ctx.strokeStyle = withAlpha(metrics.selectedStroke, 0.78);
      ctx.lineWidth = 1.2;
      drawRoundedRect(ctx, badgeX, badgeY, badgeWidth, badgeHeight, 8);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#f4f4f4";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(badgeLabel, badgeX + badgeWidth / 2, badgeY + badgeHeight / 2 + 0.5);
    }

    ctx.restore();
  }, [focusIsActive, focusTraversal, hideUnrelated, highlightedNodeIds, pathNodeIds, reviewNodeIds, selectedNodeId, selectedNodeIdSet]);

  const handlePointerPaint = useCallback((node, color, ctx) => {
    const metrics = getNodeMetrics(node, ctx);
    ctx.fillStyle = color;
    drawRoundedRect(ctx, metrics.x - 4, metrics.y - 4, metrics.width + 8, metrics.height + 8, 10);
    ctx.fill();
  }, []);

  const handleLinkRender = useCallback((link, ctx, globalScale) => {
    const style = getLinkVisualStyle(link);
    const sourceNode = typeof link.source === "object" ? link.source : null;
    const targetNode = typeof link.target === "object" ? link.target : null;
    if (!sourceNode || !targetNode) return;

    const sourceMetrics = getNodeMetrics(sourceNode, ctx);
    const targetMetrics = getNodeMetrics(targetNode, ctx);
    const angle = Math.atan2(targetNode.y - sourceNode.y, targetNode.x - sourceNode.x);
    const sourceInset = Math.max(sourceMetrics.width, sourceMetrics.height) * 0.34;
    const targetInset = Math.max(targetMetrics.width, targetMetrics.height) * 0.38;
    const startX = sourceNode.x + Math.cos(angle) * sourceInset;
    const startY = sourceNode.y + Math.sin(angle) * sourceInset;
    const endX = targetNode.x - Math.cos(angle) * targetInset;
    const endY = targetNode.y - Math.sin(angle) * targetInset;
    const isPath = highlightedEdgeKeys.has(link.key) && pathEdgeKeys.has(link.key);
    const isFocused = highlightedEdgeKeys.has(link.key) && focusTraversal.edgeKeys.has(link.key);
    const hasSelectedEndpoint = selectedNodeIdSet.has(link.sourceId) || selectedNodeIdSet.has(link.targetId);
    const isDimmed = focusIsActive && !hideUnrelated
      ? !(highlightedEdgeKeys.has(link.key) || hasSelectedEndpoint)
      : false;
    const alpha = isDimmed
      ? 0.08
      : isPath
        ? 0.92
        : isFocused
          ? 0.76
          : hasSelectedEndpoint
            ? 0.58
            : 0.28;
    const lineWidth = isPath
      ? style.lineWidth + 1.35
      : isFocused || hasSelectedEndpoint
        ? style.lineWidth + 0.55
        : style.lineWidth;

    ctx.save();
    ctx.strokeStyle = withAlpha(style.stroke, alpha);
    ctx.fillStyle = withAlpha(style.stroke, Math.min(1, alpha + 0.12));
    ctx.lineWidth = lineWidth;
    if (style.dash.length) ctx.setLineDash(style.dash);
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.stroke();
    ctx.setLineDash([]);
    drawArrowHead(ctx, startX, startY, endX, endY, {
      length: isPath ? 12 : 9,
      width: isPath ? 8 : 6,
      inset: 0
    });

    if (isPath || isFocused || hasSelectedEndpoint) {
      const label = String(link.label || link.type || "").trim();
      if (label) {
        const midX = (startX + endX) / 2;
        const midY = (startY + endY) / 2;
        const fontSize = Math.max(9, 10 / Math.max(globalScale, 0.84));
        ctx.font = `700 ${fontSize}px "Aptos", "Segoe UI", sans-serif`;
        const textWidth = ctx.measureText(label).width;
        ctx.fillStyle = withAlpha("#060a12", 0.82);
        ctx.strokeStyle = withAlpha("#ffffff", 0.18);
        ctx.lineWidth = 1;
        drawRoundedRect(ctx, midX - textWidth / 2 - 8, midY - 9, textWidth + 16, 18, 8);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#f4f4f4";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, midX, midY + 0.5);
      }
    }

    ctx.restore();
  }, [focusIsActive, focusTraversal, hideUnrelated, highlightedEdgeKeys, pathEdgeKeys, selectedNodeIdSet]);

  const mapTabsChrome = (
    <section className={`map-tabs-shell panel ${mapTabsCollapsed ? "is-collapsed" : ""}`}>
      <div className="map-tabs-row">
        <button
          type="button"
          className={`map-home-tab ${!sessionId ? "is-active" : ""}`}
          onClick={() => navigateToSession(null)}
        >
          All Maps
        </button>

        {!mapTabsCollapsed && openTabSessions.map((session) => (
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

        {!mapTabsCollapsed && (
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
        )}

        {!mapTabsCollapsed && sessionTargetState.activeSession ? (
          <span className="map-tabs-target-pill">
            {`⬤ ${getMapName(sessionTargetState.activeSession)}`}
          </span>
        ) : null}

        <button
          className="map-tabs-toggle"
          type="button"
          onClick={() => setMapTabsCollapsed((c) => !c)}
          aria-label={mapTabsCollapsed ? "Expand map tabs" : "Collapse map tabs"}
          title={mapTabsCollapsed ? "Expand map tabs" : "Collapse map tabs"}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            {mapTabsCollapsed
              ? <polyline points="6 9 12 15 18 9"/>
              : <polyline points="18 15 12 9 6 15"/>}
          </svg>
        </button>
      </div>

      {!mapTabsCollapsed && reopenableSessions.length ? (
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

  const unifiedTopbar = (
    <header className="workspace-topbar">
      {/* ── Column 1: Maps (tabs + new map) ── */}
      <div className="topbar-maps-group">
        <button
          type="button"
          className="topbar-home"
          onClick={() => navigateToSession(null)}
          aria-label="All maps"
          title="All maps"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>
          </svg>
        </button>
        {openTabSessions.map((session) => (
          <div key={session.id} className={`topbar-tab ${sessionId === session.id ? "is-active" : ""}`}>
            <button type="button" className="topbar-tab-main" onClick={() => openSessionTab(session.id)}>
              {getMapName(session)}
            </button>
            <button
              type="button"
              className="topbar-tab-close"
              onClick={() => closeSessionTab(session.id)}
              aria-label={`Close ${getMapName(session)}`}
            >
              ×
            </button>
          </div>
        ))}
        <form className="topbar-new-map" onSubmit={(event) => handleCreateSession(event, { fromTabs: true })}>
          <input
            className="topbar-new-input"
            placeholder="New map…"
            value={tabComposerGoal}
            onChange={(event) => setTabComposerGoal(event.target.value)}
          />
          <button className="topbar-new-btn" type="submit" disabled={isCreatingSession} aria-label="Create new map" title="Create new map">
            +
          </button>
        </form>
      </div>

      {/* ── Column 2: Tools (search | views | direction filters) ── */}
      {sessionId && (
        <div className="topbar-tools-group">
          <div className="topbar-section topbar-search-section">
            <input
              className="topbar-search-input"
              placeholder="Search nodes…"
              value={nodeSearch}
              onChange={(event) => setNodeSearch(event.target.value)}
            />
            <button className="topbar-btn" type="button" onClick={handleGraphSearch} disabled={isSearchingGraph || !nodeSearch.trim()}>
              {isSearchingGraph ? "…" : "Find"}
            </button>
            <button className="topbar-btn topbar-fit-btn" type="button" onClick={handleFocusGraph} title="Fit graph to viewport" aria-label="Fit graph to viewport">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
              </svg>
            </button>
          </div>
          <div className="topbar-divider" />
          <div className="topbar-section topbar-filter-section">
            <SelectControl
              className="topbar-type-filter"
              value={nodeTypeFilter}
              onChange={setNodeTypeFilter}
              options={NODE_TYPE_OPTIONS}
              ariaLabel="Filter node type"
            />
            <SelectControl
              className="topbar-type-filter"
              value={graphColorMode}
              onChange={(value) => setGraphColorMode(value)}
              options={GRAPH_COLOR_MODE_OPTIONS}
              ariaLabel="Graph color mode"
            />
          </div>
          <div className="topbar-divider" />
          <div className="topbar-section topbar-views-section">
            {GRAPH_VIEW_PRESET_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`topbar-view-chip ${graphPreset === option.value ? "is-active" : ""}`}
                onClick={() => handleApplyGraphPreset(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="topbar-divider" />
          <div className="topbar-section topbar-focus-section">
            <span className="topbar-focus-label">Focus</span>
            <div className="topbar-direction-toggle">
              {[
                { value: "upstream", label: "↑ Up", title: "Show upstream ancestors" },
                { value: "both", label: "↕ Both", title: "Show upstream and downstream" },
                { value: "downstream", label: "↓ Down", title: "Show downstream descendants" },
              ].map(({ value, label, title }) => (
                <button
                  key={value}
                  type="button"
                  className={`topbar-dir-btn${focusMode === value ? " is-active" : ""}`}
                  title={title}
                  onClick={() => {
                    const next = focusMode === value ? "none" : value;
                    setFocusMode(next);
                    if (next === "none") setHideUnrelated(false);
                    setGraphPreset("custom");
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {focusMode !== "none" && (
              <SelectControl
                className="topbar-focus-depth"
                value={focusDepth}
                onChange={(value) => {
                  setFocusDepth(value);
                  setGraphPreset("custom");
                }}
                options={GRAPH_FOCUS_DEPTH_OPTIONS}
                ariaLabel="Focus depth"
              />
            )}
          </div>
        </div>
      )}

      {/* ── Column 3: Status ── */}
      <div className="topbar-end">
        {sessionId && (
          <span className="topbar-status-pill">
            {isLoadingGraph ? "Loading…" : `${graphData.nodes.length} nodes`}
            <span className="topbar-dot">·</span>
            {graphState?.session?.endedAt ? "ended" : "live"}
            <span className="topbar-dot">·</span>
            {graphState?.artifacts?.length ?? 0} src
          </span>
        )}
        {sessionTargetState.activeSession && (
          <span className="topbar-target-pill">
            <span className="topbar-target-dot" />
            {getMapName(sessionTargetState.activeSession)}
          </span>
        )}
      </div>
    </header>
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
      {unifiedTopbar}
      <div className={appShellClassName}>
        <aside className={`left-rail ${leftRailMinimized ? "is-minimized" : ""}`} aria-label="Map navigation">
          <section className="panel workspace-nav">
            <div className="panel-heading-row">
              <p className="panel-title">Workspaces</p>
              <button className="rail-toggle-button" type="button" onClick={() => setLeftRailMinimized(true)} aria-label="Close workspaces">
                ✕
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
            quickAddNodeType={quickAddNodeType}
            onQuickAddNodeTypeChange={setQuickAddNodeType}
            quickAddNodeLabel={goalNodeDraft}
            onQuickAddNodeLabelChange={setGoalNodeDraft}
            onCreateNode={handleCreateQuickAddNode}
            isCreatingNode={isCreatingGoalNode}
            quickAddNodeTypeOptions={NODE_TYPE_OPTIONS.filter((option) => option.value !== "all")}
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
        </aside>

        <main className="graph-card">
          {(!leftRailMinimized || !rightRailMinimized) && (
            <div className="drawer-backdrop" onClick={() => { setLeftRailMinimized(true); setRightRailMinimized(true); }} />
          )}
          {leftRailMinimized && (
            <button className="drawer-open-left" type="button" onClick={() => setLeftRailMinimized(false)} aria-label="Open workspaces panel">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          )}
          {rightRailMinimized && (
            <button className="drawer-open-right" type="button" onClick={() => setRightRailMinimized(false)} aria-label={`Open ${rightPanelLabel}`}>
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
          )}
          {(breadcrumbNodes.length > 1 || selectedNode || selectedGroupNodes.length > 1) && (
            <div className="graph-context-strip">
              {breadcrumbNodes.length > 1 && (
                <div className="graph-breadcrumbs">
                  {breadcrumbNodes.map((node, index) => (
                    <button
                      key={node.id}
                      type="button"
                      className={`graph-breadcrumb ${node.id === selectedNodeId ? "is-active" : ""}`}
                      onClick={() => {
                        selectGraphNode(node.id);
                        handleCenterGraphOnNode(node.id, 1.32);
                      }}
                    >
                      {index > 0 ? <span aria-hidden="true">/</span> : null}
                      {node.label}
                    </button>
                  ))}
                </div>
              )}
              {selectedGroupNodes.length > 1 ? (
                <div className="context-group">
                  <div className="graph-selection-pill-row">
                    {selectedGroupNodes.map((node) => (
                      <button
                        key={node.id}
                        type="button"
                        className={`graph-selection-pill ${node.id === selectedNodeId ? "is-primary" : ""}`}
                        onClick={() => {
                          selectGraphNode(node.id);
                          handleCenterGraphOnNode(node.id, 1.32);
                          openRightPanel("inspector");
                        }}
                      >
                        {node.label}
                      </button>
                    ))}
                  </div>
                  <button className="small-button" type="button" disabled={!canRunBridge || isIntersecting} onClick={() => { openRightPanel("inspector"); void handleIntersect(); }}>
                    {isIntersecting ? "Explaining..." : "Explain Bridge"}
                  </button>
                  <button className="small-button" type="button" onClick={clearGraphSelection}>
                    Clear
                  </button>
                </div>
              ) : selectedNode ? (
                <div className="context-group">
                  <span className="context-node-label">{selectedNode.label}</span>
                  <button className="small-button" type="button" onClick={handleShowSelectedBranch}>Focus Branch</button>
                  <button className="small-button" type="button" onClick={handleShowImmediateNeighbors}>Neighbors</button>
                  <button className="small-button" type="button" onClick={handleShowPathToRoot}>Path to Root</button>
                  <button className="small-button" type="button" disabled={!selectedDescendantCount} onClick={handleToggleCollapsedBranch}>
                    {isSelectedNodeCollapsed ? `Expand (${selectedDescendantCount})` : `Collapse (${selectedDescendantCount})`}
                  </button>
                  <button className="small-button" type="button" disabled={!selectedBranchNodeIds.length} onClick={handleTogglePinnedBranch}>
                    {isSelectedBranchPinned ? "Unpin Branch" : "Pin Branch"}
                  </button>
                  <button className="small-button" type="button" onClick={handleToggleHideUnrelated}>
                    {hideUnrelated ? "Show All" : "Hide Unrelated"}
                  </button>
                </div>
              ) : null}
            </div>
          )}
          {searchResults.length ? (
            <div className="search-results-strip">
              {searchResults.slice(0, 6).map((result) => (
                <button
                  key={`${result.kind}-${result.id}`}
                  className="search-chip"
                  onClick={() => {
                    if (result.kind !== "node") return;
                    selectGraphNode(result.id);
                    handleCenterGraphOnNode(result.id, 1.34);
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
                {graphColorMode !== "type" ? (
                  <span className="graph-legend-item">
                    <span
                      className="graph-legend-swatch"
                      aria-hidden="true"
                      style={{ background: getBranchVisualStyle(null).fill, borderColor: getBranchVisualStyle(null).stroke }}
                    />
                    {`Fallback (${graphColorMode})`}
                  </span>
                ) : null}
              </div>
            ) : null}
            {graphData.nodes.length && isGraphViewportReady ? (
              <div className="graph-minimap-shell">
                <GraphMiniMap
                  nodes={graphData.nodes}
                  links={graphData.links}
                  graphSize={graphSize}
                  viewport={graphViewport}
                  selectedNodeId={selectedNodeId}
                  selectedNodeIds={selectedNodeIdList}
                  onSelectNode={(nodeId, options) => {
                    selectGraphNode(nodeId, options);
                  }}
                  onCenterNode={handleCenterGraphOnNode}
                />
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
              onRenderFramePre={handleGraphFramePre}
              nodeCanvasObject={handleNodeRender}
              nodePointerAreaPaint={handlePointerPaint}
              linkCanvasObject={handleLinkRender}
              linkWidth={() => 1}
              linkColor={() => "rgba(255,255,255,0.18)"}
              onNodeClick={(node, event) => {
                selectGraphNode(node.id, { additive: Boolean(event?.shiftKey) });
                if (rightRailMinimized || rightPanel !== "inspector") {
                  openRightPanel("inspector", { reveal: false });
                }
              }}
              onBackgroundClick={() => clearGraphSelection()}
              onZoomEnd={syncGraphViewport}
              nodeRelSize={4}
              warmupTicks={140}
              cooldownTicks={110}
              d3VelocityDecay={0.22}
              onEngineStop={handleGraphEngineStop}
              onNodeDragEnd={(node) => {
                if (!pinnedNodePositions[node.id]) return;
                setPinnedNodePositions((current) => ({
                  ...current,
                  [node.id]: { x: node.x, y: node.y }
                }));
                syncGraphViewport();
              }}
            />
          </div>
        </main>

        <aside ref={rightRailRef} className={`right-rail ${rightRailMinimized ? "is-minimized" : ""}`} aria-label="Workspace details">
          <section className="panel scroll-panel workspace-panel">
            <div className="workspace-panel-chrome">
              <span>{rightPanelLabel}</span>
              <button className="rail-toggle-button" type="button" onClick={() => setRightRailMinimized(true)} aria-label="Close right panel">
                ✕
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
                        <button className="small-button" onClick={() => { selectGraphNode(node.id); handleCenterGraphOnNode(node.id, 1.34); openRightPanel("inspector"); }}>Inspect</button>
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
                  {selectedNode.secondaryRoles?.length ? (
                    <div className="semantic-role-summary">
                      Also acts as {selectedNode.secondaryRoles.join(", ")}.
                    </div>
                  ) : null}
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
                    <strong>Primary Role</strong>
                    <span>{selectedNode.primaryRole || selectedNode.type}</span>
                  </div>
                  <div>
                    <strong>Also Acts As</strong>
                    <span>{selectedNode.secondaryRoles?.length ? selectedNode.secondaryRoles.join(", ") : "None yet"}</span>
                  </div>
                  <div>
                    <strong>Identity</strong>
                    <span>{selectedNode.entityId?.replace(/^entity:/, "") || selectedNode.canonicalLabel || "Not set"}</span>
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
                  <h3>Path & Workflow</h3>
                  <div className="queue-meta">
                    {whyThisHereSummary?.breadcrumb
                      ? `Breadcrumb: ${whyThisHereSummary.breadcrumb}`
                      : "This node is currently the top of its visible branch."}
                  </div>
                  <div className="metadata-grid compact-metadata-grid">
                    <div>
                      <strong>Domain Group</strong>
                      <span>{whyThisHereSummary?.domainLabel ?? "Ungrouped"}</span>
                    </div>
                    <div>
                      <strong>Upstream Context</strong>
                      <span>{whyThisHereSummary?.upstreamLabels?.length ? whyThisHereSummary.upstreamLabels.join(", ") : "No visible parents"}</span>
                    </div>
                    <div>
                      <strong>Downstream Context</strong>
                      <span>{whyThisHereSummary?.downstreamLabels?.length ? whyThisHereSummary.downstreamLabels.join(", ") : "No visible children"}</span>
                    </div>
                    <div>
                      <strong>Keyboard</strong>
                      <span>Arrow keys move through connected nodes. Press F to focus the selected branch.</span>
                    </div>
                  </div>
                  <div className="queue-actions">
                    <button className="small-button" type="button" onClick={handleShowSelectedBranch}>Focus Branch</button>
                    <button className="small-button" type="button" onClick={handleShowImmediateNeighbors}>Show Neighbors</button>
                    <button className="small-button" type="button" onClick={handleShowPathToRoot}>Path To Root</button>
                    <button className="small-button" type="button" disabled={!selectedDescendantCount} onClick={handleToggleCollapsedBranch}>
                      {isSelectedNodeCollapsed ? "Expand Branch" : "Collapse Branch"}
                    </button>
                    <button className="small-button" type="button" disabled={!selectedBranchNodeIds.length} onClick={handleTogglePinnedBranch}>
                      {isSelectedBranchPinned ? "Unpin Branch" : "Pin Branch"}
                    </button>
                  </div>
                </div>
                <div className="summary-card">
                  <h3>Why this exists</h3>
                  <div className="queue-meta">{selectedNode.whyThisExists || selectedNode.description || "This node came from the current map and can be refined with stronger evidence or cleaner relationships."}</div>
                  {whyThisHereSummary ? (
                    <div className="queue-meta">
                      Anchored in {whyThisHereSummary.domainLabel} with {whyThisHereSummary.sourceCount} source{whyThisHereSummary.sourceCount === 1 ? "" : "s"}.
                      {whyThisHereSummary.upstreamLabels?.length ? ` Upstream: ${whyThisHereSummary.upstreamLabels.join(", ")}.` : ""}
                      {whyThisHereSummary.downstreamLabels?.length ? ` Downstream: ${whyThisHereSummary.downstreamLabels.join(", ")}.` : ""}
                    </div>
                  ) : null}
                </div>
                <div className="summary-card">
                  <div className="node-note-card-header">
                    <div>
                      <h3>Node Notes</h3>
                      <div className="queue-meta">Attach markdown notes to this node in this map only.</div>
                    </div>
                    <div className="queue-actions">
                      <button className="small-button" type="button" onClick={handleToggleNodeNoteEditor}>
                        {nodeNoteActionLabel}
                      </button>
                    </div>
                  </div>
                  {!isNodeNoteEditorOpen ? (
                    selectedNode.hasNote ? (
                      <>
                        {selectedNode.noteUpdatedAt ? (
                          <div className="queue-meta">Last updated {formatTimestamp(selectedNode.noteUpdatedAt)}.</div>
                        ) : null}
                        <MarkdownNotePreview
                          content={selectedNode.note}
                          className="node-note-markdown node-note-markdown-collapsed"
                        />
                      </>
                    ) : (
                      <div className="queue-meta">No note attached yet. Use the note button to add markdown for this node.</div>
                    )
                  ) : isNodeNoteFullscreen ? (
                    <div className="queue-meta">Editing this note in fullscreen.</div>
                  ) : renderNodeNoteEditor("inline")}
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
                    {canEditSelectedNodeRoles ? (
                      <div className="semantic-role-editor">
                        <div className="muted-copy">Keep one semantic node and mark every role it plays in the map.</div>
                        <SelectControl
                          value={nodeEditForm.primaryRole}
                          onChange={(value) => setNodeEditForm((current) => ({
                            ...current,
                            primaryRole: value,
                            secondaryRoles: current.secondaryRoles.filter((role) => role !== value)
                          }))}
                          options={SEMANTIC_ROLE_OPTIONS}
                          ariaLabel="Primary node role"
                        />
                        <div className="semantic-role-toggles">
                          {SEMANTIC_ROLE_OPTIONS.filter((option) => option.value !== nodeEditForm.primaryRole).map((option) => (
                            <label key={option.value} className="semantic-role-toggle">
                              <input
                                type="checkbox"
                                checked={nodeEditForm.secondaryRoles.includes(option.value)}
                                onChange={(event) => setNodeEditForm((current) => ({
                                  ...current,
                                  secondaryRoles: event.target.checked
                                    ? [...current.secondaryRoles, option.value]
                                    : current.secondaryRoles.filter((role) => role !== option.value)
                                }))}
                              />
                              <span>{option.label}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    ) : null}
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
                      <span>Use this when two nodes describe the same thing. The current node is hidden from this session after merge.</span>
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
                  <button className="ghost-button" type="button" onClick={handleToggleNodeNoteEditor}>
                    {nodeNoteActionLabel}
                  </button>
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
                  <h3>{selectedGroupNodes.length > 1 ? "Selected Concept Bridge" : "Concept Bridge"}</h3>
                  <div className="queue-meta">
                    {selectedGroupNodes.length > 1
                      ? "Shift-click builds a bridge explanation across the current selection."
                      : "Find how this node connects to another part of the graph."}
                  </div>
                  {selectedGroupNodes.length > 1 ? (
                    <div className="graph-selection-pill-row inspector-selection-pill-row">
                      {selectedGroupNodes.map((node) => (
                        <button
                          key={node.id}
                          type="button"
                          className={`graph-selection-pill ${node.id === selectedNodeId ? "is-primary" : ""}`}
                          onClick={() => {
                            selectGraphNode(node.id);
                            handleCenterGraphOnNode(node.id, 1.3);
                          }}
                        >
                          {node.label}
                        </button>
                      ))}
                    </div>
                  ) : (
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
                    </div>
                  )}
                  <div className="queue-actions">
                    <button className="secondary-button" disabled={isIntersecting || !canRunBridge} onClick={handleIntersect}>
                      {isIntersecting ? "Finding bridge..." : "Find Bridge"}
                    </button>
                    {selectedGroupNodes.length > 1 ? (
                      <button className="ghost-button" type="button" onClick={clearGraphSelection}>
                        Clear Selection
                      </button>
                    ) : null}
                  </div>
                  {intersectionResult ? (
                    <div className="learn-more-copy">
                      {currentBridgeNodes.length ? `Across: ${currentBridgeNodes.map((node) => node.label).join(", ")}\n\n` : ""}
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
        </aside>
        {isNodeNoteFullscreen && selectedNode ? (
          <div className="node-note-fullscreen-overlay" role="dialog" aria-modal="true" aria-label={`Fullscreen note editor for ${selectedNode.label}`}>
            <div className="node-note-fullscreen-shell">
              <div className="node-note-fullscreen-header">
                <div>
                  <p className="panel-title">Node Notes</p>
                  <h2>{selectedNode.label}</h2>
                  <div className="queue-meta">Markdown note attached to this node in the current map.</div>
                  {selectedNode.noteUpdatedAt ? (
                    <div className="queue-meta">Last updated {formatTimestamp(selectedNode.noteUpdatedAt)}.</div>
                  ) : null}
                </div>
                <div className="queue-actions">
                  <button className="ghost-button" type="button" onClick={closeNodeNoteEditor}>
                    Close Notes
                  </button>
                </div>
              </div>
              {renderNodeNoteEditor("fullscreen")}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
