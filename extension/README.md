# MindWeaver Extension

The Chrome extension is the on-demand capture surface for MindWeaver. It saves the active page or selected text only after a user explicitly asks it to.

## Behavior

- `Save Current Page` extracts the active tab and sends it to the local MindWeaver server.
- The popup shows recent destination maps and lets you switch the shared active map used by both the Web UI and the extension.
- If no map is active, the popup can create one first using the optional goal field.
- `Save selection to MindWeaver` in the right-click menu saves highlighted text as evidence.
- `Open MindWeaver` opens the active map in the web UI, or the last-used map if capture is currently idle.
- `End Active Map` ends the shared active map for future saves while preserving the saved graph.

## Privacy Model

The extension is not a continuous browsing tracker.

- `manifest.json` does not register a content script across all URLs.
- `content.js` is injected only by the background worker after `Save Current Page`.
- Page extraction happens in the active tab only.
- The extension sends data only to the local server at `http://localhost:3001`.

The extractor sends:

- page title,
- page URL,
- meta keywords when present,
- a short excerpt,
- up to 16,000 characters of readable page text.

The extractor skips:

- localhost pages,
- non-HTTP(S) pages,
- pages with password fields,
- common account/login hosts,
- common financial/payment hosts.

## Files

- [`manifest.json`](manifest.json): Chrome extension permissions, popup, and background worker config.
- [`popup.html`](popup.html): popup UI.
- [`popup.js`](popup.js): shared target-map selection, map creation, save-page button, and open-app behavior.
- [`background.js`](background.js): active-tab extraction, context menu handling, and shared target-map API calls.
- [`content.js`](content.js): readable-text extraction logic injected on demand.

## Local Requirements

Start MindWeaver before saving a page:

```bash
npm run dev
```

The extension sends saves to `http://localhost:3001`. The popup opens `http://localhost:5197` during web development when available, then falls back to the production-style local server at `http://localhost:3001`.

## Reloading During Development

After changing files in `extension/`, open `chrome://extensions` and click reload on the unpacked MindWeaver extension. Chrome does not automatically pick up these changes.
