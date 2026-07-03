#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
from textwrap import fill

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch


ROOT = Path(__file__).resolve().parents[1]
FIG_DIR = Path(__file__).resolve().parent / "figures"
EVAL_PATH = ROOT / "generated-knowledge" / "windrise-mechanism-graph-evaluation.json"

PALETTE = {
    "blue_main": "#0F4D92",
    "blue_secondary": "#3775BA",
    "teal": "#42949E",
    "green": "#2E9E44",
    "green_soft": "#AADCA9",
    "red": "#B64342",
    "gold": "#C89B2C",
    "violet": "#7C6CCF",
    "neutral_light": "#D8D8D8",
    "neutral_mid": "#767676",
    "neutral_dark": "#4D4D4D",
    "neutral_black": "#272727",
    "bg": "#F7F8FA",
}


plt.rcParams["font.family"] = "sans-serif"
plt.rcParams["font.sans-serif"] = ["Arial", "DejaVu Sans", "Liberation Sans"]
plt.rcParams["svg.fonttype"] = "none"
plt.rcParams["pdf.fonttype"] = 42
plt.rcParams["font.size"] = 7
plt.rcParams["axes.spines.right"] = False
plt.rcParams["axes.spines.top"] = False
plt.rcParams["axes.linewidth"] = 0.75
plt.rcParams["legend.frameon"] = False


def load_eval() -> dict:
    return json.loads(EVAL_PATH.read_text(encoding="utf-8"))


def panel_label(ax, label: str, x: float = -0.04, y: float = 1.04) -> None:
    ax.text(x, y, label, transform=ax.transAxes, fontsize=10, fontweight="bold", va="bottom")


def save_pdf(fig: plt.Figure, name: str) -> None:
    FIG_DIR.mkdir(exist_ok=True)
    fig.savefig(FIG_DIR / f"{name}.pdf", bbox_inches="tight", transparent=False)
    plt.close(fig)


def draw_box(ax, xy, text, width=0.16, height=0.12, color="#3775BA", fc="white", fontsize=6.5):
    x, y = xy
    box = FancyBboxPatch(
        (x, y),
        width,
        height,
        boxstyle="round,pad=0.012,rounding_size=0.018",
        linewidth=1.0,
        edgecolor=color,
        facecolor=fc,
        transform=ax.transAxes,
    )
    ax.add_patch(box)
    ax.text(x + width / 2, y + height / 2, text, transform=ax.transAxes, ha="center", va="center", fontsize=fontsize)
    return (x + width, y + height / 2), (x, y + height / 2)


def draw_arrow(ax, start, end, color="#767676", lw=1.1):
    arrow = FancyArrowPatch(
        start,
        end,
        transform=ax.transAxes,
        arrowstyle="-|>",
        mutation_scale=8,
        linewidth=lw,
        color=color,
        shrinkA=2,
        shrinkB=2,
    )
    ax.add_patch(arrow)


def style_percent_axis(ax):
    ax.set_ylim(0, 1.08)
    ax.set_yticks([0, 0.25, 0.50, 0.75, 1.0])
    ax.set_yticklabels(["0", "25", "50", "75", "100"])
    ax.set_ylabel("Coverage (%)")
    ax.grid(axis="y", color="#E6E6E6", linewidth=0.7)


