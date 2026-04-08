import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import "./app.css";

const API_BASE = import.meta.env.VITE_API_BASE ?? (window.location.port === "5197" ? "http://localhost:3001" : window.location.origin);
const visibleNodeTypes = ["goal", "domain", "skill", "concept"];

function useQueryParam(name) {
  return useMemo(() => new URLSearchParams(window.location.search).get(name), [name]);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || payload.reason || `Request failed with status ${response.status}`);
  }

  return payload;
}

function groupVerificationResults(quiz, answers) {
  const buckets = {
    correct: [],
    incorrect: []
  };

  for (const question of quiz) {
    const selectedIndex = answers[question.id];
    if (selectedIndex === undefined) continue;
    const bucket = selectedIndex === question.correct ? "correct" : "incorrect";
    buckets[bucket].push(question.conceptId);
  }

  return buckets;
}

function formatTimestamp(value) {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  return date.toLocaleString();
}

function describeReviewDate(value) {
  if (!value) return "Not scheduled";
  return value <= Date.now() ? "Due now" : `Next review: ${new Date(value).toLocaleDateString()}`;
}

function getSafeFileName(value) {
  return String(value || "mindweaver-map")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "mindweaver-map";
}

function downloadTextFile(content, fileName, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export default function App() {
  const sessionId = useQueryParam("sessionId");
  const fgRef = useRef(null);
  const importPanelRef = useRef(null);
  const graphContainerRef = useRef(null);

  const [graphState, setGraphState] = useState(null);
  const [healthState, setHealthState] = useState(null);
  const [recentSessions, setRecentSessions] = useState([]);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [homeErrorMessage, setHomeErrorMessage] = useState("");
  const [isLoadingGraph, setIsLoadingGraph] = useState(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [isCreatingDemo, setIsCreatingDemo] = useState(false);
  const [isDeletingSession, setIsDeletingSession] = useState(false);
  const [isEndingSession, setIsEndingSession] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isLearningMore, setIsLearningMore] = useState(false);
  const [learnMoreCopy, setLearnMoreCopy] = useState("");
  const [isReviewing, setIsReviewing] = useState(false);
  const [isLoadingGaps, setIsLoadingGaps] = useState(false);
  const [gapSummary, setGapSummary] = useState(null);
  const [isLoadingQuiz, setIsLoadingQuiz] = useState(false);
  const [quizState, setQuizState] = useState({ quiz: [], message: "" });
  const [quizAnswers, setQuizAnswers] = useState({});
  const [quizResult, setQuizResult] = useState(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importForm, setImportForm] = useState({
    sourceType: "note",
    title: "",
    url: "",
    content: ""
  });
  const [startGoal, setStartGoal] = useState("");
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

  const loadHomeData = async () => {
    setHomeErrorMessage("");

    try {
      const [health, sessions] = await Promise.all([
        fetchJson(`${API_BASE}/api/health`),
        fetchJson(`${API_BASE}/api/sessions?limit=8`)
      ]);
      setHealthState(health);
      setRecentSessions(sessions.sessions ?? []);
    } catch (error) {
      setHomeErrorMessage(`${error.message}. Start the MindWeaver app, then refresh this page.`);
    }
  };

  useEffect(() => {
    loadHomeData();
  }, []);

  useEffect(() => {
    if (!graphContainerRef.current) return;

    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setGraphSize({
        width: Math.max(320, Math.floor(width)),
        height: Math.max(420, Math.floor(height))
      });
    });

    observer.observe(graphContainerRef.current);
    return () => observer.disconnect();
  }, []);

  const loadGraph = async () => {
    if (!sessionId) return;
    setIsLoadingGraph(true);
    setErrorMessage("");

    try {
      const data = await fetchJson(`${API_BASE}/api/graph/${encodeURIComponent(sessionId)}`);
      setGraphState(data);
      const progress = await fetchJson(`${API_BASE}/api/progress/${encodeURIComponent(sessionId)}`).catch(() => null);
      if (progress) setProgressState(progress);
      setGapSummary((current) => current ?? data.latestGapAnalysis ?? null);
      setSelectedNodeId((current) => {
        if (!current) return data.reviewQueue?.[0]?.id ?? data.nodes?.[0]?.id ?? null;
        return data.nodes.some((node) => node.id === current) ? current : data.reviewQueue?.[0]?.id ?? data.nodes?.[0]?.id ?? null;
      });
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsLoadingGraph(false);
    }
  };

  useEffect(() => {
    loadGraph();
  }, [sessionId]);

  const handleCreateSession = async (event) => {
    event.preventDefault();
    setIsCreatingSession(true);
    setHomeErrorMessage("");

    try {
      const session = await fetchJson(`${API_BASE}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: startGoal.trim() || null })
      });
      window.location.assign(`${window.location.pathname}?sessionId=${encodeURIComponent(session.id)}`);
    } catch (error) {
      setHomeErrorMessage(error.message);
    } finally {
      setIsCreatingSession(false);
    }
  };

  const handleCreateDemoSession = async () => {
    setIsCreatingDemo(true);
    setHomeErrorMessage("");

    try {
      const session = await fetchJson(`${API_BASE}/api/demo-session`, { method: "POST" });
      window.location.assign(`${window.location.pathname}?sessionId=${encodeURIComponent(session.id)}`);
    } catch (error) {
      setHomeErrorMessage(error.message);
    } finally {
      setIsCreatingDemo(false);
    }
  };

  const handleEndSession = async () => {
    if (!sessionId) return;
    setIsEndingSession(true);
    setErrorMessage("");

    try {
      await fetchJson(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/end`, { method: "POST" });
      setStatusMessage("Session ended. You can still review, import, and quiz against the saved graph.");
      await loadGraph();
      await loadHomeData();
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsEndingSession(false);
    }
  };

  const handleDeleteSession = async () => {
    if (!sessionId) return;
    const confirmed = window.confirm("Delete this local session, its sources, and session-specific graph data? This cannot be undone.");
    if (!confirmed) return;

    setIsDeletingSession(true);
    setErrorMessage("");

    try {
      await fetchJson(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      window.location.assign(window.location.pathname);
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
      const fileBase = getSafeFileName(graphState?.session?.goal || "mindweaver-map");
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
      window.location.assign(window.location.pathname);
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

  const graphData = useMemo(() => {
    if (!graphState) return { nodes: [], links: [] };

    const query = nodeSearch.trim().toLowerCase();
    const nodes = graphState.nodes.filter((node) => {
      if (!visibleNodeTypes.includes(node.type)) return false;
      if (nodeTypeFilter !== "all" && node.type !== nodeTypeFilter) return false;
      if (query && !node.label.toLowerCase().includes(query)) return false;
      return true;
    });
    const nodeIds = new Set(nodes.map((node) => node.id));
    const links = graphState.edges
      .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
      .map((edge) => ({
        ...edge,
        source: edge.source,
        target: edge.target
      }));

    return { nodes, links };
  }, [graphState, nodeSearch, nodeTypeFilter]);

  const maxImportChars = healthState?.maxPayloadContentChars ?? 80000;
  const importContentLength = importForm.content.length;
  const importIsTooLong = importContentLength > maxImportChars;

  useEffect(() => {
    if (!fgRef.current) return;
    fgRef.current.d3Force("charge").strength(-260);
    fgRef.current.d3Force("link").distance(150);
    fgRef.current.d3ReheatSimulation();
  }, [graphData]);

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
      setStatusMessage(action === "approve" ? "Concept approved and moved forward in the review schedule." : "Concept rejected and removed from this session graph.");
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
        body: JSON.stringify({
          label: selectedNode.label,
          type: selectedNode.type,
          upstream: selectedNodeConnections.upstream.map((entry) => entry.node.label),
          downstream: selectedNodeConnections.downstream.map((entry) => entry.node.label)
        })
      });
      setLearnMoreCopy(result.content ?? "");
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsLearningMore(false);
    }
  };

  const handleRunGapAnalysis = async () => {
    if (!sessionId || !graphState?.goals?.length) return;
    setIsLoadingGaps(true);
    setGapSummary(null);
    setErrorMessage("");

    try {
      const result = await fetchJson(`${API_BASE}/api/gaps`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          goalId: graphState.goals[0].id
        })
      });
      setGapSummary(result);
      setStatusMessage("Gap analysis updated from the current session graph.");
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
        body: JSON.stringify({ sessionId })
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
        body: JSON.stringify({
          sessionId,
          sourceType: importForm.sourceType,
          title: importForm.title.trim(),
          url: importForm.url.trim() || undefined,
          excerpt: importForm.content.trim().slice(0, 280),
          content: importForm.content.trim()
        })
      });
      setImportForm((current) => ({
        ...current,
        title: "",
        url: "",
        content: ""
      }));
      setStatusMessage("Imported source added to the session graph.");
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
        body: JSON.stringify({
          sessionId,
          items: chunks.map((content, index) => ({
            sourceType: "markdown",
            title: `Bulk note ${index + 1}`,
            content
          }))
        })
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
        body: JSON.stringify({ sessionId, question: chatQuestion.trim() })
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

  const handleIntersect = async () => {
    if (!selectedNode || !intersectionTargetId) return;
    setIsIntersecting(true);
    setErrorMessage("");

    try {
      const result = await fetchJson(`${API_BASE}/api/intersect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId1: selectedNode.id, nodeId2: intersectionTargetId })
      });
      setIntersectionResult(result);
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setIsIntersecting(false);
    }
  };

  const handleRecommendation = (recommendation) => {
    if (recommendation.nodeId) {
      setSelectedNodeId(recommendation.nodeId);
      return;
    }

    if (recommendation.kind === "capture") {
      importPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const handleNodeRender = (node, ctx) => {
    const palette = {
      goal: { fill: "#fff2de", stroke: "#ff8b54", radius: 24 },
      domain: { fill: "#dff6ff", stroke: "#60cce8", radius: 19 },
      skill: { fill: "#dff9f0", stroke: "#64d8b2", radius: 15 },
      concept: { fill: "#fff6d4", stroke: "#f6ca68", radius: 11 }
    };

    const style = palette[node.type] ?? { fill: "#eef3fa", stroke: "#adc0da", radius: 12 };
    const isSelected = node.id === selectedNodeId;

    ctx.save();
    ctx.beginPath();
    ctx.arc(node.x, node.y, style.radius, 0, Math.PI * 2);
    ctx.fillStyle = style.fill;
    ctx.shadowColor = isSelected ? "rgba(255,139,84,0.5)" : "transparent";
    ctx.shadowBlur = isSelected ? 18 : 0;
    ctx.fill();
    ctx.lineWidth = isSelected ? 3 : 2;
    ctx.strokeStyle = isSelected ? "#ff8b54" : style.stroke;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = "#0b1525";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `600 ${Math.max(10, style.radius * 0.7)}px Segoe UI`;
    const label = node.label.length > 18 ? `${node.label.slice(0, 16)}...` : node.label;
    ctx.fillText(label, node.x, node.y);
    ctx.restore();
  };

  const handlePointerPaint = (node, color, ctx) => {
    const radius = node.type === "goal" ? 30 : node.type === "domain" ? 24 : node.type === "skill" ? 20 : 16;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.fill();
  };

  const handleLinkRender = (link, ctx) => {
    ctx.save();
    ctx.strokeStyle = link.type === "needs" ? "rgba(255,122,122,0.72)" : "rgba(124,225,255,0.32)";
    ctx.lineWidth = link.type === "needs" ? 1.7 : 1.1;
    if (link.type === "needs") ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(link.source.x, link.source.y);
    ctx.lineTo(link.target.x, link.target.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  };

  if (!sessionId) {
    return (
      <div className="page-shell">
        <div className="landing-shell">
          <section className="landing-hero panel">
            <p className="panel-title">MindWeaver</p>
            <h1>Build a knowledge map from what you are actually learning.</h1>
            <p>
              Start a map, save the current page from the extension, or paste notes and transcripts directly.
              MindWeaver turns the work into a source-grounded map you can review, quiz, and improve.
            </p>
            <form className="start-form" onSubmit={handleCreateSession}>
              <label>
                <span>Learning goal</span>
                <textarea
                  className="text-area compact-area"
                  placeholder="Example: Build a practical mental model of event-driven systems"
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
                <div className="step-card"><strong>1. Set a goal</strong><span>Give the graph a direction so gaps and quizzes stay useful.</span></div>
                <div className="step-card"><strong>2. Capture sources</strong><span>Browse with the extension or import notes, PDF text, docs, and transcripts.</span></div>
                <div className="step-card"><strong>3. Review the map</strong><span>Approve good concepts, reject noisy ones, and use quizzes to strengthen memory.</span></div>
              </div>
            </div>

            <div className="panel">
              <p className="panel-title">Safety</p>
              <div className="safety-stack">
                <div><strong>Local-first storage</strong><span>Your graph is stored in the local server data file.</span></div>
                <div><strong>AI visibility</strong><span>{healthState?.openaiConfigured ? `OpenAI is configured. Up to ${healthState.contentLimitChars?.toLocaleString() ?? "16,000"} characters per source can be sent for classification.` : "OpenAI is not configured, so AI features will be unavailable."}</span></div>
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
                    onClick={() => window.location.assign(`${window.location.pathname}?sessionId=${encodeURIComponent(session.id)}`)}
                  >
                    <strong>{session.goal || "Untitled learning session"}</strong>
                    <span>{session.conceptCount} concepts • {session.sourceCount} sources • {session.endedAt ? "ended" : "live"}</span>
                  </button>
                )) : (
                  <div className="queue-item">
                    <h3>No maps yet</h3>
                    <div className="queue-meta">Start your first session above. The extension is optional for getting started.</div>
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="app-shell">
        <aside className="left-rail">
          <section className="panel hero-card">
            <p className="panel-title">Session Overview</p>
            <h1>{graphState?.session?.goal || "Open learning session"}</h1>
            <p>
              Turn passive browsing into a graph you can trust, review, and strengthen with better evidence.
            </p>
            <div className="stat-grid">
              <div className="stat-card">
                <span className="stat-label">Nodes</span>
                <span className="stat-value">{graphData.nodes.length}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Sources</span>
                <span className="stat-value">{graphState?.artifacts?.length ?? 0}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Needs Review</span>
                <span className="stat-value">{graphState?.reviewQueue?.length ?? 0}</span>
              </div>
            </div>
            <div className="action-row">
              <button className="primary-button" onClick={handleRunGapAnalysis} disabled={isLoadingGaps || !graphState?.goals?.length}>
                {isLoadingGaps ? "Finding gaps..." : "Run Gap Analysis"}
              </button>
              <button className="secondary-button" onClick={handleGenerateQuiz} disabled={isLoadingQuiz}>
                {isLoadingQuiz ? "Building quiz..." : "Generate Quiz"}
              </button>
              <button className="ghost-button" onClick={handleEndSession} disabled={isEndingSession || graphState?.session?.endedAt}>
                {graphState?.session?.endedAt ? "Session Ended" : isEndingSession ? "Ending..." : "End Session"}
              </button>
            </div>
            {statusMessage ? <div className="message-banner">{statusMessage}</div> : null}
            {errorMessage ? <div className="message-banner error-banner">{errorMessage}</div> : null}
          </section>

          <section className="panel safety-panel">
            <p className="panel-title">Privacy & Control</p>
            <p className="panel-subtitle">
              Local storage is used for the graph. AI classification uses configured OpenAI calls, capped at {healthState?.contentLimitChars?.toLocaleString() ?? "16,000"} characters per source.
            </p>
            <div className="queue-actions">
              <button className="small-button" onClick={() => window.location.assign(window.location.pathname)}>All Maps</button>
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

          <section className="panel scroll-panel">
            <p className="panel-title">{graphState?.studyPlan?.title ?? "Study Plan"}</p>
            <p className="panel-subtitle">
              A realistic next session, sized to about {graphState?.studyPlan?.totalMinutes ?? 15} minutes.
            </p>
            <div className="study-steps">
              {(graphState?.studyPlan?.steps ?? []).map((step, index) => (
                <div key={`${step.title}-${index}`} className="study-step">
                  <span>{step.minutes}m</span>
                  <div>
                    <strong>{step.title}</strong>
                    <p>{step.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="panel scroll-panel">
            <p className="panel-title">Progress Report</p>
            <p className="panel-subtitle">
              Session and long-term learning health, based on concepts, evidence, and verification.
            </p>
            <div className="progress-grid">
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
          </section>

          <section className="panel scroll-panel">
            <p className="panel-title">Graph Assistant</p>
            <p className="panel-subtitle">
              Ask questions against this map. Answers are grounded in matching concepts and sources.
            </p>
            <div className="import-form">
              <textarea
                className="text-area compact-area"
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
          </section>

          <section className="panel scroll-panel">
            <p className="panel-title">Next Actions</p>
            <p className="panel-subtitle">
              Recommendations are built from review due dates, low-evidence concepts, and your latest gap analysis.
            </p>
            <div className="review-list">
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
          </section>

          <section className="panel scroll-panel">
            <p className="panel-title">Review Queue</p>
            <p className="panel-subtitle">
              These concepts are low-confidence or due for spaced review. Approve them when they look right, or reject them to clean the session graph.
            </p>
            <div className="review-list">
              {graphState?.reviewQueue?.length ? graphState.reviewQueue.map((node) => (
                <div key={node.id} className="queue-item">
                  <h3>{node.label}</h3>
                  <div className="queue-meta">
                    Confidence {Math.round((node.confidence ?? 0) * 100)}% • Evidence {node.evidenceCount} • {describeReviewDate(node.nextReviewAt)}
                  </div>
                  <div className="queue-actions">
                    <button className="small-button" onClick={() => setSelectedNodeId(node.id)}>Inspect</button>
                    <button className="small-button is-approve" disabled={isReviewing} onClick={() => handleReview(node.id, "approve")}>Approve</button>
                    <button className="small-button is-reject" disabled={isReviewing} onClick={() => handleReview(node.id, "reject")}>Reject</button>
                  </div>
                </div>
              )) : <div className="queue-item"><h3>Queue cleared</h3><div className="queue-meta">Nothing is waiting for review right now.</div></div>}
            </div>
          </section>

          <section className="panel scroll-panel" ref={importPanelRef}>
            <p className="panel-title">Import Sources</p>
            <p className="panel-subtitle">
              Add manual notes, PDF text, or YouTube transcripts so the graph is not limited to passive browser capture.
            </p>
            <form className="import-form" onSubmit={handleImportSubmit}>
              <select className="text-input" value={importForm.sourceType} onChange={(event) => handleImportChange("sourceType", event.target.value)}>
                <option value="note">Manual Note</option>
                <option value="pdf">PDF Text</option>
                <option value="youtube">YouTube Transcript</option>
                <option value="doc">Document</option>
                <option value="markdown">Markdown Notes</option>
                <option value="bookmark">Bookmark</option>
                <option value="repo">Repository / Docs</option>
                <option value="highlight">Highlight</option>
              </select>
              <input className="text-input" placeholder="Title" value={importForm.title} onChange={(event) => handleImportChange("title", event.target.value)} />
              <input className="text-input" placeholder="Optional source URL" value={importForm.url} onChange={(event) => handleImportChange("url", event.target.value)} />
              <textarea
                className="text-area"
                placeholder="Paste the note, transcript, or extracted PDF text here..."
                value={importForm.content}
                onChange={(event) => handleImportChange("content", event.target.value)}
              />
              <input className="text-input" type="file" accept=".txt,.md,.text" onChange={handleImportFile} />
              <div className={`char-meter ${importIsTooLong ? "is-danger" : ""}`}>
                {importContentLength.toLocaleString()} / {maxImportChars.toLocaleString()} characters. OpenAI classification reads up to {healthState?.contentLimitChars?.toLocaleString() ?? "16,000"} characters.
              </div>
              {importIsTooLong ? <div className="message-banner error-banner">This import is too large. Trim it or split it into multiple sources before importing.</div> : null}
              <button className="primary-button" type="submit" disabled={isImporting || importIsTooLong}>
                {isImporting ? "Importing..." : "Import Into Session"}
              </button>
            </form>
            <div className="summary-card">
              <h3>Bulk Markdown / Reading List Import</h3>
              <div className="queue-meta">Paste multiple notes or saved-reading extracts. Separate each item with a line containing ---.</div>
              <div className="import-form">
                <textarea
                  className="text-area"
                  placeholder={"Note one...\n---\nNote two..."}
                  value={bulkImportText}
                  onChange={(event) => setBulkImportText(event.target.value)}
                />
                <button className="secondary-button" type="button" disabled={isBulkImporting || !bulkImportText.trim()} onClick={handleBulkImport}>
                  {isBulkImporting ? "Bulk importing..." : "Bulk Import"}
                </button>
              </div>
            </div>
            <div className="review-list">
              {(graphState?.artifacts ?? []).slice(-4).reverse().map((artifact) => (
                <div key={artifact.id} className="queue-item">
                  <h3>{artifact.title}</h3>
                  <div className="queue-meta">{artifact.sourceType || "page"} • {artifact.contentLength} chars</div>
                  <div className="queue-actions">
                    <button className="small-button is-reject" type="button" disabled={isDeletingArtifact} onClick={() => handleDeleteArtifact(artifact.id)}>
                      Remove Source
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="panel scroll-panel">
            <p className="panel-title">Gap Analysis</p>
            <p className="panel-subtitle">
              Use the current graph plus your session goal to spot missing concepts and choose the next learning move.
            </p>
            {gapSummary ? (
              <div className="summary-card">
                <h3>{gapSummary.gaps?.length ? `${gapSummary.gaps.length} gap${gapSummary.gaps.length === 1 ? "" : "s"} found` : "No explicit gaps yet"}</h3>
                <div className="quiz-meta">Difficulty: {gapSummary.difficulty || "unknown"}</div>
                {gapSummary.gaps?.length ? (
                  <div className="queue-meta">Missing concepts: {gapSummary.gaps.join(", ")}</div>
                ) : (
                  <div className="queue-meta">The current session already covers the obvious next concepts. Keep verifying what you know.</div>
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
          </section>

          <section className="panel scroll-panel">
            <p className="panel-title">Quiz Loop</p>
            <p className="panel-subtitle">
              Generate a short spaced-review quiz, answer it here, and feed the results back into the graph confidence model.
            </p>
            {quizState.message ? <div className="summary-card"><h3>Quiz status</h3><div className="queue-meta">{quizState.message}</div></div> : null}
            {quizState.quiz?.length ? (
              <>
                <div className="quiz-list">
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
          </section>
        </aside>

        <main className="graph-card">
          <div className="graph-toolbar">
            <div>
              <h2>Knowledge Graph</h2>
              <p>{isLoadingGraph ? "Refreshing graph..." : `${graphData.nodes.length} visible nodes. Search, filter, then click a node to inspect it.`}</p>
            </div>
            <div className="graph-controls">
              <input
                className="text-input graph-search"
                placeholder="Search nodes..."
                value={nodeSearch}
                onChange={(event) => setNodeSearch(event.target.value)}
              />
              <select className="text-input graph-filter" value={nodeTypeFilter} onChange={(event) => setNodeTypeFilter(event.target.value)}>
                <option value="all">All Types</option>
                <option value="goal">Goals</option>
                <option value="domain">Domains</option>
                <option value="skill">Skills</option>
                <option value="concept">Concepts</option>
              </select>
              <button className="small-button" onClick={handleGraphSearch} disabled={isSearchingGraph || !nodeSearch.trim()}>
                {isSearchingGraph ? "Searching..." : "Search Evidence"}
              </button>
            </div>
            <div className="status-pill">
              <span>{graphState?.session?.endedAt ? "Ended" : "Live session"}</span>
              <span>•</span>
              <span>{graphState?.artifacts?.length ?? 0} sources</span>
            </div>
          </div>
          {searchResults.length ? (
            <div className="search-results-strip">
              {searchResults.slice(0, 6).map((result) => (
                <button
                  key={`${result.kind}-${result.id}`}
                  className="search-chip"
                  onClick={() => result.kind === "node" ? setSelectedNodeId(result.id) : null}
                >
                  <strong>{result.label}</strong>
                  <span>{result.kind} • {result.type}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="graph-canvas" ref={graphContainerRef}>
            {!isLoadingGraph && graphData.nodes.length === 0 ? (
              <div className="graph-empty">
                <p className="panel-title">Start Building</p>
                <h3>No visible map nodes yet</h3>
                <p>Set a goal, import a note, or browse with the extension. Once sources are classified, your knowledge map will appear here.</p>
                <button className="primary-button" onClick={() => importPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                  Import First Source
                </button>
              </div>
            ) : null}
            <ForceGraph2D
              ref={fgRef}
              graphData={graphData}
              width={graphSize.width}
              height={graphSize.height}
              backgroundColor="rgba(0,0,0,0)"
              nodeCanvasObject={handleNodeRender}
              nodePointerAreaPaint={handlePointerPaint}
              linkCanvasObject={handleLinkRender}
              linkWidth={() => 1}
              linkColor={() => "rgba(255,255,255,0.18)"}
              onNodeClick={(node) => setSelectedNodeId(node.id)}
              nodeRelSize={4}
              warmupTicks={120}
              cooldownTicks={90}
              d3VelocityDecay={0.28}
            />
          </div>
        </main>

        <aside className="right-rail">
          <section className="panel scroll-panel">
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
                    <select
                      className="text-input"
                      value={nodeEditForm.masteryState}
                      onChange={(event) => setNodeEditForm((current) => ({ ...current, masteryState: event.target.value }))}
                    >
                      <option value="new">New</option>
                      <option value="seen">Seen</option>
                      <option value="understood">Understood</option>
                      <option value="verified">Verified</option>
                    </select>
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
                      <select className="text-input" value={mergeTargetId} onChange={(event) => setMergeTargetId(event.target.value)}>
                        <option value="">Merge into...</option>
                        {mergeCandidateNodes.map((node) => (
                          <option key={node.id} value={node.id}>{node.label}</option>
                        ))}
                      </select>
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
                    <select className="text-input" value={relationshipForm.targetId} onChange={(event) => setRelationshipForm((current) => ({ ...current, targetId: event.target.value }))}>
                      <option value="">Connect to...</option>
                      {(graphState?.nodes ?? []).filter((node) => node.id !== selectedNode.id && visibleNodeTypes.includes(node.type)).map((node) => (
                        <option key={node.id} value={node.id}>{node.label}</option>
                      ))}
                    </select>
                    <select className="text-input" value={relationshipForm.type} onChange={(event) => setRelationshipForm((current) => ({ ...current, type: event.target.value }))}>
                      <option value="related">Related</option>
                      <option value="prerequisite">Prerequisite</option>
                      <option value="supports">Supports</option>
                      <option value="contrasts">Contrasts</option>
                    </select>
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
                    <select className="text-input" value={intersectionTargetId} onChange={(event) => setIntersectionTargetId(event.target.value)}>
                      <option value="">Compare with...</option>
                      {(graphState?.nodes ?? []).filter((node) => node.id !== selectedNode.id && visibleNodeTypes.includes(node.type)).map((node) => (
                        <option key={node.id} value={node.id}>{node.label}</option>
                      ))}
                    </select>
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
                        <div className="muted-copy">{source.sourceType || "page"} • {source.url}</div>
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
          </section>
        </aside>
      </div>
    </div>
  );
}
