# MindWeaver

MindWeaver is a local-first knowledge mapping app. You intentionally save a page or selected highlight from the Chrome extension, the local server classifies that source into a session-scoped graph, and the web app helps you review, clean up, quiz, and export the resulting map.

It is built for personal learning workflows first: capture evidence on demand, keep provenance visible, let humans correct the graph, and use AI as a classifier/coach rather than an invisible background tracker.

## Current Product

- On-demand Chrome extension source saving with no continuous page tracking.
- Session-scoped knowledge graphs built from goals, domains, skills, concepts, sources, and relationships.
- Manual imports for notes, PDF text, transcripts, Markdown, bookmarks, repository/docs excerpts, and highlights.
- Review queue, approve/reject actions, node editing, duplicate merging, edge review, and graph pruning.
- Gap analysis, study plan generation, spaced-review quiz loop, progress reporting, and source-grounded graph chat.
- Local backup/restore plus Markdown/JSON map export.
- Production-style local run path that serves the built web app from the Express server.

## Repo Map

- [`extension/`](extension/README.md): Chrome extension for saving the current page or selected highlights on demand.
- [`server/`](server): Express API, LowDB persistence, OpenAI-backed classification, and learning endpoints.
- [`web/`](web): Vite + React graph UI.
- [`scripts/`](scripts): local development helpers.
- [`docs/`](docs/README.md): architecture, API, security, product, and development documentation.
- [`TODO.md`](TODO.md): roadmap and linked GitHub issues for deferred team/org work.

## Quick Start

Install dependencies:

```bash
npm --prefix server install
npm --prefix web install
```

Create a local secret file:

```bash
copy server\.env.example server\.env.local
```

Then edit `server/.env.local` and set:

```bash
OPENAI_API_KEY=your_key_here
```

`server/.env.local` is git-ignored. Do not put real API keys in tracked files.

Start the development stack:

```bash
npm run dev
```

That starts:

- API server: `http://localhost:3001`
- Web app: `http://localhost:5197`

## Production-Style Local Run

Use this when showing the product or testing the single-server path:

```bash
npm run build
npm run start
```

Or double-click [`start-production.bat`](start-production.bat) on Windows.

After build, the Express server serves the web app from `web/dist` at `http://127.0.0.1:3001`.

## Load The Extension

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Click "Load unpacked".
4. Select the [`extension`](extension) folder.
5. Run the MindWeaver server locally.
6. Click the MindWeaver extension icon.
7. Optionally enter a learning goal.
8. Click "Save Current Page" on pages you want in the graph.

The extension injects its extractor only after you click "Save Current Page". It sends title, URL, meta keywords when present, excerpt, and up to 16,000 characters of readable page text to `http://localhost:3001`. It skips localhost, non-web protocols, password pages, and common account or financial pages.

You can also right-click selected text and choose "Save selection to MindWeaver" to add a highlight as direct evidence.

## Product Loop

1. Start or open a knowledge map.
2. Save a useful source page or selected highlight from the extension.
3. Import notes, transcripts, docs, or Markdown directly in the web app when needed.
4. Review low-confidence concepts and reject bad classifier output.
5. Edit labels/summaries, merge duplicates, remove weak evidence, and approve trustworthy relationships.
6. Run gap analysis and generate a quiz to update confidence.
7. Ask source-grounded questions against the graph.
8. Export Markdown/JSON or download a full local backup.

## Verification

Run the backend test suite:

```bash
npm run test
```

Run the broader local readiness check:

```bash
npm run check
```

Replay sample imports through the pipeline:

```bash
npm run eval:fixtures
```

## More Documentation

- [Development Guide](docs/DEVELOPMENT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [API Reference](docs/API.md)
- [Security And Privacy](docs/SECURITY.md)
- [Product Notes](docs/PRODUCT.md)
- [Extension README](extension/README.md)
- [Roadmap](TODO.md)

## Production Boundary

MindWeaver is productionized as a local-first personal learning product. It includes local user/workspace foundations, but it is not yet a hosted multi-tenant SaaS. The deferred team/org roadmap issues track auth, permissions, shared graphs, onboarding packs, expertise maps, shared goals, and research-team reporting.
