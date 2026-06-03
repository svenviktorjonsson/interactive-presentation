from __future__ import annotations

import csv
from pathlib import Path


ASPECT = 1080 / 1920


def _to_float(value: str) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _iter_geom_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for p in root.rglob("geometries.csv"):
        files.append(p)
    for p in root.rglob("notes_geometries.csv"):
        files.append(p)
    return files


def migrate_file(path: Path) -> bool:
    if not path.exists():
        return False
    rows: list[dict[str, str]] = []
    changed = False
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames or []
        for row in reader:
            if str(row.get("space", "")).strip().lower() == "screen":
                y = _to_float(row.get("y", "") or "")
                h = _to_float(row.get("h", "") or "")
                if y is not None:
                    row["y"] = f"{y * ASPECT:.15g}"
                    changed = True
                if h is not None:
                    row["h"] = f"{h * ASPECT:.15g}"
                    changed = True
            rows.append(row)
    if not changed:
        return False
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    return True


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    targets = _iter_geom_files(root / "presentations")
    changed = 0
    for path in targets:
        if migrate_file(path):
            changed += 1
    print(f"Updated {changed} geometry file(s).")


if __name__ == "__main__":
    main()
