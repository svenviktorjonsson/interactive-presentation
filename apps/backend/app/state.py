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
class AppState:
    joined: list[dict] = field(default_factory=list)
    timer: TimerState = field(default_factory=TimerState)
    choices: dict[str, ChoicesPollState] = field(default_factory=dict)


STATE = AppState()