def fig_mechanism_overview():
    data = load_eval()
    base = data["baseline"]
    mech = data["mechanism"]
    fig = plt.figure(figsize=(7.2, 5.4), constrained_layout=False)
    gs = fig.add_gridspec(2, 3, height_ratios=[1.25, 1.0], width_ratios=[1.25, 1.05, 1.0], hspace=0.52, wspace=0.42)

    ax_a = fig.add_subplot(gs[0, :2])
    ax_a.set_axis_off()
    panel_label(ax_a, "a", -0.03, 1.02)
    ax_a.set_title("Mechanism-enhanced graph turns retrieval into falsifiable troubleshooting", loc="left", fontsize=9, pad=7)
    steps = [
        ("Fault\ncase", PALETTE["neutral_black"]),
        ("Mechanism\narchetype", PALETTE["blue_main"]),
        ("Failure mode\n+ propagation", PALETTE["teal"]),
        ("Observable\n+ test", PALETTE["gold"]),
        ("Control\nbarrier", PALETTE["green"]),
    ]
    starts = []
    ends = []
    for i, (txt, color) in enumerate(steps):
        right, left = draw_box(ax_a, (0.02 + i * 0.19, 0.58), txt, width=0.145, height=0.18, color=color, fontsize=6.4)
        starts.append(right)
        ends.append(left)
    for i in range(len(steps) - 1):
        draw_arrow(ax_a, starts[i], ends[i + 1])

    hyp_right, _ = draw_box(
        ax_a,
        (0.23, 0.16),
        "Diagnostic\nhypothesis",
        width=0.16,
        height=0.15,
        color=PALETTE["violet"],
        fc="#FBFAFF",
        fontsize=6.3,
    )
    ev_right, ev_left = draw_box(
        ax_a,
        (0.46, 0.16),
        "Evidence\n+ counterfactual",
        width=0.19,
        height=0.15,
        color=PALETTE["violet"],
        fc="#FBFAFF",
        fontsize=6.2,
    )
    rule_right, rule_left = draw_box(
        ax_a,
        (0.73, 0.16),
        "Decision\nrule",
        width=0.15,
        height=0.15,
        color=PALETTE["violet"],
        fc="#FBFAFF",
        fontsize=6.3,
    )
    draw_arrow(ax_a, (0.29, 0.58), (0.30, 0.31), PALETTE["violet"])
    draw_arrow(ax_a, hyp_right, ev_left, PALETTE["violet"])
    draw_arrow(ax_a, ev_right, rule_left, PALETTE["violet"])
    ax_a.text(
        0.02,
        0.02,
        "Core claim: each case is connected to a mechanism, verification path, prevention barrier and falsifiable diagnostic hypothesis.",
        transform=ax_a.transAxes,
        fontsize=6.3,
        color=PALETTE["neutral_mid"],
    )

    ax_b = fig.add_subplot(gs[0, 2])
    panel_label(ax_b, "b")
    labels = ["pairwise\ncompetition", "single\ncounterfactual"]
    values = [18, 15]
    colors = [PALETTE["blue_secondary"], PALETTE["gold"]]
    wedges, _ = ax_b.pie(values, startangle=90, colors=colors, wedgeprops=dict(width=0.42, edgecolor="white", linewidth=1))
    ax_b.text(0, 0.03, "33/33\ncases", ha="center", va="center", fontsize=10, fontweight="bold")
    ax_b.set_title("Hypothesis design", fontsize=8, pad=8)
    ax_b.legend(wedges, labels, loc="lower center", bbox_to_anchor=(0.5, -0.20), ncol=1, fontsize=6)

    ax_c = fig.add_subplot(gs[1, :])
    panel_label(ax_c, "c", -0.02, 1.05)
    metrics = ["Profile\ncomplete", "Validation\nclosure", "Prevention\nclosure", "Hypothesis\ndiscrimination"]
    baseline = np.array([base["complete_profile_rate"], base["validation_closure_rate"], base["prevention_closure_rate"], 0])
    enhanced = np.array([mech["profile_complete_rate"], mech["validation_closure_rate"], mech["prevention_closure_rate"], mech["discrimination_coverage_rate"]])
    x = np.arange(len(metrics))
    width = 0.34
    ax_c.bar(x - width / 2, baseline, width, label="Traditional profile", color=PALETTE["neutral_light"], edgecolor="white")
    ax_c.bar(x + width / 2, enhanced, width, label="Mechanism graph", color=PALETTE["teal"], edgecolor="white")
    for xi, val in zip(x - width / 2, baseline):
        ax_c.text(xi, val + 0.025, f"{val * 100:.0f}", ha="center", fontsize=6, color=PALETTE["neutral_mid"])
    for xi, val in zip(x + width / 2, enhanced):
        ax_c.text(xi, val + 0.025, f"{val * 100:.0f}", ha="center", fontsize=6, color=PALETTE["neutral_black"])
    ax_c.set_xticks(x)
    ax_c.set_xticklabels(metrics)
    style_percent_axis(ax_c)
    ax_c.legend(loc="upper left", ncol=2)
    ax_c.set_title("Structural ablation", loc="left", fontsize=8)
    save_pdf(fig, "fig_nature_mechanism_overview")


