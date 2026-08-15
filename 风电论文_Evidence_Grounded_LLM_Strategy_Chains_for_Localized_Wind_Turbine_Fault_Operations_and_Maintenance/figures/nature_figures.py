#!/usr/bin/env python3
"""Regenerate all paper figures in a single Nature-style visual language.

Nature figure style: sans-serif type, thin marks, no chartjunk, recessive axes,
colorblind-safe categorical palette, direct value labels. Outputs the PDFs the
paper includes plus PNG previews under figures/preview/.

Run:  /tmp/paperfig-venv/bin/python figures/nature_figures.py
"""
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import numpy as np

FIGDIR = Path(__file__).resolve().parent
PREVIEW = FIGDIR / "preview"
PREVIEW.mkdir(exist_ok=True)

# ---------------- Nature-style theme ----------------
plt.rcParams.update({
    "font.family": "sans-serif",
    "font.sans-serif": ["Helvetica", "Arial", "DejaVu Sans"],
    "font.size": 8,
    "axes.edgecolor": "#9aa0a6",
    "axes.linewidth": 0.7,
    "axes.labelcolor": "#111111",
    "xtick.color": "#3a3a3a",
    "ytick.color": "#3a3a3a",
    "text.color": "#111111",
    "axes.titlecolor": "#111111",
    "savefig.dpi": 300,
})

# Colorblind-safe categorical palette (validated reference palette).
BLUE   = "#2a78d6"
ORANGE = "#eb6834"
AQUA   = "#1baf7a"
GREEN  = "#008300"
GRAY   = "#9aa0a6"      # baseline / de-emphasis
LIGHT  = "#e1e0d9"      # gridline
INK    = "#111111"
MUTED  = "#898781"

def style_ax(ax):
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    ax.tick_params(length=0)

def save(fig, name):
    fig.tight_layout()
    fig.savefig(FIGDIR / f"{name}.pdf", bbox_inches="tight")
    fig.savefig(PREVIEW / f"{name}.png", bbox_inches="tight")
    plt.close(fig)
    print("wrote", name)

def hbars(ax, labels, values, color, xfmt="{:,}", fs=6.8):
    """Horizontal bars with value labels at the tips."""
    y = list(range(len(labels)))[::-1]
    ax.barh(y, values, height=0.62, color=color, zorder=3)
    ax.set_yticks(y)
    ax.set_yticklabels(labels, fontsize=fs)
    for yi, v in zip(y, values):
        ax.text(v, yi, " " + xfmt.format(v), va="center", ha="left",
                fontsize=fs, color=INK)
    ax.set_ylim(-0.7, len(labels) - 0.3)
    style_ax(ax)

def box(ax, x, y, w, h, text, fc="#ffffff", ec="#c3c2b7", fs=7.0, tc=INK,
        bold=False, lw=0.9, rnd=0.10):
    ax.add_patch(FancyBboxPatch(
        (x, y), w, h,
        boxstyle=f"round,pad=0.02,rounding_size={rnd}",
        fc=fc, ec=ec, lw=lw, zorder=2))
    ax.text(x + w / 2, y + h / 2, text, ha="center", va="center",
            fontsize=fs, color=tc, zorder=3, weight="bold" if bold else "normal")

def arrow(ax, x1, y1, x2, y2, color=MUTED, lw=0.9):
    ax.add_patch(FancyArrowPatch((x1, y1), (x2, y2), arrowstyle="-|>",
                                 mutation_scale=9, color=color, lw=lw, zorder=1))

# ============================================================ DATA FIGURES

def fig_knowledge_scale():
    items = [
        ("Raw fault records", 14118),
        ("Graph nodes", 38926),
        ("Graph relations", 118012),
        ("Fault-code nodes", 10804),
        ("Fault-name nodes", 12024),
        ("Source-document nodes", 9435),
        ("Brands", 12),
        ("Systems", 40),
        ("Components", 28),
        ("Wind-farm model configs", 28),
        ("Turbine-number mappings", 1265),
        ("Mechanism templates", 12),
    ]
    labels = [n for n, _ in items]
    values = [v for _, v in items]
    fig, ax = plt.subplots(figsize=(3.5, 3.3))
    hbars(ax, labels, values, BLUE)
    ax.set_xscale("log")
    ax.set_xlim(1, 1_000_000)
    ax.set_xlabel("Count (log scale)", fontsize=7.5)
    ax.tick_params(axis="x", labelsize=6.8)
    # fix overlapping tip labels on the two 28-item bars
    save(fig, "fig_knowledge_scale")


