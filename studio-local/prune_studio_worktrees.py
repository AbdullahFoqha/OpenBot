#!/usr/bin/env python3
"""Prune *.studio-worktree dirs left by studio_run_task.

Dry-run by default. Never removes worktrees for in_progress tasks.
Removes when:
  - linked task is terminal (in_review|integrated|blocked|interrupted|failed|done)
    AND mtime age >= --older-than hours (default 2), OR
  - orphan (no matching taskId suffix) AND age >= --older-than hours.

Usage:
  ./studio-local/prune-studio-worktrees.sh [--apply] [--older-than HOURS] [--projects-dir DIR]
  ./studio prune-worktrees [--apply] [--older-than HOURS]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

TERMINAL = {
    "in_review",
    "integrated",
    "blocked",
    "interrupted",
    "failed",
    "done",
}
PROTECTED = {"in_progress"}


def fetch_tasks(server: str) -> tuple[dict[str, dict], int]:
    """Map last-6-char taskId suffix → {id, state}. Count in_progress."""
    by_suffix: dict[str, dict] = {}
    active = 0
    try:
        with urllib.request.urlopen(f"{server}/api/studio/tasks", timeout=10) as r:
            data = json.load(r)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
        print(f"WARN: could not load tasks from {server}: {e}", file=sys.stderr)
        return by_suffix, active
    for t in data.get("tasks") or []:
        tid = str(t.get("id") or "")
        state = str(t.get("state") or "")
        if state == "in_progress":
            active += 1
        if len(tid) >= 6:
            by_suffix[tid[-6:].lower()] = {"id": tid, "state": state}
    return by_suffix, active


def worktree_main_repo(path: Path) -> Path | None:
    gitfile = path / ".git"
    if not gitfile.is_file():
        return None
    text = gitfile.read_text().strip()
    if not text.startswith("gitdir:"):
        return None
    gitdir = Path(text.split(":", 1)[1].strip())
    # .../repo/.git/worktrees/<name> → repo
    try:
        return gitdir.parent.parent.parent
    except Exception:
        return None


def remove_worktree(path: Path) -> str:
    main = worktree_main_repo(path)
    if main and (main / ".git").exists():
        r = subprocess.run(
            ["git", "-C", str(main), "worktree", "remove", "--force", str(path)],
            capture_output=True,
            text=True,
        )
        if r.returncode == 0:
            return "git-worktree-remove"
        # fall through
    shutil.rmtree(path)
    return "rm"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="Actually delete (default: dry-run)")
    ap.add_argument("--older-than", type=float, default=2.0, help="Min age in hours (default 2)")
    ap.add_argument(
        "--projects-dir",
        default=os.environ.get("STUDIO_PROJECTS_DIR", "/Users/abdullah/Documents/projects"),
    )
    ap.add_argument(
        "--server",
        default=os.environ.get("STUDIO_SERVER", "http://127.0.0.1:3012"),
    )
    ap.add_argument(
        "--task-id",
        default=None,
        help="Only consider the worktree for this taskId (suffix match)",
    )
    args = ap.parse_args()

    projects = Path(args.projects_dir)
    by_suffix, active = fetch_tasks(args.server)
    now = time.time()
    mode = "APPLY" if args.apply else "DRY-RUN"
    print(
        f"mode={mode} older_than={args.older_than}h projects={projects} "
        f"active_in_progress={active} tasks_indexed={len(by_suffix)}"
    )
    print()

    prune: list[tuple[Path, str, str, float]] = []
    keep = 0

    for path in sorted(projects.glob("*.studio-worktree")):
        if not path.is_dir():
            continue
        stem = path.name[: -len(".studio-worktree")]
        suffix = stem[-6:].lower() if len(stem) >= 6 else ""
        age_h = round((now - path.stat().st_mtime) / 3600, 1)
        info = by_suffix.get(suffix)
        state = info["state"] if info else "orphan"
        tid = info["id"] if info else ""
        if args.task_id:
            want = args.task_id.lower()
            if want not in (tid.lower(), suffix) and not (tid and tid.lower().endswith(want[-6:])):
                keep += 1
                print(f"{'KEEP':<6}  {'task-filter':<16}  age={age_h:5.1f}h  {path.name}")
                continue

        action = "KEEP"
        reason = state
        if state in PROTECTED:
            action = "KEEP"
            reason = "in_progress"
        elif age_h < args.older_than:
            action = "KEEP"
            reason = f"{state}-young"
        elif state in TERMINAL or state == "orphan":
            action = "PRUNE"
            reason = state
        else:
            action = "KEEP"
            reason = state or "unknown"

        label = path.name
        if tid:
            label = f"{path.name}  ({tid})"
        print(f"{action:<6}  {reason:<16}  age={age_h:5.1f}h  {label}")

        if action == "PRUNE":
            prune.append((path, state, tid, age_h))
        else:
            keep += 1

    print()
    print(f"summary: prune={len(prune)} keep={keep} (dry-run unless --apply)")

    if not args.apply:
        print("Re-run with --apply to remove PRUNE rows via git worktree remove --force.")
        return 0

    if not prune:
        print("Nothing to prune.")
        return 0

    removed = 0
    failed = 0
    for path, state, tid, age_h in prune:
        try:
            how = remove_worktree(path)
            print(f"REMOVED({how}) {path}")
            removed += 1
        except Exception as e:
            print(f"FAIL {path}: {e}")
            failed += 1
    print(f"done removed={removed} failed={failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
