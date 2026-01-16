from __future__ import annotations

import asyncio
import math
import time
from typing import Any

from ..state import STATE

try:
    import numpy as np  # type: ignore
except Exception:  # pragma: no cover
    np = None  # type: ignore

try:
    import sounddevice as sd  # type: ignore
except Exception:  # pragma: no cover
    sd = None  # type: ignore


class _SoundCapture:
    def __init__(self) -> None:
        self._stream: Any | None = None
        self._running = False
        self._lock = asyncio.Lock()
        self._last_seq = 0
        self._raw_ring = None
        self._ring_idx = 0
        self._ring_n = 0
        self._sr: int | None = None

    def _ensure_ring(self, sr: int) -> None:
        # Keep ~2 seconds raw audio for FFT windows.
        n = int(sr * 2.0)
        if np is None:
            return
        if self._raw_ring is None or int(getattr(self._raw_ring, "size", 0)) != n:
            self._raw_ring = np.zeros(n, dtype=np.float32)
            self._ring_idx = 0
            self._ring_n = 0

    def _push_raw(self, x: Any) -> None:
        if np is None or self._raw_ring is None:
            return
        a = np.asarray(x, dtype=np.float32).reshape(-1)
        n = int(a.size)
        if n <= 0:
            return
        ring = self._raw_ring
        idx = int(self._ring_idx)
        cap = int(ring.size)
        if n >= cap:
            ring[:] = a[-cap:]
            idx = 0
            self._ring_n = cap
        else:
            end = idx + n
            if end <= cap:
                ring[idx:end] = a
            else:
                k = cap - idx
                ring[idx:] = a[:k]
                ring[: end - cap] = a[k:]
            idx = end % cap
            self._ring_n = min(cap, self._ring_n + n)
        self._ring_idx = idx

    def _latest_raw(self, n: int) -> Any | None:
        if np is None or self._raw_ring is None:
            return None
        if self._ring_n <= 0:
            return None
        n = max(1, min(int(n), int(self._ring_n)))
        ring = self._raw_ring
        idx = int(self._ring_idx)
        cap = int(ring.size)
        start = (idx - n) % cap
        if start < idx:
            return ring[start:idx].copy()
        return np.concatenate([ring[start:], ring[:idx]]).copy()

    def _update_spectrum(self, sr: int) -> None:
        if np is None:
            return
        # Use a power-of-two-ish window for a stable spectrum view.
        win = 2048
        raw = self._latest_raw(win)
        if raw is None:
            return
        if raw.size < win:
            pad = np.zeros(win - raw.size, dtype=np.float32)
            raw = np.concatenate([pad, raw])
        # Hann window and rFFT
        w = np.hanning(win).astype(np.float32)
        xw = raw * w
        spec = np.fft.rfft(xw)
        mag = np.abs(spec).astype(np.float32)
        # Convert to a visually useful scale (dB-ish) and clamp.
        mag_db = 20.0 * np.log10(np.maximum(1e-9, mag))
        mag_db = np.clip(mag_db, -120.0, 0.0)
        freqs = np.fft.rfftfreq(win, d=1.0 / float(sr)).astype(np.float32)
        STATE.sound.spectrum_freq_hz = freqs.tolist()
        STATE.sound.spectrum_mag = mag_db.tolist()

    def start_if_needed(self) -> None:
        # If we're already running, we may still need to initialize the spectrum ring
        # if the mode was switched while running.
        if self._running:
            if STATE.sound.enabled and STATE.sound.compute_spectrum and np is not None and self._sr is not None:
                self._ensure_ring(self._sr)
            return
        if not STATE.sound.enabled:
            return
        if sd is None or np is None:
            STATE.sound.last_error = "Missing dependency: install numpy + sounddevice (and a working audio input device)."
            return

        sr = int(STATE.sound.sample_rate_hz or 48_000)
        self._sr = sr
        win_ms = int(STATE.sound.window_ms or 10)
        block = max(1, int(round(sr * (win_ms / 1000.0))))
        # Only need the raw ring if we compute spectrum.
        if STATE.sound.compute_spectrum:
            self._ensure_ring(sr)

        def callback(indata, frames, time_info, status):  # type: ignore[no-untyped-def]
            try:
                if not STATE.sound.enabled:
                    return
                x = indata[:, 0].astype(np.float32, copy=True)
                if STATE.sound.compute_spectrum:
                    self._push_raw(x)
                    self._update_spectrum(sr)
                if STATE.sound.compute_pressure:
                    # Envelope-like “sound pressure” series: RMS, positive-only.
                    rms = float(math.sqrt(float(np.mean(x * x)))) if x.size else 0.0
                    STATE.sound.pressure_10ms.append(max(0.0, rms))
                    # Keep last 30s @ 10ms => 3000 points
                    STATE.sound.pressure_10ms[:] = STATE.sound.pressure_10ms[-3000:]
                STATE.sound.seq += 1
                STATE.sound.last_error = None
            except Exception as e:  # pragma: no cover
                STATE.sound.last_error = f"{type(e).__name__}: {e}"

        try:
            self._stream = sd.InputStream(
                samplerate=sr,
                channels=1,
                blocksize=block,
                callback=callback,
                dtype="float32",
            )
            self._stream.start()
            self._running = True
            STATE.sound.last_error = None
        except Exception as e:  # pragma: no cover
            self._running = False
            self._stream = None
            STATE.sound.last_error = f"{type(e).__name__}: {e}"

    def start(self) -> None:
        STATE.sound.enabled = True
        STATE.sound.last_error = None
        self.start_if_needed()

    def pause(self) -> None:
        # Stop capture and stop producing new data.
        STATE.sound.enabled = False
        try:
            if self._stream is not None:
                self._stream.stop()
                self._stream.close()
        except Exception:
            pass
        self._stream = None
        self._running = False

    def stop(self) -> None:
        # Back-compat alias for pause.
        self.pause()

    def reset(self) -> None:
        # Clear buffers without changing running state.
        STATE.sound.pressure_10ms = []
        STATE.sound.spectrum_freq_hz = []
        STATE.sound.spectrum_mag = []
        STATE.sound.seq = 0


