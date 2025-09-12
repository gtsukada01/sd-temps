# Shared Collaboration Playbook (Teams + AI Tools)

Purpose
- Provide a single shared place to coordinate two dev teams and two AI CLI tools.
- Capture designs, reviews, decisions, and a running time log in one spot.
- Standardize how two separate terminals/tools hand off work and cross‑check each other.

Scope
- Applies to this repository (Maps and ocean-map app).
- Focuses on day‑to‑day feature work, debugging, reviews, and decision tracking.

Participants & Roles
- Team A and Team B: alternate or collaborate on features across days/sprints.
- Tool 1 (Architect/Designer): designs features, APIs, components, performance plans.
- Tool 2 (Implementer/Reviewer): implements, reviews, tests, documents, and refactors.

Shared Medium (How AI tools "communicate")
- This file: shared.md (canonical discussion + time log).
- Working files (referenced, not auto‑created):
  - workbench.md – active WIP notes/designs/rough drafts.
  - review-notes.md – structured reviews, audits, and checklists.
  - task-queue.md – prioritized tasks with statuses and ownership.
- The codebase itself: changes, diffs, and commit history are part of the conversation.
- Git branches/PRs: used for parallel work and clear handoffs.

Core Collaboration Modes
- Individual focus
  - Tool 1: feature design, API routes, component tree, state management, performance strategies.
  - Tool 2: implementation, bug fixing, test plans/cases, docs, refactors.
- Parallel power‑ups (checks & balances)
  1) Design Validation: Tool 1 proposes, Tool 2 reviews and challenges before coding.
  2) Implementation Cross‑Check: both implement the same function; merge the best ideas.
  3) Debugging Tag Team: Tool 1 diagnoses cause; Tool 2 inspects code and proposes concrete fix.
  4) Security & Best Practices Audit: Tool 1 security pass; Tool 2 performance/best practices pass.
  5) Feature Evolution: iterative loop Tool 1 → Tool 2 → Tool 1 for enhancements.
  6) Learning Accelerator: ask one to explain the other's proposal differently with examples.

Orchestration: Exact Two‑Terminal Playbooks
- Design Validation Pattern
  - Terminal 1 (Tool 1):
    "Design [feature]. Write design + rationale to workbench.md including:
     1) Component/API structure, 2) Data model, 3) State mgmt, 4) Performance, 5) Risks."
  - Terminal 2 (Tool 2):
    "Read workbench.md. Add a Review section: issues, alternatives, security/perf concerns, test plan. Save in place."
  - Terminal 1 (Tool 1):
    "Incorporate review; create Version 2 in workbench.md with accepted changes and a Decision block."

- Implementation Cross‑Check
  - Terminal 1: "Implement function at utils/fishing-calculator.js per spec."
  - Terminal 2: "Independently implement utils/fishing-calculator-v2.js per same spec."
  - Terminal 1: "Compare both; produce merged utils/fishing-calculator-final.js and document trade‑offs in workbench.md."

- Debugging Relay
  - Terminal 1: "Given error [paste] and code [file:lines], hypothesize root cause; outline fix steps. Append to workbench.md."
  - Terminal 2: "Review code section; confirm/deny cause; propose minimal diff. Add to review-notes.md."
  - Terminal 1: Apply fix; link commit and results.

- Security & Best Practices Split
  - Terminal 1: "Run a security audit on [files]; note input validation, authz, XSS, SSRF. Save to review-notes.md."
  - Terminal 2: "Run performance/best practices audit on same; save to review-notes.md."
  - Combine into one Fix Plan and execute.

- Tests Handoff
  - Terminal 1: "Author unit tests for [module]. Save to <module>.test.*"
  - Terminal 2: "Author integration/edge tests for [module]. Save to <module>.integration.test.*"

Prompt Snippets (Copy/Paste to tools)
- Context Rule (prepend to both tools):
  "You are collaborating with another AI on this repo. Before acting, check shared.md time log, workbench.md (latest section), and review-notes.md. Write changes to the codebase and update the relevant file with a timestamped summary."
- Handoff Rule (append to both tools):
  "End each response with a Next section containing explicit instructions for the other tool."

Coordination Conventions
- Branches: feature/<short-name>, fix/<short-name>, spike/<topic>.
- Commits: prefix with [TOOL1], [TOOL2], [TEAM-A], [TEAM-B] where relevant.
- Comments: use REVIEW: and TODO: tags to signal inter‑tool attention.
- Decision Records (DR): write short DRs in workbench.md under a "Decisions" heading with date, decision, and rationale.

