from __future__ import annotations

import argparse
import sys
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.python.interactive_presentation.pr.parser import parse_presentation_pr


def collect_group_ids(pr_path: Path, seen: set[str]) -> set[str]:
    spec = parse_presentation_pr(pr_path)
    group_ids = {g.id for g in spec.groups}
    for screen in spec.screens:
        group_ids.update(g.id for g in screen.groups)
    for gid in group_ids:
        if gid in seen:
            continue
        seen.add(gid)
        group_elements = pr_path.parent / "groups" / gid / "elements.pr"
        if group_elements.exists():
            collect_group_ids(group_elements, seen)
    return seen


def cleanup_groups(presentation_pr: Path, notes_pr: Path | None = None) -> list[Path]:
    pres_dir = presentation_pr.parent
    groups_root = pres_dir / "groups"
    if not groups_root.exists():
        return []
    active_ids = collect_group_ids(presentation_pr, set())
    if notes_pr and notes_pr.exists():
        active_ids = collect_group_ids(notes_pr, active_ids)
    removed: list[Path] = []
    for entry in groups_root.iterdir():
        if not entry.is_dir():
            continue
        if entry.name.startswith("."):
            continue
        if entry.name not in active_ids:
            shutil.rmtree(entry, ignore_errors=True)
            removed.append(entry)
    return removed


def main() -> int:
    parser = argparse.ArgumentParser(description="Remove orphan group folders.")
    parser.add_argument(
        "presentation_pr",
        nargs="?",
        default="presentations/default/presentation.pr",
        help="Path to presentation.pr",
    )
    parser.add_argument(
        "--notes",
        dest="notes_pr",
        default="presentations/default/notes.pr",
        help="Optional notes.pr path",
    )
    args = parser.parse_args()
    presentation_pr = Path(args.presentation_pr).resolve()
    notes_pr = Path(args.notes_pr).resolve() if args.notes_pr else None
    removed = cleanup_groups(presentation_pr, notes_pr)
    if removed:
        print("Removed group folders:")
        for path in removed:
            print(f"- {path}")
    else:
        print("No orphan group folders found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
