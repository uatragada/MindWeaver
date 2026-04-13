export const visibleNodeTypes = ["goal", "domain", "skill", "concept"];
export const OPEN_TABS_STORAGE_KEY = "mindweaver:open-map-tabs:v1";
export const TAB_VIEW_STORAGE_KEY = "mindweaver:tab-view-state:v1";
export const DEFAULT_LLM_PROVIDER = "openai";
export const DEFAULT_LOCAL_LLM_MODEL = "qwen3.5:4b";
export const EMPTY_QUIZ_STATE = { quiz: [], message: "" };
export const EMPTY_IMPORT_FORM = {
  sourceType: "note",
  title: "",
  url: "",
  content: ""
};
export const DEFAULT_TAB_VIEW = {
  selectedNodeId: null,
  rightPanel: "inspector",
  leftRailMinimized: false,
  rightRailMinimized: true,
  nodeSearch: "",
  nodeTypeFilter: "all"
};

export const RIGHT_PANEL_LABELS = {
  inspector: "Inspector",
  assistant: "Graph Assistant",
  actions: "Next Actions",
  review: "Review Queue",
  plan: "Study Plan",
  progress: "Progress",
  import: "Import Sources",
  gaps: "Gap Analysis",
  quiz: "Quiz Loop"
};

export const NODE_TYPE_OPTIONS = [
  { value: "all", label: "All Types" },
  { value: "goal", label: "Goal Nodes" },
  { value: "domain", label: "Domains" },
  { value: "skill", label: "Skills" },
  { value: "concept", label: "Concepts" }
];

export const SOURCE_TYPE_OPTIONS = [
  { value: "note", label: "Manual Note" },
  { value: "pdf", label: "PDF Text" },
  { value: "youtube", label: "YouTube Transcript" },
  { value: "doc", label: "Document" },
  { value: "markdown", label: "Markdown Notes" },
  { value: "bookmark", label: "Bookmark" },
  { value: "repo", label: "Repository / Docs" },
  { value: "highlight", label: "Highlight" }
];

export const CHAT_IMPORT_PROVIDER_OPTIONS = [
  { value: "chatgpt", label: "ChatGPT" },
  { value: "claude", label: "Claude" }
];

export const LLM_PROVIDER_OPTIONS = [
  { value: "openai", label: "OpenAI" },
  { value: "local", label: "Local (Ollama)" }
];

export const LOCAL_LLM_MODEL_OPTIONS = [
  { value: DEFAULT_LOCAL_LLM_MODEL, label: "Qwen3.5 4B" }
];

export const MASTERY_OPTIONS = [
  { value: "new", label: "New" },
  { value: "seen", label: "Seen" },
  { value: "understood", label: "Understood" },
  { value: "verified", label: "Verified" }
];

export const RELATIONSHIP_TYPE_OPTIONS = [
  { value: "related", label: "Related" },
  { value: "prerequisite", label: "Prerequisite" },
  { value: "supports", label: "Supports" },
  { value: "contrasts", label: "Contrasts" }
];
