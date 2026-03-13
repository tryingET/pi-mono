---
summary: "Accepted decision to create softwareco/fork/pi-mono as the local home for post-upstream DSPY work."
read_when:
  - "When deciding why the fork exists"
  - "When choosing how much authority still belongs to upstream issue follow-up"
---

# ADR — Bootstrap `softwareco/fork/pi-mono` and make the upstream boundary explicit

- Status: accepted
- Date: 2026-03-13

## Context

Software Company pursued a DSPY-related roadmap against `badlogic/pi-mono` through the upstream issue-tracker path.
That line is now considered closed locally for future work.
Some asks were rejected or abandoned before submission, and the local direction changed from "continue requesting upstream changes" to "create an explicit fork home for the work."

Without a concrete repo under `softwareco/fork/`, that decision would remain rhetorical:
- no repo-local work queue
- no durable fork rationale
- no obvious place to record sync/import policy
- recurring risk of falling back to stale upstream issue context as if it were still the authority surface

## Decision

Create `softwareco/fork/pi-mono` as the first concrete repo in the fork lane.

For this bootstrap slice:
1. use the company `tpl-project-repo` control-plane scaffold to create the repo quickly
2. normalize the repo metadata to the fork lane (`location: fork`, TypeScript context)
3. record the fork rationale in repo-local mission/goals/decision docs
4. defer actual upstream code import/sync to the next explicit decision slice

## Consequences

### Positive
- There is now a concrete local home for post-upstream DSPY work.
- Future work can be planned in repo-local artifacts instead of drifting across issue-tracker notes.
- The distinction between upstream reference material and local fork authority is explicit.

### Negative / debt accepted
- The repo currently contains control-plane scaffolding rather than imported upstream code.
- The scaffold comes from `tpl-project-repo`, so structure may evolve once the real upstream import/sync posture is chosen.
- A follow-up decision is still required before code-bearing divergence work begins.

## Follow-up

The next required decision is how `badlogic/pi-mono` enters this repo:
- mirror import
- filtered import
- another explicit seed strategy

That decision must also define sync cadence, merge/rebase posture, and the evidence expected before local divergence expands.