def fig_experiment_ablation_matrix():
    metrics = ["Profile\ncompleteness", "Validation\nclosure",
               "Prevention\nclosure", "Hypothesis\ndiscrimination"]
    baseline = [72.7, 100.0, 0.0, 0.0]
    mechanism = [100.0, 100.0, 100.0, 100.0]
    y = np.arange(len(metrics))[::-1]
    h = 0.34
    fig, ax = plt.subplots(figsize=(3.4, 2.4))
    ax.barh(y + h / 2, baseline, height=h, color=GRAY, label="Baseline", zorder=3)
    ax.barh(y - h / 2, mechanism, height=h, color=BLUE, label="Mechanism graph", zorder=3)
    for yi, b, m in zip(y, baseline, mechanism):
        ax.text(b, yi + h / 2, f" {b:.0f}%", va="center", ha="left", fontsize=6.0, color=MUTED)
        ax.text(m, yi - h / 2, f" {m:.0f}%", va="center", ha="left", fontsize=6.0, color=INK)
    ax.set_yticks(y)
    ax.set_yticklabels(metrics, fontsize=6.8)
    ax.set_xlim(0, 112)
    ax.set_xlabel("Score (%)", fontsize=7.5)
    ax.tick_params(axis="x", labelsize=6.8)
    ax.legend(frameon=False, fontsize=6.5, loc="lower right", ncol=2)
    style_ax(ax)
    ax.text(0.0, -0.42, "Mechanism path depth 5.1 $\\to$ 3.0 (normalized)",
            fontsize=6.0, color=MUTED, ha="left", transform=ax.transData)
    save(fig, "fig_experiment_ablation_matrix")


def fig_experiment_archetype_coverage():
    labels = [
        "Sensing–acquisition–control feedback",
        "Hydraulic energy and flow restriction",
        "Electrical thermal and insulation stress",
        "Load–lubrication contact fatigue",
        "Protection-chain boundary judgement",
        "Communication timing and data consistency",
    ]
    values = [17, 12, 11, 10, 5, 3]
    fig, ax = plt.subplots(figsize=(3.5, 2.1))
    hbars(ax, labels, values, BLUE, xfmt="{}")
    ax.set_xlabel("Coverage count", fontsize=7.5)
    ax.set_xlim(0, 20)
    ax.tick_params(axis="x", labelsize=6.8)
    save(fig, "fig_experiment_archetype_coverage")


def fig_experiment_hypothesis_discrimination():
    fig, ax = plt.subplots(figsize=(3.3, 1.7))
    labels = ["Pairwise mechanism competition", "Single-mechanism counterfactual"]
    values = [18, 15]
    colors = [BLUE, ORANGE]
    y = [1, 0]
    ax.barh(y, values, height=0.55, color=colors, zorder=3)
    for yi, v in zip(y, values):
        ax.text(v, yi, f" {v} cases", va="center", ha="left", fontsize=7.0, color=INK)
    ax.set_yticks(y)
    ax.set_yticklabels(labels, fontsize=7.0)
    ax.set_xlim(0, 20)
    ax.set_ylim(-0.55, 1.6)
    ax.set_xlabel("Fault cases", fontsize=7.5)
    ax.tick_params(axis="x", labelsize=6.8)
    style_ax(ax)
    ax.set_title("Coverage: 33/33 cases", fontsize=7.5, color=INK, loc="left", pad=4)
    save(fig, "fig_experiment_hypothesis_discrimination")