CAPTURE = _SoundCapture()


def sound_state_payload() -> dict[str, Any]:
    # Only produce/stream data while running.
    if STATE.sound.enabled:
        CAPTURE.start_if_needed()
    running = bool(STATE.sound.enabled)
    return {
        "enabled": running,
        "computeSpectrum": bool(STATE.sound.compute_spectrum),
        "computePressure": bool(STATE.sound.compute_pressure),
        "seq": int(STATE.sound.seq),
        "sampleRateHz": int(STATE.sound.sample_rate_hz),
        "windowMs": int(STATE.sound.window_ms),
        # When paused: keep sending the last buffers so the frontend can keep showing the frozen plot.
        "pressure10ms": STATE.sound.pressure_10ms[-3000:],
        "spectrum": {
            "freqHz": STATE.sound.spectrum_freq_hz,
            "magDb": STATE.sound.spectrum_mag,
        },
        "error": STATE.sound.last_error,
        "serverTimeMs": int(time.time() * 1000),
    }


async def sound_sse_events(*, min_interval_ms: int = 50):
    """
    Server-Sent Events stream: pushes latest payload.
    We throttle the stream rate but keep 10ms resolution inside the payload.
    """
    if STATE.sound.enabled:
        CAPTURE.start_if_needed()
    last = -1
    while True:
        if not STATE.sound.enabled:
            # While paused: only send minimal status periodically (no arrays).
            import json

            yield f"data: {json.dumps(sound_state_payload(), separators=(',', ':'))}\n\n"
            await asyncio.sleep(0.5)
            continue
        cur = int(STATE.sound.seq)
        if cur != last:
            last = cur
            import json

            yield f"data: {json.dumps(sound_state_payload(), separators=(',', ':'))}\n\n"
        await asyncio.sleep(max(0.001, min_interval_ms / 1000.0))