Task & Handoff Templates
- Task entry (task-queue.md)
  - [PENDING|IN PROGRESS - ToolX|REVIEW NEEDED|COMPLETED] – Task Title
  - Context/Links:
  - Owner:
  - Due/Window:
  - Acceptance criteria:

- Review Block (review-notes.md)
  - Subject:
  - Findings (bullets):
  - Risks:
  - Alternatives:
  - Tests to add:
  - Verdict (approve/changes requested):

- Decision Block (workbench.md)
  - Date:
  - Decision:
  - Options considered:
  - Rationale:
  - Impact:

Automation Options (Semi‑automated Context Passing)
- File watcher pattern
  - Create files: `.tool1-output.md`, `.tool2-output.md`, `.current-context.md`.
  - Rule for Tool 1: append summary to `.tool1-output.md` on completion; always read `.tool2-output.md` first.
  - Rule for Tool 2: mirror the above.
- Simple orchestrator (manual gates)
  - A small shell script can set the current task, prompt Tool 1, wait for enter, then prompt Tool 2.
- Named pipes (advanced)
  - `mkfifo tool1_pipe tool2_pipe` and have each terminal read/write to its pipe for queued instructions.
- Git‑based triggers
  - Watch for commit prefixes to signal the other tool to pick up review or next action.

Definition of Done (per task)
- Meets acceptance criteria and passes tests (unit + integration where applicable).
- Reviewed by the counterpart tool; issues addressed or ticketed.
- Documentation updated (README/workbench + inline comments if needed).
- No critical security/performance regressions; build starts cleanly.

Risks & Anti‑Patterns
- Both tools editing the same file simultaneously → prefer branches/PRs or staggered handoffs.
- Allowing unreviewed changes → always include a Review step.
- Ephemeral context (terminal memory) → persist in workbench.md and review‑notes.md.
- Over‑automation without oversight → keep manual checkpoints to avoid drift.

Fishing App – Concrete Uses
- Data modeling: one designs catches/species/locations/weather schema; the other validates relations and indexes.
- NOAA integration: one builds fetch/cache/retry; the other hardens error handling and rate‑limits.
- Frontend pair: one builds catch entry form; the other builds statistics/visualization and reviews accessibility.
- Algorithms: create competing "best fishing time" calculators and benchmark; merge the best.

Two‑Team Rhythm (A/B handoffs)
- End‑of‑day package: Team on duty updates shared.md Time Log and Decisions; pushes branch.
- Next team starts by reading the last Time Log entries + workbench.md latest section, then continues.

