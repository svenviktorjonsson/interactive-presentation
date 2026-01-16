from __future__ import annotations

import argparse
import os
import re
import signal
import socket
import subprocess
import sys
import time
import urllib.request
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
    return Path(__file__).resolve().parents[1]


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


def _cloudflared_cmd() -> str:
    found = which("cloudflared.exe") if sys.platform.startswith("win") else which("cloudflared")
    if not found:
        raise FileNotFoundError("cloudflared not found on PATH. Install Cloudflare Tunnel to use HTTPS public URLs.")
    return found


def _start_cloudflared_tunnel(local_port: int, hostname: str | None = None) -> tuple[subprocess.Popen, str]:
    """
    Starts a Cloudflare quick tunnel and returns (process, public_base_url).
    """
    cloudflared = _cloudflared_cmd()
    cmd = [
        cloudflared,
        "tunnel",
        "--url",
        f"http://127.0.0.1:{local_port}",
        "--no-autoupdate",
    ]
    if hostname:
        cmd.extend(["--hostname", hostname])
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
    url = f"https://{hostname}" if hostname else ""
    url_re = re.compile(r"(https?://[A-Za-z0-9.-]+\.trycloudflare\.com)")
    deadline = time.time() + 35
    while time.time() < deadline and p.poll() is None and p.stdout is not None:
        line = p.stdout.readline()
        if not line:
            time.sleep(0.05)
            continue
        s = line.rstrip()
        print(s)
        if hostname:
            continue
        m = url_re.search(line)
        if m:
            url = m.group(1).rstrip().rstrip(",")
            break
    return p, url


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
    def ensure_install(where: Path, required_files: list[Path]) -> None:
        if all(p.exists() for p in required_files):
            return
        print(f"[run_presentation] Installing Node dependencies (npm install) in {where} ...")
        res = subprocess.run([_npm_cmd(), "install"], cwd=str(where), shell=False)
        if res.returncode != 0:
            raise SystemExit(res.returncode)

    # app/web deps (vite + katex)
    web_dir = root / "app" / "web"
    web_nm = web_dir / "node_modules"
    vite_bin = web_nm / ".bin" / ("vite.cmd" if sys.platform.startswith("win") else "vite")
    web_katex_pkg = web_nm / "katex" / "package.json"
    ensure_install(web_dir, [vite_bin, web_katex_pkg])

    # packages/runtime deps (katex-renderer + katex) are needed for Vite build resolution
    # because Vite builds against runtime source files under ./packages/runtime/src/**.
    rt_dir = root / "packages" / "runtime"
    rt_nm = rt_dir / "node_modules"
    rt_renderer_pkg = rt_nm / "@cellmax" / "katex-renderer" / "package.json"
    rt_katex_pkg = rt_nm / "katex" / "package.json"
    ensure_install(rt_dir, [rt_renderer_pkg, rt_katex_pkg])


