# MindWeaver MCP Server

MindWeaver includes a stdio Model Context Protocol server that lets Codex, Claude Code, and other MCP clients read, search, traverse, and safely extend local knowledge maps.

## Is This A Good Idea?

Yes, with guardrails. MindWeaver is already a durable graph, so exposing it through MCP turns it into shared project memory for coding agents instead of another chat-only note pile.

The useful pattern is:

- Agents read the graph before acting.
- Agents add bounded, source-aware concepts and relationships.
- Agents update node notes with reasoning, evidence, and follow-up context.
- Humans still use the MindWeaver UI to review, merge, prune, and curate.

The risky pattern is letting agents destructively rewrite memory. This MCP server intentionally does not expose delete, bulk restore, or prune tools. It favors additive writes and explicit node updates.

## What It Exposes

Resources:

| URI | Purpose |
| --- | --- |
| `mindweaver://maps` | Lists maps with graph counts. |
| `mindweaver://maps/{sessionId}/graph` | Reads a full JSON graph for one map. |

Prompt:

| Name | Purpose |
| --- | --- |
| `mindweaver_graph_brief` | Generates a prompt for an evidence-aware graph briefing. |

Tools:

| Tool | Purpose |
| --- | --- |
| `mindweaver_list_maps` | List local maps and active-map state. |
| `mindweaver_create_map` | Create a new map and make it active. |
| `mindweaver_get_graph` | Read a compact or full graph. |
| `mindweaver_search_graph` | Search node labels, summaries, notes, and evidence. |
| `mindweaver_get_node` | Read one node, its note/history, and neighbors. |
| `mindweaver_traverse_graph` | Traverse from a node up to a bounded depth. |
| `mindweaver_add_node` | Add a `goal`, `area`, `domain`, `topic`, `skill`, or `concept`. |
| `mindweaver_update_node` | Update label, description, summary, semantic roles, or node note. |
| `mindweaver_add_edge` | Add and approve a relationship between existing nodes. |

## Run It

From the repo root:

```bash
npm --prefix server run mcp
```

The server speaks MCP over stdio. Do not run it in a normal terminal expecting an HTTP URL; an MCP client should launch it as a child process.

On Windows, use the batch wrapper when a client prefers a `.bat` command:

```powershell
G:\Projects\MindWeaver\start-mcp.bat
```

Packaged desktop builds also generate a launcher in your MindWeaver app-data folder:

```text
%APPDATA%\MindWeaver\start-mindweaver-mcp.bat
```

That generated launcher uses the installed MindWeaver executable as Node through `ELECTRON_RUN_AS_NODE`, so end users do not need to install Node just to use MCP.

On first launch, the setup window includes a `Connect Coding Agent` step with:

- `Copy Codex Config`
- `Add to Codex Config`
- `Copy Claude Code Config`
- `Open Config Help`
- `Test Agent Launcher`
- `Copy Chrome Extension Folder`
- `Open Chrome Setup`
- a short post-install checklist

By default, it uses the shared local MindWeaver graph file:

```text
%APPDATA%\MindWeaver\mindweaver-data.json
```

To point at another MindWeaver data file:

```bash
MINDWEAVER_DATA_FILE=/absolute/path/to/data.json npm --prefix server run mcp
```

PowerShell:

```powershell
$env:MINDWEAVER_DATA_FILE="C:\Users\You\AppData\Roaming\MindWeaver\mindweaver-data.json"
npm --prefix server run mcp
```

## Codex Configuration

In the desktop app, open `Agent Access` and choose `Add to Codex Config` to update your Codex config file automatically. MindWeaver appends or replaces only its own `mindweaver` MCP section in:

```text
%USERPROFILE%\.codex\config.toml
```

It preserves existing Codex settings, projects, profiles, plugins, and other MCP servers. Restart Codex after adding the config.

You can still choose `Copy Codex Config` if you prefer to paste the values manually. The config includes the generated launcher path and the active desktop data file.

For source checkouts, add an MCP server entry that launches Node against `server/mcp.js`.

Example:

```json
{
  "mcpServers": {
    "mindweaver": {
      "command": "node",
      "args": ["G:\\Projects\\MindWeaver\\server\\mcp.js"],
      "env": {
        "MINDWEAVER_DATA_FILE": "G:\\Projects\\MindWeaver\\server\\data.json"
      }
    }
  }
}
```

