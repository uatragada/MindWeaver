# MindWeaver Roadmap

This roadmap turns the current prototype into a usable product in stages. The goal is to keep the scope ambitious but buildable: first make the existing loop reliable, then improve graph quality, then add learning workflows, and only after that expand into assistant and team features.

## Product Goal

MindWeaver should become a personal learning system that:

- captures what a user studies across the web,
- organizes that material into a trustworthy knowledge graph,
- measures what the user understands,
- recommends what to learn next,
- and eventually supports team onboarding and shared research.

## Production Implementation Status

The local-first production version now covers the personal learning graph, learning loop, expanded text/highlight intake, source-grounded graph assistant, progress reporting, exports, full local backup/restore, map health, search, pruning, manual relationships, node cleanup, duplicate merging, source removal, and a production-style single-server run path.

Hosted team/SaaS capabilities are intentionally deferred rather than faked in this local app. The code now includes local user/workspace foundations, but a public multi-user deployment still needs real auth, authorization, encrypted persistence, and operational hosting.

## Current State

Today the repo has:

- a browser extension that captures page data during a session,
- a local Express server that classifies pages into graph nodes using OpenAI,
- a graph viewer that visualizes nodes and evidence,
- production safety controls for backup, restore, deletion, and local source cleanup,
- graph quality controls for review, pruning, relationship review, manual edits, and duplicate merges,
- learning workflows for gaps, quizzes, verification, study plans, progress, summaries, and graph-grounded chat.

The remaining intentionally deferred scope is collaboration and hosted team/SaaS infrastructure.

## Roadmap Principles

- Build from reliable capture to reliable understanding.
- Favor explainable graph edges over opaque AI output.
- Keep humans in the loop for correction, verification, and trust.
- Ship milestones that are useful on their own.

## Phase 1: Harden The MVP

Outcome: the current extension -> server -> graph flow works consistently enough to demo and publish safely.

- [x] Add a root README with setup, architecture, and run instructions.
- [x] Add top-level scripts or a simple dev runner so the app can be started without manual multi-terminal setup.
- [x] Filter graph responses by `sessionId` so one session does not leak into another.
- [x] Add dedupe for repeated page ingests so refreshes and revisits do not spam evidence.
- [x] Make ingestion fail gracefully when OpenAI is unavailable and record a clear status.
- [x] Add request timeouts and safer JSON parsing around all OpenAI calls.
- [x] Remove debug logging noise from the frontend and backend.
- [x] Add basic validation for incoming extension payloads.
- [x] Add a publish-safe `.gitignore`, env example files, and document local secret handling.
- [x] Add smoke tests for session creation, ingest, graph fetch, and learn-more.

Definition of done:

- A new user can run the stack locally in under 10 minutes.
- A single learning session produces a stable, session-scoped graph.
- The app does not silently fail when OpenAI returns bad output.

## Phase 2: Improve Graph Quality

Outcome: the graph becomes believable, editable, and useful instead of just visually interesting.

- [x] Introduce canonical node merging so similar concepts do not appear as duplicates.
- [x] Separate `page`, `artifact`, and `concept` more clearly in the data model.
- [x] Track provenance on concepts and relationships, including source evidence and review state.
- [x] Add confidence scoring rules that combine AI output, repeated evidence, and user verification.
- [x] Add manual approve/reject controls for nodes and edges in the UI.
- [x] Add source dedupe so one article does not create repeated evidence entries.
- [x] Add prerequisite and relationship types beyond `contains` and `builds_on`.
- [x] Add graph pruning rules for low-confidence or low-evidence concepts.
- [x] Add a review queue for "AI-added but unverified" concepts.
- [x] Add regression fixtures using saved sample pages to measure graph quality over time.

Definition of done:

- Duplicate concept creation drops significantly.
- Every important concept shown in the UI has explainable evidence.
- Users can correct graph mistakes without editing JSON manually.

## Phase 3: Turn It Into A Learning Product

Outcome: MindWeaver moves from passive capture to active mastery tracking.

