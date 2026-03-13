---
summary: "Maintained fork scaffold for post-upstream DSPY work on pi-mono."
read_when:
  - "You start work in softwareco/fork/pi-mono"
  - "You need the repo purpose before deciding whether to import or diverge from upstream"
---

# pi-mono

Software Company maintained fork scaffold for post-upstream DSPY work.

## Context

- **Location**: fork
- **Language**: typescript
- **Upstream reference**: `badlogic/pi-mono`
- **Current state**: repo-local control plane exists; upstream code import/sync is still undecided

## Why this repo exists

Future DSPY-related work is no longer being pursued through additional `badlogic/pi-mono` upstream requests.
This repo is the explicit local home for that divergence.

The immediate goal is not a blind code dump.
The immediate goal is to create a clean, auditable fork surface with:
- repo-local mission and goals
- a decision record for why the fork exists
- a concrete work queue for the next bounded slices

## Bootstrap status

- fork repo scaffold created on `2026-03-13`
- rationale captured in `docs/decisions/2026-03-13-fork-bootstrap-and-upstream-boundary.md`
- next bounded slice: decide upstream import/sync posture and translate the abandoned DSPY issue set into the first executable local work item

## Structure

```text
pi-mono/
├── AGENTS.md
├── next_session_prompt.md
├── docs/
│   ├── org_context/
│   ├── project/
│   ├── decisions/
│   ├── learnings/
│   └── system4d/
├── diary/
├── governance/
├── ontology/
├── policy/
├── scripts/
├── src/
└── tests/
```

## What this repo is not yet

This repo does **not** yet contain imported upstream `pi-mono` code.
That is an explicit follow-up slice so sync posture, divergence boundaries, and validation expectations are documented before code lands.

## First commands

```bash
git status --short
./scripts/ci/smoke.sh
./scripts/ci/full.sh
node ~/ai-society/core/agent-scripts/scripts/docs-list.mjs --docs . --strict
```

## Generation note

This repo started from the company `tpl-project-repo` control-plane scaffold and was then normalized for the fork lane.
That keeps the initial governance surface lightweight while the real upstream import/sync posture is still being decided.
