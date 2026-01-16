from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> int:
  parser = argparse.ArgumentParser(prog="interactive-presentation-next")
  sub = parser.add_subparsers(dest="cmd", required=True)

  run_p = sub.add_parser("run", help="Run local server for a presentation")
  run_p.add_argument("presentation", help="Path to presentation.pr")
  run_p.add_argument("--port", type=int, default=8000)

  export_p = sub.add_parser("export", help="Export standalone offline bundle")
  export_p.add_argument("presentation", help="Path to presentation.pr")
  export_p.add_argument("--out", default="dist", help="Output directory")

  args = parser.parse_args(argv)

  if args.cmd == "run":
    from .server.app import run_server

    run_server(args.presentation, port=args.port)
    return 0

  if args.cmd == "export":
    from .export.exporter import export_bundle

    export_bundle(args.presentation, out_dir=args.out)
    return 0

  parser.print_help()
  return 2


if __name__ == "__main__":
  raise SystemExit(main(sys.argv[1:]))

