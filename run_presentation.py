from __future__ import annotations

import argparse
import os
import re
import signal
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from shutil import which

_STOP_REQUESTED = False


def _request_stop() -> None:
    global _STOP_REQUESTED
    _STOP_REQUESTED = True


def _install_signal_handlers() -> None:
    """
    Best-effort: ensure "stop" signals lead to a clean shutdown.

    Notes:
    - Ctrl+C -> SIGINT (raises KeyboardInterrupt normally)
    - Ctrl+Z on many *nix shells -> SIGTSTP (suspends by default, keeping the port bound)
      We override SIGTSTP to request shutdown instead, so the server doesn't linger.
    - On Windows PowerShell, Ctrl+Z is NOT a stop signal for processes; users should use Ctrl+C.
    """
    try:
        if hasattr(signal, "SIGTSTP"):
            signal.signal(signal.SIGTSTP, lambda *_: _request_stop())  # type: ignore[arg-type]
    except Exception:
        # Non-fatal; continue without extra signal handling.
        pass

def _repo_root() -> Path:
    return Path(__file__).resolve().parent


def _run(cmd: list[str], *, cwd: Path) -> subprocess.Popen:
    # Use text mode for readable logs.
    return subprocess.Popen(
        cmd,
        cwd=str(cwd),
        env=os.environ.copy(),
        stdout=None,
        stderr=None,
        shell=False,
    )

def _run_with_env(cmd: list[str], *, cwd: Path, env_overrides: dict[str, str]) -> subprocess.Popen:
    env = os.environ.copy()
    env.update(env_overrides)
    return subprocess.Popen(
        cmd,
        cwd=str(cwd),
        env=env,
        stdout=None,
        stderr=None,
        shell=False,
    )

def _npm_cmd() -> str:
    # On Windows, `npm` is typically a `npm.cmd` shim; CreateProcess can't execute `.cmd`
    # unless we either use shell=True or invoke the `.cmd` explicitly.
    if sys.platform.startswith("win"):
        found = which("npm.cmd") or which("npm.exe") or which("npm")
    else:
        found = which("npm")
    if not found:
        raise FileNotFoundError("npm not found on PATH. Install Node.js to run the web frontend.")
    return found

def _ssh_cmd() -> str:
    found = which("ssh.exe") if sys.platform.startswith("win") else which("ssh")
    if not found:
        raise FileNotFoundError("ssh not found on PATH. Install OpenSSH client to use localhost.run tunneling.")
    return found

def _start_localhostrun_tunnel(local_port: int) -> tuple[subprocess.Popen, str]:
    """
    Starts a localhost.run tunnel and returns (process, public_base_url).

    Docs example: ssh -R 80:localhost:8080 nokey@localhost.run
    We'll tunnel remote :80 -> local :<local_port>.
    """
    ssh = _ssh_cmd()
    null_hosts = "NUL" if sys.platform.startswith("win") else "/dev/null"
    cmd = [
        ssh,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        f"UserKnownHostsFile={null_hosts}",
        "-o",
        "ServerAliveInterval=10",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "ExitOnForwardFailure=yes",
        "-T",
        "-R",
        # Use explicit IPv4 to avoid Windows localhost -> ::1 resolution issues.
        f"80:127.0.0.1:{local_port}",
        "nokey@localhost.run",
    ]

    p = subprocess.Popen(
        cmd,
        cwd=str(_repo_root()),
        env=os.environ.copy(),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        shell=False,
    )

    # Try to discover the public URL from ssh output.
    # IMPORTANT: the banner contains other https:// links (admin/docs/twitter). We want the assigned tunnel URL,
    # which appears on a line like:
    #   "<id>.lhr.life tunneled with tls termination, https://<id>.lhr.life"
    url = ""
    tunneled_re = re.compile(r"tunneled with tls termination,\s*(https?://\S+)", re.IGNORECASE)
    host_re = re.compile(r"(https?://[A-Za-z0-9.-]+\.(?:localhost\.run|lhr\.rocks|lhr\.life))")
    host_only_re = re.compile(r"([A-Za-z0-9.-]+\.(?:localhost\.run|lhr\.rocks|lhr\.life))")
    banned_hosts = {"https://admin.localhost.run", "https://localhost.run", "https://localhost.run/docs"}

    lines_seen: list[str] = []
    deadline = time.time() + 35
    while time.time() < deadline and p.poll() is None and p.stdout is not None:
        line = p.stdout.readline()
        if not line:
            time.sleep(0.05)
            continue
        # Echo tunnel output so the user can see the assigned domain in logs.
        s = line.rstrip()
        lines_seen.append(s)
        print(s)

        tm = tunneled_re.search(line)
        if tm:
            url = tm.group(1).rstrip().rstrip(",")
            break

        m = host_re.search(line)
        if m:
            cand = m.group(1).rstrip().rstrip(",")
            if cand not in banned_hosts:
                url = cand
                break
        m2 = host_only_re.search(line)
        if m2:
            cand = "https://" + m2.group(1)
            if cand not in banned_hosts:
                url = cand
                break

    if not url:
        # If ssh already exited, show any remaining output for diagnosis.
        if p.stdout is not None:
            try:
                rest = p.stdout.read() or ""
                if rest.strip():
                    for ln in rest.splitlines():
                        print(ln.rstrip())
            except Exception:
                pass
        url = ""

    return p, url