- [x] Connect session goals to actual graph planning and recommendations.
- [x] Build a gap analysis UI on top of the existing `/api/gaps` endpoint.
- [x] Build quiz and verification flows on top of `/api/quiz` and `/api/verify`.
- [x] Add concept mastery states such as `new`, `seen`, `understood`, and `verified`.
- [x] Add review scheduling and spaced repetition for weak concepts.
- [x] Generate study paths from goals using prerequisite chains and evidence.
- [x] Add "what should I study next?" recommendations driven by low-confidence nodes.
- [x] Add concept summaries that improve as more evidence is gathered.
- [x] Add progress views for a session, a goal, and long-term learning history.

Definition of done:

- A user can set a goal, study normally, and get concrete next steps.
- Verification changes recommendations and confidence in visible ways.
- The product answers "what do I know, what am I missing, and what should I do next?"

## Phase 4: Expand Capture Beyond Web Pages

Outcome: the system becomes a true knowledge intake layer, not just a browser session logger.

- [x] Add PDF-text ingestion.
- [x] Add YouTube transcript ingestion.
- [x] Add manual notes and highlights as first-class artifacts.
- [x] Add import from saved bookmarks, reading lists, or markdown notes.
- [x] Add repo and documentation extract ingestion for technical learning use cases.
- [x] Add lightweight browser actions for "save this as evidence" and "highlight this concept."

Definition of done:

- The graph can be built from multiple learning surfaces, not only visited pages.
- Users can intentionally add high-quality evidence instead of relying only on passive capture.

## Phase 5: Add Assistant And Memory Features

Outcome: the graph starts powering a real assistant instead of sitting beside one.

- [x] Add chat over the user's graph with source-grounded answers.
- [x] Add node-level "explain this from my current level" responses.
- [x] Add concept intersection workflows that suggest bridges between domains.
- [x] Add on-demand learning summaries.
- [x] Add "continue where I left off" recommendations at session start.
- [x] Add graph-aware search across concepts, evidence, and goals.
- [x] Add retrieval that favors stronger evidence and higher-confidence concepts.

Definition of done:

- The assistant uses the graph as memory, not just raw page text.
- Answers can cite evidence and reflect what the user already knows.

## Phase 6: Support Team And Org Use Cases

Outcome: the product grows from personal learning into team onboarding and research mapping.

- [ ] Add authentication and user accounts.
- [ ] Add shared workspaces and team graphs.
- [ ] Add permissions for private vs shared evidence.
- [ ] Add onboarding packs for new hires or new domains.
- [ ] Add expertise maps that show who knows what.
- [ ] Add shared learning goals and recommended pathways.
- [ ] Add export and reporting for research teams.

Definition of done:

- A team can use MindWeaver for onboarding, research synthesis, and knowledge transfer.

## Highest-Priority Next 10 Tasks

These are the best immediate tasks if the goal is to create momentum without overreaching:

- [x] Write a root README.
- [x] Add a one-command local dev start flow.
- [x] Scope graph queries to `sessionId`.
- [x] Add ingest dedupe by URL and session.
- [x] Add resilient OpenAI JSON parsing and timeout handling.
- [x] Add tests for `/api/sessions`, `/api/ingest`, and `/api/graph/:sessionId`.
- [x] Add a review queue for low-confidence concepts.
- [x] Add manual node approve/reject actions in the UI.
- [x] Build a simple gap-analysis panel in the web app.
- [x] Build a quiz panel that feeds verification back into confidence.

## Success Metrics

Use these to judge whether the roadmap is working:

- Session-to-graph completion rate
- Duplicate concept rate
- Percentage of concepts with evidence
- Percentage of concepts user-verified
- Recommendation click-through rate
- Quiz completion rate
- Time from first session to first useful recommendation

## Long-Term Product Positioning

If execution goes well, MindWeaver can evolve through three strong product shapes:

- Personal learning graph
- AI study coach with memory and verification
- Team knowledge and onboarding platform

The key is not to chase all three at once. Ship the personal learning graph first, then turn it into a learning loop, then turn that loop into a collaborative product.
