# MindWeaver Calmer Workspace Redesign

## Direction

- Concept reference: `docs/redesign/calmer-workspace-concept.png`
- Branch: `codex/plan-visual-redesign`
- Visual language: current MindWeaver graph palette on a calmer dark workspace.
- Structure: top command bar, graph-centered canvas, compact workspace nav, focused task drawer.
- Behavior contract: preserve existing routes, local storage, API calls, graph data, and workflows.

## Progress Log

### 2026-05-07

- Generated a concept board for desktop workspace, narrow workspace, and right drawer detail.
- Confirmed baseline web tests pass: `npm --prefix web test` returned 26/26.
- Added `lucide-react` to support consistent icon buttons and tooltips.
- Started extracting shared UI primitives before changing the shell layout.
- Wired the first redesign slice: top command bar, compact workspace nav, right workspace drawer, Map drawer, segmented Inspector sections, segmented Import modes, and shell primitives.
- Adjusted the visual direction after palette review: preserve the existing MindWeaver black/gray shell and graph palette exactly, with a more minimal Obsidian-like workspace instead of adding a new blue-tinted accent layer.
- Replaced remaining tab glyph controls with icon controls and added tooltips/labels where the controls are icon-only.
- Hardened the server test harness against browser-blocked ephemeral ports after the root suite hit an unlucky `fetch failed: bad port` allocation.
- Completed browser QA screenshots for homepage, desktop workspace, Map drawer, Review drawer, Inspector, Import drawer, and mobile/narrow workspace in `output/playwright/`.
- Fixed visual QA findings from screenshots: preserved the original palette, removed the added blue shell tint, stopped top command bar overlap on narrow screens, kept the right drawer beside the compact rail on mobile, wrapped long map tab names instead of clipping them, removed ForceGraph console warnings by deferring viewport state updates, and tightened graph fit padding so labels remain readable.

## QA Ledger

- Unit baseline: passing before implementation.
- `npm --prefix web test`: passing, 26/26.
- `npm run test:extension:unit`: passing, 13/13.
- `npm test`: passing, 39/39.
- `npm run build`: passing; Vite still reports the existing large chunk warning.
- Browser visual QA: passing with no console warnings, no horizontal overflow, and no clipped button text at 1440x900 or 390x844.