def _ensure_node_deps(root: Path) -> None:
    # Keep it simple: if apps/web/node_modules is missing, run npm install in apps/web.
    web_dir = root / "apps" / "web"
    node_modules = web_dir / "node_modules"
    # Also ensure the local vite binary exists (common failure after package.json changes).
    vite_bin = node_modules / ".bin" / ("vite.cmd" if sys.platform.startswith("win") else "vite")
    # Also ensure key runtime deps exist (e.g., katex) since we rely on local installs only.
    katex_pkg = node_modules / "katex" / "package.json"

    if node_modules.exists() and vite_bin.exists() and katex_pkg.exists():
        return

    print("[run_presentation] Installing Node dependencies (npm install)...")
    res = subprocess.run([_npm_cmd(), "install"], cwd=str(web_dir), shell=False)
    if res.returncode != 0:
        raise SystemExit(res.returncode)


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Run interactive presentation (dev mode).")
    p.add_argument(
        "-p",
        "--presentation",
        default=os.environ.get("IP_PRESENTATION_ID") or "default",
        help="Presentation id (folder under ./presentations/). Also configurable via IP_PRESENTATION_ID.",
    )
    p.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("IP_PORT") or "8000"),
        help="Local backend port (default: 8000). Useful if another server is already running.",
    )
    p.add_argument(
        "--no-reload",
        action="store_true",
        help="Disable uvicorn --reload (more stable on some Windows/OneDrive setups).",
    )
    return p.parse_args()


def _port_in_use(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=0.25):
            return True
    except OSError:
        return False


