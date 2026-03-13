from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path

from rich.console import Console

from rocs_cli import __version__
from rocs_cli.cache import cache_dir, clear_cache, list_cache_entries, prune_cache
from rocs_cli.graph import build_edges, collapse_nodes, compute_layout, write_graph
from rocs_cli.id_index import build_id_index
from rocs_cli.inverses import check_inverses
from rocs_cli.layers import dist_dir, parse_gitlab_ref, repo_root as _repo_root, resolve_layers
from rocs_cli.lint import lint_docs
from rocs_cli.model import collect_docs
from rocs_cli.normalize import normalize_tree
from rocs_cli.pack import build_pack, pack_config_from_profile
from rocs_cli.rules import Finding, RULES
from rocs_cli.validate import (
    enforce_budget,
    validate_layers_exist,
    validate_manifest_placeholders,
    validate_reference_schema,
    validate_repo_structure,
)
from rocs_cli.vendored import verify_vendored_hashes


console = Console()


def _filter_layers(layers, *, only: str | None, layer: str | None):
    out = layers
    if only:
        if only not in ("path", "ref"):
            raise SystemExit("--only must be path|ref")
        out = [l for l in out if l.kind == only]
    if layer:
        out = [l for l in out if l.name == layer]
    return out


def _maybe_load_env_file(env_file: str | None) -> None:
    if not env_file:
        return
    from rocs_cli.gitlab import load_env_file

    load_env_file(Path(env_file))


def _findings_to_json(findings: list[Finding]) -> list[dict]:
    return [f.to_dict() for f in findings]


def _print_findings(findings: list[Finding]) -> None:
    for f in findings:
        loc = f.path or ""
        if loc:
            console.print(f"- {f.rule_id} {f.severity} {loc}: {f.message}")
        else:
            console.print(f"- {f.rule_id} {f.severity}: {f.message}")


def _write_resolve_artifact(repo: Path, *, layers, profile: str | None) -> Path:
    dist = dist_dir(repo)
    dist.mkdir(parents=True, exist_ok=True)
    entries = []
    for l in layers:
        cache_repo_root = None
        if l.kind == "ref":
            # <cache>/gitlab/<proj>/<ref>/ontology/src
            cache_repo_root = str(l.src_root.parent.parent)
        entries.append(
            {
                "name": l.name,
                "kind": l.kind,
                "origin": l.origin,
                "src_root": str(l.src_root),
                "cache_repo_root": cache_repo_root,
            }
        )
    payload = {
        "version": __version__,
        "generated_at": int(time.time()),
        "repo": str(repo),
        "profile": profile,
        "layers": entries,
    }
    out = dist / "resolve.json"
    out.write_text(json.dumps(payload, indent=2) + "\n", "utf-8")
    return out


def cmd_version(_args: argparse.Namespace) -> int:
    console.print(f"rocs-cli {__version__}")
    return 0


def cmd_resolve(args: argparse.Namespace) -> int:
    _maybe_load_env_file(getattr(args, "env_file", None))
    repo = _repo_root(args.repo)
    layers, meta = resolve_layers(repo, profile=args.profile, resolve_refs=args.resolve_refs)
    layers = _filter_layers(layers, only=args.only, layer=args.layer)
    payload = {
        "repo": str(repo),
        "profile": meta.get("profile"),
        "layers": [{"name": l.name, "origin": l.origin, "src_root": str(l.src_root), "kind": l.kind} for l in layers],
    }
    if args.write_dist:
        _write_resolve_artifact(repo, layers=layers, profile=payload["profile"])
    if args.format == "json":
        console.print_json(json.dumps(payload))
    else:
        console.print(f"repo: {payload['repo']}")
        console.print(f"profile: {payload['profile']}")
        for l in payload["layers"]:
            console.print(f"- layer {l['name']}: {l['origin']}")
    return 0