def fig_graph_composition():
    data = load_eval()
    node_types = data["mechanism"]["node_types"]
    relation_types = data["mechanism"]["relation_types"]
    fig = plt.figure(figsize=(7.2, 4.8), constrained_layout=False)
    gs = fig.add_gridspec(2, 2, height_ratios=[1.0, 0.95], width_ratios=[1.15, 0.85], hspace=0.55, wspace=0.38)

    ax_a = fig.add_subplot(gs[:, 0])
    panel_label(ax_a, "a")
    ordered_nodes = [
        ("Mechanism\nlayer", node_types["mechanism_layer"], PALETTE["blue_main"]),
        ("Propagation\nstep", node_types["propagation_step"], PALETTE["blue_secondary"]),
        ("Observable", node_types["observable"], PALETTE["teal"]),
        ("Failure\nmode", node_types["failure_mode"], PALETTE["red"]),
        ("Verification\ntest", node_types["verification_test"], PALETTE["gold"]),
        ("Control\nbarrier", node_types["control_barrier"], PALETTE["green"]),
        ("Discriminating\nevidence", node_types["discriminating_evidence"], PALETTE["violet"]),
        ("Counterfactual\ntest", node_types["counterfactual_test"], PALETTE["gold"]),
        ("Decision\nrule", node_types["decision_rule"], PALETTE["neutral_dark"]),
        ("Diagnostic\nhypothesis", node_types["diagnostic_hypothesis"], PALETTE["violet"]),
        ("Archetype", node_types["mechanism_archetype"], PALETTE["neutral_mid"]),
    ]
    labels = [x[0] for x in ordered_nodes]
    values = [x[1] for x in ordered_nodes]
    colors = [x[2] for x in ordered_nodes]
    y = np.arange(len(values))[::-1]
    ax_a.barh(y, values, color=colors, edgecolor="white", height=0.68)
    for yi, val in zip(y, values):
        ax_a.text(val + 5, yi, str(val), va="center", fontsize=6)
    ax_a.set_yticks(y)
    ax_a.set_yticklabels(labels, fontsize=6.2)
    ax_a.set_xlabel("Node count")
    ax_a.set_xlim(0, 260)
    ax_a.grid(axis="x", color="#E6E6E6", linewidth=0.7)
    ax_a.set_title("Mechanism node types", loc="left", fontsize=8)

    ax_b = fig.add_subplot(gs[0, 1])
    panel_label(ax_b, "b")
    top_rel = sorted(relation_types.items(), key=lambda x: x[1], reverse=True)[:7]
    rel_labels = [fill(k.replace("_", " "), 18) for k, _ in top_rel]
    rel_values = [v for _, v in top_rel]
    yy = np.arange(len(rel_values))[::-1]
    ax_b.barh(yy, rel_values, color=PALETTE["teal"], edgecolor="white", height=0.64)
    for yi, val in zip(yy, rel_values):
        ax_b.text(val + 7, yi, str(val), va="center", fontsize=6)
    ax_b.set_yticks(yy)
    ax_b.set_yticklabels(rel_labels, fontsize=5.8)
    ax_b.set_xlim(0, 380)
    ax_b.set_xlabel("Relation count")
    ax_b.grid(axis="x", color="#E6E6E6", linewidth=0.7)
    ax_b.set_title("Dominant relation types", loc="left", fontsize=8)

    ax_c = fig.add_subplot(gs[1, 1])
    panel_label(ax_c, "c")
    closure_labels = ["Mechanism\nclosure", "Hypothesis\ndiscrimination", "Profile\ncomplete"]
    closure_vals = [data["mechanism"]["coverage_rate"], data["mechanism"]["discrimination_coverage_rate"], data["mechanism"]["profile_complete_rate"]]
    ax_c.bar(np.arange(3), closure_vals, color=[PALETTE["blue_main"], PALETTE["violet"], PALETTE["green"]], edgecolor="white")
    for i, val in enumerate(closure_vals):
        ax_c.text(i, val + 0.025, f"{val * 100:.0f}%", ha="center", fontsize=6)
    ax_c.set_xticks(np.arange(3))
    ax_c.set_xticklabels(closure_labels, fontsize=6)
    style_percent_axis(ax_c)
    ax_c.set_title("Closure metrics", loc="left", fontsize=8)
    save_pdf(fig, "fig_nature_graph_composition")