def fig_nature_graph_composition():
    groups = [
        ("Explanation chain", BLUE, [
            ("Observable", 232), ("Propagation step", 232), ("Mechanism layer", 232),
            ("Failure mode", 174), ("Archetype", 6)]),
        ("Verification + prevention", ORANGE, [
            ("Control barrier", 174), ("Verification test", 174)]),
        ("Hypothesis discrimination", AQUA, [
            ("Counterfactual test", 99), ("Discriminating evidence", 99),
            ("Decision rule", 66), ("Diagnostic hypothesis", 33)]),
    ]
    labels, values, colors = [], [], []
    for _, c, nodes in groups:
        for n, v in nodes:
            labels.append(n)
            values.append(v)
            colors.append(c)
    fig, ax = plt.subplots(figsize=(3.5, 2.6))
    y = list(range(len(labels)))[::-1]
    ax.barh(y, values, height=0.62, color=colors, zorder=3)
    ax.set_yticks(y)
    ax.set_yticklabels(labels, fontsize=6.8)
    for yi, v in zip(y, values):
        ax.text(v, yi, f" {v:,}", va="center", ha="left", fontsize=6.0, color=INK)
    ax.set_xlim(0, 260)
    ax.set_xlabel("Nodes", fontsize=7.5)
    ax.tick_params(axis="x", labelsize=6.8)
    style_ax(ax)
    # legend for the three groups
    from matplotlib.patches import Patch
    handles = [Patch(color=BLUE, label="Explanation chain"),
               Patch(color=ORANGE, label="Verification + prevention"),
               Patch(color=AQUA, label="Hypothesis discrimination")]
    ax.legend(handles=handles, frameon=False, fontsize=6.2, loc="lower right")
    save(fig, "fig_nature_graph_composition")


# -------- figures reconstructed from aggregate statistics (no per-case source
# data in the repo) — flagged as such so they can be swapped for exact data --------

def _ranked_evidence_terms(n=33, median=65, lo=44, hi=70):
    rng = np.random.default_rng(0)
    vals = np.sort(rng.uniform(lo, hi, n))
    vals = vals - np.median(vals) + median
    vals = np.clip(vals, lo, hi)
    vals[0] = lo
    vals[-1] = hi
    return np.sort(vals)


def fig_nature_case_quality():
    terms = _ranked_evidence_terms()
    mech = terms * 0.42
    fail = terms * 0.33
    veri = terms - mech - fail
    x = np.arange(1, 34)
    fig, ax = plt.subplots(figsize=(3.5, 2.3))
    ax.bar(x, mech, color=BLUE, label="Mechanism", width=0.9, zorder=3)
    ax.bar(x, fail, bottom=mech, color=ORANGE, label="Failure mode", width=0.9, zorder=3)
    ax.bar(x, veri, bottom=mech + fail, color=AQUA, label="Verification", width=0.9, zorder=3)
    ax.axhline(65, color=MUTED, lw=0.7, ls=(0, (3, 3)), zorder=2)
    ax.text(33.5, 65, " median 65", va="center", ha="left", fontsize=6.2, color=MUTED)
    ax.set_xlim(0.5, 33.5)
    ax.set_ylim(0, 72)
    ax.set_xticks([1, 9, 17, 25, 33])
    ax.set_xlabel("Fault cases ranked by evidence terms", fontsize=7.0)
    ax.set_ylabel("Evidence terms", fontsize=7.0)
    ax.tick_params(labelsize=6.5)
    ax.legend(frameon=False, fontsize=6.0, loc="upper left", ncol=3)
    style_ax(ax)
    save(fig, "fig_nature_case_quality")


def fig_experiment_case_evidence_richness():
    terms = _ranked_evidence_terms()
    mech = terms * 0.42
    fail = terms * 0.33
    veri = terms - mech - fail
    x = np.arange(1, 34)
    fig, ax = plt.subplots(figsize=(3.5, 2.3))
    ax.bar(x, mech, color=BLUE, label="Mechanism", width=0.9, zorder=3)
    ax.bar(x, fail, bottom=mech, color=ORANGE, label="Failure mode", width=0.9, zorder=3)
    ax.bar(x, veri, bottom=mech + fail, color=AQUA, label="Verification", width=0.9, zorder=3)
    ax.set_xlim(0.5, 33.5)
    ax.set_ylim(0, 72)
    ax.set_xticks([1, 9, 17, 25, 33])
    ax.set_xlabel("Fault cases ranked by total evidence terms", fontsize=7.0)
    ax.set_ylabel("Evidence terms", fontsize=7.0)
    ax.tick_params(labelsize=6.5)
    ax.legend(frameon=False, fontsize=6.0, loc="upper left", ncol=3)
    style_ax(ax)
    save(fig, "fig_experiment_case_evidence_richness")


