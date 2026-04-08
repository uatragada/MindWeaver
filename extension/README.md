# MindWeaver Extension

The Chrome extension is an on-demand source saver for the local MindWeaver app.

## Behavior

- Click **Save Current Page** to add the active tab to the current knowledge map.
- If no map is active yet, the popup creates one using the optional goal field.
- Right-click selected text and choose **Save selection to MindWeaver** to add a highlight as evidence.
- Click **Open MindWeaver** to open the graph UI for the current map.
- Click **End Current Map** to stop adding evidence to the current session.

## Privacy Model

The extension does not continuously track browsing. It does not register a content script that runs on every page. It injects `content.js` only after the user clicks **Save Current Page**.

The extractor sends the local server:

- page title,
- page URL,
- meta keywords when present,
- a short excerpt,
- up to 16,000 characters of readable page text.

It skips localhost, non-web protocols, password pages, and common account or financial pages.

## Local Requirements

Run the MindWeaver server before saving a page:

```bash
npm run dev
```

The extension sends data to `http://localhost:3001`. The web UI opens `http://localhost:5197` in development when available, then falls back to the production-style local server at `http://localhost:3001`.