def fig_case_quality():
    data = load_eval()
    cases = data["case_metrics"]
    scores = np.array([case["mechanism_score"] for case in cases])
    depths = np.array([case["max_mechanism_depth"] for case in cases])
    discrim_types = [case.get("discriminator_types", ["unspecified"])[0] for case in cases]
    pairwise = sum(t == "pairwise_archetype_competition" for t in discrim_types)
    single = sum(t == "single_archetype_counterfactual" for t in discrim_types)

    fig = plt.figure(figsize=(7.2, 4.6), constrained_layout=False)
    gs = fig.add_gridspec(2, 3, height_ratios=[1.0, 0.95], width_ratios=[1.15, 1.0, 1.0], hspace=0.48, wspace=0.42)

    ax_a = fig.add_subplot(gs[:, 0])
    panel_label(ax_a, "a")
    sorted_scores = np.sort(scores)
    colors = [PALETTE["blue_secondary"] if i < pairwise else PALETTE["gold"] for i in range(len(sorted_scores))]
    ax_a.barh(np.arange(len(sorted_scores)), sorted_scores, color=colors, edgecolor="white", height=0.78)
    ax_a.axvline(scores.mean(), color=PALETTE["neutral_black"], linewidth=1.0, linestyle="--")
    ax_a.text(scores.mean() + 0.4, len(sorted_scores) - 2, f"mean {scores.mean():.1f}", fontsize=6, rotation=90, va="top")
    ax_a.set_xlabel("Mechanism quality score")
    ax_a.set_ylabel("Fault cases (ranked)")
    ax_a.set_xlim(0, 100)
    ax_a.set_yticks([])
    ax_a.grid(axis="x", color="#E6E6E6", linewidth=0.7)
    ax_a.set_title("Per-case quality distribution", loc="left", fontsize=8)

    ax_b = fig.add_subplot(gs[0, 1])
    panel_label(ax_b, "b")
    ax_b.hist(scores, bins=[80, 85, 90, 95, 100], color=PALETTE["teal"], edgecolor="white")
    ax_b.set_xlabel("Score")
    ax_b.set_ylabel("Case count")
    ax_b.set_title("Score concentration", loc="left", fontsize=8)
    ax_b.grid(axis="y", color="#E6E6E6", linewidth=0.7)

    ax_c = fig.add_subplot(gs[0, 2])
    panel_label(ax_c, "c")
    ax_c.bar(["Pairwise", "Single"], [pairwise, single], color=[PALETTE["blue_secondary"], PALETTE["gold"]], edgecolor="white", width=0.62)
    ax_c.set_ylabel("Case count")
    ax_c.set_title("Hypothesis type", loc="left", fontsize=8)
    for i, val in enumerate([pairwise, single]):
        ax_c.text(i, val + 0.5, str(val), ha="center", fontsize=7)
    ax_c.set_ylim(0, 22)
    ax_c.grid(axis="y", color="#E6E6E6", linewidth=0.7)

    ax_d = fig.add_subplot(gs[1, 1:])
    panel_label(ax_d, "d", -0.03, 1.05)
    ax_d.set_axis_off()
    summary = [
        ("33/33", "closed cases", PALETTE["blue_main"]),
        (f"{depths.mean():.2f}", "mean path depth", PALETTE["teal"]),
        (str(depths.max()), "max path depth", PALETTE["gold"]),
        ("100%", "verification + prevention", PALETTE["green"]),
    ]
    for i, (num, lab, col) in enumerate(summary):
        x = 0.03 + i * 0.24
        rect = FancyBboxPatch(
            (x, 0.28),
            0.19,
            0.42,
            boxstyle="round,pad=0.015,rounding_size=0.03",
            transform=ax_d.transAxes,
            facecolor="#FFFFFF",
            edgecolor=col,
            linewidth=1.0,
        )
        ax_d.add_patch(rect)
        ax_d.text(x + 0.095, 0.55, num, transform=ax_d.transAxes, ha="center", va="center", fontsize=12, fontweight="bold", color=col)
        ax_d.text(x + 0.095, 0.38, lab, transform=ax_d.transAxes, ha="center", va="center", fontsize=6.2, color=PALETTE["neutral_dark"])
    ax_d.set_title("Closed mechanism-verification-prevention chain", loc="left", fontsize=8)
    save_pdf(fig, "fig_nature_case_quality")


def main():
    fig_mechanism_overview()
    fig_graph_composition()
    fig_case_quality()


if __name__ == "__main__":
    main()