def _ensure_python_deps(root: Path) -> None:
    try:
        import flask  # noqa: F401
        return
    except Exception:
        pass
    app_python = root / "app" / "python"
    print(f"[run_presentation] Installing app python deps (pip -e) in {app_python} ...")
    res = subprocess.run([sys.executable, "-m", "pip", "install", "-e", str(app_python)], cwd=str(root), shell=False)
    if res.returncode != 0:
        raise SystemExit(res.returncode)


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Run interactive presentation (dev mode).")
    p.add_argument(
        "-p",
        "--presentation",
        default=os.environ.get("IP_PRESENTATION_ID") or "default",
        help="Presentation id (folder under ./presentations/) or a direct path to presentation.pr.",
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
    p.add_argument(
        "--no-web-watch",
        action="store_true",
        help="Disable watching/rebuilding the web frontend while running (advanced).",
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
    web_watch = not bool(getattr(args, "no_web_watch", False))
    os.environ["IP_PRESENTATION_ID"] = pres_id
    os.environ["IP_PORT"] = str(port)
    pres_arg = Path(pres_id)
    if pres_arg.is_file():
        presentation_pr = pres_arg.resolve()
        pres_dir = presentation_pr.parent
    else:
        pres_dir = root / "presentations" / pres_id
        presentation_pr = pres_dir / "presentation.pr"
    if not presentation_pr.exists():
        print(f"[run_presentation] Presentation file not found: {presentation_pr}")
        print("[run_presentation] Create it under ./presentations/<id>/presentation.pr or pass a file path.")
        return 1
    if _port_in_use(port):
        start_port = port
        for _ in range(20):
            port += 1
            if not _port_in_use(port):
                break
        if _port_in_use(port):
            print(f"[run_presentation] Port {start_port} is already in use and no free port found nearby.")
            print("[run_presentation] Stop the existing server, or run on a different port:")
            alt = start_port + 1 if start_port != 8001 else 8002
            print(f"[run_presentation]   poetry run python scripts/run_presentation.py --presentation {pres_id} --port {alt}")
            return 1
        print(f"[run_presentation] Port {start_port} is in use; switching to {port}.")

    print("[run_presentation] Starting presentation (dev mode)")
    print(f"[run_presentation] Presentation id: {pres_id}")
    print(f"[run_presentation] Port: {port}")
    print(f"[run_presentation] Reload: {reload}")
    _ensure_python_deps(root)
    _ensure_node_deps(root)

    procs: list[subprocess.Popen] = []
    tunnel_proc: subprocess.Popen | None = None
    public_url = ""
    try:
        web_dir = root / "app" / "web"
        # Web frontend:
        # - In dev mode we want the latest UI always.
        # - The backend serves ./app/web/dist, so we run a build AND keep it updated in watch mode.
        print("[run_presentation] Building frontend (npm run build)...")
        res = subprocess.run([_npm_cmd(), "run", "build"], cwd=str(web_dir), shell=False)
        if res.returncode != 0:
            return res.returncode
        if web_watch:
            print("[run_presentation] Watching frontend (vite build --watch)...")
            web_watch_proc = _run([_npm_cmd(), "run", "build", "--", "--watch"], cwd=web_dir)
            procs.append(web_watch_proc)

        # Start a public tunnel for QR links.
        tunnel_mode = (os.environ.get("IP_TUNNEL") or "cloudflared").strip().lower()
        tunnel_hostname = (os.environ.get("IP_TUNNEL_HOSTNAME") or "").strip() or None
        if tunnel_mode != "none":
            started = False
            if tunnel_mode in {"auto", "cloudflared"}:
                try:
                    tunnel_proc, public_url = _start_cloudflared_tunnel(port, tunnel_hostname)
                    started = True
                except Exception as e:
                    print(f"[run_presentation] cloudflared tunnel unavailable ({e})")
                    return 1
            if tunnel_proc and public_url:
                print(f"[run_presentation] Public URL: {public_url}")

        # Start app server (Flask) from the app python package.
        app_python = root / "app" / "python"
        env_overrides: dict[str, str] = {
            "PYTHONPATH": str(app_python) + (os.pathsep + os.environ["PYTHONPATH"] if os.environ.get("PYTHONPATH") else ""),
        }
        if public_url:
            env_overrides["PUBLIC_BASE_URL"] = public_url
        backend_cmd = [
            sys.executable,
            "-m",
            "interactive_presentation.cli",
            "run",
            str(presentation_pr),
            "--port",
            str(port),
        ]
        backend_proc = _run_with_env(backend_cmd, cwd=root, env_overrides=env_overrides)
        procs.append(backend_proc)

        # Wait for the server to accept connections before opening a browser.
        base_url = f"http://localhost:{port}"
        model_url = f"{base_url}/model"
        for _ in range(60):
            try:
                with urllib.request.urlopen(model_url, timeout=0.5) as resp:
                    if resp.status >= 200 and resp.status < 500:
                        break
            except Exception:
                time.sleep(0.1)
        print("")
        print(f"[run_presentation] Presentation: {base_url}")
        print(f"[run_presentation] Backend API:  {model_url}")
        print("")
        print("[run_presentation] Press Ctrl+C to stop. (Ctrl+Z may suspend on some shells and keep the port in use.)")

        # Open browser to first view (best-effort; does not guarantee fullscreen).
        try:
            webbrowser.open(base_url, new=1)
        except Exception:
            pass

        # Wait until any process exits
        while True:
            if _STOP_REQUESTED:
                raise KeyboardInterrupt
            for p in procs:
                code = p.poll()
                if code is not None:
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
        if tunnel_proc and tunnel_proc.poll() is None:
            try:
                if sys.platform.startswith("win"):
                    tunnel_proc.terminate()
                else:
                    tunnel_proc.send_signal(signal.SIGTERM)
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
        if tunnel_proc and tunnel_proc.poll() is None:
            try:
                tunnel_proc.kill()
            except Exception:
                pass

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
