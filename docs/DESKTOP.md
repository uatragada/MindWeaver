# MindWeaver Desktop Guide

MindWeaver can run as a normal desktop app or stay available in the Windows tray, similar to apps like f.lux or Discord. The tray keeps the local MindWeaver server available for browser captures, MCP agents, and quick imports without keeping the main window open.

When MCP agents, tray actions, or the extension update the shared local graph, the desktop app refreshes the active map automatically. In normal local use, changes should appear a moment later without a manual refresh.

MindWeaver's browser/server workflow is the primary experience. The Windows desktop app is optional, and it now uses the same default graph file as the local web server so both entry points see the same maps.

## Install

Download and run the Windows installer:

```text
MindWeaver-Setup-0.1.0.exe
```

On first launch, MindWeaver opens a setup window that helps you:

- choose OpenAI or leave the key blank for Local (Ollama),
- use `Copy Chrome Extension Folder` or `Open Chrome Setup` for the packaged extension,
- connect Codex or Claude Code through MCP,
- add MindWeaver directly to Codex with `Add to Codex Config`,
- use `Test Agent Launcher` to confirm the MCP launcher works,
- finish a short post-install checklist.

The shared default graph file is:

```text
%APPDATA%\MindWeaver\mindweaver-data.json
```

## Tray Behavior

Closing the MindWeaver window hides it to the system tray instead of shutting it down. MindWeaver keeps running in the background so:

- the Chrome extension can save pages,
- `mindweaver://open` can reopen the app,
- MCP clients can use the local graph server,
- quick tray actions can send text into the active map.

To fully exit MindWeaver, use:

```text
Tray icon -> Quit MindWeaver
```

## Tray Menu

Right-click the MindWeaver tray icon to open these actions:

| Action | What it does |
| --- | --- |
| `Open MindWeaver` | Opens or focuses the main app window. |
| `Create Note` | Opens a small note window where you choose a map, define a node label/type, write a description and note, and save it into the graph. MindWeaver attaches the node through its normal hierarchy rules. |
| `Paste Clipboard Text` | Imports the current clipboard text into the active map as a manual note. |
| `Import PDF / Office / Text` | Imports `.txt`, `.md`, `.markdown`, `.text`, `.pdf`, `.docx`, and `.pptx` files into the active map after extracting readable text. |
| `Agent Access` | Opens the app to MCP setup for Codex and Claude Code. |
| `Extension Setup` | Opens the packaged Chrome extension folder. |
| `Quit MindWeaver` | Stops the background app and local server. |

## Quick Notes

The tray `Create Note` action is for lightweight capture while MindWeaver is running in the background.

The note window lets users set:

- destination map,
- node label,
- node type,
- optional description,
- note title,
- Markdown note content.

If a node label is provided, MindWeaver creates that node and attaches the note to it. If the label is blank, the content is imported as source material instead.

## Chrome Extension Launch Flow

The Windows installer registers:

```text
mindweaver://open
```

If the Chrome extension cannot reach the local MindWeaver server, the popup switches to a start-app state. Clicking `Open MindWeaver` launches the installed app through `mindweaver://open`, waits briefly for the API to come online, and refreshes the popup.

This means users do not need to manually find MindWeaver before saving a page. They can start it from the extension.

## Coding Agent Setup

MindWeaver includes a local MCP server for coding agents. In the first-run setup window or the app's `Agent Access` workspace, users can add MindWeaver directly to Codex or copy ready-to-use config for:

- Codex
- Claude Code

`Add to Codex Config` updates `%USERPROFILE%\.codex\config.toml` by appending or replacing only the managed `mindweaver` MCP server block. Existing Codex settings and other MCP servers are preserved. Restart Codex after using it.

The packaged app creates an MCP launcher in your app-data folder:

```text
%APPDATA%\MindWeaver\start-mindweaver-mcp.bat
```

That launcher uses the installed MindWeaver executable as Node, so users do not need to install Node.js separately for MCP access.

## Document Import Notes

The tray can directly import:

- `.txt`
- `.md`
- `.markdown`
- `.text`
- `.pdf`
- `.docx`
- `.pptx`

PDF, Word, and PowerPoint imports use local text extraction before sending the content to the active map. If a file cannot be parsed or contains no extractable text, MindWeaver opens the import workspace so you can finish manually.
