---
summary: "Repo operating contract for the softwareco/fork/pi-mono bootstrap repo."
read_when:
  - "You start work in softwareco/fork/pi-mono"
  - "You need fork-specific guardrails for post-upstream DSPY work"
type: "reference"
---

# AGENTS.md — pi-mono

## Intent
Provide the local home for post-upstream DSPY work that no longer fits the `badlogic/pi-mono` upstream boundary.

This repo intentionally starts as a **fork control-plane scaffold**:
- explicit fork rationale
- repo-local decisions and work queue
- a clean place to land future divergence

Importing or syncing upstream code is a follow-up decision, not an implicit assumption.

## Guardrails
- No secrets in git.
- Never push to `main`; MRs only.
- Treat `docs/_core/**` as immutable.
- Track deferred work in `governance/work-items.json`.
- Keep the fork rationale explicit in `docs/decisions/`.
- Do not treat abandoned upstream issue text as repo-local authority once a fork decision has been made.
- Do not import upstream code or start large divergence work without an explicit import/sync decision.

## Deterministic tooling policy (ROCS-first)
- Prefer `./scripts/rocs.sh <args...>` before ad-hoc shell or Python.
- Use repo-local scripts before one-off commands when an equivalent wrapper exists.
- Use inline Python only as an explicit fallback when no deterministic command exists.

## Current repo reality
- Repo path: `~/ai-society/softwareco/fork/pi-mono`
- Lane: `softwareco/fork`
- Upstream reference: `badlogic/pi-mono`
- Current state: documentation/governance scaffold only; upstream code import is still pending

## Required read order
1. `README.md`
2. `governance/work-items.json`
3. `docs/project/mission.md`
4. `docs/project/tactical_goals.md`
5. `docs/decisions/2026-03-13-fork-bootstrap-and-upstream-boundary.md`
6. latest file in `diary/`
7. `next_session_prompt.md`

## Knowledge crystallization flow

```text
Session -> diary/ -> docs/learnings/ -> docs/decisions/
```

If a pattern becomes durable, move it out of handoff prose and into project docs.
