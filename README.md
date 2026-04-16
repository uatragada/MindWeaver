<img width="1440" height="1502" alt="image" src="https://github.com/user-attachments/assets/0e08e6cc-81e6-49ac-9f4d-78455edfc289" />

## What It Does

- Capture source material from the Chrome extension or paste it directly into the app.
- Organize learning into named maps, domains, skills, concepts, and relationships.
- Run AI-backed classification and cleanup with OpenAI or a local Ollama model.
- Keep provenance visible so every concept can be traced back to source material.
- Review noisy AI output instead of trusting it blindly.
- Attach session-scoped Markdown notes to nodes and expand them into a fullscreen note editor.
- Run gap analysis, study plans, quiz loops, and source-grounded graph chat.
- Export maps as Markdown, JSON, or full local backups.

## What It Looks Like


| Graph workspace | Extension |
| --- | --- |
| ![Graph workspace](https://github.com/user-attachments/assets/be254e05-a609-46b9-93d0-ca3389bd0859) | ![Extension](https://github.com/user-attachments/assets/f20d6164-02a7-4eaa-a132-d3172a42180d) |


## Quick Start

### 1. Install dependencies

```bash
npm run setup
```

### 2. Create a local env file

```bash
copy server\.env.example server\.env.local
```

Then edit `server/.env.local`.

If you want AI-powered classification, chat, quizzes, and richer gap analysis, set:

```bash
OPENAI_API_KEY=your_key_here
```

If you prefer local AI, install Ollama and pull a model such as `qwen3.5:4b`, then choose `Local (Ollama)` inside MindWeaver. Local mode keeps AI requests on-device and raises source/page limits to 128,000 characters per save or import.

MindWeaver still runs without an OpenAI key, but some features fall back to simpler local behavior unless you select a local Ollama model.

### 3. Start the app

```bash
npm run dev
```

That starts:

- web app: `http://127.0.0.1:5197`
- API server: `http://127.0.0.1:3001`

### 3b. Start the desktop app

If you want MindWeaver as a standalone Windows desktop shell instead of running it in the browser:

```bash
npm run electron:dev
```

That starts the local API server, starts the React dev renderer, and opens MindWeaver in Electron.

### 4. Fastest possible first run

1. Open `http://127.0.0.1:5197`
2. Click `Try A Demo Map`
3. Click nodes in the graph
4. Open `Inspector`
5. Open `Import Sources`
6. Run `Gap Analysis` or `Generate Quiz`

If you just want to kick the tires, the demo map is the best starting point.

## Windows Shortcuts

If you want double-click shortcuts on Windows:

- `quick-start-first-time.bat`: installs dependencies, prompts for `OPENAI_API_KEY`, writes `server/.env.local`, asks where `chrome.exe` lives, and launches Chrome with the unpacked extension loaded.
- `quick-start-dev.bat`: starts the backend and web dev server together so the app is available at `http://127.0.0.1:3001` and `http://127.0.0.1:5197`.

## Production-Style Local Run

If you want a single-server local run that serves the built app through Express:

```bash
npm run build
npm run start
```

Then open:

- app: `http://127.0.0.1:3001`
- health: `http://127.0.0.1:3001/api/health`

On Windows, you can also double-click:

- [`start-app.bat`](start-app.bat)
- [`start-production.bat`](start-production.bat)

## Windows Desktop Packaging

To build a Windows installer with Electron:

```bash
npm run electron:build
```

That produces an installer in `release/`.

## A 5-Minute Tour

### 1. Start with a map

Create a fresh map for something concrete:

- "Build a practical mental model of event-driven systems"
- "Understand RL enough to implement PPO"
- "Learn the moving parts of Stripe subscriptions"

A strong map name gives the graph a direction. If you want extra structure later, you can still add goal nodes inside the map.

### 2. Add source material

You can use MindWeaver in two ways:

- with the Chrome extension for saving live pages and selected highlights
- without the extension by importing notes, transcripts, PDF text, bookmarks, docs, and Markdown directly in the app

The import panel supports:

- manual notes
- PDF text
- YouTube transcripts
- documents
- Markdown notes
- bookmarks
- repository/docs excerpts
- highlights

### 3. Review the graph

The graph is the main character of the product.

Use it to:

- search nodes
- filter by type
- navigate with the minimap, branch focus, and path-to-root tools
- refresh the canvas manually after extension saves or other external updates
- inspect one concept at a time
- merge duplicates
- approve or reject weak nodes
- add or review relationships

### 4. Clean up concepts

The `Inspector` lets you:

- rename nodes
- write your own explanation
- add session-scoped Markdown notes with write/preview and fullscreen editing
- adjust semantic roles when one node plays more than one role in the map
- change mastery state
- merge duplicates
- review edge quality
- remove bad evidence

This is where MindWeaver becomes your tool instead of an opaque classifier.

### 5. Strengthen the map

The right-side workspaces are built around actual study actions:

- `Graph Assistant` for source-grounded questions
- `Next Actions` for concrete follow-up work
- `Review Queue` for noisy or weak concepts
- `Import Sources` for adding material
- `Gap Analysis` for missing areas
- `Quiz Loop` for spaced-review questions
- `Progress Report` for session history

### 6. Export what matters

When the map is useful, you can:

- export Markdown
- export JSON
- download a full backup
- restore from backup later

## Use It Without The Extension

You do not need the browser extension to get value from MindWeaver.

Good local-only workflows:

- paste lecture notes after a study session
- import a transcript from a video you watched
- paste text from a PDF you already own
- dump saved reading notes as Markdown
- add repo docs or architecture notes before a project deep dive


## Use It With The Chrome Extension

Load the extension from [`extension/`](extension/README.md):

1. Open `chrome://extensions`
2. Enable Developer Mode
3. Click `Load unpacked`
4. Select the [`extension`](extension) folder
5. Make sure the MindWeaver server is running locally
6. Click the extension icon
7. Save the current page, save selected text, or turn on `Continuous Save`

The extension is explicit by default and can switch into a user-enabled continuous-save mode:

- it injects extraction only after you click save or turn on `Continuous Save`
- it can automatically save newly visited pages only while that toggle is on
- it sends data only to your local MindWeaver server

The popup destination list mirrors the currently open map tabs in the web UI, page saves are processed in order if another save is already running, and `Continuous Save` follows the currently active destination map. Continuous saves are also queued in the extension so fast navigation can still stack pending captures. If the graph is already open, use the in-canvas `Refresh map` button after external saves because the workspace no longer auto-polls.

## What Works Today

- local session creation
- demo maps for quick exploration
- graph browsing and node inspection
- color-coded graph hierarchy with a minimap, branch focus controls, manual refresh, and improved spacing
- manual imports and bulk Markdown import
- local Ollama mode with higher 128k source limits
- source-backed node editing, Markdown node notes, and review
- automatic exact-label dedupe after imports, edits, and refine
- shared extension and web-app map targeting
- queued page saves from the extension
- duplicate merging and edge review
- local backup and restore
- Markdown and JSON export
- graph chat
- gap analysis
- quiz generation
- progress reporting

## What Is Still Rough

- this is not a hosted multi-user product
- persistence is still local JSON storage
- the browser extension is a power-user workflow, not a polished store release
- some AI-heavy flows are meaningfully better with a configured OpenAI key
- the project is still evolving quickly and the UI may keep changing

## Privacy And AI Boundary

MindWeaver is local-first.

- local runtime data lives in `server/data.json`
- `.env.local` files and local data are git-ignored
- OpenAI requests are made from the local server, not the extension UI
- Local (Ollama) requests also flow through the local server and stay on-device
- bounded slices of imported content are sent for AI-backed features when OpenAI is configured

Do not import data you are not comfortable sending to the configured OpenAI account.

More detail: [Security And Privacy](docs/SECURITY.md)

## Scripts

```bash
npm run setup        # install server and web dependencies
npm run dev          # run server + web together
npm run dev:server   # backend only
npm run dev:web      # frontend only
npm run test:web     # frontend unit tests for extracted helpers
npm run build        # build the web app
npm run start        # start the production-style Express server
npm run test         # run backend tests
npm run check        # backend, frontend, extension unit tests + build
npm run test:extension:integration  # browser extension integration flow
npm run eval:fixtures
```

## Repo Map

- [`web/`](web): Vite + React graph UI
- [`web/src/components/`](web/src/components): extracted UI panels and controls
- [`web/src/components/graph/`](web/src/components/graph): graph-specific workspace components such as the minimap
- [`web/src/components/notes/`](web/src/components/notes): Markdown note rendering helpers
- [`web/src/hooks/`](web/src/hooks): reusable React hooks for routing and persisted UI state
- [`web/src/lib/`](web/src/lib): frontend constants, formatting helpers, graph rendering logic, graph traversal helpers, and import parsing
- [`server/`](server): Express API, persistence, and AI-backed learning endpoints
- [`server/services/`](server/services): extracted graph, import, refine, learning, and shared server logic
- [`extension/`](extension/README.md): Chrome extension for saving pages and highlights
- [`docs/`](docs/README.md): architecture, API, development, product, and security docs
- [`scripts/`](scripts): local development helpers
- [`TODO.md`](TODO.md): roadmap and deferred product work

## Documentation

- [Development Guide](docs/DEVELOPMENT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [API Reference](docs/API.md)
- [Security And Privacy](docs/SECURITY.md)
- [Product Notes](docs/PRODUCT.md)
- [Extension README](extension/README.md)

## Open-Source Boundary

MindWeaver is ready to share as an open-source local-first alpha.

It is not yet a hosted multi-tenant SaaS. If you want to put it on the public internet later, the next major work is auth, authorization, hosted persistence, and hardening around destructive endpoints and private user data.
