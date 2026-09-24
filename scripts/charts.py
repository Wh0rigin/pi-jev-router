#!/usr/bin/env python3
"""Generate the charts embedded in README.md.

All data is transcribed from real runs (see README §验证):
  - E2E runs: pi (glm-5.3-flash) + real jev-1.13.0 via the proprietary choice protocol
  - Mock loop: test/integration.test.ts scenario (scripted jev answers)
  - Latencies: real jev call timings from those runs + jev-ping probes

Usage:  python charts.py      # writes PNGs to assets/
"""
import os
import statistics

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")

C_LOW, C_MED, C_HIGH, C_XHIGH = "#55A868", "#4C72B0", "#DD8452", "#C44E52"
LEVEL_COLORS = {"low": C_LOW, "medium": C_MED, "high": C_HIGH, "xhigh": C_XHIGH}

# ---- real E2E run 3 (debug task: failing node --test on calc.js) -----------
E2E_DECISIONS = [
    # (trigger, before, after, source, latency_ms, note)
    ("task-start", "high", "medium", "jev", 1712, "jev p(medium)=0.56"),
    ("failure", "medium", "medium", "jev", 428, "keep — bug is simple (p=0.52)"),
    ("downgrade-check", "medium", "medium", "jev", 909, "keep — stable at medium"),
]

# ---- mock integration scenario (test/integration.test.ts) ------------------
MOCK_TURNS = [
    # (turn, level_after, event)
    (-1, "low", "task start (pi at low)"),
    (0, "medium", "jev: medium"),
    (1, "high", "test failed → escalate"),
    (2, "high", "clean turn 1 (streak 1/2)"),
    (3, "medium", "clean turn 2 → downgrade"),
    (4, "high", "test failed → escalate"),
    (5, "high", "failure → escalation cap reached"),
]

# ---- 3-seed A/B: fixed max (no routing) vs jev-router ----------------------
# Real runs via scripts/benchmark.ts (pi --mode json, glm-5.3-flash + jev-1.13.0,
# fail-then-fix task, fresh dir per run, interleaved A/B order).
AB = {
    "fixed max": {
        "wall": [24.0, 18.7, 19.8], "in": [18732, 12311, 4606], "out": [248, 242, 179],
    },
    "jev-router": {
        "wall": [19.5, 20.3, 24.0], "in": [11390, 8771, 8731], "out": [225, 201, 218],
    },
}

# ---- real jev probability distributions (choices over 4 levels) ------------
# Every row is a real jev-1.13.0 response (E2E runs, ping probes, live test,
# or replayed E2E snapshots; jev is non-deterministic, so replays differ).
DISTRIBUTIONS = [
    ("trivial rename (E2E, task-start)", {"low": 0.98, "medium": 0.01, "high": 0.01, "xhigh": 0.00}),
    ("docs edit (jev-ping probe)", {"low": 0.81, "medium": 0.19, "high": 0.00, "xhigh": 0.00}),
    ("debug task start (replayed snapshot)", {"low": 0.01, "medium": 0.98, "high": 0.01, "xhigh": 0.00}),
    ("test failure, one-line bug (replay)", {"low": 0.25, "medium": 0.61, "high": 0.14, "xhigh": 0.00}),
    ("concurrency NPE (live-jev test)", {"low": 0.00, "medium": 0.01, "high": 0.99, "xhigh": 0.00}),
    ("concurrency probe (jev-ping)", {"low": 0.00, "medium": 0.01, "high": 0.97, "xhigh": 0.02}),
    ("caching architecture design (replay)", {"low": 0.00, "medium": 0.20, "high": 0.02, "xhigh": 0.78}),
]

# ---- real jev call latencies (ms) ------------------------------------------
LATENCIES = [
    ("E2E\ntrivial rename", 978),
    ("E2E\ndebug start v1", 807),
    ("E2E\ndebug start v2", 1712),
    ("E2E\nfailure eval", 428),
    ("E2E\ndowngrade eval", 909),
    ("ping\ndocs probe", 912),
    ("ping\nconcurrency", 401),
    ("live\ntest call", 1157),
]

