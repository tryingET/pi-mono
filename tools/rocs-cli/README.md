---
summary: "Minimal ROCS CLI reference vendored with this repo scaffold."
read_when:
  - "When using the vendored ROCS tooling from this repo"
  - "When debugging the deterministic ROCS wrapper selection order"
---

# rocs-cli

Minimal ROCS CLI for ai-society.

## Common commands
- `rocs version`
- `rocs resolve --repo . [--profile <name>] [--resolve-refs]`
- `rocs summary --repo .`
- `rocs validate --repo . [--profile <name>] [--resolve-refs]`
- `rocs build --repo . [--profile <name>] [--resolve-refs] [--clean]`

## Scope
- validate ROCS repo structure and ontology front matter
- build local artifacts into `ontology/dist/`

## Tests

```bash
uv run python -m unittest discover -s tests -p 'test_*.py' -q
```