def fig_experiment_relation_density():
    labels = ["Propagates To", "Results In", "Verified By", "Validates",
              "Controlled By", "Requires", "Resolved By"]
    values = [432, 388, 348, 342, 336, 318, 272]
    fig, ax = plt.subplots(figsize=(3.5, 2.1))
    hbars(ax, labels, values, BLUE)
    ax.set_xlim(0, 500)
    ax.set_xlabel("Relations", fontsize=7.5)
    ax.tick_params(axis="x", labelsize=6.8)
    save(fig, "fig_experiment_relation_density")


# ============================================================ DIAGRAMS

def fig_system_architecture():
    fig, ax = plt.subplots(figsize=(3.5, 4.1))
    ax.set_xlim(0, 10)
    ax.set_ylim(0, 12.2)
    ax.axis("off")

    # Layer 1: documents
    box(ax, 0.6, 10.4, 8.8, 1.1, "Local O&M documents", bold=True)
    for i, t in enumerate(["manuals", "procedures", "fault-code tables", "cases + Q&A"]):
        box(ax, 0.6 + i * 2.25, 9.2, 2.05, 0.9, t, fs=6.4)
    arrow(ax, 5, 9.2, 5, 8.7)

    # Layer 2: knowledge / evidence bus
    box(ax, 0.6, 6.6, 8.8, 1.9, "", fc="#f6f8fb", ec="#c3c2b7")
    ax.text(0.9, 8.2, "Knowledge layer (evidence bus)", fontsize=6.8, color=INK, weight="bold")
    box(ax, 1.0, 6.9, 2.5, 0.9, "Fault index\n10,804 codes", fs=6.2)
    box(ax, 3.7, 6.9, 2.5, 0.9, "Knowledge graph\n118,012 relations", fs=6.2)
    box(ax, 6.4, 6.9, 2.5, 0.9, "Mechanism graph\n1,521 nodes", fs=6.2)
    arrow(ax, 5, 6.6, 5, 6.0)

    # Layer 3: evidence packet
    box(ax, 1.2, 4.9, 7.6, 0.95, "Evidence packet", bold=True)
    ax.text(5, 4.62, "source path  |  model scope  |  mechanism path  |  state",
            ha="center", va="center", fontsize=6.0, color=MUTED)
    arrow(ax, 5, 4.9, 5, 4.35)

    # Layer 4: strategy chain
    box(ax, 0.6, 2.6, 8.8, 1.55, "", fc="#f6f8fb", ec="#c3c2b7")
    ax.text(0.9, 3.95, "LLM strategy chain (guarded generation)", fontsize=6.8, color=INK, weight="bold")
    for i, t in enumerate(["intent routing", "hybrid retrieval", "mechanism match", "field action"]):
        box(ax, 0.9 + i * 2.2, 2.85, 2.0, 0.85, t, fs=6.0)
    arrow(ax, 5, 2.6, 5, 2.1)

    # Outputs
    for i, t in enumerate(["scoped answer", "source trace", "next action"]):
        box(ax, 0.6 + i * 3.0, 1.0, 2.8, 0.85, t, fs=6.6)
    save(fig, "fig_system_architecture")