# ---- test suite results ----------------------------------------------------
SUITE = [
    ("levels", 3, 0),
    ("errors", 7, 0),
    ("state", 4, 0),
    ("policy: rules", 3, 0),
    ("policy: clamps", 10, 0),
    ("config", 3, 0),
    ("integration: loop", 4, 0),
    ("integration: fallback", 7, 0),
    ("integration: misc", 2, 0),
    ("live jev (JEV_LIVE=1)", 1, 0),
]


def fig_e2e():
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12.5, 4.0), gridspec_kw={"width_ratios": [1.4, 1]})
    xs = range(len(E2E_DECISIONS))
    for i, (trigger, before, after, source, lat, note) in enumerate(E2E_DECISIONS):
        y = [LEVEL_COLORS[before], LEVEL_COLORS[after]]
        ax1.plot([i - 0.15, i + 0.15], [0, 1], color="#cccccc", zorder=1, lw=6, solid_capstyle="round")
        ax1.scatter([i - 0.15], [0], color=y[0], s=700, zorder=2, marker="s")
        ax1.scatter([i + 0.15], [1], color=y[1], s=700, zorder=2, marker="s")
        ax1.text(i - 0.15, 0, before, ha="center", va="center", fontsize=8, color="white", fontweight="bold")
        ax1.text(i + 0.15, 1, after, ha="center", va="center", fontsize=8, color="white", fontweight="bold")
        ax1.text(i, -0.28, trigger, ha="center", fontsize=8)
        ax1.text(i, 1.18, f"{lat}ms", ha="center", fontsize=8, color="#555555")
    ax1.set_yticks([])
    ax1.set_xticks([])
    ax1.set_xlim(-0.6, len(E2E_DECISIONS) - 0.4)
    for spine in ax1.spines.values():
        spine.set_visible(False)
    ax1.set_title("real E2E debug task: every trigger consulted jev (glm-5.3-flash + jev-1.13.0)", fontsize=9)

    bars = ax2.barh([f"{t}\n{note}" for t, _, _, _, _, note in E2E_DECISIONS][::-1],
                    [l for *_, l, _ in E2E_DECISIONS][::-1], color="#4C72B0", alpha=0.85)
    ax2.bar_label(bars, fmt="%dms", fontsize=8)
    ax2.set_title("jev latency per decision", fontsize=9)
    ax2.grid(axis="x", alpha=0.3)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "e2e-routing.png"), dpi=150)
    plt.close(fig)


def fig_mock():
    fig, ax = plt.subplots(figsize=(9.5, 3.6))
    turns = [t for t, _, _ in MOCK_TURNS]
    levels = [{"low": 0, "medium": 1, "high": 2, "xhigh": 3}[l] for _, l, _ in MOCK_TURNS]
    ax.step(turns, levels, where="post", color="#4C72B0", lw=2)
    ax.scatter(turns, levels, color=[LEVEL_COLORS[l] for _, l, _ in MOCK_TURNS], s=70, zorder=3)
    for i, (t, l, event) in enumerate(MOCK_TURNS):
        if event:
            dy = 9 if i % 2 == 0 else 26  # alternate rows so neighbours never collide
            ax.annotate(event, (t, {"low": 0, "medium": 1, "high": 2, "xhigh": 3}[l]),
                        textcoords="offset points", xytext=(4, dy), fontsize=7.5, color="#333333")
    ax.set_yticks([0, 1, 2, 3])
    ax.set_yticklabels(["low", "medium", "high", "xhigh"])
    ax.set_xlabel("turn index (mock jev, integration test scenario)")
    ax.set_title("scripted loop: escalate on failure, downgrade after 2 clean turns, cap at 2 escalations", fontsize=9)
    ax.grid(axis="y", alpha=0.3)
    ax.set_ylim(-0.4, 3.4)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "mock-loop.png"), dpi=150)
    plt.close(fig)