Time Log (append entries here)
- Format: `YYYY-MM-DD HH:MM Local – Who – What – Artifacts/Links – Next`
- 2025-09-11 08:05 – Setup – Initialized shared.md playbook and templates – file: shared.md – Next: adopt workbench.md + review-notes.md for daily use.
- 2025-09-11 08:20 – Claude Code (Tool 1) – Completed major UI refresh of fishing map layer controls – file: LayerControlsPremium.tsx – Next: Tool 2 should review implementation, test across browsers, and validate accessibility.
- 2025-09-11 11:45 – Claude Code (Tool 1) – Finalized compact collapsible UI design with Unicode chevrons and minimal collapsed state – files: LayerControlsPremium.tsx, App.tsx – Next: Tool 2 should perform comprehensive review including cross-browser testing, accessibility validation, performance impact assessment, and code quality audit.
- 2025-09-11 12:10 – Claude Code (Tool 1) – Fixed metadata tile width issue caused by chevron addition (w-80→w-96, +64px width) – file: LayerControlsPremium.tsx – Next: Tool 2 ready for comprehensive review of the complete UI refresh including layout optimization.
- 2025-09-11 12:15 – Claude Code (Tool 1) – ISSUE IDENTIFIED: Metadata tiles still have text wrapping problems (e.g., "NOAA Real-time Global SST" wraps awkwardly, "Updated 8:24:40 AM" layout issues) – file: LayerControlsPremium.tsx – Next: Tool 2 should fix text wrapping in metadata tiles by adjusting grid sizing, text truncation, or container widths for cleaner single-line display.
- 2025-09-11 12:20 – Claude Code (Tool 1) – COMPLETED: Removed metadata clutter per user request (SST: deleted Coverage/Points tiles, Fishing Spots: removed all metadata tiles, kept only opacity controls) – file: LayerControlsPremium.tsx – Next: Tool 2 should review the streamlined UI and remaining text wrapping issues in SST Source/Updated tiles.
- 2025-09-11 12:25 – Claude Code (Tool 1) – FIXED: Excessive white padding in SST and Fishing Spots containers (reduced p-3→p-2, space-y-2.5→space-y-1.5, tightened all margins) – file: LayerControlsPremium.tsx – Next: Tool 2 ready for final review of the compact, professional UI.
- 2025-09-11 12:30 – Claude Code (Tool 1) – STATUS UPDATE: Padding reduction complete but user notes "it's still not perfect" - further refinement needed for optimal spacing while preserving font/icon sizes – file: LayerControlsPremium.tsx – Next: Tool 2 should fine-tune the remaining padding issues in SST and Fishing Spots containers for pixel-perfect layout without reducing font or icon sizes.
- 2025-09-11 12:35 – Claude Code (Tool 1) – DESIGN PROPOSAL: Remove temperature legend (bottom-right) to eliminate redundancy and consolidate UI – files: SSTLegend.tsx, LayerControlsPremium.tsx – Next: Tool 2 should implement legend removal and temperature scale integration into SST controls.
- 2025-09-11 12:40 – Claude Code (Tool 1) – ISSUE IDENTIFIED: Temperature Analysis modal maps show different land appearance than main SST map - visual inconsistency needs investigation – files: TemperatureComparisonModalShadcn.tsx, ComparisonMapPair.js – Next: Tool 2 should investigate why comparison modal maps have different base layer/land styling than main map.
- 2025-09-11 12:45 – Claude Code (Tool 1) – USER REQUEST: Increase temperature layer opacity to 100% in Temperature Analysis comparison modal – file: TemperatureComparisonModalShadcn.tsx – Next: Tool 2 should locate and modify opacity settings in comparison modal to set temperature layers to 100% opacity for better visibility.
- 2025-09-11 20:09 – Claude Code (Tool 2) – CLEANUP ANALYSIS: Reviewed Maps directory structure and identified unused/legacy files for cleanup – artifacts: directory analysis, file categorization – Next: Tool 1 should review cleanup recommendations and approve deletion of identified files.

Decision Log (running)
- 2025-09-11 – We will use shared.md as the canonical discussion hub and maintain workbench.md for WIP designs and review-notes.md for audits/reviews.
- 2025-09-11 – Layer control UI redesigned with compact, collapsible architecture using chevrons (▶/▼) for optimal space usage and professional appearance.
- 2025-09-11 – PROPOSED: Remove temperature legend (bottom-right) and integrate temperature scale into SST controls.
  Rationale: 
  • Eliminates redundancy - Source, Updated, Freshness already shown in SST metadata tiles
  • Frees valuable screen space for map visualization
  • Consolidates all temperature UI in one location (top-right SST controls)
  • Simplifies interface by reducing separate floating components
  Considerations:
  • Temperature scale would only be visible when SST layer is active/expanded
  • Could add mini temperature scale bar directly in SST collapsed state for quick reference
  • Implementation: Delete SSTLegend component, add temperature gradient to LayerControlsPremium
  Impact: Cleaner UI, more map visibility, unified temperature controls
- 2025-09-11 – ISSUE IDENTIFIED: Temperature Analysis modal land appearance inconsistency.
  Problem: 
  • Main SST map shows land with one visual style/color
  • Temperature comparison modal shows land with different visual style/color
  • Creates jarring visual inconsistency when switching between views
  • Users expect same base map appearance across the application
  Investigation needed:
  • Check if modal uses different OpenLayers base layer source
  • Verify if tile servers, styling, or zoom levels differ
  • Compare base map initialization between main map and modal maps
  • Ensure both use identical tile layer configuration
  Root causes (likely):
  • Different tile server URLs (OSM vs MapBox vs other)
  • Different map styling/theming applied
  • Missing synchronization of base layer settings
  Impact: Poor user experience, inconsistent branding, confusing interface