def cmd_summary(args: argparse.Namespace) -> int:
    _maybe_load_env_file(getattr(args, "env_file", None))
    repo = _repo_root(args.repo)
    layers, meta = resolve_layers(repo, profile=args.profile, resolve_refs=args.resolve_refs)
    layers = _filter_layers(layers, only=args.only, layer=args.layer)
    concepts, relations = collect_docs(layers)
    payload = {
        "repo": str(repo),
        "profile": meta.get("profile"),
        "layers": [{"name": l.name, "origin": l.origin, "src_root": str(l.src_root), "kind": l.kind} for l in layers],
        "counts": {"concepts": len(concepts), "relations": len(relations)},
    }
    if args.format == "text":
        console.print(f"repo: {payload['repo']}")
        console.print(f"profile: {payload['profile']}")
        console.print(f"counts: concepts={payload['counts']['concepts']} relations={payload['counts']['relations']}")
        for l in payload["layers"]:
            console.print(f"- layer {l['name']}: {l['origin']}")
    else:
        console.print_json(json.dumps(payload))
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    _maybe_load_env_file(getattr(args, "env_file", None))
    repo = _repo_root(args.repo)
    findings: list[Finding] = []
    findings.extend(validate_repo_structure(repo))
    findings.extend(validate_manifest_placeholders(repo, strict_placeholders=args.strict_placeholders))
    layers, meta = resolve_layers(repo, profile=args.profile, resolve_refs=args.resolve_refs)
    layers = _filter_layers(layers, only=args.only, layer=args.layer)
    findings.extend(validate_layers_exist(layers))
    schema_findings, _meta2 = validate_reference_schema(
        layers, strict_placeholders=args.strict_placeholders, validate_deps=args.validate_deps
    )
    findings.extend(schema_findings)

    concepts, relations = collect_docs(layers)
    budget = None
    profile_def = meta.get("profile_def") or {}
    if isinstance(profile_def, dict) and profile_def.get("budget") is not None:
        try:
            budget = int(profile_def.get("budget"))
        except Exception:
            findings.append(
                Finding(
                    rule_id="BUD001",
                    severity="error",
                    message=f"invalid profile budget (expected int): {profile_def.get('budget')!r}",
                )
            )
    ok_budget, budget_payload = enforce_budget(concepts, relations, budget=budget)
    if not ok_budget:
        findings.append(
            Finding(
                rule_id="BUD010",
                severity="error",
                message=f"budget exceeded: units={budget_payload['units']} budget={budget_payload['budget']}",
            )
        )

    if findings:
        if args.json:
            console.print_json(json.dumps({"ok": False, "findings": _findings_to_json(findings), "budget": budget_payload}))
        else:
            console.print("[red]rocs validate: FAIL[/red]")
            _print_findings(findings)
        return 1

    if args.json:
        console.print_json(json.dumps({"ok": True, "findings": [], "budget": budget_payload}))
    else:
        console.print("[green]rocs validate: OK[/green]")
    return 0


def cmd_build(args: argparse.Namespace) -> int:
    _maybe_load_env_file(getattr(args, "env_file", None))
    repo = _repo_root(args.repo)
    dist = dist_dir(repo)
    if args.clean and dist.exists():
        shutil.rmtree(dist)
    dist.mkdir(parents=True, exist_ok=True)
    layers, meta = resolve_layers(repo, profile=args.profile, resolve_refs=args.resolve_refs)
    layers = _filter_layers(layers, only=args.only, layer=args.layer)
    concepts, relations = collect_docs(layers)
    _write_resolve_artifact(repo, layers=layers, profile=meta.get("profile"))
    payload = {
        "repo": str(repo),
        "profile": meta.get("profile"),
        "layers": [{"name": l.name, "origin": l.origin} for l in layers],
        "counts": {"concepts": len(concepts), "relations": len(relations)},
        "concept_ids": sorted(concepts.keys()),
        "relation_ids": sorted(relations.keys()),
    }
    (dist / "summary.json").write_text(json.dumps(payload, indent=2) + "\n", "utf-8")
    (dist / "id_index.json").write_text(json.dumps(build_id_index(concepts=concepts, relations=relations), indent=2) + "\n", "utf-8")
    console.print(f"[green]wrote[/green] {dist/'summary.json'}")
    console.print(f"[green]wrote[/green] {dist/'id_index.json'}")
    return 0