def fig_ab():
    fig, axes = plt.subplots(1, 3, figsize=(13, 4.2))
    metrics = [("wall", "wall time (s)"), ("in", "input tokens (excl. cache)"), ("out", "output tokens")]
    labels = list(AB.keys())
    colors = ("#4C72B0", "#DD8452")
    for ax, (key, title) in zip(axes, metrics):
        for i, cfg in enumerate(("fixed max", "jev-router")):
            vals = AB[cfg][key]
            mean = statistics.mean(vals)
            sd = statistics.stdev(vals)
            x = i
            ax.bar([x], [mean], width=0.5, yerr=[sd], capsize=5, color=colors[i],
                   label=cfg if key == "wall" else None, alpha=0.9)
            ax.scatter([x] * len(vals), vals, color="black", s=16, zorder=3, alpha=0.6)
            ax.text(x, mean + sd * 0.15, f"{mean:.0f}", ha="center", va="bottom", fontsize=9, fontweight="bold")
        ax.set_xticks(range(len(labels)))
        ax.set_xticklabels(labels, fontsize=9)
        ax.set_title(title, fontsize=10)
        ax.grid(axis="y", alpha=0.3)
    axes[0].legend(fontsize=8)
    fig.suptitle("3-seed A/B: fixed thinking=max (no routing) vs jev-router — 3 independent runs each (bars: mean, whiskers: stdev, dots: per-run)", fontsize=9)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "ab-3seed.png"), dpi=150)
    plt.close(fig)


def fig_distributions():
    fig, ax = plt.subplots(figsize=(10.5, 4.4))
    names = [d[0] for d in DISTRIBUTIONS][::-1]
    lefts = [0.0] * len(names)
    colors = [C_LOW, C_MED, C_HIGH, C_XHIGH]
    labels = ["low", "medium", "high", "xhigh"]
    for li, lvl in enumerate(labels):
        vals = [d[1].get(lvl, 0) for d in DISTRIBUTIONS][::-1]
        bars = ax.barh(names, vals, left=lefts, color=colors[li], label=lvl, alpha=0.9)
        for b, v in zip(bars, vals):
            if v >= 0.25:
                ax.text(b.get_x() + b.get_width() / 2, b.get_y() + b.get_height() / 2,
                        f"{v:.2f}", ha="center", va="center", fontsize=8, color="white", fontweight="bold")
        lefts = [a + v for a, v in zip(lefts, vals)]
    ax.set_xlim(0, 1.0)
    ax.set_title("probability distributions returned by jev-1.13.0 (real calls)", fontsize=9)
    ax.legend(loc="lower right", fontsize=8, ncols=4)
    ax.tick_params(axis="y", labelsize=8)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "jev-distributions.png"), dpi=150)
    plt.close(fig)


def fig_latency():
    fig, ax = plt.subplots(figsize=(9.5, 3.4))
    names = [n for n, _ in LATENCIES]
    vals = [v for _, v in LATENCIES]
    mean = sum(vals) / len(vals)
    bars = ax.bar(names, vals, color="#4C72B0", alpha=0.85)
    ax.axhline(mean, color="#C44E52", ls="--", lw=1.4, label=f"mean {mean:.0f}ms")
    ax.bar_label(bars, fmt="%d", fontsize=8)
    ax.set_ylabel("latency (ms)")
    ax.set_title("real jev call latency across all runs (timeout guard: 20s, all calls ≪ timeout)", fontsize=9)
    ax.legend(fontsize=8)
    ax.grid(axis="y", alpha=0.3)
    ax.tick_params(axis="x", labelsize=7.5)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "jev-latency.png"), dpi=150)
    plt.close(fig)


def fig_suite():
    fig, ax = plt.subplots(figsize=(9.5, 3.4))
    names = [n for n, _, _ in SUITE]
    passed = [p for _, p, _ in SUITE]
    failed = [f for _, _, f in SUITE]
    ax.barh(names[::-1], passed[::-1], color="#55A868", label="pass")
    ax.barh(names[::-1], failed[::-1], left=passed[::-1], color="#C44E52", label="fail")
    for i, (p, f) in enumerate(zip(passed[::-1], failed[::-1])):
        ax.text(p + f + 0.08, i, str(p), va="center", fontsize=8)
    ax.set_xlabel("tests")
    ax.set_title("test suite results (node --test, 44 hermetic + 1 live)", fontsize=9)
    ax.legend(fontsize=8)
    ax.grid(axis="x", alpha=0.3)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "test-results.png"), dpi=150)
    plt.close(fig)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    fig_ab()
    fig_e2e()
    fig_mock()
    fig_distributions()
    fig_latency()
    fig_suite()
    for f in sorted(os.listdir(OUT)):
        print("wrote", os.path.join(OUT, f))
