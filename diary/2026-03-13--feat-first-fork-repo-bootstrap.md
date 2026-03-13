---
summary: "Created softwareco/fork/pi-mono as the first concrete fork-lane repo for post-upstream DSPY work."
read_when:
  - "When resuming work in softwareco/fork/pi-mono after the initial bootstrap"
  - "When checking why the repo exists before upstream code is imported"
type: "diary"
---

# 2026-03-13 — First fork-lane repo bootstrap

## Summary
This session created `softwareco/fork/pi-mono` as the first concrete repo under the `softwareco/fork` lane.

The bootstrap intentionally stopped at a truthful control-plane state:
- repo created
- fork rationale documented
- repo-local work-items seeded
- active handoff updated
- standalone git history initialized

Upstream `badlogic/pi-mono` code was **not** imported in this slice.
That remains an explicit follow-up decision.

## Key decisions
- Use the company `tpl-project-repo` scaffold for the initial control-plane surface rather than blocking on a perfect upstream-topology template match.
- Normalize the generated repo to fork-lane reality (`location: fork`, TypeScript context, fork-specific README/AGENTS/CODEOWNERS).
- Capture the upstream-boundary decision in a repo-local ADR before any code import begins.
- Seed the next work queue around upstream import/sync posture and DSPY backlog translation.

## Validation
Passed:

```bash
./scripts/ci/smoke.sh
node ~/ai-society/core/agent-scripts/scripts/docs-list.mjs --docs . --strict
```

Not required for this bootstrap/docs slice:
- `./scripts/ci/full.sh` currently attempts remote ontology ref resolution and timed out against placeholder GitLab refs

## Next step recommendation
Start with issue `I2` from `governance/work-items.json`: decide how upstream `badlogic/pi-mono` should enter this repo and what evidence is required before local divergence work begins.
