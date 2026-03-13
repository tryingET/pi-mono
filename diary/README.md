---
summary: "How to capture raw session notes for this repo."
read_when:
  - "When adding a new diary entry"
  - "When deciding where raw session context belongs"
---

# Diary

Repo-local session capture for the knowledge-crystallization flow.

## Rule

Use `diary/` as the canonical raw log for this repository.

- Entry file: `YYYY-MM-DD--type-scope-summary.md`
- Multiple sessions/day: `YYYY-MM-DD--type-scope-summary--2.md`
- Crystallize durable patterns into `docs/learnings/` or `docs/decisions/` when appropriate

## Entry template

```markdown
# YYYY-MM-DD — [Session Focus]

## What I Did
- [Actions]

## What Surprised Me
- [Unexpected outcomes]

## Patterns
- [Repeated structures]

## Crystallization Candidates
- -> docs/learnings/
- -> docs/decisions/
```