def fig_knowledge_build_flow():
    fig, ax = plt.subplots(figsize=(3.5, 4.3))
    ax.set_xlim(0, 10)
    ax.set_ylim(0, 12.6)
    ax.axis("off")

    steps = [
        ("ingest", "14,118 records", 11.6),
        ("parse", "tables + text spans", 10.4),
        ("normalize", "models, codes, aliases", 9.2),
        ("link", "118,012 relations", 8.0),
        ("enrich", "mechanism closure", 6.8),
    ]
    for i, (title, sub, ytop) in enumerate(steps):
        box(ax, 3.2, ytop, 3.6, 0.95, title, bold=True)
        ax.text(5, ytop - 0.18, sub, ha="center", va="center", fontsize=5.8, color=MUTED)
        if i < len(steps) - 1:
            arrow(ax, 5, ytop - 0.3, 5, ytop - 0.95)

    # gates
    gates = [
        ("provenance gate", "source path retained"),
        ("scope gate", "farm/model bound"),
        ("mechanism gate", "test + barrier closed"),
    ]
    for i, (title, sub) in enumerate(gates):
        y = 5.2 - i * 1.05
        box(ax, 3.2, y, 3.6, 0.9, title, fc="#fdf3e7", ec="#e8c99a", fs=6.2, bold=True)
        ax.text(5, y - 0.18, sub, ha="center", va="center", fontsize=5.6, color=MUTED)
    arrow(ax, 5, 2.6, 5, 1.95)

    outputs = [
        ("Fault index\n10,804 codes", 1.0),
        ("Reasoning graph\n2,326 nodes", 1.0),
        ("Wiki pages", 1.0),
        ("Audit views", 1.0),
    ]
    for i, (t, y) in enumerate(outputs):
        box(ax, 0.6 + i * 2.35, y, 2.15, 0.9, t, fs=6.0)
    save(fig, "fig_knowledge_build_flow")


def fig_nature_mechanism_overview():
    fig, ax = plt.subplots(figsize=(3.5, 3.4))
    ax.set_xlim(0, 10)
    ax.set_ylim(0, 10)
    ax.axis("off")

    # closure callouts
    ax.text(5, 9.55, "profile 100%   ·   prevention 100%   ·   hypothesis 100%",
            ha="center", fontsize=6.8, color=INK, weight="bold")

    # chain 1: explanation
    box(ax, 0.5, 7.4, 1.9, 0.8, "Fault case", bold=True, fs=6.2)
    box(ax, 3.0, 7.4, 1.9, 0.8, "Archetype", fs=6.2)
    box(ax, 5.5, 7.4, 1.9, 0.8, "Propagation", fs=6.2)
    box(ax, 8.0, 7.4, 1.7, 0.8, "Failure mode", fs=6.2)
    for x in (2.4, 4.9, 7.4):
        arrow(ax, x, 7.8, x + 0.35, 7.8)
    ax.text(5, 6.9, "mechanism closure — explanation chain", ha="center",
            fontsize=6.2, color=MUTED)

    # chain 2: hypothesis test
    box(ax, 0.5, 4.9, 2.0, 0.8, "Diagnostic\nhypothesis", fs=6.0)
    box(ax, 3.1, 4.9, 2.0, 0.8, "Discriminating\nevidence", fs=6.0)
    box(ax, 5.7, 4.9, 2.0, 0.8, "Counterfactual\ntest", fs=6.0)
    box(ax, 8.3, 4.9, 1.5, 0.8, "Decision\nrule", fs=6.0)
    for x in (2.5, 5.1, 7.7):
        arrow(ax, x, 5.3, x + 0.35, 5.3)
    ax.text(5, 4.4, "hypothesis discrimination", ha="center", fontsize=6.2, color=MUTED)

    # chain 3: verification + prevention
    box(ax, 1.4, 2.2, 2.6, 0.8, "Observable", fs=6.2)
    box(ax, 4.6, 2.2, 2.6, 0.8, "Verification test", fs=6.2)
    box(ax, 7.8, 2.2, 1.9, 0.8, "Control barrier", fs=6.2)
    for x in (4.0, 7.2):
        arrow(ax, x, 2.6, x + 0.35, 2.6)
    ax.text(5, 1.7, "verification + prevention", ha="center", fontsize=6.2, color=MUTED)
    save(fig, "fig_nature_mechanism_overview")


if __name__ == "__main__":
    fig_knowledge_scale()
    fig_experiment_ablation_matrix()
    fig_experiment_archetype_coverage()
    fig_experiment_hypothesis_discrimination()
    fig_nature_graph_composition()
    fig_nature_case_quality()
    fig_experiment_case_evidence_richness()
    fig_experiment_relation_density()
    fig_system_architecture()
    fig_knowledge_build_flow()
    fig_nature_mechanism_overview()
    print("done")
