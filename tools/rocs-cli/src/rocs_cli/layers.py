from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import yaml

from rocs_cli.gitlab import fetch_repo_archive, gitlab_base_url, gitlab_headers


GITLAB_REF_RE = re.compile(r"^<gitlab:([^@>]+)@([^>]+)>$")


@dataclass(frozen=True)
class LayerSpec:
    name: str
    src_root: Path
    origin: str  # path or ref locator
    kind: str  # path|ref


def repo_root(repo: str) -> Path:
    return Path(repo).resolve()


def ontology_root(repo_root: Path) -> Path:
    return repo_root / "ontology"


def manifest_path(repo_root: Path) -> Path:
    return ontology_root(repo_root) / "manifest.yaml"


def dist_dir(repo_root: Path) -> Path:
    return ontology_root(repo_root) / "dist"


def load_manifest(repo_root: Path) -> dict:
    p = manifest_path(repo_root)
    if not p.exists():
        raise SystemExit(f"missing ontology manifest: {p}")
    return yaml.safe_load(p.read_text("utf-8")) or {}


def parse_gitlab_ref(locator: str) -> tuple[str, str] | None:
    m = GITLAB_REF_RE.match(locator.strip())
    if not m:
        return None
    return m.group(1), m.group(2)


def _src_root_for_ref(locator: str, *, resolve_refs: bool) -> tuple[Path, str]:
    parsed = parse_gitlab_ref(locator)
    if not parsed:
        raise SystemExit(f"invalid GitLab ref locator (expected <gitlab:...@...>): {locator!r}")
    project_path, ref = parsed
    if not resolve_refs:
        raise SystemExit(
            f"ref layer requires network resolution: {locator} (rerun with --resolve-refs; offline-first default)"
        )
    repo = fetch_repo_archive(project_path, ref, base_url=gitlab_base_url(), headers=gitlab_headers())
    return (repo / "ontology" / "src"), locator


def resolve_layers(repo_root: Path, *, profile: str | None, resolve_refs: bool) -> tuple[list[LayerSpec], dict]:
    manifest = load_manifest(repo_root)
    rocs = manifest.get("rocs") or {}
    profiles = rocs.get("profiles") or {}

    default_profile = profiles.get("default")
    if profile is None and isinstance(default_profile, str) and default_profile:
        profile = default_profile

    layer_cfgs: list[dict] = []
    if isinstance(rocs.get("layers"), list):
        for x in rocs.get("layers") or []:
            if isinstance(x, dict):
                layer_cfgs.append(x)
    else:
        # Back-compat: rocs.layer + depends_on list.
        deps = rocs.get("depends_on") or []
        if isinstance(deps, list):
            for d in deps:
                if isinstance(d, dict) and d.get("ref"):
                    layer_cfgs.append({"name": str(d.get("layer") or ""), "ref": str(d.get("ref") or "")})
        self_name = str(rocs.get("layer") or "repo")
        layer_cfgs.append({"name": self_name, "path": "ontology/src"})

    include: set[str] | None = None
    exclude: set[str] = set()
    profile_def: dict | None = None
    if profile:
        profile_def = profiles.get(profile)
        if not isinstance(profile_def, dict):
            raise SystemExit(f"unknown profile {profile!r} (missing rocs.profiles.{profile})")
        inc = profile_def.get("include_layers")
        exc = profile_def.get("exclude_layers")
        if isinstance(inc, list):
            include = {str(x) for x in inc}
        if isinstance(exc, list):
            exclude = {str(x) for x in exc}

    layers: list[LayerSpec] = []
    for cfg in layer_cfgs:
        name = str(cfg.get("name") or "")
        if not name:
            raise SystemExit(f"layer missing name: {cfg!r}")
        if include is not None and name not in include:
            continue
        if name in exclude:
            continue

        if "path" in cfg:
            src_root = (repo_root / str(cfg["path"])).resolve()
            layers.append(LayerSpec(name=name, src_root=src_root, origin=str(cfg["path"]), kind="path"))
        elif "ref" in cfg:
            src_root, origin = _src_root_for_ref(str(cfg["ref"]), resolve_refs=resolve_refs)
            layers.append(LayerSpec(name=name, src_root=src_root, origin=origin, kind="ref"))
        else:
            raise SystemExit(f"layer must have path or ref: {cfg!r}")

    meta = {"manifest": manifest, "profile": profile, "profile_def": profile_def}
    return layers, meta

