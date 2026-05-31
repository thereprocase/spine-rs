#!/usr/bin/env python3
"""Parse criterion text output, compare to baseline.json, emit a markdown table.

Usage:
    perf_compare.py <bench-output.txt> <baseline.json> [section-title]

`section-title` is the text used as the markdown header (e.g.,
"spine-bf::write_paths"). Defaults to "<parent-dir>::<bench-file-stem>" derived
from the baseline.json path so the workflow doesn't have to thread it through.

Phase 1 (today): always exits 0; the markdown table is written to stdout for
$GITHUB_STEP_SUMMARY consumption. Regressions are flagged in the table but do
not fail CI.

Phase 2 (later, after observing CI variance): set the env var
PERF_FAIL_ON_REGRESSION=1 and the script exits 1 if any bench median exceeds
its ceiling. Flip via workflow yaml; no code change here required.

The ceiling-vs-baseline split lets us track drift (median creeping toward the
ceiling) before we breach it. A bench whose median has doubled but is still
under ceiling is informational; one over ceiling is the alert.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

# criterion prints durations with one of these unit suffixes; convert to µs.
UNIT_TO_US: dict[str, float] = {
    "ps": 1e-6,
    "ns": 1e-3,
    "µs": 1.0,
    "us": 1.0,
    "ms": 1e3,
    "s": 1e6,
}

# `time:   [ low_v low_u  med_v med_u  high_v high_u ]` — three (value, unit)
# pairs separated by whitespace inside square brackets.
TIME_LINE = re.compile(
    r"\btime:\s*\[\s*"
    r"([\d.]+)\s*([a-zµ]+)\s+"
    r"([\d.]+)\s*([a-zµ]+)\s+"
    r"([\d.]+)\s*([a-zµ]+)\s*\]"
)

# Lines we know aren't bench-name lines; everything else at column 0 is a
# candidate name.
NON_NAME_PREFIXES = (
    "Benchmarking ",
    "warning:",
    "    Finished",
    "     Running",
    "Gnuplot ",
    "    Compiling",
    "   Compiling",
    "    Updating",
    "    Downloading",
    "  Downloaded",
    "   Cargo.lock",
    "error[",
    "thread '",
)


def to_us(value: str, unit: str) -> float:
    factor = UNIT_TO_US.get(unit)
    if factor is None:
        raise ValueError(f"unknown criterion unit: {unit!r}")
    return float(value) * factor


def parse_bench_output(text: str) -> dict[str, float]:
    """Return {bench_name: median_us}."""
    out: dict[str, float] = {}
    last_name: str | None = None
    for raw in text.splitlines():
        if not raw.strip():
            continue
        m = TIME_LINE.search(raw)
        if m:
            if last_name is not None:
                out[last_name] = round(to_us(m.group(3), m.group(4)), 1)
            continue
        if raw.startswith(NON_NAME_PREFIXES):
            continue
        if not raw[0].isspace():
            last_name = raw.strip()
    return out


def render_table(
    measured: dict[str, float], baseline: dict, title: str, baseline_path: Path
) -> tuple[str, int]:
    """Return (markdown_table, regression_count)."""
    rows: list[str] = []
    regressions = 0
    seen: set[str] = set()
    for name, meta in baseline.items():
        if name.startswith("_"):
            continue
        seen.add(name)
        base = float(meta["baseline_us"])
        informational = bool(meta.get("informational", False))
        note = meta.get("note", "")
        m = measured.get(name)
        if informational:
            ceiling_cell = "info"
            if m is None:
                rows.append(
                    f"| `{name}` | _missing_ | {base:.0f} | {ceiling_cell} | — | "
                    f"⚠ bench did not run (informational) |"
                )
                continue
            delta_pct = (m - base) / base * 100.0 if base else 0.0
            cell_note = f" {note}" if note else ""
            rows.append(
                f"| `{name}` | {m:.0f} | {base:.0f} | {ceiling_cell} | "
                f"{delta_pct:+.0f}% | ℹ informational{cell_note} |"
            )
            continue
        ceiling = float(meta["ceiling_us"])
        if m is None:
            rows.append(
                f"| `{name}` | _missing_ | {base:.0f} | {ceiling:.0f} | — | "
                f"⚠ bench did not run |"
            )
            regressions += 1
            continue
        delta_pct = (m - base) / base * 100.0 if base else 0.0
        delta_str = f"{delta_pct:+.0f}%"
        if m > ceiling:
            status = "✗ over ceiling"
            regressions += 1
        elif m > base * 1.5:
            status = "⚠ drift > 50% over baseline"
        else:
            status = "✓"
        cell_note = f" {note}" if note else ""
        rows.append(
            f"| `{name}` | {m:.0f} | {base:.0f} | {ceiling:.0f} | {delta_str} | "
            f"{status}{cell_note} |"
        )

    extra_rows: list[str] = []
    for name, m in measured.items():
        if name in seen:
            continue
        extra_rows.append(
            f"| `{name}` | {m:.0f} | _unpinned_ | _unpinned_ | — | "
            f"new bench — add to baseline.json |"
        )

    table = [
        f"## Sprint 19 perf bench (`{title}`)",
        "",
        "| Bench | Measured µs | Baseline µs | Ceiling µs | Δ vs baseline | Status |",
        "|---|---:|---:|---:|---:|---|",
        *rows,
        *extra_rows,
        "",
    ]
    if regressions:
        table.append(
            f"**{regressions} bench(es) over ceiling or missing.** "
            f"See internal design notes for the re-pin "
            f"procedure if the change is intentional."
        )
    else:
        table.append("All pinned benches within ceiling.")
    if extra_rows:
        table.append(
            f"_New (unpinned) benches detected — add entries to "
            f"`{baseline_path}` to bring them under the gate._"
        )
    fail_on = os.environ.get("PERF_FAIL_ON_REGRESSION", "").lower() in ("1", "true", "yes")
    table.append(
        f"_Phase {'2 — fail-on-regression ENABLED' if fail_on else '1 — report-only'}._"
    )
    return "\n".join(table), regressions


def derive_title(baseline_path: Path) -> str:
    """Derive `<package>::<bench-stem>` from a baseline.json path like
    `core/spine-bf/benches/baseline.json` → `spine-bf::write_paths`.

    The bench-stem comes from the matching `[[bench]] name = ...` in the
    package's Cargo.toml; we approximate by reading the single .rs file in
    the benches/ directory next to baseline.json. If we can't resolve, fall
    back to the package name alone.
    """
    benches_dir = baseline_path.parent
    pkg_dir = benches_dir.parent
    pkg = pkg_dir.name
    if benches_dir.name == "benches":
        rs_files = sorted(p.stem for p in benches_dir.glob("*.rs"))
        if len(rs_files) == 1:
            return f"{pkg}::{rs_files[0]}"
    return pkg


def main() -> int:
    if not 3 <= len(sys.argv) <= 4:
        print(
            "usage: perf_compare.py <bench-output.txt> <baseline.json> [section-title]",
            file=sys.stderr,
        )
        return 2
    bench_path = Path(sys.argv[1])
    baseline_path = Path(sys.argv[2])
    title = sys.argv[3] if len(sys.argv) == 4 else derive_title(baseline_path)
    text = bench_path.read_text(encoding="utf-8")
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    measured = parse_bench_output(text)
    table, regressions = render_table(measured, baseline, title, baseline_path)
    print(table)
    if regressions and os.environ.get("PERF_FAIL_ON_REGRESSION", "").lower() in (
        "1",
        "true",
        "yes",
    ):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