def cmd_pack(args: argparse.Namespace) -> int:
    _maybe_load_env_file(getattr(args, "env_file", None))
    repo = _repo_root(args.repo)
    layers, meta = resolve_layers(repo, profile=args.profile, resolve_refs=args.resolve_refs)
    layers = _filter_layers(layers, only=args.only, layer=args.layer)
    concepts, relations = collect_docs(layers)
    cid = args.ont_id
    doc = concepts.get(cid) or relations.get(cid)
    if not doc:
        console.print(f"[red]unknown ont_id[/red]: {cid}")
        return 2

    rel_types: set[str] | None = None
    if args.rel_types:
        rel_types = {x.strip() for x in args.rel_types.split(",") if x.strip()}

    cfg = pack_config_from_profile(
        profile_def=meta.get("profile_def") if isinstance(meta, dict) else None,
        overrides={
            "max_depth": args.depth,
            "rel_types": rel_types,
            "include_relation_defs": True if args.include_relation_defs else None,
            "max_docs": args.max_docs,
            "max_bytes": args.max_bytes,
        },
    )

    packed, pack_meta = build_pack(concepts=concepts, relations=relations, root_id=cid, config=cfg)
    if args.format == "json":
        console.print_json(
            json.dumps(
                {
                    "repo": str(repo),
                    "profile": meta.get("profile"),
                    "pack": pack_meta,
                    "docs": [{"ont_id": d.ont_id, "kind": d.kind, "path": d.path} for d in packed],
                }
            )
        )
        return 0

    first = True
    for d in packed:
        if not first:
            console.print("\n---\n")
        first = False
        console.print(d.path)
        console.print(d.text)
    return 0


def cmd_lint(args: argparse.Namespace) -> int:
    _maybe_load_env_file(getattr(args, "env_file", None))
    repo = _repo_root(args.repo)
    layers, _meta = resolve_layers(repo, profile=args.profile, resolve_refs=args.resolve_refs)
    layers = _filter_layers(layers, only=args.only, layer=args.layer)
    concepts, relations = collect_docs(layers)
    findings = lint_docs(concepts, relations, strict_placeholders=args.strict_placeholders)
    rule_filter: set[str] | None = None
    if args.rules and args.rules != "all":
        rule_filter = {x.strip() for x in args.rules.split(",") if x.strip()}
        unknown = sorted([r for r in rule_filter if r not in RULES])
        if unknown:
            raise SystemExit(f"unknown lint rule ids: {unknown}")
    if rule_filter is not None:
        findings = [f for f in findings if f.rule_id in rule_filter]
    if args.json:
        console.print_json(json.dumps({"findings": _findings_to_json(findings)}))
    else:
        if findings:
            console.print("[yellow]rocs lint[/yellow]")
            _print_findings(findings)
        else:
            console.print("[green]rocs lint: OK[/green]")
    if findings and args.fail_on_warn:
        return 1
    return 0


def cmd_check_inverses(args: argparse.Namespace) -> int:
    _maybe_load_env_file(getattr(args, "env_file", None))
    repo = _repo_root(args.repo)
    layers, _meta = resolve_layers(repo, profile=args.profile, resolve_refs=args.resolve_refs)
    layers = _filter_layers(layers, only=args.only, layer=args.layer)
    _concepts, relations = collect_docs(layers)
    findings = check_inverses(relations, fix=args.fix)
    if args.json:
        console.print_json(json.dumps({"findings": _findings_to_json(findings)}))
    else:
        if not findings:
            console.print("[green]rocs check-inverses: OK[/green]")
        else:
            console.print("[yellow]rocs check-inverses[/yellow]")
            _print_findings(findings)
    if any(f.severity == "error" for f in findings):
        return 1
    return 0


