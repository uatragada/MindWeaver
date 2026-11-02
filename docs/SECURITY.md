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

- map names and optional goal nodes,
- shared active-map state and open map tabs,
- saved page URLs and titles,
- imported note/transcript/PDF text excerpts,
- concept labels and summaries,
- review history,
- selected AI provider/model settings,
- local reports,
- backups or exportable graph evidence.

`server/data.json` is ignored by Git and should not be published.

## Extension Privacy Model

The Chrome extension is manual by default and can be switched into a user-enabled continuous-save mode.

- It does not register a content script across all URLs.
- It injects `content.js` only after `Save Current Page` or while the user-enabled `Continuous Save` toggle is observing newly visited pages.
- It saves selected text only after the user chooses the context-menu action.
- It can automatically save newly visited pages only while `Continuous Save` is enabled.
- It sends data only to `http://localhost:3001`.

The extractor skips:

- localhost pages,
- non-HTTP(S) pages,
- pages with password fields,
- common account/login hosts,
- common financial/payment hosts.

This skip logic is a guardrail, not a guarantee. Users should still avoid saving private, regulated, or sensitive pages.

## AI Boundary

AI calls are made from the local server, not from the browser extension or web client. OpenAI requests leave the machine only when OpenAI is the selected provider. Local/Ollama requests stay on-device, and structured local JSON is schema-validated on the server before it is used to mutate the graph.

Gap analysis, quiz generation, and source classification keep stored goals, concept labels, and graph context in user messages. Their system messages contain application instructions only. Imported or restored graph text must keep the same data role; input normalization alone does not prevent prompt injection. Both provider paths have regression tests for this boundary. This separation does not guarantee that a model will ignore every instruction embedded in source content.

Current limits:

- extension page text extraction: up to the selected provider's source limit (16,000 characters for OpenAI, 128,000 for Local/Ollama),
- OpenAI classification/refinement slice: up to 16,000 characters,
- Local/Ollama classification/refinement slice: up to 128,000 characters,
- local import payload validation: up to 80,000 characters for OpenAI and 128,000 for Local/Ollama.

Do not import data you are not comfortable sending to the configured OpenAI account when OpenAI is selected.

## Dependency Maintenance

Audit all three lockfiles, including development dependencies:

```bash
npm audit
npm --prefix server audit
npm --prefix web audit
```

The desktop build uses Electron 45 and requires Node.js 22.12 or newer. Root overrides update ASAR and the universal packager together so their matcher calls support minimatch 11. Modern glob consumers use glob 14. The legacy `temp` dependency uses a scoped adapter to Node's literal-path removal API, preserving its callback and synchronous cleanup behavior without glob 7's incompatible matcher internals. Keep these overrides together until electron-builder adopts patched versions. Run `npm run test:packaging` and verify Windows packaging when changing them.

Desktop packaging includes server runtime code and production dependencies. Local server configuration, databases, tests, and fixtures are outside that file list. Configure API keys on the machine running the app through its environment.

Dependabot alert #145 references the withdrawn advisory [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) for sprintf-js. GitHub withdrew it on October 22, 2026 because exception handling belongs to the calling application. It has no patched release and is excluded from npm's active audit findings. Its status is documented here rather than dismissed as part of the dependency update.

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
