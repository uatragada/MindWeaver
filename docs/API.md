# API Reference

The local API runs at `http://localhost:3001` in development and production-style local mode.

All request and response bodies are JSON unless noted otherwise.

## Health And Local Workspace

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Returns server health, provider availability, selected AI settings, and content limits. |
| `GET` | `/api/workspaces` | Returns local workspace records. |
| `POST` | `/api/workspaces` | Creates a local workspace placeholder. |

## Backup And Restore

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/backup` | Downloads the full local MindWeaver data payload. |
| `POST` | `/api/restore` | Replaces local data with a MindWeaver backup when `confirm: true` is provided. |

Restore body:

```json
{
  "confirm": true,
  "backup": {
    "app": "MindWeaver",
    "version": 1,
    "data": {}
  }
}
```

## Sessions And Maps

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/sessions?limit=8` | Lists recent maps with summary counts. |
| `GET` | `/api/session-target` | Returns the shared active-map state used by the web UI and extension. |
| `PUT` | `/api/session-target` | Updates the shared active map and the tab-backed map list used by both the web UI and extension. |
| `POST` | `/api/sessions` | Creates a new learning map and optional legacy goal node. |
| `POST` | `/api/demo-session` | Creates a prebuilt demo map. |
| `PATCH` | `/api/sessions/:id` | Renames an existing map. |
| `POST` | `/api/goals` | Adds or updates a session goal. |
| `GET` | `/api/goals/:sessionId` | Lists goals for a session. |
| `POST` | `/api/sessions/:id/end` | Marks a session ended. |
| `DELETE` | `/api/sessions/:id` | Deletes a local session and session-scoped graph data. |

Create session body:

```json
{
  "goal": "Build a practical mental model of event-driven systems"
}
```

`goal` is still the field name in the data model, but in the current product this value is primarily treated as the map name.

`GET /api/session-target` and `PUT /api/session-target` return the shared capture target plus `tabSessions`, which is the server-backed list used to keep the extension destination menu aligned with the web app's map tabs.

## Sources And Imports

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/ingest` | Ingests a saved web page from the extension through the FIFO page-save queue. |
| `POST` | `/api/import` | Imports manual notes, PDF text, transcripts, Markdown, bookmarks, docs/repo excerpts, or highlights. |
| `GET` | `/api/import-chat-history/template?provider=chatgpt&sessionId=...` | Returns a copy-paste prompt template for ChatGPT or Claude. |
| `POST` | `/api/import-chat-history` | Imports structured JSON generated from external chat history. |
| `POST` | `/api/import-bulk` | Imports multiple source items at once. |
| `DELETE` | `/api/sessions/:sessionId/artifacts/:artifactId` | Removes one source artifact and detaches it from node evidence. |

Allowed `sourceType` values:

- `page`
- `note`
- `pdf`
- `youtube`
- `transcript`
- `doc`
- `markdown`
- `bookmark`
- `repo`
- `highlight`

Single import body:

```json
{
  "sessionId": "session-id",
  "sourceType": "note",
  "title": "Reliable consumers note",
  "url": "https://example.com/optional-source",
  "excerpt": "Optional short summary",
  "content": "Source text to classify and attach to the graph."
}
```

The server accepts source content up to 80,000 characters when using OpenAI and up to 128,000 characters when using a local Ollama model. OpenAI classification reads up to 16,000 characters per source, while local models can read up to 128,000 characters per source. Page saves are processed one at a time, and exact duplicate labels are collapsed automatically after ingest/import updates.

Chat-history import body:

```json
{
  "sessionId": "session-id",
  "importData": {
    "schema_version": "mindweaver.chat_import.v1",
    "provider": "chatgpt",
    "title": "System design history",
    "summary": "Broad summary of the imported conversation history.",
    "conversation_highlights": [],
    "nodes": [],
    "relationships": []
  }
}
```

## Graph

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/graph/:sessionId` | Returns session-scoped nodes, edges, artifacts, review queue, recommendations, health, and study plan. |
| `GET` | `/api/review/:sessionId` | Returns the current review queue. |
| `GET` | `/api/recommendations/:sessionId` | Returns next-step recommendations. |
| `GET` | `/api/progress/:sessionId` | Returns session and long-term progress summaries. |
| `GET` | `/api/search/:sessionId?q=query` | Searches concepts, goals, and evidence for a session. |
| `GET` | `/api/sessions/:id/export?format=json` | Exports a map as JSON. |
| `GET` | `/api/sessions/:id/export?format=markdown` | Exports a map as Markdown. |

## Node And Edge Cleanup

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/nodes/:id/review` | Approves or rejects a node for a session. |
| `PATCH` | `/api/nodes/:id` | Edits a node label, description, summary, or mastery state. |
| `POST` | `/api/nodes/:id/merge` | Merges the source node into a target node for the session. |
| `POST` | `/api/edges` | Adds a manual relationship between two nodes. |
| `POST` | `/api/edges/:key/review` | Approves or rejects a graph edge for a session. |
| `POST` | `/api/prune` | Finds or removes low-confidence concepts with no direct evidence. |
| `POST` | `/api/nodes` | Creates a manual node, including top-level goal nodes when needed. |

MindWeaver also runs conservative exact-label dedupe after `POST /api/ingest`, `POST /api/import`, `POST /api/nodes`, `PATCH /api/nodes/:id`, and `POST /api/refine`, so repeated saves or label edits collapse back onto one visible canonical node.

Node review body:

```json
{
  "sessionId": "session-id",
  "action": "approve"
}
```

Node edit body:

```json
{
  "sessionId": "session-id",
  "label": "consumer lag monitoring",
  "description": "Tracks delayed consumers.",
  "summary": "Use consumer lag to notice when downstream systems fall behind.",
  "masteryState": "verified"
}
```

Merge body:

```json
{
  "sessionId": "session-id",
  "targetId": "concept:consumer lag"
}
```

Manual relationship body:

```json
{
  "sessionId": "session-id",
  "sourceId": "concept:producer",
  "targetId": "concept:consumer",
  "type": "related",
  "label": "communicates with"
}
```

## Learning And Assistant Features

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/gaps` | Runs gap analysis for a session goal and can create missing-concept nodes. |
| `POST` | `/api/quiz` | Generates a spaced-review quiz for review-worthy concepts. |
| `POST` | `/api/verify` | Applies quiz results to confidence and review scheduling. |
| `POST` | `/api/chat` | Answers a source-grounded question against the graph. |
| `GET` | `/api/summary/:sessionId` | Generates and stores a learning summary. |
| `POST` | `/api/refine` | Reviews the current graph and applies conservative cleanup or relabeling. |
| `POST` | `/api/intersect` | Finds a bridge between two graph nodes. |
| `POST` | `/api/learn-more` | Generates a short explanation for a selected node. |

Gap analysis body:

```json
{
  "sessionId": "session-id",
  "goalId": "goal-node-id"
}
```

Quiz verification body:

```json
{
  "sessionId": "session-id",
  "conceptIds": ["concept:idempotency"],
  "correct": true
}
```

Chat body:

```json
{
  "sessionId": "session-id",
  "question": "What should I study next?"
}
```

## AI Provider Notes

MindWeaver can run AI-backed endpoints with either OpenAI or a local Ollama model. OpenAI-backed routes use the server-side `OPENAI_API_KEY` from `server/.env.local`, while local mode uses the selected Ollama model reported by `GET /api/health`. Classification, quiz generation, gap analysis, chat enrichment, and explanations are most useful when at least one provider is configured.
