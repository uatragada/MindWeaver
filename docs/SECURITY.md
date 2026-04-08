# Security And Privacy

MindWeaver is designed as a local-first personal learning product. The current production target is a single-user local app, not a hosted multi-tenant SaaS.

## Secret Handling

Use `server/.env.local` for real API keys:

```bash
OPENAI_API_KEY=your_key_here
```

Tracked files should contain placeholders only. The repo intentionally ignores:

- `.env`
- `.env.*`
- `server/.env`
- `server/.env.*`
- `web/.env.*`
- `extension/.env.*`
- private keys and certificates such as `*.pem`, `*.key`, `*.p12`, and `*.pfx`

If a real API key is ever committed, rotate it immediately. Removing it from a later commit does not make the old key safe.

## Local Data

Runtime data lives in `server/data.json`. It can include:

- session goals,
- saved page URLs and titles,
- imported note/transcript/PDF text excerpts,
- concept labels and summaries,
- review history,
- local reports,
- backups or exportable graph evidence.

`server/data.json` is ignored by Git and should not be published.

## Extension Privacy Model

The Chrome extension is explicit and on-demand.

- It does not continuously track browsing.
- It does not register a content script across all URLs.
- It injects `content.js` only after `Save Current Page`.
- It saves selected text only after the user chooses the context-menu action.
- It sends data only to `http://localhost:3001`.

The extractor skips:

- localhost pages,
- non-HTTP(S) pages,
- pages with password fields,
- common account/login hosts,
- common financial/payment hosts.

This skip logic is a guardrail, not a guarantee. Users should still avoid saving private, regulated, or sensitive pages.

## AI Boundary

OpenAI calls are made from the local server, not from the browser extension or web client. The server sends bounded slices of source content to OpenAI for classification and learning features.

Current limits:

- extension page text extraction: up to 16,000 characters,
- OpenAI classification/refinement slice: up to 16,000 characters,
- local import payload validation: up to 80,000 characters.

Do not import data you are not comfortable sending to the configured OpenAI account.

## Backup And Restore

The backup endpoint exports the local MindWeaver data store. Treat backup files like private data.

Recommended handling:

- store backups outside the repo,
- do not commit backup files,
- do not share backups without reviewing source content,
- restore only from files you trust.

## Public Deployment Checklist

Before deploying MindWeaver as a hosted app, add:

- real authentication,
- server-side authorization,
- workspace and evidence permission enforcement,
- encrypted persistence,
- hosted secrets management,
- operational backups,
- logging that avoids source content leakage,
- rate limits and abuse protection,
- data deletion/export workflows,
- a privacy policy and terms appropriate to the deployment.

The current local user/workspace fields are foundations, not a replacement for hosted auth or authorization.
