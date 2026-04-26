# Development Guide

This guide covers local setup, common workflows, verification, and release hygiene.

## Prerequisites

- Node.js and npm.
- Chrome or Chromium for the unpacked extension.
- Either an OpenAI API key or a local Ollama install for AI-backed classification and learning features.

## Install

From the repo root:

```bash
npm run setup
```

Create local secrets:

```bash
copy server\.env.example server\.env.local
```

Then set `OPENAI_API_KEY` in `server/.env.local`.

For the packaged Windows desktop app, the first launch after install prompts for `OPENAI_API_KEY` and writes it to the desktop app's user-data `.env.local`, so the installed app does not rely on editing files inside the installation directory.

## Scripts

Run both dev servers:

```bash
npm run dev
```

Run backend tests:

```bash
npm run test
```

Run frontend unit tests:

```bash
npm run test:web
```

Run the main readiness check:

```bash
npm run check
```

Run the browser-extension integration flow:

```bash
npm run test:extension:integration
```

Build the web app:

```bash
npm run build
```

Serve production-style local mode:

```bash
npm run start
```

Replay fixture imports:

```bash
npm run eval:fixtures
```

## Ports

- API server: `3001`
- Vite web dev server: `5197`
- Old Vite default `5173` is intentionally avoided so other projects can use it.

## Frontend Structure

The web app is now split into a few clear layers instead of keeping all helper logic inside `web/src/App.jsx`:

- `web/src/components/`: presentational UI slices and shared controls
- `web/src/components/graph/`: graph-only workspace widgets such as the minimap
- `web/src/components/notes/`: Markdown note rendering helpers
- `web/src/hooks/`: reusable hooks for route state and local storage
- `web/src/lib/`: pure helpers, constants, graph rendering helpers, graph traversal/layout helpers, and import parsing
- `web/src/App.jsx`: top-level workspace coordination and API-driven flows

The server follows a similar split:

- `server/app.js`: route wiring
- `server/services/`: extracted graph, import, refine, learning, and shared business logic

When refactoring, prefer moving pure logic into `lib/` first, then extracting stable UI sections into `components/`.

## Extension Workflow

1. Start the local server with `npm run dev` or `npm run start`.
2. Open `chrome://extensions`.
3. Enable Developer Mode.
4. Load the `extension/` folder as an unpacked extension.
5. After changing extension files, reload the unpacked extension in Chrome.

The extension supports one-shot saves and an optional continuous-save toggle for newly visited pages. It still injects extraction through the background worker instead of registering a permanent content script.

The Electron installer also bundles that unpacked extension as a packaged resource for desktop users.

## Data During Development

Source checkouts use `server/data.json` by default. It is ignored by Git and can be deleted if you want a clean local state. The server recreates the default structure on startup.

The packaged desktop app and generated MCP launcher use the shared desktop data file instead:

```text
%APPDATA%\MindWeaver\mindweaver-data.json
```

Set `MINDWEAVER_DATA_FILE` when you want development, desktop, and MCP clients to point at a specific graph file.

Do not commit:

- `server/data.json`,
- `.env` files,
- backups,
- `node_modules`,
- `web/dist`.

## Testing Checklist

Before pushing meaningful code changes, run:

```bash
npm run check
npm run test:extension:integration
```

For security-sensitive or release-prep changes, also run:

```bash
npm --prefix server audit
npm --prefix web audit
npm run eval:fixtures
```

## Production-Style Smoke Test

1. Run `npm run build`.
2. Run `npm run start`.
3. Open `http://127.0.0.1:3001`.
4. Check `http://127.0.0.1:3001/api/health`.
5. Create or open a map.
6. Save a page from the extension.
7. Confirm the graph updates after an extension save or external file change.
8. Select a node, open the inspector note editor, and verify Markdown note write/preview/fullscreen flows still work.

## Git Hygiene

This repo is connected to `uatragada/MindWeaver` on GitHub.

Before committing, confirm sensitive files are not staged:

```bash
git status --short --ignored
git diff --cached --name-only
```

The ignored files should include `server/.env.local`, `server/data.json`, `server/node_modules/`, `web/node_modules/`, and `web/dist/`.

## Troubleshooting

- If `localhost:5197` does not load, make sure `npm run dev` started the web dev server.
- If the extension cannot save a page, make sure the API server is running on `http://localhost:3001`.
- If the extension still behaves like an older version, reload it in `chrome://extensions`.
- If AI features fail, check `server/.env.local` and restart the server.
- If the graph looks stale after an extension save or another external update, switch maps or reload the app. In normal local use, MindWeaver watches the shared graph file and refreshes the active map automatically.
