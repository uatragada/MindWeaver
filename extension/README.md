# MindWeaver Extension

The Chrome extension is the browser capture surface for MindWeaver. It supports one-shot saves and an optional continuous-save toggle for newly visited pages.

## Behavior

- `Save Current Page` extracts the active tab, strips navigation-heavy chrome, and sends the result to the local MindWeaver server.
- `Save Current Page` is queued server-side, so rapid captures are processed in order if one save is already running.
- The popup shows destination maps from the same server-backed tab list used by the Web UI, so both surfaces stay in sync.
- If no map is active, the popup can create one first using the optional map-name field.
- `Continuous Save` is a green on/off toggle that snapshots each newly visited page while it is enabled, queues those saves in the extension, and sends them to MindWeaver one after another.
- `Save selection to MindWeaver` in the right-click menu saves highlighted text as evidence.
- `Open MindWeaver` opens the active map in the reachable local app surface, or the last-used map if capture is currently idle.
- Captured pages and highlights can then be reviewed, merged, and annotated with Markdown node notes inside the MindWeaver inspector.

## Privacy Model

The extension does not register a permanent content script across all sites, but it can automatically capture newly visited pages while the user-enabled `Continuous Save` toggle is on.

- `manifest.json` does not register a content script across all URLs.
- `content.js` is injected by the background worker after `Save Current Page`, when `Continuous Save` observes a newly visited page, or when a single-page app changes routes.
- Page extraction happens in the active tab only.
- The extension sends data only to the local server at `http://localhost:3001`.

The extractor sends:

- page title,
- page URL,
- meta keywords when present,
- a short excerpt,
- cleaned readable text with common navigation, sidebar, and table-of-contents chrome stripped out,
- up to the selected provider's page-text limit (16,000 characters for OpenAI, 128,000 for Local/Ollama).

The extractor skips:

- localhost pages,
- non-HTTP(S) pages,
- pages with password fields,
- common account/login hosts,
- common financial/payment hosts.

## Files

- [`manifest.json`](manifest.json): Chrome extension permissions, popup, and background worker config.
- [`popup.html`](popup.html): popup UI.
- [`popup.js`](popup.js): shared target-map selection, map creation, manual save button, continuous-save toggle, and open-app behavior.
- [`background.js`](background.js): background worker entrypoint.
- [`lib/background-controller.js`](lib/background-controller.js): active-tab extraction, continuous-save tab listeners, context menu handling, and shared target-map API calls.
- [`content.js`](content.js): readable-text extraction logic injected on demand.

## Local Requirements

Start MindWeaver before saving a page:

```bash
npm run dev
```

The extension sends saves to `http://localhost:3001`. The popup opens the matching local app surface that is currently reachable: `http://localhost:5197` during web development when the Vite dev server is running, otherwise the production-style local server at `http://localhost:3001`.

If the graph is already open when a capture finishes, use the in-canvas `Refresh map` button in MindWeaver to pull in the latest changes. The graph view no longer auto-refreshes.

## Reloading During Development

After changing files in `extension/`, open `chrome://extensions` and click reload on the unpacked MindWeaver extension. Chrome does not automatically pick up these changes.
