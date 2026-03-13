---
summary: "Planning contract for repo-local work items."
read_when:
  - "When updating governance/work-items.json"
  - "When deciding whether work belongs in this repo-local queue"
---

# Project Work Items

`governance/work-items.json` is the repo-local planning model for this repository.

## Use this file when
- work is local to `softwareco/fork/pi-mono`
- the task needs milestone/issue/task structure
- the work should remain visible after the current session ends

## Validation

```bash
cue vet governance/work-items.json governance/work-items.cue
```

## Non-negotiable
Do not leave deferred work as scattered TODO comments or stale handoff prose.
Track deferred work in the authoritative work-items model.
