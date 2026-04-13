# Development Guide

This guide covers local setup, common workflows, verification, and release hygiene.

## Prerequisites

- Node.js and npm.
- Chrome or Chromium for the unpacked extension.
- An OpenAI API key for AI-backed classification and learning features.

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
- `web/src/hooks/`: reusable hooks for route state and local storage
- `web/src/lib/`: pure helpers, constants, graph rendering helpers, and import parsing
- `web/src/App.jsx`: top-level workspace coordination and API-driven flows

When refactoring, prefer moving pure logic into `lib/` first, then extracting stable UI sections into `components/`.

## Extension Workflow

1. Start the local server with `npm run dev` or `npm run start`.
2. Open `chrome://extensions`.
3. Enable Developer Mode.
4. Load the `extension/` folder as an unpacked extension.
5. After changing extension files, reload the unpacked extension in Chrome.

The extension saves pages on demand only. It does not continuously track browsing.

## Data During Development

The local database is `server/data.json`. It is ignored by Git and can be deleted if you want a clean local state. The server recreates the default structure on startup.

Do not commit:

- `server/data.json`,
- `.env` files,
- backups,
- `node_modules`,
- `web/dist`.

## Testing Checklist

Before pushing meaningful code changes, run:

```bash
npm run test
npm run test:web
npm run test:extension:unit
npm run build
node --check extension\content.js
node --check extension\background.js
node --check extension\popup.js
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
7. Confirm the graph updates.

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
- If the graph looks stale, refresh the web app after ingestion or reopen the session URL.
