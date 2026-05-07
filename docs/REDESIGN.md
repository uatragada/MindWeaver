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
- Ran full visual QA across homepage provider switching, start/demo/recent maps, graph search/presets/focus/minimap/legend, every drawer panel, Inspector tabs, notes fullscreen, review actions, gap/quiz flows, exports, backup/restore, end/delete, and mobile/narrow layout.
- Fixed visual QA findings from the full pass: hidden the homepage map-tabs scrollbar, raised `/api/restore` payload capacity for real local backups, added a large-backup restore regression test, reduced remaining pill controls to the requested 8px radius, and tightened topbar filter flex rules so graph controls no longer protrude at 1440px or mobile widths.
- Redesigned the no-session opening page into a calmer All Maps workspace instead of a marketing-style page, using the existing dark shell and graph palette without introducing new brand colors.
- Preserved opening-page workflows for map tabs, reopen recent, provider switching, start map, demo map, recent maps, workspace flow, and local data/privacy status.
- Fixed homepage visual QA findings: long capture target names now truncate instead of expanding the top strip, the mobile map strip stays compact and horizontally scrollable, the mobile recent list is bounded, and the active-map action stacks cleanly on narrow screens.

## QA Ledger

- Unit baseline: passing before implementation.
- `npm --prefix web test`: passing, 26/26.
- `npm test`: passing, 40/40.
- `npm run test:extension:unit`: passing, 13/13.
- `npm run build`: passing; Vite still reports the existing large chunk warning.
- Browser visual QA: full interaction sweep captured 38 screenshots in `output/playwright/full-visual-qa-2026-05-07T17-48-40-658Z/`. Restore completed, export downloads were created, and QA maps were cleaned up afterward.
- Targeted topbar regression: passing with no overflow, no clipped controls, no oversized radii, and no console warnings at 1440px and 390px in `output/playwright/topbar-regression-2026-05-07T17-51-57-716Z/`.
- Opening page visual QA: in-app browser smoke passed for All Maps, AI Provider, Start A Knowledge Map, and Try A Demo Map. Scripted Playwright QA passed with 7 screenshots in `output/playwright/homepage-qa-2026-05-07T23-40-04-437Z/`, covering desktop/tablet/mobile layouts, provider menu and switch/restore, start-map and demo-map flows with API cleanup, recent-map opening, no body overflow, no clipped visible controls, no oversized homepage radii, no unlabeled icon buttons, no console warnings/errors, and no hard-coded hex colors in the new opening-page CSS block.
