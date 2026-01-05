from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class TimerState:
    accepting: bool = False
    samples_ms: list[float] = field(default_factory=list)


@dataclass
class ChoicesPollState:
    accepting: bool = False
    votes: dict[str, int] = field(default_factory=dict)
    question: str = ""
    bullets: str | None = None


@dataclass
class SoundState:
    """
    Server-side audio capture state.
    - pressure_10ms: envelope-like series (positive-only), one value per 10ms window.
    - spectrum_*: most recent spectrum computed from the raw ring buffer.
    """

    # Whether server-side capture is running (controls whether data is produced/streamed).
    enabled: bool = False
    # Which computations to perform while running.
    # We pause the inactive one when switching modes to save CPU.
    compute_spectrum: bool = True
    compute_pressure: bool = False
    sample_rate_hz: int = 48_000
    window_ms: int = 10
    seq: int = 0
    last_error: str | None = None
    pressure_10ms: list[float] = field(default_factory=list)
    spectrum_freq_hz: list[float] = field(default_factory=list)
    spectrum_mag: list[float] = field(default_factory=list)


@dataclass
class AppState:
    joined: list[dict] = field(default_factory=list)
    timer: TimerState = field(default_factory=TimerState)
    choices: dict[str, ChoicesPollState] = field(default_factory=dict)
    sound: SoundState = field(default_factory=SoundState)


STATE = AppState()

