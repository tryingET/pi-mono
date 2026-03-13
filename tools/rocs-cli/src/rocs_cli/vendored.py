from __future__ import annotations

import hashlib
import json
from pathlib import Path


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def compute_expected_hashes(vendored_dir: Path) -> dict[str, str]:
    files: list[Path] = []
    for rel in [Path("pyproject.toml"), Path("README.md")]:
        files.append(rel)
    src_root = vendored_dir / "src" / "rocs_cli"
    if src_root.exists():
        for p in sorted(src_root.rglob("*.py")):
            if "__pycache__" in p.parts:
                continue
            files.append(p.relative_to(vendored_dir))
    out: dict[str, str] = {}
    for rel in files:
        out[str(rel)] = sha256_file(vendored_dir / rel)
    return out


def read_vendored_hashes(vendored_dir: Path) -> dict:
    p = vendored_dir / "VENDORED_HASHES.json"
    if not p.exists():
        raise FileNotFoundError(str(p))
    return json.loads(p.read_text("utf-8"))


def verify_vendored_hashes(vendored_dir: Path) -> tuple[bool, list[str]]:
    data = read_vendored_hashes(vendored_dir)
    if data.get("schema_version") != 1:
        return False, [f"unsupported schema_version: {data.get('schema_version')!r}"]
    expected = data.get("files")
    if not isinstance(expected, dict):
        return False, ["invalid VENDORED_HASHES.json: missing 'files' mapping"]

    ok = True
    lines: list[str] = []
    for rel, want in sorted(expected.items(), key=lambda kv: kv[0]):
        p = vendored_dir / rel
        if not p.exists():
            ok = False
            lines.append(f"missing: {rel}")
            continue
        got = sha256_file(p)
        if got != str(want):
            ok = False
            lines.append(f"mismatch: {rel} expected={want} got={got}")
        else:
            lines.append(f"ok: {rel} {got}")
    return ok, lines