def cmd_graph(args: argparse.Namespace) -> int:
    _maybe_load_env_file(getattr(args, "env_file", None))
    repo = _repo_root(args.repo)
    layers, _meta = resolve_layers(repo, profile=args.profile, resolve_refs=args.resolve_refs)
    layers = _filter_layers(layers, only=args.only, layer=args.layer)
    concepts, _relations = collect_docs(layers)
    rel_filter: set[str] | None = None
    if args.scope == "taxonomy":
        rel_filter = {"is_a"}
    if args.relation:
        rel_filter = {args.relation}
    edges = build_edges(concepts, rel_filter=rel_filter)
    nodes = sorted(concepts.keys())
    if args.collapse_prefix:
        nodes, edges = collapse_nodes(nodes, edges, prefixes=args.collapse_prefix.split(","))
    layout = compute_layout(nodes, edges, layout=args.layout)
    if args.out:
        out = Path(args.out)
    else:
        if args.format == "dot":
            out = dist_dir(repo) / "graph.dot"
        elif args.format == "json":
            out = dist_dir(repo) / "graph.json"
        elif args.format == "excalidraw-cli-json":
            out = dist_dir(repo) / "graph.excalidraw-cli.json"
        else:
            out = dist_dir(repo) / "graph.excalidraw.json"
    direction = "LR" if args.layout == "dag" else "TB"
    write_graph(out, fmt=args.format, nodes=nodes, edges=edges, layout=layout, direction=direction)
    console.print(f"[green]wrote[/green] {out}")
    return 0


def cmd_cache(args: argparse.Namespace) -> int:
    if args.subcmd == "dir":
        console.print(str(cache_dir()))
        return 0
    if args.subcmd == "ls":
        entries = list_cache_entries()
        for e in entries:
            console.print(f"{e.bytes:>12}  {e.path}")
        return 0
    if args.subcmd == "clear":
        clear_cache()
        console.print("[green]cache cleared[/green]")
        return 0
    if args.subcmd == "prune":
        removed = prune_cache(max_age_days=int(args.max_age_days))
        console.print(f"[green]pruned[/green] {removed}")
        return 0
    raise SystemExit(f"unknown cache subcmd: {args.subcmd}")


def cmd_vendored_check(args: argparse.Namespace) -> int:
    vendored_dir = Path(args.vendored_dir).resolve()
    ok, lines = verify_vendored_hashes(vendored_dir)
    if ok:
        console.print("[green]vendored-check: OK[/green]")
        return 0
    console.print("[red]vendored-check: FAIL[/red]")
    for ln in lines[:200]:
        console.print(f"- {ln}")
    if len(lines) > 200:
        console.print(f"... ({len(lines) - 200} more)")
    return 1


def cmd_normalize(args: argparse.Namespace) -> int:
    _maybe_load_env_file(getattr(args, "env_file", None))
    repo = _repo_root(args.repo)
    layers, _meta = resolve_layers(repo, profile=args.profile, resolve_refs=args.resolve_refs)
    # normalize never touches ref layers
    layers = _filter_layers(layers, only="path", layer=args.layer)
    changed_paths: list[str] = []
    for l in layers:
        for c in normalize_tree(l.src_root, apply=args.apply):
            if c.changed:
                changed_paths.append(str(c.path))

    if changed_paths and not args.apply:
        console.print("[yellow]rocs normalize: changes needed (rerun with --apply)[/yellow]")
        for p in changed_paths[:50]:
            console.print(f"- {p}")
        if len(changed_paths) > 50:
            console.print(f"... ({len(changed_paths) - 50} more)")
        return 2

    if changed_paths and args.apply:
        console.print(f"[green]rocs normalize: applied[/green] ({len(changed_paths)} files)")
    else:
        console.print("[green]rocs normalize: OK[/green]")
    return 0


def _diff_sets(a: set[str], b: set[str]) -> tuple[list[str], list[str]]:
    removed = sorted(a - b)
    added = sorted(b - a)
    return removed, added


