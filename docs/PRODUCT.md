# Product Notes

MindWeaver is positioned as a personal learning graph and AI study coach.

## Core Promise

Turn intentional learning saves into a trustworthy knowledge map that answers:

- What have I been studying?
- Which concepts are supported by evidence?
- What should I review next?
- What is missing from this map?
- Which sources created this understanding?

## Target User

The current product is best for individual learners, researchers, builders, and technical readers who move across browser tabs, notes, transcripts, and docs.

Good use cases:

- learning a technical domain,
- synthesizing research,
- mapping a reading list,
- tracking concepts while studying documentation,
- turning saved notes into quiz/review material.

Out of current scope:

- hosted team collaboration,
- multi-user permissioned workspaces,
- public SaaS deployment,
- fully automated browsing surveillance.

## Product Principles

- Capture should be intentional.
- Every concept should have provenance.
- AI output should be reviewable and correctable.
- The graph should become more useful after human review.
- Recommendations should point to concrete next actions.
- Local data should stay local unless the user exports or backs it up.

## Main User Flow

1. Start a map with a clear name and scope.
2. Save useful pages or highlights from the extension.
3. Import notes, transcripts, PDFs, Markdown, docs, or repo excerpts when needed.
4. Review the generated concepts and relationships in the color-coded graph workspace.
5. Clean up duplicates, weak evidence, and add session-scoped Markdown notes in the inspector, while letting exact-label dedupe collapse repeated saves and edits automatically.
6. Use gap analysis to find missing concepts.
7. Generate quizzes to update confidence.
8. Ask the graph assistant source-grounded questions.
9. Export or back up the map.

## Trust Features

- Session-scoped graph fetches.
- Source evidence attached to concepts.
- `whyThisExists` explanations.
- Review queue for low-confidence concepts.
- Manual approve/reject for nodes and edges.
- Shared active-map targeting between the web app and extension.
- FIFO page-save queue for extension captures.
- Conservative exact-label dedupe after imports, edits, and refine passes.
- Node editing, semantic-role cleanup, duplicate merging, and session-scoped Markdown notes.
- Source removal.
- Local backup/restore.

## Deferred Team Roadmap

Team/org features are tracked as deferred GitHub issues:

- [Authentication and user accounts](https://github.com/uatragada/MindWeaver/issues/1)
- [Shared workspaces and team graphs](https://github.com/uatragada/MindWeaver/issues/2)
- [Private vs shared evidence permissions](https://github.com/uatragada/MindWeaver/issues/3)
- [Onboarding packs](https://github.com/uatragada/MindWeaver/issues/4)
- [Expertise maps](https://github.com/uatragada/MindWeaver/issues/5)
- [Shared maps and pathways](https://github.com/uatragada/MindWeaver/issues/6)
- [Research-team export and reporting](https://github.com/uatragada/MindWeaver/issues/7)