Use absolute paths. On Windows, JSON strings need escaped backslashes.

Windows batch-file variant:

```json
{
  "mcpServers": {
    "mindweaver": {
      "command": "cmd.exe",
      "args": ["/d", "/s", "/c", "G:\\Projects\\MindWeaver\\start-mcp.bat"],
      "env": {
        "MINDWEAVER_DATA_FILE": "G:\\Projects\\MindWeaver\\server\\data.json"
      }
    }
  }
}
```

## Claude Code Configuration

Claude Code can launch stdio MCP servers. A typical local entry is:

```json
{
  "mcpServers": {
    "mindweaver": {
      "command": "node",
      "args": ["G:\\Projects\\MindWeaver\\server\\mcp.js"],
      "env": {
        "MINDWEAVER_DATA_FILE": "G:\\Projects\\MindWeaver\\server\\data.json"
      }
    }
  }
}
```

After restarting the client, ask it to list available MCP tools and look for the `mindweaver_*` tools.

Windows batch-file variant:

```json
{
  "mcpServers": {
    "mindweaver": {
      "command": "cmd.exe",
      "args": ["/d", "/s", "/c", "G:\\Projects\\MindWeaver\\start-mcp.bat"],
      "env": {
        "MINDWEAVER_DATA_FILE": "G:\\Projects\\MindWeaver\\server\\data.json"
      }
    }
  }
}
```

## Suggested Agent Workflow

1. Call `mindweaver_list_maps`.
2. Pick a map and call `mindweaver_get_graph` with `compact: true`.
3. Use `mindweaver_search_graph` before adding anything.
4. Use `mindweaver_get_node` or `mindweaver_traverse_graph` to inspect nearby context.
5. Add only the smallest useful node or edge.
6. Put caveats, source hints, and unresolved questions in node notes.

Good node note:

```markdown
Observed while implementing the MCP server.

- Codex and Claude Code both benefit from stable stdio launch instructions.
- Destructive graph operations should stay out of the MCP surface until review controls exist.
- Follow up: add an import-source tool only if it can preserve provenance cleanly.
```

## Tool Examples

Create a map:

```json
{
  "title": "Shared agent memory",
  "description": "Durable concepts and decisions for coding agents."
}
```

Add a concept:

```json
{
  "sessionId": "map-session-id",
  "type": "concept",
  "label": "bounded graph writes",
  "description": "Agents can add memory without deleting or bulk rewriting existing graph state.",
  "note": "Prefer additive MCP tools until human review is available."
}
```

Add a relationship:

```json
{
  "sessionId": "map-session-id",
  "sourceId": "domain-node-id",
  "targetId": "concept-node-id",
  "type": "supports",
  "label": "supports safe shared memory"
}
```

Traverse from a node:

```json
{
  "sessionId": "map-session-id",
  "startNodeId": "concept-node-id",
  "depth": 2,
  "direction": "both"
}
```

## MindWeaver Sync Behavior

MindWeaver MCP writes land in the same local graph file the desktop app uses.

- MCP mutations persist immediately to disk.
- The desktop app now refreshes from that shared file on reads, so MCP-created maps and node edits do not get overwritten by stale in-memory state.
- The desktop UI also listens for local graph-file changes and reloads the current map automatically, so MCP edits usually show up a moment later without pressing refresh.

This is near-real-time local sync, not a remote collaboration protocol. If multiple agent clients are heavily mutating the same graph at once, changes still serialize through the shared JSON file.

## Data Safety

The server reads from disk before each tool call and writes the lowdb file after mutations. This keeps it usable alongside the web app for normal local workflows.

Avoid running multiple long-lived MCP clients that heavily mutate the same `data.json` at the same time. lowdb is a JSON-file store, not a transactional database.

The MCP surface intentionally omits:

- delete map
- delete node
- delete edge
- restore backup
- prune
- bulk import

Those remain better suited to the MindWeaver UI or reviewed API workflows.

## Development

Run the MCP tests:

```bash
npm --prefix server test -- tests/mcp.test.js
```

Run the full server test suite:

```bash
npm --prefix server test
```

The tests cover direct graph operations and a real stdio MCP client launching `server/mcp.js`.