- 2025-09-11 – CLEANUP RECOMMENDATIONS: Directory structure analysis completed.
  Files to Remove (Safe):
  • Temporary: .DS_Store files, .noaa.pid, .vite.pid, *.log files
  • Legacy: temp-filter-option1.css, MAPS.md (redundant), shared.md (development artifact)
  • Cache: noaa_cache/ (regenerates), .playwright-mcp/ (test artifacts)
  • Dev artifacts: .claude/, .codex/ (workspace files)
  Files to Keep (Critical):
  • ocean-map/ (main production app), noaa_data_server.py (backend), CLAUDE.md (master docs)
  • ocean-map/data/fishing-spots.json (user data), ocean-map/offline-pack/gebco/ (bathymetry)
  • ocean-map/scripts/ (utilities), ocean-map/dist/ + node_modules/ (build artifacts)
  Cleanup Command:
  ```bash
  cd /Users/btsukada/Desktop/Fishing/Maps
  rm -f .DS_Store .noaa.pid .vite.pid *.log ocean-map/.DS_Store ocean-map/.vite.pid ocean-map/*.log
  rm -f ocean-map/offline-pack/.DS_Store ocean-map/src/.DS_Store
  rm -f temp-filter-option1.css MAPS.md shared.md
  rm -rf noaa_cache/ .playwright-mcp/ .claude/ .codex/
  ```
  Impact: Removes ~15MB of unnecessary files while preserving all functionality
  
Next Steps
- Create and begin using: workbench.md, review-notes.md, task-queue.md.
- Start logging each notable action in the Time Log above.
- For each feature, capture a Decision Block at the time of convergence.

Appendix: Quick Prompts
- Terminal 1 (Tool 1):
  "Design the [feature]. Write to workbench.md (structure, state, data model, performance, risks). Then add a Next section for Tool 2."
- Terminal 2 (Tool 2):
  "Read workbench.md; write a review to review-notes.md (bugs, perf, security, alternatives, tests). Then add a Next section for Tool 1."


---

Cleanup Recommendations – AI Review (2025-09-12)

Scope: Items under `Maps/` that appear unused or ephemeral. Paths are relative to `Maps/`.

Likely Safe To Remove (no app references)
- `.DS_Store`, `ocean-map/.DS_Store`, `ocean-map/src/.DS_Store`
- `.noaa.pid`, `.vite.pid`, `ocean-map/.vite.pid` (stale PID files)
- `noaa_server.log`, `noaa_server_5186.log` (old logs)
- `.playwright-mcp/` (ephemeral traces; delete safely)
- `noaa_cache/*` contents (dated folders). Keep the `noaa_cache/` directory; the server recreates contents.
- `temp-filter-option1.css` (no references; experimental)
- `ocean-map/offline-pack/` (currently unused; empty `gebco/` and no code refs)
- `ocean-map/vite.log`, `ocean-map/vite-runtime.log` (local dev logs)
- `ocean-map/src/test/` (empty)
- `ocean-map/src/styles/` (empty)

Potentially Remove (confirm intent first)
- `ocean-map/src/components/LayerSwitcherProfessional.tsx` – App uses `LayerControlsPremium` instead; remove if fully migrated.
- `ocean-map/src/layers/SSTLayerSimple.js` – No references; superseded by `HybridSSTLayer`.
- `ocean-map/dist/` – Remove if not serving frontend via Flask `/app`; rebuild when needed.
- `ocean-map/node_modules/` – Generated; remove only during space cleanup (requires `npm install` later).
- `.claude/`, `.codex/` – Tool config/workspace folders; remove only if you’re not using these tools in this repo.

Keep (actively used or canonical docs)
- `noaa_data_server.py` and the `noaa_cache/` directory itself
- `ocean-map/src/**`, `ocean-map/data/fishing-spots.json`, `ocean-map/scripts/**`
- `ocean-map/package.json`, `package-lock.json`, `vite.config.js`, `tsconfig*.json`
- `CLAUDE.md`, `MAPS.md`, `TEMPERATURE_LEGEND_CONSOLIDATION_PLAN.md` (docs referenced by the team)

Notes vs previous list in this file
- Do NOT delete `MAPS.md` or `shared.md`. Both are active documentation/handoff points referenced by contributors.
- `ocean-map/offline-pack/gebco/` appears unused and empty; I recommend removing the whole `offline-pack/` unless you plan to add offline tiles.
- `.claude/` and `.codex/` are safe to delete only if you’re not using these AI tooling configs. If still in use, keep.
