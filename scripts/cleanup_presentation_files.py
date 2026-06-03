from __future__ import annotations

import csv
import re
import sys
from pathlib import Path


def collect_ids(pr_path: Path) -> set[str]:
    ids: set[str] = set()
    for raw in pr_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"[A-Za-z]+\[([^\]]+)\]", line)
        if not m:
            continue
        inner = m.group(1)
        kv = dict(p.split("=", 1) for p in inner.split(",") if "=" in p)
        node_id = kv.get("id") or kv.get("name")
        if node_id:
            ids.add(node_id)
    return ids


def filter_csv(path: Path, ids: set[str], default_fields: list[str]) -> None:
    if not path.exists():
        return
    rows = list(csv.DictReader(path.open(encoding="utf-8")))
    keep = [r for r in rows if r.get("id") in ids]
    fields = list(rows[0].keys()) if rows else default_fields
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in keep:
            w.writerow(r)


def main() -> int:
    root = Path("presentations/default")
    pr_path = root / "presentation.pr"
    ids = collect_ids(pr_path)
    filter_csv(
        root / "geometries.csv",
        ids,
        ["id", "view", "space", "x", "y", "w", "h", "rotationDeg", "anchor", "fontPx"],
    )
    filter_csv(root / "animations.csv", ids, ["id", "what", "when", "how", "where", "delayMs"])
    print("kept ids:", ", ".join(sorted(ids)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