def main() -> int:
    _install_signal_handlers()
    root = _repo_root()
    args = _parse_args()
    pres_id = str(args.presentation or "default").strip() or "default"
    port = int(args.port or 8000)
    reload = not bool(getattr(args, "no_reload", False))
    os.environ["IP_PRESENTATION_ID"] = pres_id
    os.environ["IP_PORT"] = str(port)
    pres_dir = root / "presentations" / pres_id
    if not pres_dir.exists():
        print(f"[run_presentation] Presentation folder not found: {pres_dir}")
        print("[run_presentation] Create it under ./presentations/<id>/ or pick an existing one.")
        return 1
    if _port_in_use(port):
        print(f"[run_presentation] Port {port} is already in use.")
        print("[run_presentation] Stop the existing server, or run on a different port:")
        alt = port + 1 if port != 8001 else 8002
        print(f"[run_presentation]   poetry run python run_presentation.py --presentation {pres_id} --port {alt}")
        return 1

    print("[run_presentation] Starting presentation (dev mode)")
    print(f"[run_presentation] Presentation id: {pres_id}")
    print(f"[run_presentation] Port: {port}")
    print(f"[run_presentation] Reload: {reload}")
    _ensure_node_deps(root)

    procs: list[subprocess.Popen] = []
    try:
        # Build frontend once (served by backend at :8000)
        web_dir = root / "apps" / "web"
        print("[run_presentation] Building frontend (npm run build)...")
        res = subprocess.run([_npm_cmd(), "run", "build"], cwd=str(web_dir), shell=False)
        if res.returncode != 0:
            return res.returncode

        public_base_url = os.environ.get("PUBLIC_BASE_URL", "").strip()
        tunnel_proc: subprocess.Popen | None = None
        if not public_base_url:
            # Start a localhost.run tunnel so the QR code points to a real public URL.
            try:
                print("[run_presentation] Starting tunnel (localhost.run via ssh)...")
                tunnel_proc, public_base_url = _start_localhostrun_tunnel(port)
                procs.append(tunnel_proc)
                if public_base_url:
                    print(f"[run_presentation] Tunnel URL: {public_base_url}")
                else:
                    print("[run_presentation] Tunnel started, but could not parse the public URL from output.")
                    print("[run_presentation] Please run the tunnel manually once and copy the assigned https://<id>.lhr.life URL,")
                    print("[run_presentation] then set PUBLIC_BASE_URL and re-run:")
                    print("[run_presentation]   $env:PUBLIC_BASE_URL=\"https://<id>.lhr.life\"")
                    print("[run_presentation]   poetry run python run_presentation.py")
                    return 1
            except Exception as e:
                print(f"[run_presentation] Tunnel disabled (could not start ssh tunnel): {e}")

        # Generate / update join QR png into presentations/<id>/media/join_qr.png
        try:
            import qrcode  # type: ignore
            from PIL import Image  # type: ignore

            join_origin = public_base_url.strip()
            if not join_origin:
                print("[run_presentation] Cannot generate join QR without a public URL.")
                print("[run_presentation] Set PUBLIC_BASE_URL to the assigned localhost.run domain and re-run.")
                return 1
            join_url = join_origin.rstrip("/") + "/join"

            media_dir = root / "presentations" / pres_id / "media"
            media_dir.mkdir(parents=True, exist_ok=True)
            out_path = media_dir / "join_qr.png"

            # IMPORTANT: generate QR with TRANSPARENT background so pixelate can fade in over the
            # presentation background without any white "flash".
            qr = qrcode.QRCode(border=1)
            qr.add_data(join_url)
            qr.make(fit=True)
            # Standard QR colors: black modules on white background.
            # The pixelate animation controls alpha, so we don't need image transparency here.
            img = qr.make_image(fill_color=(0, 0, 0, 255), back_color=(255, 255, 255, 255))
            if not isinstance(img, Image.Image):
                img = img.get_image()  # type: ignore[attr-defined]
            img = img.convert("RGBA")

            img.save(out_path)
            print(f"[run_presentation] Wrote join QR: {out_path} -> {join_url}")
        except ModuleNotFoundError as e:
            print(f"[run_presentation] Join QR generation failed: {e}")
            print("[run_presentation] Run `poetry install` to install Python deps (qrcode + pillow), then re-run.")
            return 1
        except Exception as e:
            print(f"[run_presentation] Join QR generation failed: {e}")
            return 1

        # Start backend
        backend_cmd = [
            sys.executable,
            "-m",
            "uvicorn",
            "apps.backend.app.main:app",
            "--port",
            str(port),
        ]
        if reload:
            backend_cmd.append("--reload")
        env_overrides: dict[str, str] = {}
        # Explicitly pass presentation id to the backend process (important for --reload spawns).
        env_overrides["IP_PRESENTATION_ID"] = pres_id
        env_overrides["IP_PORT"] = str(port)
        if public_base_url:
            env_overrides["PUBLIC_BASE_URL"] = public_base_url
        backend_proc = _run_with_env(backend_cmd, cwd=root, env_overrides=env_overrides)
        procs.append(backend_proc)

        time.sleep(0.5)
        print("")
        print(f"[run_presentation] Presentation: http://localhost:{port}")
        print(f"[run_presentation] Backend API:  http://localhost:{port}/api/presentation")
        if public_base_url:
            print(f"[run_presentation] Audience join: {public_base_url.rstrip('/')}/join")
        print("")
        print("[run_presentation] Press Ctrl+C to stop. (Ctrl+Z may suspend on some shells and keep the port in use.)")

        # Open browser to first view (best-effort; does not guarantee fullscreen).
        try:
            webbrowser.open(f"http://localhost:{port}", new=1)
        except Exception:
            pass

        # Wait until any process exits
        while True:
            if _STOP_REQUESTED:
                raise KeyboardInterrupt
            for p in procs:
                code = p.poll()
                if code is not None:
                    # If the tunnel drops, keep the backend running; just warn.
                    if tunnel_proc is not None and p is tunnel_proc:
                        print(f"[run_presentation] Tunnel process exited with code {code}. Backend will keep running.")
                        tunnel_proc = None
                        continue
                    print(f"[run_presentation] A process exited with code {code}. Shutting down.")
                    return code
            time.sleep(0.2)
    except KeyboardInterrupt:
        return 0
    finally:
        for p in procs:
            if p.poll() is None:
                try:
                    if sys.platform.startswith("win"):
                        p.terminate()
                    else:
                        p.send_signal(signal.SIGTERM)
                except Exception:
                    pass

        # Give them a moment, then force kill.
        time.sleep(0.6)
        for p in procs:
            if p.poll() is None:
                try:
                    p.kill()
                except Exception:
                    pass

    return 0


if __name__ == "__main__":
    raise SystemExit(main())


