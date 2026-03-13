from __future__ import annotations

from dataclasses import dataclass

from rocs_cli.model import OntDoc, relation_label_index


@dataclass(frozen=True)
class PackConfig:
    max_depth: int = 0
    rel_types: set[str] | None = None
    include_relation_defs: bool = False
    max_docs: int | None = None
    max_bytes: int | None = None


@dataclass(frozen=True)
class PackedDoc:
    ont_id: str
    kind: str  # concept|relation
    path: str
    text: str


def _parse_profile_pack_cfg(profile_def: dict | None) -> PackConfig:
    if not isinstance(profile_def, dict):
        return PackConfig()
    pack = profile_def.get("pack")
    if not isinstance(pack, dict):
        return PackConfig()

    max_depth = pack.get("max_depth")
    if max_depth is None:
        max_depth = 0
    try:
        max_depth = int(max_depth)
    except Exception:
        max_depth = 0

    rel_types = None
    raw_rel_types = pack.get("rel_types")
    if isinstance(raw_rel_types, list):
        rel_types = {str(x) for x in raw_rel_types if str(x).strip()}

    include_relation_defs = bool(pack.get("include_relation_defs") or False)

    def _maybe_int(v) -> int | None:
        if v is None:
            return None
        try:
            return int(v)
        except Exception:
            return None

    return PackConfig(
        max_depth=max_depth,
        rel_types=rel_types,
        include_relation_defs=include_relation_defs,
        max_docs=_maybe_int(pack.get("max_docs")),
        max_bytes=_maybe_int(pack.get("max_bytes")),
    )


def build_pack(
    *,
    concepts: dict[str, OntDoc],
    relations: dict[str, OntDoc],
    root_id: str,
    config: PackConfig,
) -> tuple[list[PackedDoc], dict]:
    if root_id not in concepts and root_id not in relations:
        raise KeyError(root_id)

    packed: list[PackedDoc] = []
    bytes_used = 0

    def add_doc(ont_id: str, kind: str, doc: OntDoc) -> None:
        nonlocal bytes_used
        text = doc.path.read_text("utf-8")
        b = len(text.encode("utf-8"))
        if config.max_bytes is not None and bytes_used + b > config.max_bytes:
            return
        bytes_used += b
        packed.append(PackedDoc(ont_id=ont_id, kind=kind, path=str(doc.path), text=text))

    # Concepts first: root, then BFS expansion.
    included_concepts: set[str] = set()
    frontier: list[tuple[str, int]] = []
    if root_id in concepts:
        included_concepts.add(root_id)
        frontier.append((root_id, 0))

    while frontier:
        cid, depth = frontier.pop(0)
        if config.max_docs is not None and len(included_concepts) >= config.max_docs:
            break
        if depth >= config.max_depth:
            continue
        cdoc = concepts.get(cid)
        if not cdoc:
            continue
        rels = cdoc.ont.get("relations") or []
        if not isinstance(rels, list):
            continue
        for edge in rels:
            if not isinstance(edge, dict):
                continue
            rtype = str(edge.get("type") or "")
            target = str(edge.get("target") or "")
            if not rtype or not target:
                continue
            if config.rel_types is not None and rtype not in config.rel_types:
                continue
            if target in concepts and target not in included_concepts:
                included_concepts.add(target)
                frontier.append((target, depth + 1))

    # Deterministic order: root, then other concepts, then relation defs (optional).
    ordered_concepts = []
    if root_id in included_concepts:
        ordered_concepts.append(root_id)
    ordered_concepts.extend(sorted([x for x in included_concepts if x != root_id]))

    for cid in ordered_concepts:
        cdoc = concepts.get(cid)
        if not cdoc:
            continue
        add_doc(cid, "concept", cdoc)

    included_relation_labels: set[str] = set()
    if config.include_relation_defs:
        for cid in ordered_concepts:
            cdoc = concepts.get(cid)
            if not cdoc:
                continue
            rels = cdoc.ont.get("relations") or []
            if not isinstance(rels, list):
                continue
            for edge in rels:
                if not isinstance(edge, dict):
                    continue
                rtype = str(edge.get("type") or "")
                if rtype:
                    included_relation_labels.add(rtype)

    rel_label_to_ids = relation_label_index(relations)
    included_relation_ids: set[str] = set()
    if config.include_relation_defs:
        for lbl in sorted(included_relation_labels):
            for rid in sorted(rel_label_to_ids.get(lbl) or []):
                included_relation_ids.add(rid)

    for rid in sorted(included_relation_ids):
        rdoc = relations.get(rid)
        if not rdoc:
            continue
        add_doc(rid, "relation", rdoc)

    meta = {
        "root_id": root_id,
        "config": {
            "max_depth": config.max_depth,
            "rel_types": sorted(config.rel_types) if config.rel_types is not None else None,
            "include_relation_defs": config.include_relation_defs,
            "max_docs": config.max_docs,
            "max_bytes": config.max_bytes,
        },
        "bytes_used": bytes_used,
        "counts": {
            "docs": len(packed),
            "concepts": len([d for d in packed if d.kind == "concept"]),
            "relations": len([d for d in packed if d.kind == "relation"]),
        },
    }
    return packed, meta


def pack_config_from_profile(*, profile_def: dict | None, overrides: dict) -> PackConfig:
    cfg = _parse_profile_pack_cfg(profile_def)
    max_depth = overrides.get("max_depth")
    if max_depth is not None:
        cfg = PackConfig(
            max_depth=int(max_depth),
            rel_types=cfg.rel_types,
            include_relation_defs=cfg.include_relation_defs,
            max_docs=cfg.max_docs,
            max_bytes=cfg.max_bytes,
        )

    rel_types = overrides.get("rel_types")
    if rel_types is not None:
        cfg = PackConfig(
            max_depth=cfg.max_depth,
            rel_types=set(rel_types) if rel_types else set(),
            include_relation_defs=cfg.include_relation_defs,
            max_docs=cfg.max_docs,
            max_bytes=cfg.max_bytes,
        )

    include_relation_defs = overrides.get("include_relation_defs")
    if include_relation_defs is not None:
        cfg = PackConfig(
            max_depth=cfg.max_depth,
            rel_types=cfg.rel_types,
            include_relation_defs=bool(include_relation_defs),
            max_docs=cfg.max_docs,
            max_bytes=cfg.max_bytes,
        )

    max_docs = overrides.get("max_docs")
    if max_docs is not None:
        cfg = PackConfig(
            max_depth=cfg.max_depth,
            rel_types=cfg.rel_types,
            include_relation_defs=cfg.include_relation_defs,
            max_docs=int(max_docs),
            max_bytes=cfg.max_bytes,
        )

    max_bytes = overrides.get("max_bytes")
    if max_bytes is not None:
        cfg = PackConfig(
            max_depth=cfg.max_depth,
            rel_types=cfg.rel_types,
            include_relation_defs=cfg.include_relation_defs,
            max_docs=cfg.max_docs,
            max_bytes=int(max_bytes),
        )

    return cfg

