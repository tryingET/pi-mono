---
summary: "Active handoff for the softwareco/fork/pi-mono bootstrap window."
read_when:
  - "At the start of every work session"
  - "When resuming work in softwareco/fork/pi-mono"
---

# Next Session Prompt

## SESSION TRIGGER (AUTO-START)
Reading this file is authorization to begin immediately.
Do not ask for permission to start.

## ANTI-STALE RULES (HARD)
- Keep this file short and current.
- Keep only the active handoff window, not a running history.
- Move completed session narrative to `diary/`.
- Crystallize durable patterns in `docs/learnings/` and accepted decisions in `docs/decisions/`.
- Track deferred work in `governance/work-items.json`.

## SOURCE-OF-TRUTH MAP
- Repo operating contract: `AGENTS.md`
- Mission and goals: `docs/project/`
- Active/deferred work contract: `governance/work-items.json`
- Fork rationale: `docs/decisions/2026-03-13-fork-bootstrap-and-upstream-boundary.md`
- Raw session capture: `diary/`

## ACTIVE HANDOFF
- `softwareco/fork/pi-mono` was created on `2026-03-13` as the first concrete repo in the fork lane.
- The repo currently contains control-plane scaffolding, explicit fork rationale, and an initial local work queue.
- Upstream `badlogic/pi-mono` code has **not** been imported yet.
- Next bounded slice: decide the first upstream import/sync posture, then pick the first executable DSPY follow-up slice.
- Latest diary entry: `diary/2026-03-13--feat-first-fork-repo-bootstrap.md`

## SESSION PREFLIGHT
- Objective (one sentence): choose and document the first upstream import/sync posture for this fork, then make the next DSPY slice executable.
- Constraints (hard limits): keep fork rationale explicit; avoid hidden divergence; do not import code without an explicit sync/import decision.
- Assumptions (max 3): the repo-local control plane now exists; issue-tracker DSPY bodies remain the planning input; fork lane use is intentional and long-lived.
- Blockers (none or list): no upstream import/sync decision yet.

## READ-FIRST ALLOWLIST (STARTUP BUDGET)
1. `AGENTS.md`
2. `README.md`
3. `governance/work-items.json`
4. `docs/project/mission.md`
5. `docs/project/tactical_goals.md`
6. `docs/decisions/2026-03-13-fork-bootstrap-and-upstream-boundary.md`
7. Most recent `diary/YYYY-MM-DD--type-scope-summary.md`

## EXECUTION MODE (ONE SESSION = ONE SLICE)
1. Pick one highest-leverage actionable slice from `governance/work-items.json`.
2. Implement end-to-end on a branch.
3. Validate:
   - `./scripts/ci/smoke.sh`
   - `./scripts/ci/full.sh` (when CI/policy/ontology/contracts changed)
4. Update source-of-truth artifacts before commit.

## SESSION CHECKPOINT (UPDATE BEFORE /commit)
- Slice executed: bootstrap the first concrete fork-lane repo for post-upstream DSPY work
- Outcome: repo scaffold exists with fork-specific docs, decision record, work queue, and initial git history
- Files changed: repo bootstrap surface + initial docs/governance artifacts
- Validation commands + results: `./scripts/ci/smoke.sh` (pass); `node ~/ai-society/core/agent-scripts/scripts/docs-list.mjs --docs . --strict` (pass)
- Deferred tasks updated in `governance/work-items.json`: yes
- Next-session starting point: issue `I2` in `governance/work-items.json`

## END-OF-SESSION
Keep this file aligned with the real active slice for the next operator.
