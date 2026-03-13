from __future__ import annotations

import os
import shutil
import tarfile
import tempfile
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

from rocs_cli.cache import cache_dir


def load_env_file(path: Path, *, override: bool = False) -> None:
    """
    Minimal dotenv loader (KEY=VALUE). Used to support local workflows where `.env`
    is sourced without exporting variables.
    """
    if not path.exists():
        raise SystemExit(f"env file not found: {path}")
    for raw in path.read_text("utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if not k:
            continue
        if not override and k in os.environ:
            continue
        os.environ[k] = v


def gitlab_base_url() -> str:
    return (
        os.environ.get("ROCS_GITLAB_BASE_URL")
        or os.environ.get("GITLAB_BASE_URL")
        or os.environ.get("CI_SERVER_URL")
        or ""
    ).rstrip("/")


def gitlab_headers() -> dict[str, str]:
    tok = os.environ.get("ROCS_GITLAB_TOKEN") or os.environ.get("PAT_GITLAB") or ""
    if tok:
        return {"PRIVATE-TOKEN": tok}
    job = os.environ.get("CI_JOB_TOKEN") or ""
    if job:
        return {"JOB-TOKEN": job}
    return {}


def fetch_repo_archive(project_path: str, ref: str, *, base_url: str, headers: dict[str, str]) -> Path:
    if not base_url:
        raise SystemExit("missing GitLab base url (set ROCS_GITLAB_BASE_URL or GITLAB_BASE_URL)")

    safe_project = project_path.replace("/", "__")
    safe_ref = ref.replace("/", "__")
    dest = cache_dir() / "gitlab" / safe_project / safe_ref
    if dest.exists():
        return dest

    dest.parent.mkdir(parents=True, exist_ok=True)
    archive_url = (
        f"{base_url}/api/v4/projects/{quote(project_path, safe='')}/repository/archive.tar.gz?sha={quote(ref, safe='')}"
    )

    with tempfile.TemporaryDirectory(prefix="rocs-gitlab-") as td:
        td_path = Path(td)
        tar_path = td_path / "repo.tar.gz"
        req = Request(archive_url, headers=headers)
        with urlopen(req, timeout=30) as r:
            tar_path.write_bytes(r.read())

        extract_root = td_path / "extract"
        extract_root.mkdir(parents=True, exist_ok=True)
        with tarfile.open(tar_path, "r:gz") as tf:
            members = tf.getmembers()
            extract_root_resolved = extract_root.resolve()
            for m in members:
                if not m.name:
                    continue
                target = (extract_root / m.name).resolve()
                if not target.is_relative_to(extract_root_resolved):
                    raise SystemExit(f"unsafe GitLab archive member path: {m.name!r}")
            tf.extractall(extract_root)

        top_dirs = {Path(m.name).parts[0] for m in members if m.name and not m.name.startswith(".")}
        if len(top_dirs) != 1:
            raise SystemExit(f"unexpected GitLab archive layout for {project_path}@{ref}: {sorted(top_dirs)}")
        repo_root = extract_root / next(iter(top_dirs))
        if not repo_root.exists():
            raise SystemExit(f"failed to extract GitLab archive for {project_path}@{ref}")

        tmp_dest = dest.with_name(dest.name + ".tmp")
        if tmp_dest.exists():
            shutil.rmtree(tmp_dest)
        shutil.move(str(repo_root), str(tmp_dest))
        tmp_dest.replace(dest)
        return dest
