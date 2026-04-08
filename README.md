# MindWeaver

MindWeaver turns intentional saves from your browsing session into a living knowledge graph. The browser extension logs a page only when you click "Save Current Page" or save a highlight, the local server classifies the source into goals, domains, skills, and concepts, and the web app lets you review low-confidence ideas, run gap analysis, and quiz yourself to improve graph confidence over time.

## What You Can Do

- save source pages on demand during a learning session,
- build a session-scoped knowledge graph,
- review and approve or reject AI-added concepts,
- run gap analysis against a session goal,
- generate quizzes that feed verification back into concept confidence,
- import manual notes, PDF text, and transcript excerpts into the same graph,
- surface next-step recommendations based on gaps, low evidence, and spaced review,
- follow a generated short study plan and map-health score,
- ask source-grounded questions against the graph,
- search concepts, goals, and evidence,
- bulk import Markdown notes or reading-list extracts,
- prune low-confidence concepts with no evidence,
- add and review relationships between concepts,
- edit concept labels, descriptions, summaries, and mastery states,
- merge duplicate nodes and remove bad source evidence,
- save selected browser text as highlight evidence,
- try a prebuilt demo map before installing or using the extension,
- export a saved map as Markdown or JSON for sharing and notes,
- download and restore a full local backup of the MindWeaver data store.

## Project Structure

- `extension/`: Chrome extension for starting a session and saving the current page or selected highlights on demand.
- `server/`: Express API, lowdb storage, OpenAI-powered ingestion and learning endpoints.
- `web/`: React graph UI with review queue, gap analysis, quiz loop, and inspector.

## Local Setup

1. Install dependencies in `server/` and `web/` if they are not already installed.
2. Create a local secret file at `server/.env.local`.
3. Add `OPENAI_API_KEY=your_key_here` to that file.

You already have a safe template in [server/.env.example](G:/Projects/MindWeaver/server/.env.example).

## One-Command Development

Run this from the repo root:

```bash
npm run dev
```

That starts:

- the API server on `http://localhost:3001`
- the web app on `http://localhost:5197`

## Production-Style Local Run

Run this from the repo root:

```bash
npm run build
npm run start
```

Or on Windows, double-click [start-production.bat](G:/Projects/MindWeaver/start-production.bat).

That builds the web app and serves the full product from the local server at `http://127.0.0.1:3001`. This is the preferred mode when you are showing the product to someone or testing the full flow without Vite.

## Load The Extension

1. Open Chrome extensions.
2. Enable Developer Mode.
3. Load `extension/` as an unpacked extension.
4. Optionally add a goal in the popup.
5. Use the popup's "Open MindWeaver" button to open the web app for the current session.
6. Click "Save Current Page" whenever you want the active tab added to the graph.

The popup opens the Vite dev app at `http://localhost:5197` when available, then falls back to the production-style server at `http://localhost:3001`.

The extension no longer continuously tracks browsing. It injects the page extractor only after you click "Save Current Page", then sends page title, URL, excerpt, and up to 16,000 characters of readable page text to your local server. It skips localhost, non-web protocols, password/login pages, and common account/financial pages.

You can also highlight text on a page, right-click, and choose "Save selection to MindWeaver" to add that highlight as direct evidence.

## Tests

Run the backend smoke tests from the repo root:

```bash
npm run test
```

Run the broader local readiness check:

```bash
npm run check
```

The current tests cover:

- session creation,
- ingest dedupe,
- session-scoped graph responses.
- graph health, demo maps, export, progress, search, chat, pruning, relationships, bulk import, highlight import, backup/restore, node cleanup, source removal, and production static serving.

You can also replay a small fixture set against the current pipeline with:

```bash
npm run eval:fixtures
```

## Product Loop

1. Optionally set a session goal.
2. Visit pages worth learning from.
3. Click "Save Current Page" for sources you want in the graph.
4. Open the graph UI.
5. Review low-confidence concepts.
6. Run gap analysis to see what you are missing.
7. Generate a quiz and feed results back into confidence.
8. Ask the graph assistant or generate a learning summary.
9. Clean up the graph by editing labels, merging duplicates, and removing weak source evidence.
10. Prune weak concepts, add relationships, download a backup, or export Markdown/JSON when you want to save or share the learning map.

## Local-First Production Boundary

MindWeaver is productionized here as a local-first personal learning product. It includes local backup/restore and workspace/user foundations, but it does not pretend to be a hosted multi-tenant SaaS. If you want to deploy it publicly for teams, the next production layer should be real authentication, encrypted multi-user storage, and server-side authorization in front of the existing workspace model.

If you want to evaluate the product quickly, open the web app and use "Try A Demo Map" on the landing page.

## Roadmap

The longer roadmap is tracked in [TODO.md](G:/Projects/MindWeaver/TODO.md).