def cmd_diff(args: argparse.Namespace) -> int:
    _maybe_load_env_file(getattr(args, "env_file", None))
    repo = _repo_root(args.repo)
    baseline = args.baseline.strip()
    parsed = parse_gitlab_ref(baseline)
    if parsed is None:
        raise SystemExit("--baseline must be a <gitlab:...@...> locator for now")
    # Treat baseline as repo archive root; then diff its resolved view against current.
    from rocs_cli.gitlab import fetch_repo_archive, gitlab_base_url, gitlab_headers

    project_path, ref = parsed
    base_repo = fetch_repo_archive(project_path, ref, base_url=gitlab_base_url(), headers=gitlab_headers())

    cur_layers, cur_meta = resolve_layers(repo, profile=args.profile, resolve_refs=args.resolve_refs)
    base_layers, base_meta = resolve_layers(base_repo, profile=args.profile, resolve_refs=args.resolve_refs)
    cur_layers = _filter_layers(cur_layers, only=args.only, layer=args.layer)
    base_layers = _filter_layers(base_layers, only=args.only, layer=args.layer)

    cur_concepts, cur_relations = collect_docs(cur_layers)
    base_concepts, base_relations = collect_docs(base_layers)

    cur_edges = {f"{e.src}|{e.rel}|{e.dst}" for e in build_edges(cur_concepts, rel_filter=None)}
    base_edges = {f"{e.src}|{e.rel}|{e.dst}" for e in build_edges(base_concepts, rel_filter=None)}

    removed_concepts, added_concepts = _diff_sets(set(base_concepts.keys()), set(cur_concepts.keys()))
    removed_relations, added_relations = _diff_sets(set(base_relations.keys()), set(cur_relations.keys()))
    removed_edges, added_edges = _diff_sets(base_edges, cur_edges)

    breaking = {
        "removed_concepts": removed_concepts,
        "removed_relations": removed_relations,
        "removed_edges": removed_edges,
    }

    payload = {
        "repo": str(repo),
        "profile": cur_meta.get("profile"),
        "baseline": baseline,
        "baseline_repo": str(base_repo),
        "diff": {
            "concepts": {"removed": removed_concepts, "added": added_concepts},
            "relations": {"removed": removed_relations, "added": added_relations},
            "edges": {"removed": removed_edges, "added": added_edges},
        },
        "breaking": breaking,
    }

    dist = dist_dir(repo)
    dist.mkdir(parents=True, exist_ok=True)
    out = dist / "diff.json"
    out.write_text(json.dumps(payload, indent=2) + "\n", "utf-8")

    if args.json:
        console.print_json(json.dumps(payload))
        return 0 if not (removed_concepts or removed_relations or removed_edges) else 2

    console.print(f"baseline: {baseline}")
    console.print(f"profile: {payload['profile']}")
    console.print(f"wrote: {out}")
    console.print(f"concepts: -{len(removed_concepts)} +{len(added_concepts)}")
    console.print(f"relations: -{len(removed_relations)} +{len(added_relations)}")
    console.print(f"edges: -{len(removed_edges)} +{len(added_edges)}")
    if removed_concepts or removed_relations or removed_edges:
        console.print("[yellow]breaking removals detected[/yellow]")
        return 2
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rocs")
    parser.add_argument("--version", action="version", version=f"rocs-cli {__version__}")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("version")
    p.set_defaults(fn=cmd_version)

    p = sub.add_parser("resolve")
    p.add_argument("--repo", default=".", help="repo root path")
    p.add_argument("--profile", help="manifest profile name (defaults to rocs.profiles.default)")
    p.add_argument("--resolve-refs", action="store_true", help="allow fetching <gitlab:...> layers into cache")
    p.add_argument("--env-file", help="dotenv file to load into environment (for GitLab base url/token)")
    p.add_argument("--only", help="filter layers: path|ref")
    p.add_argument("--layer", help="filter a specific layer name")
    p.add_argument("--format", choices=["json", "text"], default="text")
    p.add_argument("--write-dist", action="store_true", help="write ontology/dist/resolve.json")
    p.set_defaults(fn=cmd_resolve)

    p = sub.add_parser("summary")
    p.add_argument("--repo", default=".", help="repo root path")
    p.add_argument("--profile", help="manifest profile name (defaults to rocs.profiles.default)")
    p.add_argument("--resolve-refs", action="store_true", help="allow fetching <gitlab:...> layers into cache")
    p.add_argument("--env-file", help="dotenv file to load into environment (for GitLab base url/token)")
    p.add_argument("--only", help="filter layers: path|ref")
    p.add_argument("--layer", help="filter a specific layer name")
    p.add_argument("--format", choices=["json", "text"], default="json")
    p.set_defaults(fn=cmd_summary)

    p = sub.add_parser("validate")
    p.add_argument("--repo", default=".", help="repo root path")
    p.add_argument("--strict-placeholders", action="store_true", help="fail if any <...> placeholders exist")
    p.add_argument("--profile", help="manifest profile name (defaults to rocs.profiles.default)")
    p.add_argument("--resolve-refs", action="store_true", help="allow fetching <gitlab:...> layers into cache")
    p.add_argument("--env-file", help="dotenv file to load into environment (for GitLab base url/token)")
    p.add_argument("--only", help="filter layers: path|ref")
    p.add_argument("--layer", help="filter a specific layer name")
    p.add_argument(
        "--validate-deps",
        action="store_true",
        help="also enforce strict schema rules on dependency layers (ref layers); default: validate path layers only",
    )
    p.add_argument("--json", action="store_true", help="emit JSON result")
    p.set_defaults(fn=cmd_validate)

    p = sub.add_parser("diff")
    p.add_argument("--repo", default=".", help="repo root path")
    p.add_argument("--baseline", required=True, help="baseline <gitlab:...@ref> to diff against")
    p.add_argument("--profile", help="manifest profile name (defaults to rocs.profiles.default)")
    p.add_argument("--resolve-refs", action="store_true", help="allow fetching <gitlab:...> layers into cache")
    p.add_argument("--env-file", help="dotenv file to load into environment (for GitLab base url/token)")
    p.add_argument("--only", help="filter layers: path|ref")
    p.add_argument("--layer", help="filter a specific layer name")
    p.add_argument("--json", action="store_true", help="emit JSON diff")
    p.set_defaults(fn=cmd_diff)

    p = sub.add_parser("lint")
    p.add_argument("--repo", default=".", help="repo root path")
    p.add_argument("--profile", help="manifest profile name (defaults to rocs.profiles.default)")
    p.add_argument("--resolve-refs", action="store_true", help="allow fetching <gitlab:...> layers into cache")
    p.add_argument("--env-file", help="dotenv file to load into environment (for GitLab base url/token)")
    p.add_argument("--only", help="filter layers: path|ref")
    p.add_argument("--layer", help="filter a specific layer name")
    p.add_argument("--strict-placeholders", action="store_true", help="treat placeholders in bodies as lint warnings")
    p.add_argument("--rules", default="all", help="comma-separated rule ids (or 'all')")
    p.add_argument("--json", action="store_true", help="emit JSON result")
    p.add_argument("--fail-on-warn", action="store_true", help="exit non-zero if warnings exist")
    p.set_defaults(fn=cmd_lint)

    p = sub.add_parser("check-inverses")
    p.add_argument("--repo", default=".", help="repo root path")
    p.add_argument("--profile", help="manifest profile name (defaults to rocs.profiles.default)")
    p.add_argument("--resolve-refs", action="store_true", help="allow fetching <gitlab:...> layers into cache")
    p.add_argument("--env-file", help="dotenv file to load into environment (for GitLab base url/token)")
    p.add_argument("--only", help="filter layers: path|ref")
    p.add_argument("--layer", help="filter a specific layer name")
    p.add_argument("--fix", action="store_true", help="apply safe fixes to local/path layer relation docs")
    p.add_argument("--json", action="store_true", help="emit JSON result")
    p.set_defaults(fn=cmd_check_inverses)

    p = sub.add_parser("graph")
    p.add_argument("--repo", default=".", help="repo root path")
    p.add_argument("--profile", help="manifest profile name (defaults to rocs.profiles.default)")
    p.add_argument("--resolve-refs", action="store_true", help="allow fetching <gitlab:...> layers into cache")
    p.add_argument("--env-file", help="dotenv file to load into environment (for GitLab base url/token)")
    p.add_argument("--only", help="filter layers: path|ref")
    p.add_argument("--layer", help="filter a specific layer name")
    p.add_argument("--scope", choices=["all", "taxonomy"], default="all")
    p.add_argument("--relation", help="only include this relation label (e.g. is_a)")
    p.add_argument("--collapse-prefix", help="comma-separated prefixes to collapse (e.g. co.software)")
    p.add_argument("--layout", choices=["grid", "dag"], default="grid")
    p.add_argument("--format", choices=["excalidraw", "excalidraw-cli-json", "json", "dot"], default="excalidraw")
    p.add_argument("--out", help="output path (default: ontology/dist/graph.<fmt>.*)")
    p.set_defaults(fn=cmd_graph)

    p = sub.add_parser("build")
    p.add_argument("--repo", default=".", help="repo root path")
    p.add_argument("--profile", help="manifest profile name (defaults to rocs.profiles.default)")
    p.add_argument("--resolve-refs", action="store_true", help="allow fetching <gitlab:...> layers into cache")
    p.add_argument("--env-file", help="dotenv file to load into environment (for GitLab base url/token)")
    p.add_argument("--only", help="filter layers: path|ref")
    p.add_argument("--layer", help="filter a specific layer name")
    p.add_argument("--clean", action="store_true", help="remove ontology/dist before building")
    p.set_defaults(fn=cmd_build)

    p = sub.add_parser("pack")
    p.add_argument("ont_id")
    p.add_argument("--repo", default=".", help="repo root path")
    p.add_argument("--profile", help="manifest profile name (defaults to rocs.profiles.default)")
    p.add_argument("--resolve-refs", action="store_true", help="allow fetching <gitlab:...> layers into cache")
    p.add_argument("--env-file", help="dotenv file to load into environment (for GitLab base url/token)")
    p.add_argument("--only", help="filter layers: path|ref")
    p.add_argument("--layer", help="filter a specific layer name")
    p.add_argument("--depth", type=int, help="relation expansion depth (default: profile pack.max_depth or 0)")
    p.add_argument("--rel-types", help="comma-separated relation labels to follow (default: profile pack.rel_types or all)")
    p.add_argument("--include-relation-defs", action="store_true", help="include relation definition docs used")
    p.add_argument("--max-docs", type=int, help="max docs in pack (default: profile pack.max_docs)")
    p.add_argument("--max-bytes", type=int, help="max UTF-8 bytes in pack (default: profile pack.max_bytes)")
    p.add_argument("--format", choices=["text", "json"], default="text")
    p.set_defaults(fn=cmd_pack)

    p = sub.add_parser("vendored-check")
    p.add_argument("--vendored-dir", required=True, help="path to vendored rocs-cli dir (contains VENDORED_HASHES.json)")
    p.set_defaults(fn=cmd_vendored_check)

    p = sub.add_parser("cache")
    sub2 = p.add_subparsers(dest="subcmd", required=True)
    p2 = sub2.add_parser("dir")
    p2.set_defaults(fn=cmd_cache)
    p2 = sub2.add_parser("ls")
    p2.set_defaults(fn=cmd_cache)
    p2 = sub2.add_parser("clear")
    p2.set_defaults(fn=cmd_cache)
    p2 = sub2.add_parser("prune")
    p2.add_argument("--max-age-days", default="30")
    p2.set_defaults(fn=cmd_cache)

    p = sub.add_parser("normalize")
    p.add_argument("--repo", default=".", help="repo root path")
    p.add_argument("--profile", help="manifest profile name (defaults to rocs.profiles.default)")
    p.add_argument("--resolve-refs", action="store_true", help="allow fetching <gitlab:...> layers into cache")
    p.add_argument("--env-file", help="dotenv file to load into environment (for GitLab base url/token)")
    p.add_argument("--layer", help="only normalize a specific layer name (path layers only)")
    p.add_argument("--apply", action="store_true", help="apply changes (default: check only)")
    p.set_defaults(fn=cmd_normalize)

    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    raise SystemExit(int(args.fn(args)))
