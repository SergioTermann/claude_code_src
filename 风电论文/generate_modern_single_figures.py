#!/usr/bin/env python3
from __future__ import annotations

import json
import textwrap
from collections import Counter
from math import cos, pi, sin
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.collections import LineCollection
from matplotlib.patches import Circle, FancyArrowPatch, PathPatch, Polygon, Rectangle, Wedge
from matplotlib.path import Path as MplPath


ROOT = Path(__file__).resolve().parents[1]
FIG_DIR = Path(__file__).resolve().parent / "figures"
EVAL_PATH = ROOT / "generated-knowledge" / "windrise-mechanism-graph-evaluation.json"
GRAPH_PATH = ROOT / "generated-knowledge" / "windrise-reasoning-graph.json"

COL = {
    "ink": "#272727",
    "muted": "#767676",
    "grid": "#E6E6E6",
    "blue": "#0F4D92",
    "blue2": "#3775BA",
    "teal": "#42949E",
    "green": "#2E9E44",
    "gold": "#C89B2C",
    "red": "#B64342",
    "violet": "#7C6CCF",
    "lav": "#E7E3F7",
    "aqua": "#E0F0F0",
    "paper": "#FFFFFF",
    "pale": "#F7F8FA",
}

FONT_SCALE = 1.38


def fs(value):
    return value * FONT_SCALE


plt.rcParams["font.family"] = "sans-serif"
plt.rcParams["font.sans-serif"] = ["Arial", "DejaVu Sans", "Liberation Sans"]
plt.rcParams["svg.fonttype"] = "none"
plt.rcParams["pdf.fonttype"] = 42
plt.rcParams["font.size"] = fs(7)
plt.rcParams["axes.spines.right"] = False
plt.rcParams["axes.spines.top"] = False
plt.rcParams["axes.linewidth"] = 0.75
plt.rcParams["legend.frameon"] = False

def load_eval():
    return json.loads(EVAL_PATH.read_text(encoding="utf-8"))


def load_graph():
    return json.loads(GRAPH_PATH.read_text(encoding="utf-8"))


def save(fig, name):
    FIG_DIR.mkdir(exist_ok=True)
    fig.savefig(FIG_DIR / f"{name}.pdf", bbox_inches="tight", pad_inches=0.02)
    plt.close(fig)


def blank(size=(7.2, 4.6)):
    fig, ax = plt.subplots(figsize=size)
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.set_axis_off()
    return fig, ax


def title(ax, text):
    return None


def arrow(ax, a, b, color=COL["muted"], lw=1.1, rad=0.0, alpha=1.0):
    ax.add_patch(
        FancyArrowPatch(
            a,
            b,
            transform=ax.transAxes,
            arrowstyle="-|>",
            mutation_scale=8,
            linewidth=lw,
            color=color,
            alpha=alpha,
            connectionstyle=f"arc3,rad={rad}",
            shrinkA=2,
            shrinkB=2,
        )
    )


def text(ax, x, y, s, fs=6, color=COL["ink"], ha="center", weight="normal", rotation=0):
    ax.text(x, y, s, transform=ax.transAxes, ha=ha, va="center", fontsize=fs * FONT_SCALE, color=color, fontweight=weight, rotation=rotation)


def bezier_band(ax, p0, p1, p2, p3, color, lw=10, alpha=0.28):
    path = MplPath([p0, p1, p2, p3], [MplPath.MOVETO, MplPath.CURVE4, MplPath.CURVE4, MplPath.CURVE4])
    patch = PathPatch(path, transform=ax.transAxes, lw=lw, edgecolor=color, facecolor="none", alpha=alpha, capstyle="round")
    ax.add_patch(patch)


def node(ax, xy, label, color, r=0.034, fs=5.8, fc="white"):
    ax.add_patch(Circle(xy, r, transform=ax.transAxes, facecolor=fc, edgecolor=color, lw=1.1))
    text(ax, xy[0], xy[1] - r - 0.030, label, fs=fs, color=COL["ink"])


def wrapped_label(label, width=13):
    return "\n".join(textwrap.wrap(label, width=width, break_long_words=False))


ARCHETYPE_LABELS = {
    "archetype:signal_integrity_feedback": "Sensing-acquisition-control feedback",
    "archetype:hydraulic_flow_restriction": "Hydraulic energy and flow restriction",
    "archetype:electrical_thermal_stress": "Electrical thermal and insulation stress",
    "archetype:mechanical_contact_wear": "Load-lubrication contact fatigue",
    "archetype:protection_logic_sequence": "Protection-chain boundary judgement",
    "archetype:communication_network_loss": "Communication timing and data consistency",
}


def draw_system_architecture():
    fig, ax = blank((7.2, 4.7))
    title(ax, "Wind-turbine troubleshooting architecture built around a local evidence bus")

    lanes = [
        ("asset layer", 0.72, COL["ink"], "#F7F8FA"),
        ("evidence layer", 0.50, COL["teal"], "#F2FAFA"),
        ("strategy layer", 0.28, COL["gold"], "#FBF8EF"),
    ]
    for lab, y, color, face in lanes:
        ax.add_patch(Rectangle((0.060, y - 0.075), 0.760, 0.150, transform=ax.transAxes, facecolor=face, edgecolor=COL["grid"], lw=0.8))
        text(ax, 0.025, y, lab, fs=5.8, color=color, ha="left", weight="bold", rotation=90)

    ax.add_patch(Rectangle((0.145, 0.465), 0.565, 0.070, transform=ax.transAxes, facecolor=COL["blue"], edgecolor="white", lw=1.0, alpha=0.90))
    text(ax, 0.427, 0.514, "local evidence bus", fs=5.5, color="white", weight="bold")
    text(ax, 0.427, 0.486, "source path | model scope | mechanism path | state", fs=4.7, color="white", weight="bold")

    asset_blocks = [
        ("manuals", "procedures", 0.145),
        ("fault-code\ntables", "alarm scope", 0.310),
        ("case reports", "field evidence", 0.475),
        ("Q&A traces", "session state", 0.640),
    ]
    for lab, detail, x in asset_blocks:
        ax.add_patch(Rectangle((x - 0.060, 0.690), 0.120, 0.064, transform=ax.transAxes, facecolor=COL["ink"], edgecolor="white", lw=0.8, alpha=0.88))
        text(ax, x, 0.733, lab, fs=4.6, color="white", weight="bold")
        text(ax, x, 0.705, detail, fs=4.2, color="white")
        arrow(ax, (x, 0.690), (x, 0.535), color=COL["muted"], lw=0.7)

    evidence_blocks = [
        ("index", "4,849", 0.200, COL["blue2"]),
        ("KG", "79,474", 0.365, COL["teal"]),
        ("mechanism", "1,521", 0.530, COL["violet"]),
        ("packet", "facts", 0.695, COL["gold"]),
    ]
    for lab, detail, x, color in evidence_blocks:
        ax.add_patch(Rectangle((x - 0.062, 0.374), 0.124, 0.062, transform=ax.transAxes, facecolor=color, edgecolor="white", lw=0.8, alpha=0.92))
        text(ax, x, 0.411, lab, fs=4.6, color="white", weight="bold")
        text(ax, x, 0.388, detail, fs=4.0, color="white")
        arrow(ax, (x, 0.465), (x, 0.452), color=color, lw=0.7)

    strategy_blocks = [
        ("intent\nrouting", 0.200, COL["ink"]),
        ("hybrid\nretrieval", 0.365, COL["teal"]),
        ("strategy\nchain", 0.530, COL["gold"]),
        ("guarded\ngeneration", 0.695, COL["red"]),
    ]
    for lab, x, color in strategy_blocks:
        ax.add_patch(Rectangle((x - 0.055, 0.245), 0.110, 0.070, transform=ax.transAxes, facecolor=color, edgecolor="white", lw=0.8, alpha=0.90))
        text(ax, x, 0.280, lab, fs=5.1, color="white", weight="bold")
        arrow(ax, (x, 0.465), (x, 0.315), color=COL["muted"], lw=0.7)
    for a, b in zip([0.200, 0.365, 0.530], [0.365, 0.530, 0.695]):
        arrow(ax, (a + 0.057, 0.280), (b - 0.057, 0.280), color=COL["muted"], lw=0.75)

    outputs = [
        ("scoped\nanswer", 0.70, COL["green"]),
        ("source\ntrace", 0.50, COL["violet"]),
        ("next field\naction", 0.30, COL["red"]),
    ]
    for lab, y, color in outputs:
        ax.add_patch(Rectangle((0.855, y - 0.040), 0.110, 0.080, transform=ax.transAxes, facecolor=color, edgecolor="white", lw=0.9, alpha=0.92))
        text(ax, 0.910, y, lab, fs=4.5, color="white", weight="bold")
        arrow(ax, (0.710, 0.500), (0.855, y), color=color, lw=0.8, rad=0.08)

    ax.plot([0.835, 0.835], [0.18, 0.82], transform=ax.transAxes, color=COL["blue"], lw=0.9, ls="--", alpha=0.75)
    text(ax, 0.835, 0.145, "generation boundary", fs=5.4, color=COL["blue"], weight="bold")
    save(fig, "fig_system_architecture")


def draw_knowledge_build_flow():
    fig, ax = blank((7.2, 4.6))
    title(ax, "Knowledge construction converts local O&M records into auditable graph assets")

    stages = [
        ("ingest", "11,865\nrecords", COL["ink"]),
        ("parse", "tables +\ntext spans", COL["blue"]),
        ("normalize", "models,\ncodes,\naliases", COL["teal"]),
        ("link", "79,474\nrelations", COL["gold"]),
        ("enrich", "mechanism\nclosure", COL["violet"]),
    ]
    xs = np.linspace(0.14, 0.86, len(stages))
    y = 0.50
    w, h = 0.112, 0.150
    for i, (lab, value, color) in enumerate(stages):
        x = xs[i]
        ax.add_patch(Rectangle((x - w / 2, y - h / 2), w, h, transform=ax.transAxes, facecolor=color, edgecolor="white", lw=1.0, alpha=0.92))
        text(ax, x, y + 0.028, lab, fs=6.4, color="white", weight="bold")
        text(ax, x, y - 0.034, value, fs=5.5, color="white")
        if i < len(stages) - 1:
            bezier_band(ax, (x + w / 2, y), (x + 0.055, y + 0.020), (xs[i + 1] - 0.055, y - 0.020), (xs[i + 1] - w / 2, y), COL["grid"], lw=9, alpha=0.70)
            arrow(ax, (x + w / 2 + 0.012, y), (xs[i + 1] - w / 2 - 0.012, y), color=COL["muted"], lw=0.9)

    sources = [("manuals", 0.10), ("fault-code\ntables", 0.19), ("case\nreports", 0.28)]
    for lab, x in sources:
        ax.add_patch(Rectangle((x - 0.038, 0.78), 0.076, 0.060, transform=ax.transAxes, facecolor=COL["pale"], edgecolor=COL["ink"], lw=0.8))
        text(ax, x, 0.810, lab, fs=4.5, color=COL["ink"])
        bezier_band(ax, (x, 0.78), (0.18, 0.70), (0.12, 0.62), (xs[0] - w / 2, y + 0.035), COL["blue"], lw=2.4, alpha=0.22)

    gates = [
        ("provenance gate", "source path retained", 0.28, COL["ink"]),
        ("scope gate", "farm/model bound", 0.50, COL["blue"]),
        ("mechanism gate", "test + barrier closed", 0.72, COL["teal"]),
    ]
    for lab, detail, x, color in gates:
        ax.add_patch(Rectangle((x - 0.090, 0.230), 0.180, 0.052, transform=ax.transAxes, facecolor="white", edgecolor=color, lw=1.0))
        text(ax, x, 0.261, lab, fs=5.6, color=color, weight="bold")
        arrow(ax, (x, 0.305), (x, 0.425), color=color, lw=0.8)

    outputs = [
        ("fault\nindex", "4,849 codes", 0.45, COL["blue"]),
        ("reasoning\ngraph", "2,326 nodes", 0.60, COL["teal"]),
        ("wiki\npages", "tech view", 0.75, COL["gold"]),
        ("HTML\ngraph", "offline audit", 0.90, COL["violet"]),
    ]
    for lab, value, x, color in outputs:
        ax.add_patch(Rectangle((x - 0.055, 0.765), 0.110, 0.078, transform=ax.transAxes, facecolor=color, edgecolor="white", lw=0.9, alpha=0.90))
        text(ax, x, 0.817, lab, fs=4.4, color="white", weight="bold")
        text(ax, x, 0.784, value, fs=4.0, color="white")
        bezier_band(ax, (xs[-1] + w / 2, y + 0.025), (0.82, 0.57), (x, 0.68), (x, 0.765), color, lw=2.2, alpha=0.24)

    ax.plot([0.10, 0.90], [0.105, 0.105], transform=ax.transAxes, color=COL["grid"], lw=0.8)
    save(fig, "fig_knowledge_build_flow")


def draw_domain_relationship():
    fig, ax = blank((7.2, 4.8))
    title(ax, "Fault-code semantics are resolved through a constraint lens")

    lens_x = 0.50
    ax.add_patch(Wedge((lens_x, 0.50), 0.42, 78, 282, width=0.080, transform=ax.transAxes, facecolor=COL["blue"], edgecolor=COL["blue"], alpha=0.10, lw=1.0))
    ax.add_patch(Wedge((lens_x, 0.50), 0.30, -78, 78, width=0.075, transform=ax.transAxes, facecolor=COL["gold"], edgecolor=COL["gold"], alpha=0.14, lw=1.0))
    ax.add_patch(Rectangle((0.485, 0.18), 0.030, 0.64, transform=ax.transAxes, facecolor=COL["ink"], edgecolor="none", alpha=0.90))
    text(ax, lens_x, 0.86, "semantic\nlens", fs=6.0, color=COL["ink"], weight="bold")

    left_items = [
        ("farm", 0.17, 0.74, COL["blue"]),
        ("model", 0.12, 0.58, COL["blue"]),
        ("brand", 0.17, 0.42, COL["blue"]),
        ("system", 0.12, 0.26, COL["teal"]),
    ]
    for lab, x, y, color in left_items:
        ax.add_patch(Circle((x, y), 0.032, transform=ax.transAxes, facecolor="white", edgecolor=color, lw=1.2))
        text(ax, x, y, lab, fs=5.5, color=COL["ink"], weight="bold")
        bezier_band(ax, (x + 0.035, y), (0.28, y + 0.04), (0.38, 0.50), (0.485, 0.50), color, lw=2.2, alpha=0.28)

    ambiguous = [(0.32, 0.63), (0.35, 0.55), (0.30, 0.47), (0.36, 0.39)]
    for i, xy in enumerate(ambiguous):
        ax.add_patch(Circle(xy, 0.024, transform=ax.transAxes, facecolor=COL["pale"], edgecolor=COL["red"], lw=0.9))
        text(ax, xy[0], xy[1], f"C{i+1}", fs=5.0, color=COL["red"], weight="bold")
    text(ax, 0.31, 0.72, "same code,\nseveral scopes", fs=5.8, color=COL["red"], weight="bold")

    ax.add_patch(Circle((0.50, 0.50), 0.070, transform=ax.transAxes, facecolor=COL["gold"], edgecolor="white", lw=1.1, zorder=5))
    text(ax, 0.50, 0.523, "fault", fs=8.0, color="white", weight="bold")
    text(ax, 0.50, 0.475, "code", fs=8.0, color="white", weight="bold")

    outputs = [
        ("mechanism\npath", 0.82, 0.72, COL["red"]),
        ("component\ncontext", 0.88, 0.56, COL["teal"]),
        ("field\naction", 0.82, 0.40, COL["green"]),
        ("source\ntrace", 0.88, 0.24, COL["violet"]),
    ]
    for lab, x, y, color in outputs:
        bezier_band(ax, (0.515, 0.50), (0.62, 0.50), (0.70, y), (x - 0.035, y), color, lw=2.6, alpha=0.34)
        ax.add_patch(Circle((x, y), 0.035, transform=ax.transAxes, facecolor="white", edgecolor=color, lw=1.3))
        text(ax, x, y - 0.070, lab, fs=5.4, color=COL["ink"])

    ax.plot([0.08, 0.92], [0.105, 0.105], transform=ax.transAxes, color=COL["grid"], lw=0.8)
    text(ax, 0.19, 0.070, "scope constraints", fs=5.8, color=COL["blue"], weight="bold")
    text(ax, 0.50, 0.070, "ambiguity compression", fs=5.8, color=COL["gold"], weight="bold")
    text(ax, 0.80, 0.070, "auditable answer", fs=5.8, color=COL["green"], weight="bold")
    save(fig, "fig_domain_relationship")


def draw_troubleshooting_loop():
    fig, ax = blank((7.2, 4.8))
    title(ax, "One troubleshooting turn is executed as a field-verification protocol")

    ax.add_patch(Rectangle((0.065, 0.245), 0.195, 0.510, transform=ax.transAxes, facecolor=COL["pale"], edgecolor=COL["grid"], lw=0.9))
    text(ax, 0.162, 0.785, "technician input", fs=6.2, color=COL["ink"], weight="bold")
    inputs = [("alarm code", "303xxx / pressure fault", 0.665), ("scope hint", "farm + turbine model", 0.525), ("short reply", "normal / abnormal", 0.385)]
    for lab, detail, y in inputs:
        ax.add_patch(Rectangle((0.095, y - 0.040), 0.135, 0.080, transform=ax.transAxes, facecolor=COL["ink"], edgecolor="white", lw=0.8, alpha=0.88))
        text(ax, 0.162, y + 0.014, lab, fs=5.4, color="white", weight="bold")
        text(ax, 0.162, y - 0.020, detail, fs=4.4, color="white")

    # Central protocol core.
    ax.add_patch(Rectangle((0.340, 0.560), 0.260, 0.115, transform=ax.transAxes, facecolor=COL["teal"], edgecolor="white", lw=1.0, alpha=0.92))
    text(ax, 0.470, 0.635, "evidence packet", fs=7.0, color="white", weight="bold")
    text(ax, 0.470, 0.594, "fault entry | mechanism | source", fs=5.0, color="white")
    ax.add_patch(Rectangle((0.340, 0.355), 0.260, 0.115, transform=ax.transAxes, facecolor=COL["blue"], edgecolor="white", lw=1.0, alpha=0.92))
    text(ax, 0.470, 0.430, "retained state", fs=7.0, color="white", weight="bold")
    text(ax, 0.470, 0.389, "scope | last action | branch result", fs=5.0, color="white")
    ax.add_patch(Rectangle((0.395, 0.485), 0.150, 0.055, transform=ax.transAxes, facecolor=COL["gold"], edgecolor="white", lw=0.9, alpha=0.96))
    text(ax, 0.470, 0.513, "turn contract", fs=6.2, color="white", weight="bold")
    for y in [0.665, 0.525, 0.385]:
        arrow(ax, (0.230, y), (0.340, 0.615 if y > 0.55 else 0.413), color=COL["muted"], lw=0.8, rad=0.06)
    arrow(ax, (0.470, 0.560), (0.470, 0.540), color=COL["gold"], lw=0.8)
    arrow(ax, (0.470, 0.470), (0.470, 0.485), color=COL["gold"], lw=0.8)

    ax.add_patch(Rectangle((0.665, 0.535), 0.160, 0.120, transform=ax.transAxes, facecolor=COL["gold"], edgecolor="white", lw=1.0, alpha=0.92))
    text(ax, 0.745, 0.615, "one field action", fs=6.4, color="white", weight="bold")
    text(ax, 0.745, 0.575, "measure pressure\nor inspect sensor", fs=4.8, color="white")
    arrow(ax, (0.545, 0.513), (0.665, 0.595), color=COL["gold"], lw=0.9, rad=0.08)

    ax.add_patch(Rectangle((0.665, 0.330), 0.160, 0.100, transform=ax.transAxes, facecolor=COL["red"], edgecolor="white", lw=1.0, alpha=0.90))
    text(ax, 0.745, 0.396, "observed result", fs=6.0, color="white", weight="bold")
    text(ax, 0.745, 0.360, "criterion checked", fs=4.8, color="white")
    arrow(ax, (0.745, 0.535), (0.745, 0.430), color=COL["muted"], lw=0.8)

    branches = [("pass", "close cause", 0.720, COL["green"]), ("fail", "switch branch", 0.520, COL["violet"])]
    for lab, detail, y, color in branches:
        ax.add_patch(Rectangle((0.865, y - 0.045), 0.095, 0.090, transform=ax.transAxes, facecolor=color, edgecolor="white", lw=0.9, alpha=0.92))
        text(ax, 0.912, y + 0.015, lab, fs=6.0, color="white", weight="bold")
        text(ax, 0.912, y - 0.022, detail, fs=4.5, color="white")
        arrow(ax, (0.825, 0.380), (0.865, y), color=color, lw=0.8, rad=0.18 if y > 0.60 else -0.18)

    ax.add_patch(Rectangle((0.340, 0.170), 0.485, 0.055, transform=ax.transAxes, facecolor="white", edgecolor=COL["gold"], lw=1.0))
    text(ax, 0.582, 0.198, "acceptance criterion example: pressure recovers to 150 bar within 15 s", fs=5.7, color=COL["ink"], weight="bold")
    ax.plot([0.08, 0.92], [0.090, 0.090], transform=ax.transAxes, color=COL["grid"], lw=0.8)
    save(fig, "fig_troubleshooting_loop")


def draw_knowledge_scale():
    vals = np.array([11865, 22680, 79474, 4849, 8295, 66, 29, 18, 12])
    labels = ["records", "nodes", "relations", "codes", "sources", "models", "farms", "systems", "templates"]
    colors = [COL["teal"], COL["blue"], COL["blue"], COL["gold"], COL["teal"], COL["muted"], COL["muted"], COL["muted"], COL["violet"]]
    fig, ax = plt.subplots(figsize=(7.2, 3.8))
    x = np.arange(len(vals))
    bars = ax.bar(x, vals, color=colors, edgecolor="white", width=0.72)
    ax.set_yscale("log")
    ax.set_ylabel("Count (log scale)")
    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    ax.grid(axis="y", which="both", color=COL["grid"], lw=0.7)
    for r, val in zip(bars, vals):
        ax.text(r.get_x() + r.get_width() / 2, val * 1.2, f"{val:,}", ha="center", va="bottom", fontsize=fs(6))
    save(fig, "fig_knowledge_scale")


def draw_mechanism_overview():
    data = load_eval()
    base = data["baseline"]
    mech = data["mechanism"]
    fig, ax = blank((7.2, 4.8))
    title(ax, "Mechanism enrichment turns each fault case into an auditable diagnostic closure")

    chain = [
        ("fault\ncase", COL["ink"]),
        ("archetype", COL["blue"]),
        ("layer", COL["blue2"]),
        ("propagation", COL["teal"]),
        ("failure\nmode", COL["red"]),
        ("observable", COL["gold"]),
        ("test", COL["green"]),
        ("barrier", COL["violet"]),
    ]
    xs = np.linspace(0.08, 0.92, len(chain))
    y = 0.62
    for i in range(len(chain) - 1):
        bezier_band(ax, (xs[i] + 0.030, y), (xs[i] + 0.060, y + 0.010), (xs[i + 1] - 0.060, y - 0.010), (xs[i + 1] - 0.030, y), chain[i + 1][1], lw=5.5, alpha=0.20)
        arrow(ax, (xs[i] + 0.038, y), (xs[i + 1] - 0.038, y), color=COL["muted"], lw=0.7)
    for x, (lab, color) in zip(xs, chain):
        ax.add_patch(Rectangle((x - 0.047, y - 0.060), 0.094, 0.120, transform=ax.transAxes, facecolor=color, edgecolor="white", lw=0.9, alpha=0.92))
        text(ax, x, y, lab, fs=4.8, color="white", weight="bold")

    hyp_y = 0.335
    branch = [
        ("diagnostic\nhypothesis", 0.32, COL["violet"]),
        ("discriminating\nevidence", 0.49, COL["blue"]),
        ("counterfactual\ntest", 0.66, COL["gold"]),
        ("decision\nrule", 0.83, COL["green"]),
    ]
    arrow(ax, (xs[1], y - 0.065), (branch[0][1], hyp_y + 0.055), color=COL["violet"], lw=0.9, rad=-0.20)
    for i, (lab, x, color) in enumerate(branch):
        ax.add_patch(Rectangle((x - 0.055, hyp_y - 0.047), 0.110, 0.094, transform=ax.transAxes, facecolor=color, edgecolor="white", lw=0.9, alpha=0.90))
        text(ax, x, hyp_y, lab, fs=4.5, color="white", weight="bold")
        if i < len(branch) - 1:
            arrow(ax, (x + 0.058, hyp_y), (branch[i + 1][1] - 0.058, hyp_y), color=COL["muted"], lw=0.8)

    metrics = [
        ("profile\ncomplete", base["complete_profile_rate"], mech["profile_complete_rate"]),
        ("prevention\nclosure", 0, mech["prevention_closure_rate"]),
        ("hypothesis\ndiscrimination", 0, mech["discrimination_coverage_rate"]),
    ]
    for i, (lab, before, after) in enumerate(metrics):
        x = 0.25 + i * 0.25
        ax.add_patch(Rectangle((x - 0.070, 0.825), 0.140, 0.028, transform=ax.transAxes, facecolor=COL["grid"], edgecolor="none"))
        ax.add_patch(Rectangle((x - 0.070, 0.825), 0.140 * after, 0.028, transform=ax.transAxes, facecolor=COL["blue"], edgecolor="none", alpha=0.88))
        ax.plot([x - 0.070 + 0.140 * before, x - 0.070 + 0.140 * before], [0.817, 0.861], transform=ax.transAxes, color=COL["red"], lw=1.0)
        text(ax, x, 0.890, lab, fs=5.4, color=COL["ink"], weight="bold")
        text(ax, x, 0.785, f"{after*100:.0f}%", fs=6.0, color=COL["blue"], weight="bold")

    ax.plot([0.08, 0.92], [0.155, 0.155], transform=ax.transAxes, color=COL["grid"], lw=0.8)
    save(fig, "fig_nature_mechanism_overview")


def draw_graph_composition():
    data = load_eval()
    nt = data["mechanism"]["node_types"]
    fig, ax = blank((7.2, 4.8))
    title(ax, "Mechanism graph nodes split into explanation, verification and discrimination functions")

    total = data["mechanism"]["node_count"]
    source = (0.12, 0.51)
    ax.add_patch(Rectangle((source[0] - 0.070, source[1] - 0.105), 0.140, 0.210, transform=ax.transAxes, facecolor=COL["ink"], edgecolor="white", lw=1.0))
    text(ax, source[0], source[1] + 0.038, f"{total:,}", fs=12.0, color="white", weight="bold")
    text(ax, source[0], source[1] - 0.036, "mechanism\nnodes", fs=5.8, color="white")

    families = [
        ("explanation\nchain", 0.72, COL["blue"], [
            ("archetype", nt["mechanism_archetype"]),
            ("layer", nt["mechanism_layer"]),
            ("propagation", nt["propagation_step"]),
            ("failure mode", nt["failure_mode"]),
            ("observable", nt["observable"]),
        ]),
        ("verification\n+ prevention", 0.50, COL["teal"], [
            ("verification test", nt["verification_test"]),
            ("control barrier", nt["control_barrier"]),
        ]),
        ("hypothesis\ndiscrimination", 0.28, COL["violet"], [
            ("hypothesis", nt["diagnostic_hypothesis"]),
            ("evidence", nt["discriminating_evidence"]),
            ("counterfactual", nt["counterfactual_test"]),
            ("decision rule", nt["decision_rule"]),
        ]),
    ]
    max_leaf = max(v for _, _, _, items in families for _, v in items)
    for name, y, color, items in families:
        fam_total = sum(v for _, v in items)
        bezier_band(ax, (source[0] + 0.070, source[1]), (0.25, source[1]), (0.28, y), (0.34, y), color, lw=8 + 11 * fam_total / total, alpha=0.23)
        ax.add_patch(Rectangle((0.31, y - 0.058), 0.155, 0.116, transform=ax.transAxes, facecolor=color, edgecolor="white", lw=0.9, alpha=0.92))
        text(ax, 0.388, y + 0.024, name, fs=4.7, color="white", weight="bold")
        text(ax, 0.388, y - 0.032, f"{fam_total} nodes", fs=4.8, color="white")

        start_x = 0.56
        for i, (lab, val) in enumerate(items):
            yy = y + (i - (len(items) - 1) / 2) * 0.045
            width = 0.050 + 0.165 * val / max_leaf
            bezier_band(ax, (0.455, y), (0.49, y), (0.52, yy), (start_x, yy), color, lw=1.1 + 3.8 * val / max_leaf, alpha=0.25)
            ax.add_patch(Rectangle((start_x, yy - 0.014), width, 0.028, transform=ax.transAxes, facecolor=color, edgecolor="white", lw=0.5, alpha=0.86))
            text(ax, start_x + width + 0.015, yy, f"{lab}  {val}", fs=5.2, color=COL["ink"], ha="left")

    ax.plot([0.08, 0.92], [0.095, 0.095], transform=ax.transAxes, color=COL["grid"], lw=0.8)
    save(fig, "fig_nature_graph_composition")


def draw_case_quality():
    data = load_eval()
    cases = data["case_metrics"]
    mech_terms = np.array([c["mechanism_term_count"] for c in cases])
    failure_terms = np.array([c["failure_mode_term_count"] for c in cases])
    verification_terms = np.array([c["verification_term_count"] for c in cases])
    total_terms = mech_terms + failure_terms + verification_terms
    pairwise = np.array([c["discriminator_types"][0] == "pairwise_archetype_competition" for c in cases])
    order = np.argsort(total_terms)
    mech_terms, failure_terms, verification_terms = mech_terms[order], failure_terms[order], verification_terms[order]
    total_terms, pairwise = total_terms[order], pairwise[order]

    fig, ax = plt.subplots(figsize=(7.2, 4.4))
    x = np.arange(len(cases))
    ax.bar(x, mech_terms, color=COL["blue"], width=0.82, edgecolor="white", linewidth=0.35, label="mechanism terms")
    ax.bar(x, failure_terms, bottom=mech_terms, color=COL["red"], width=0.82, edgecolor="white", linewidth=0.35, label="failure-mode terms")
    ax.bar(x, verification_terms, bottom=mech_terms + failure_terms, color=COL["teal"], width=0.82, edgecolor="white", linewidth=0.35, label="verification terms")
    for xi, is_pair, total in zip(x, pairwise, total_terms):
        ax.add_patch(Rectangle((xi - 0.41, total + 0.70), 0.82, 1.05, facecolor=COL["gold"] if not is_pair else COL["violet"], edgecolor="none", alpha=0.90))
    ax.axhline(np.median(total_terms), color=COL["ink"], ls="--", lw=0.9, alpha=0.65)
    ax.text(len(cases) - 0.4, np.median(total_terms) + 0.7, f"median {np.median(total_terms):.0f}", ha="right", va="bottom", fontsize=fs(5.8), color=COL["ink"])
    ax.set_xlim(-0.7, len(cases) - 0.3)
    ax.set_ylim(0, total_terms.max() + 6)
    ax.set_xlabel("Fault cases ranked by total evidence terms")
    ax.set_ylabel("Evidence terms")
    ax.set_xticks([0, 8, 16, 24, 32])
    ax.set_xticklabels(["1", "9", "17", "25", "33"], fontsize=fs(6))
    ax.grid(axis="y", color=COL["grid"], lw=0.7)
    ax.legend(loc="upper left", fontsize=fs(6))
    save(fig, "fig_nature_case_quality")


def draw_experiment_matrix():
    data = load_eval()
    metrics = [
        ("profile completeness", data["baseline"]["complete_profile_rate"], data["mechanism"]["profile_complete_rate"], "%"),
        ("validation closure", data["baseline"]["validation_closure_rate"], data["mechanism"]["validation_closure_rate"], "%"),
        ("prevention closure", data["baseline"]["prevention_closure_rate"], data["mechanism"]["prevention_closure_rate"], "%"),
        ("hypothesis discrimination", 0, data["mechanism"]["discrimination_coverage_rate"], "%"),
        ("mechanism path depth", data["baseline"]["average_explanation_depth"] / 6, data["mechanism"]["average_depth"] / 3, "depth"),
    ]
    fig, ax = plt.subplots(figsize=(7.2, 4.4))
    ax.set_xlim(-0.02, 1.18)
    ax.set_ylim(-0.7, len(metrics) - 0.3)
    ax.set_yticks(np.arange(len(metrics)))
    ax.set_yticklabels([m[0] for m in metrics], fontsize=fs(6.3))
    ax.set_xticks([0, 0.25, 0.50, 0.75, 1.00])
    ax.set_xticklabels(["0", "25", "50", "75", "100"], fontsize=fs(6))
    ax.set_xlabel("Normalized score")
    ax.invert_yaxis()
    ax.grid(axis="x", color=COL["grid"], lw=0.7)
    for spine in ax.spines.values():
        spine.set_visible(False)

    for y, (label, before, after, kind) in enumerate(metrics):
        ax.plot([before, after], [y, y], color=COL["grid"], lw=7, solid_capstyle="round", zorder=1)
        ax.plot([before, after], [y, y], color=COL["blue"], lw=2.0, solid_capstyle="round", zorder=2)
        ax.scatter([before], [y], s=72, color=COL["muted"], edgecolor="white", linewidth=0.8, zorder=3)
        ax.scatter([after], [y], s=86, color=COL["blue"], edgecolor="white", linewidth=0.8, zorder=4)
        if kind == "%":
            before_label = f"{before*100:.0f}%"
            after_label = f"{after*100:.0f}%"
            delta = f"+{(after - before)*100:.0f} pp"
        else:
            before_label = f"{data['baseline']['average_explanation_depth']:.1f}"
            after_label = f"{data['mechanism']['average_depth']:.1f}"
            delta = "normalized"
        ax.text(after + 0.025, y + 0.18, after_label, ha="left", va="center", fontsize=fs(5.8), color=COL["blue"], fontweight="bold")
        ax.text(1.04, y, delta, ha="left", va="center", fontsize=fs(5.8), color=COL["green"] if after > before else COL["muted"], fontweight="bold")

    ax.text(0.72, -0.46, "mechanism graph", fontsize=fs(5.8), color=COL["blue"], fontweight="bold")
    save(fig, "fig_experiment_ablation_matrix")


def draw_relation_density():
    data = load_eval()
    rel = data["mechanism"]["relation_types"]
    selected = ["MECHANISM_PROPAGATES_TO", "HAS_MECHANISM_LAYER", "MECHANISM_RESULTS_IN", "HAS_OBSERVABLE", "VALIDATES_ARCHETYPE", "HAS_FAILURE_MODE", "VERIFIED_BY_TEST", "CONTROLLED_BY_BARRIER", "REQUIRES_DISCRIMINATING_EVIDENCE", "RESOLVED_BY_COUNTERFACTUAL_TEST", "HAS_DECISION_RULE", "HAS_COMPETING_HYPOTHESIS"]
    vals = np.array([rel[k] for k in selected])
    labels = [k.replace("_", "\n").title() for k in selected]
    fig, ax = plt.subplots(figsize=(7.2, 4.4), subplot_kw={"projection": "polar"})
    theta = np.linspace(0, 2 * pi, len(vals), endpoint=False)
    width = 2 * pi / len(vals) * 0.82
    colors = plt.cm.PuBuGn((vals - vals.min()) / (vals.max() - vals.min() + 1e-9) * 0.65 + 0.25)
    ax.bar(theta, vals, width=width, bottom=0, color=colors, edgecolor="white", linewidth=0.8)
    ax.set_xticks(theta)
    ax.set_xticklabels(labels, fontsize=fs(5.1))
    ax.set_yticks([100, 200, 300])
    ax.set_yticklabels(["100", "200", "300"], fontsize=fs(5.5), color=COL["muted"])
    ax.grid(color=COL["grid"], lw=0.6)
    ax.spines["polar"].set_visible(False)
    save(fig, "fig_experiment_relation_density")


def draw_archetype_coverage():
    graph = load_graph()
    data = load_eval()
    case_mode = {c["case_id"]: c["discriminator_types"][0] for c in data["case_metrics"]}
    archetype_cases = {}
    for edge in graph["edges"]:
        if edge.get("type") == "EXPLAINED_BY_ARCHETYPE":
            archetype_cases.setdefault(edge["target"], []).append(edge["source"])
    rows = sorted(archetype_cases.items(), key=lambda kv: len(kv[1]), reverse=True)

    fig, ax = blank((7.2, 4.8))
    title(ax, "Mechanism archetype coverage as case-to-mechanism explanation tiles")

    x0, y0 = 0.33, 0.76
    dx, dy = 0.034, 0.105
    hex_r = 0.014
    pair_col, single_col = COL["blue"], COL["gold"]
    for row, (arch_id, cases) in enumerate(rows):
        y = y0 - row * dy
        label = ARCHETYPE_LABELS.get(arch_id, arch_id.replace("archetype:", "").replace("_", " "))
        text(ax, 0.045, y, wrapped_label(label, 25), fs=5.3, color=COL["ink"], ha="left", weight="bold")
        ax.plot([0.28, 0.90], [y, y], transform=ax.transAxes, color=COL["grid"], lw=0.5, zorder=0)
        for col, case_id in enumerate(cases):
            x = x0 + col * dx
            mode = case_mode.get(case_id, "pairwise_archetype_competition")
            color = pair_col if mode == "pairwise_archetype_competition" else single_col
            angles = np.linspace(0, 2 * pi, 7)[:-1] + pi / 6
            pts = [(x + hex_r * cos(a), y + hex_r * sin(a)) for a in angles]
            ax.add_patch(Polygon(pts, transform=ax.transAxes, closed=True, facecolor=color, edgecolor="white", lw=0.45, alpha=0.92))
        text(ax, 0.93, y, f"{len(cases)}", fs=6.0, color=COL["ink"], ha="center", weight="bold")

    ax.add_patch(Polygon([(0.58 + hex_r * cos(a), 0.885 + hex_r * sin(a)) for a in np.linspace(0, 2 * pi, 7)[:-1] + pi / 6], transform=ax.transAxes, closed=True, facecolor=pair_col, edgecolor="white", lw=0.45))
    text(ax, 0.61, 0.885, "pairwise competition", fs=5.6, color=COL["ink"], ha="left")
    ax.add_patch(Polygon([(0.78 + hex_r * cos(a), 0.885 + hex_r * sin(a)) for a in np.linspace(0, 2 * pi, 7)[:-1] + pi / 6], transform=ax.transAxes, closed=True, facecolor=single_col, edgecolor="white", lw=0.45))
    text(ax, 0.81, 0.885, "single counterfactual", fs=5.6, color=COL["ink"], ha="left")
    save(fig, "fig_experiment_archetype_coverage")


def draw_hypothesis_discrimination():
    data = load_eval()
    cases = data["case_metrics"]
    counts = Counter(c["discriminator_types"][0] for c in cases)
    pair = counts["pairwise_archetype_competition"]
    single = counts["single_archetype_counterfactual"]

    fig, ax = plt.subplots(figsize=(7.2, 4.6))
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.set_xlabel("Mechanism ambiguity")
    ax.set_ylabel("Counterfactual burden")
    ax.set_xticks([0.15, 0.50, 0.85])
    ax.set_xticklabels(["low", "medium", "high"], fontsize=fs(6))
    ax.set_yticks([0.18, 0.50, 0.82])
    ax.set_yticklabels(["low", "medium", "high"], fontsize=fs(6))
    ax.grid(color=COL["grid"], lw=0.7)

    xx = np.linspace(0.05, 0.95, 240)
    yy = np.linspace(0.08, 0.92, 200)
    X, Y = np.meshgrid(xx, yy)
    pair_field = np.exp(-((X - 0.33) ** 2 / 0.018 + (Y - 0.70) ** 2 / 0.030))
    single_field = np.exp(-((X - 0.72) ** 2 / 0.028 + (Y - 0.36) ** 2 / 0.020))
    Z = pair_field - 0.92 * single_field
    ax.contourf(X, Y, pair_field, levels=np.linspace(0.12, 1.0, 9), colors=[COL["blue"]], alpha=0.045)
    ax.contourf(X, Y, single_field, levels=np.linspace(0.12, 1.0, 9), colors=[COL["gold"]], alpha=0.060)
    ax.contour(X, Y, pair_field, levels=[0.20, 0.42, 0.68], colors=COL["blue"], linewidths=[0.45, 0.60, 0.80], alpha=0.45)
    ax.contour(X, Y, single_field, levels=[0.20, 0.42, 0.68], colors=COL["gold"], linewidths=[0.45, 0.60, 0.80], alpha=0.55)
    ax.contour(X, Y, Z, levels=[0], colors=COL["ink"], linewidths=1.0, linestyles="--", alpha=0.70)

    t_pair = np.linspace(-1.05, 1.05, pair)
    pair_x = 0.33 + 0.105 * np.sin(t_pair)
    pair_y = 0.70 + 0.105 * np.cos(t_pair) - 0.018 * np.sin(2 * t_pair)
    t_single = np.linspace(-1.10, 1.10, single)
    single_x = 0.72 + 0.115 * np.sin(t_single)
    single_y = 0.36 - 0.085 * np.cos(t_single) + 0.015 * np.sin(2 * t_single)
    ax.plot(pair_x, pair_y, color=COL["blue"], lw=1.0, alpha=0.58)
    ax.plot(single_x, single_y, color=COL["gold"], lw=1.0, alpha=0.70)
    ax.scatter(pair_x, pair_y, s=36, color=COL["blue"], edgecolor="white", linewidth=0.7, zorder=4, label="pairwise competition")
    ax.scatter(single_x, single_y, s=36, color=COL["gold"], edgecolor="white", linewidth=0.7, zorder=4, label="single counterfactual")

    path = [(0.58, 0.78, "evidence", COL["violet"]), (0.70, 0.78, "test", COL["red"]), (0.82, 0.78, "rule", COL["green"])]
    for i, (x, y, lab, color) in enumerate(path):
        ax.add_patch(Circle((x, y), 0.030, transform=ax.transAxes, facecolor=color, edgecolor="white", lw=0.8, zorder=5))
        ax.text(x, y - 0.065, lab, transform=ax.transAxes, ha="center", va="center", fontsize=fs(5.5), color=COL["ink"])
        if i < len(path) - 1:
            ax.annotate("", xy=(path[i + 1][0] - 0.035, y), xytext=(x + 0.035, y), xycoords=ax.transAxes, arrowprops=dict(arrowstyle="-|>", color=COL["muted"], lw=0.8))

    ax.annotate(f"pairwise mechanism competition\n{pair} cases", xy=(0.33, 0.70), xytext=(0.12, 0.89), textcoords=ax.transAxes, fontsize=fs(6.0), color=COL["blue"], fontweight="bold", arrowprops=dict(arrowstyle="-|>", lw=0.8, color=COL["blue"]))
    ax.annotate(f"single-mechanism counterfactual\n{single} cases", xy=(0.72, 0.36), xytext=(0.52, 0.13), textcoords=ax.transAxes, fontsize=fs(6.0), color=COL["gold"], fontweight="bold", arrowprops=dict(arrowstyle="-|>", lw=0.8, color=COL["gold"]))
    ax.text(0.97, 0.05, "coverage: 33/33 cases", transform=ax.transAxes, ha="right", va="bottom", fontsize=fs(6.2), color=COL["ink"], fontweight="bold")
    ax.legend(loc="upper right", fontsize=fs(6))
    save(fig, "fig_experiment_hypothesis_discrimination")


def draw_case_evidence_richness():
    data = load_eval()
    cases = data["case_metrics"]
    mech = np.array([c["mechanism_term_count"] for c in cases])
    fail = np.array([c["failure_mode_term_count"] for c in cases])
    verify = np.array([c["verification_term_count"] for c in cases])
    richness = mech + fail + verify
    pairwise = np.array([c["discriminator_types"][0] == "pairwise_archetype_competition" for c in cases])
    order = np.argsort(richness)
    x = np.arange(len(cases))
    mech, fail, verify, richness, pairwise = mech[order], fail[order], verify[order], richness[order], pairwise[order]

    fig, ax = plt.subplots(figsize=(7.2, 4.2))
    ax.set_xlim(-0.6, len(cases) - 0.4)
    ax.set_ylim(-0.35, 3.15)
    ax.set_yticks([2.42, 1.58, 0.74])
    ax.set_yticklabels(["mechanism", "failure mode", "verification"], fontsize=fs(6.3))
    ax.set_xticks([0, 8, 16, 24, 32])
    ax.set_xticklabels(["1", "9", "17", "25", "33"], fontsize=fs(6))
    ax.set_xlabel("Fault cases ranked by total evidence terms")
    ax.spines["left"].set_visible(False)
    ax.spines["bottom"].set_color(COL["grid"])
    ax.grid(axis="x", color=COL["grid"], lw=0.5)

    strands = [
        (mech, 2.42, COL["blue"], "mechanism"),
        (fail, 1.58, COL["red"], "failure mode"),
        (verify, 0.74, COL["teal"], "verification"),
    ]
    for vals, y, color, _ in strands:
        vmax = vals.max()
        ax.plot(x, y + (vals / vmax - 0.5) * 0.30, color=color, lw=1.0, alpha=0.85)
        for xi, val in zip(x, vals):
            height = 0.12 + 0.34 * val / vmax
            ax.add_patch(Rectangle((xi - 0.36, y - height / 2), 0.72, height, facecolor=color, edgecolor="white", lw=0.35, alpha=0.84))

    # Lower annotation strip encodes hypothesis type for the same ordered cases.
    for xi, is_pair in zip(x, pairwise):
        color = COL["blue"] if is_pair else COL["gold"]
        ax.add_patch(Rectangle((xi - 0.36, 0.02), 0.72, 0.10, facecolor=color, edgecolor="none", alpha=0.88))

    median_total = np.median(richness)
    ax.axvline(np.searchsorted(richness, median_total), color=COL["ink"], lw=0.8, ls="--", alpha=0.55)
    save(fig, "fig_experiment_case_evidence_richness")


def _blank_col(height=5.0):
    return blank((4.05, height))


def _box_col(ax, x, y, w, h, label, color, fc=None, size=5.2, weight="bold"):
    ax.add_patch(Rectangle((x, y), w, h, transform=ax.transAxes, facecolor=fc or color, edgecolor="white", lw=0.8, alpha=0.92))
    text(ax, x + w / 2, y + h / 2, label, fs=size, color="white" if fc is None else COL["ink"], weight=weight)


def draw_system_architecture():
    fig, ax = _blank_col(5.4)
    lanes = [
        ("Local O&M documents", 0.82, COL["ink"], [("manuals", "procedures"), ("fault codes", "cases + Q&A")]),
        ("Evidence bus", 0.58, COL["blue"], [("index", "4,849"), ("KG", "79,474"), ("mechanism", "1,521"), ("packet", "facts")]),
        ("Strategy chain", 0.30, COL["gold"], [("intent", "routing"), ("hybrid", "retrieval"), ("mechanism", "match"), ("field", "action")]),
    ]
    for title_text, y, color, items in lanes:
        ax.add_patch(Rectangle((0.08, y - 0.11), 0.84, 0.19, transform=ax.transAxes, facecolor=COL["pale"], edgecolor=COL["grid"], lw=0.8))
        text(ax, 0.13, y + 0.055, title_text, fs=5.8, color=color, ha="left", weight="bold")
        cols = 2 if len(items) == 2 else 4
        for i, (a, b) in enumerate(items):
            x = 0.12 + i * (0.76 / cols)
            w = 0.28 if cols == 2 else 0.16
            _box_col(ax, x, y - 0.055, w, 0.070, f"{a}\n{b}", color, size=4.6)
        if title_text == "Evidence bus":
            text(ax, 0.50, y - 0.090, "source path | model scope | mechanism path | state", fs=3.8, color=COL["blue"], weight="bold")
        if title_text == "Strategy chain":
            text(ax, 0.50, y - 0.090, "guarded generation with local evidence", fs=3.8, color=COL["gold"], weight="bold")
    arrow(ax, (0.50, 0.715), (0.50, 0.665), color=COL["muted"])
    arrow(ax, (0.50, 0.475), (0.50, 0.385), color=COL["muted"])

    outputs = [("scoped\nanswer", COL["green"]), ("source\ntrace", COL["violet"]), ("next\naction", COL["red"])]
    for i, (lab, color) in enumerate(outputs):
        _box_col(ax, 0.16 + i * 0.25, 0.09, 0.18, 0.08, lab, color, size=4.5)
        arrow(ax, (0.50, 0.22), (0.25 + i * 0.25, 0.17), color=color, lw=0.8, rad=(i - 1) * 0.12)
    save(fig, "fig_system_architecture")


def draw_knowledge_build_flow():
    fig, ax = _blank_col(5.4)
    stages = [
        ("ingest", "11,865\nrecords", COL["ink"]),
        ("parse", "tables +\ntext spans", COL["blue"]),
        ("normalize", "models,\ncodes,\naliases", COL["teal"]),
        ("link", "79,474\nrelations", COL["gold"]),
        ("enrich", "mechanism\nclosure", COL["violet"]),
    ]
    y_positions = np.linspace(0.79, 0.28, len(stages))
    for i, (head, detail, color) in enumerate(stages):
        y = y_positions[i]
        _box_col(ax, 0.20, y - 0.045, 0.23, 0.09, f"{head}\n{detail}", color, size=5.0)
        if i < len(stages) - 1:
            arrow(ax, (0.315, y - 0.055), (0.315, y_positions[i + 1] + 0.055), color=COL["muted"], lw=0.8)
    gates = [
        ("provenance\ngate", "source path retained", COL["ink"]),
        ("scope\ngate", "farm/model bound", COL["blue"]),
        ("mechanism\ngate", "test + barrier closed", COL["teal"]),
    ]
    for i, (head, detail, color) in enumerate(gates):
        y = 0.70 - i * 0.17
        ax.add_patch(Rectangle((0.57, y - 0.045), 0.28, 0.09, transform=ax.transAxes, facecolor="white", edgecolor=color, lw=1.0))
        text(ax, 0.71, y + 0.014, head, fs=4.8, color=color, weight="bold")
        text(ax, 0.71, y - 0.028, detail, fs=3.9, color=COL["muted"])
        arrow(ax, (0.43, y), (0.57, y), color=color, lw=0.75)
    outputs = [
        ("fault\nindex", "4,849 codes", COL["blue"]),
        ("reasoning\ngraph", "2,326 nodes", COL["teal"]),
        ("wiki\npages", "tech view", COL["gold"]),
        ("audit\nview", "offline audit", COL["violet"]),
    ]
    for i, (lab, detail, color) in enumerate(outputs):
        x = 0.10 + i * 0.21
        _box_col(ax, x, 0.075, 0.17, 0.085, f"{lab}\n{detail}", color, size=3.6)
        arrow(ax, (0.315, 0.235), (0.18 + i * 0.21, 0.15), color=color, lw=0.7, rad=(i - 1.5) * 0.08)
    save(fig, "fig_knowledge_build_flow")


def draw_knowledge_scale():
    vals = np.array([11865, 22680, 79474, 4849, 8295, 66, 29, 18, 12])
    labels = ["records", "nodes", "relations", "codes", "sources", "models", "farms", "systems", "templates"]
    colors = [COL["teal"], COL["blue"], COL["blue"], COL["gold"], COL["teal"], COL["muted"], COL["muted"], COL["muted"], COL["violet"]]
    fig, ax = plt.subplots(figsize=(4.05, 3.6))
    x = np.arange(len(vals))
    bars = ax.bar(x, vals, color=colors, edgecolor="white", width=0.70)
    ax.set_yscale("log")
    ax.set_ylabel("Count (log scale)")
    ax.set_xticks(x)
    ax.set_xticklabels(labels, rotation=45, ha="right", fontsize=fs(5.5))
    ax.grid(axis="y", which="both", color=COL["grid"], lw=0.7)
    for r, val in zip(bars, vals):
        ax.text(r.get_x() + r.get_width() / 2, val * 1.2, f"{val:,}", ha="center", va="bottom", fontsize=fs(5.0), rotation=90)
    fig.subplots_adjust(bottom=0.24, left=0.16, right=0.98, top=0.96)
    save(fig, "fig_knowledge_scale")


def draw_mechanism_overview():
    data = load_eval()
    mech = data["mechanism"]
    fig, ax = _blank_col(5.35)

    metrics = [
        ("profile", mech["profile_complete_rate"], COL["blue"]),
        ("prevention", mech["prevention_closure_rate"], COL["teal"]),
        ("hypothesis", mech["discrimination_coverage_rate"], COL["violet"]),
    ]
    for i, (lab, val, color) in enumerate(metrics):
        x = 0.09 + i * 0.305
        ax.add_patch(Rectangle((x, 0.895), 0.215, 0.058, transform=ax.transAxes, facecolor=COL["pale"], edgecolor=COL["grid"], lw=0.7))
        text(ax, x + 0.048, 0.924, lab, fs=4.0, color=COL["ink"], weight="bold")
        text(ax, x + 0.170, 0.924, f"{val*100:.0f}%", fs=4.45, color=color, weight="bold")

    ax.add_patch(Rectangle((0.330, 0.425), 0.340, 0.158, transform=ax.transAxes, facecolor="white", edgecolor=COL["grid"], lw=1.0))
    ax.add_patch(Rectangle((0.350, 0.548), 0.300, 0.016, transform=ax.transAxes, facecolor=COL["blue"], edgecolor="none", alpha=0.90))
    ax.add_patch(Rectangle((0.350, 0.526), 0.300, 0.016, transform=ax.transAxes, facecolor=COL["violet"], edgecolor="none", alpha=0.90))
    ax.add_patch(Rectangle((0.350, 0.504), 0.300, 0.016, transform=ax.transAxes, facecolor=COL["teal"], edgecolor="none", alpha=0.90))
    text(ax, 0.500, 0.475, "mechanism", fs=5.3, color=COL["ink"], weight="bold")
    text(ax, 0.500, 0.449, "closure", fs=5.3, color=COL["ink"], weight="bold")

    text(ax, 0.20, 0.785, "explanation chain", fs=4.7, color=COL["blue"], weight="bold")
    explanation = [
        ("fault\ncase", COL["ink"]),
        ("archetype", COL["blue"]),
        ("propagation", COL["teal"]),
        ("failure\nmode", COL["red"]),
    ]
    for i, (lab, color) in enumerate(explanation):
        y = 0.715 - i * 0.102
        _box_col(ax, 0.070, y - 0.030, 0.220, 0.060, lab, color, size=4.0)
        if i < len(explanation) - 1:
            arrow(ax, (0.180, y - 0.031), (0.180, y - 0.071), color=COL["muted"], lw=0.65)
    arrow(ax, (0.290, 0.560), (0.330, 0.510), color=COL["blue"], lw=0.75, rad=-0.05)

    text(ax, 0.80, 0.785, "hypothesis test", fs=4.7, color=COL["violet"], weight="bold")
    discrimination = [
        ("diagnostic\nhypothesis", COL["violet"]),
        ("discriminating\nevidence", COL["blue"]),
        ("counterfactual\ntest", COL["gold"]),
        ("decision\nrule", COL["green"]),
    ]
    for i, (lab, color) in enumerate(discrimination):
        y = 0.715 - i * 0.102
        _box_col(ax, 0.710, y - 0.030, 0.220, 0.060, lab, color, size=3.75)
        if i < len(discrimination) - 1:
            arrow(ax, (0.820, y - 0.031), (0.820, y - 0.071), color=COL["muted"], lw=0.65)
    arrow(ax, (0.670, 0.510), (0.710, 0.662), color=COL["violet"], lw=0.75, rad=0.05)

    text(ax, 0.50, 0.310, "verification + prevention", fs=4.7, color=COL["teal"], weight="bold")
    verification = [
        ("observable", COL["gold"]),
        ("verification\ntest", COL["green"]),
        ("control\nbarrier", COL["violet"]),
    ]
    for i, (lab, color) in enumerate(verification):
        x = 0.105 + i * 0.305
        _box_col(ax, x, 0.175, 0.205, 0.068, lab, color, size=3.95)
        if i < len(verification) - 1:
            arrow(ax, (x + 0.205, 0.209), (x + 0.297, 0.209), color=COL["muted"], lw=0.65)
    arrow(ax, (0.500, 0.415), (0.500, 0.322), color=COL["teal"], lw=0.75)

    save(fig, "fig_nature_mechanism_overview")


def draw_graph_composition():
    data = load_eval()
    nt = data["mechanism"]["node_types"]
    fig, ax = _blank_col(5.3)
    groups = [
        ("explanation chain", COL["blue"], [("observable", 232), ("propagation", 232), ("layer", 232), ("failure mode", 174), ("archetype", 6)]),
        ("verification + prevention", COL["teal"], [("control barrier", 174), ("verification test", 174)]),
        ("hypothesis discrimination", COL["violet"], [("counterfactual", 99), ("evidence", 99), ("decision rule", 66), ("hypothesis", 33)]),
    ]
    max_v = 232
    y = 0.88
    text(ax, 0.08, y, "1,521\nmechanism\nnodes", fs=7.0, color=COL["ink"], ha="left", weight="bold")
    y -= 0.12
    for name, color, items in groups:
        text(ax, 0.08, y, name, fs=5.3, color=color, ha="left", weight="bold")
        y -= 0.045
        for lab, val in items:
            width = 0.15 + 0.55 * val / max_v
            ax.add_patch(Rectangle((0.22, y - 0.012), width, 0.024, transform=ax.transAxes, facecolor=color, edgecolor="white", lw=0.4, alpha=0.88))
            text(ax, 0.22 + width + 0.025, y, f"{lab}  {val}", fs=4.8, color=COL["ink"], ha="left")
            y -= 0.045
        y -= 0.035
    save(fig, "fig_nature_graph_composition")


def draw_case_quality():
    data = load_eval()
    cases = data["case_metrics"]
    mech_terms = np.array([c["mechanism_term_count"] for c in cases])
    failure_terms = np.array([c["failure_mode_term_count"] for c in cases])
    verification_terms = np.array([c["verification_term_count"] for c in cases])
    total_terms = mech_terms + failure_terms + verification_terms
    order = np.argsort(total_terms)
    mech_terms, failure_terms, verification_terms = mech_terms[order], failure_terms[order], verification_terms[order]
    total_terms = total_terms[order]
    fig, ax = plt.subplots(figsize=(4.05, 4.2))
    x = np.arange(len(cases))
    ax.bar(x, mech_terms, color=COL["blue"], width=0.82, edgecolor="white", linewidth=0.3, label="mechanism")
    ax.bar(x, failure_terms, bottom=mech_terms, color=COL["red"], width=0.82, edgecolor="white", linewidth=0.3, label="failure")
    ax.bar(x, verification_terms, bottom=mech_terms + failure_terms, color=COL["teal"], width=0.82, edgecolor="white", linewidth=0.3, label="verification")
    ax.set_xlim(-0.7, len(cases) - 0.3)
    ax.set_ylim(0, total_terms.max() + 5)
    ax.set_xlabel("Fault cases ranked by evidence terms")
    ax.set_ylabel("Evidence terms")
    ax.set_xticks([0, 8, 16, 24, 32])
    ax.set_xticklabels(["1", "9", "17", "25", "33"], fontsize=fs(6))
    ax.grid(axis="y", color=COL["grid"], lw=0.7)
    ax.axhline(np.median(total_terms), color=COL["ink"], ls="--", lw=0.8, alpha=0.55)
    ax.text(len(cases) - 0.4, np.median(total_terms) + 0.7, f"median {np.median(total_terms):.0f}", ha="right", va="bottom", fontsize=fs(5.0), color=COL["ink"])
    ax.legend(loc="upper left", fontsize=fs(5.5), ncol=1)
    fig.subplots_adjust(left=0.18, right=0.98, bottom=0.16, top=0.97)
    save(fig, "fig_nature_case_quality")


def draw_experiment_matrix():
    data = load_eval()
    metrics = [
        ("profile\ncompleteness", data["baseline"]["complete_profile_rate"], data["mechanism"]["profile_complete_rate"], "%"),
        ("validation\nclosure", data["baseline"]["validation_closure_rate"], data["mechanism"]["validation_closure_rate"], "%"),
        ("prevention\nclosure", data["baseline"]["prevention_closure_rate"], data["mechanism"]["prevention_closure_rate"], "%"),
        ("hypothesis\ndiscrimination", 0, data["mechanism"]["discrimination_coverage_rate"], "%"),
        ("mechanism\npath depth", data["baseline"]["average_explanation_depth"] / 6, data["mechanism"]["average_depth"] / 3, "depth"),
    ]
    fig, ax = plt.subplots(figsize=(4.05, 3.8))
    ax.set_xlim(-0.02, 1.27)
    ax.set_ylim(-0.7, len(metrics) - 0.3)
    ax.set_yticks(np.arange(len(metrics)))
    ax.set_yticklabels([m[0] for m in metrics], fontsize=fs(5.4))
    ax.set_xticks([0, 0.5, 1.0])
    ax.set_xticklabels(["0", "50", "100"], fontsize=fs(6))
    ax.set_xlabel("Normalized score")
    ax.invert_yaxis()
    ax.grid(axis="x", color=COL["grid"], lw=0.7)
    for spine in ax.spines.values():
        spine.set_visible(False)
    for y, (_, before, after, kind) in enumerate(metrics):
        ax.plot([before, after], [y, y], color=COL["grid"], lw=6, solid_capstyle="round", zorder=1)
        ax.plot([before, after], [y, y], color=COL["blue"], lw=2.0, solid_capstyle="round", zorder=2)
        ax.scatter([before], [y], s=48, color=COL["muted"], edgecolor="white", linewidth=0.7, zorder=3)
        ax.scatter([after], [y], s=56, color=COL["blue"], edgecolor="white", linewidth=0.7, zorder=4)
        before_label = f"{before*100:.0f}%" if kind == "%" else f"{data['baseline']['average_explanation_depth']:.1f}"
        label = f"{after*100:.0f}%" if kind == "%" else f"{data['mechanism']['average_depth']:.1f}"
        delta = f"+{(after - before)*100:.0f} pp" if kind == "%" else "normalized"
        ax.text(max(before - 0.025, 0.01), y - 0.20, before_label, ha="right", va="center", fontsize=fs(5.0), color=COL["muted"])
        ax.text(min(after + 0.020, 1.03), y, label, fontsize=fs(5.1), color=COL["blue"], va="center", fontweight="bold")
        ax.text(1.145, y, delta, fontsize=fs(4.4), color=COL["green"] if after > before else COL["muted"], va="center", fontweight="bold")
    ax.text(0.05, -0.48, "baseline", fontsize=fs(4.8), color=COL["muted"], fontweight="bold")
    ax.text(0.68, -0.48, "mechanism graph", fontsize=fs(4.8), color=COL["blue"], fontweight="bold")
    fig.subplots_adjust(left=0.34, right=0.985, bottom=0.15, top=0.97)
    save(fig, "fig_experiment_ablation_matrix")


def draw_relation_density():
    data = load_eval()
    rel = data["mechanism"]["relation_types"]
    selected = ["MECHANISM_PROPAGATES_TO", "HAS_MECHANISM_LAYER", "MECHANISM_RESULTS_IN", "HAS_OBSERVABLE", "VALIDATES_ARCHETYPE", "HAS_FAILURE_MODE", "VERIFIED_BY_TEST", "CONTROLLED_BY_BARRIER", "REQUIRES_DISCRIMINATING_EVIDENCE", "RESOLVED_BY_COUNTERFACTUAL_TEST", "HAS_DECISION_RULE", "HAS_COMPETING_HYPOTHESIS"]
    vals = np.array([rel[k] for k in selected])
    labels = [k.replace("MECHANISM_", "").replace("HAS_", "").replace("_", "\n").title() for k in selected]
    fig, ax = plt.subplots(figsize=(4.05, 4.05), subplot_kw={"projection": "polar"})
    theta = np.linspace(0, 2 * pi, len(vals), endpoint=False)
    width = 2 * pi / len(vals) * 0.82
    colors = plt.cm.PuBuGn((vals - vals.min()) / (vals.max() - vals.min() + 1e-9) * 0.65 + 0.25)
    ax.bar(theta, vals, width=width, bottom=0, color=colors, edgecolor="white", linewidth=0.8)
    ax.set_xticks(theta)
    ax.set_xticklabels(labels, fontsize=fs(4.4))
    ax.set_yticks([100, 200, 300])
    ax.set_yticklabels(["100", "200", "300"], fontsize=fs(5.0), color=COL["muted"])
    ax.grid(color=COL["grid"], lw=0.6)
    ax.spines["polar"].set_visible(False)
    save(fig, "fig_experiment_relation_density")


def draw_archetype_coverage():
    graph = load_graph()
    data = load_eval()
    case_mode = {c["case_id"]: c["discriminator_types"][0] for c in data["case_metrics"]}
    archetype_cases = {}
    for edge in graph["edges"]:
        if edge.get("type") == "EXPLAINED_BY_ARCHETYPE":
            archetype_cases.setdefault(edge["target"], []).append(edge["source"])
    rows = sorted(archetype_cases.items(), key=lambda kv: len(kv[1]), reverse=True)
    fig, ax = _blank_col(4.7)
    x0, y0 = 0.36, 0.82
    dx, dy = 0.030, 0.115
    hex_r = 0.012
    pair_col, single_col = COL["blue"], COL["gold"]
    ax.add_patch(Polygon([(0.54 + hex_r * cos(a), 0.925 + hex_r * sin(a)) for a in np.linspace(0, 2 * pi, 7)[:-1] + pi / 6], transform=ax.transAxes, closed=True, facecolor=pair_col, edgecolor="white", lw=0.35))
    text(ax, 0.575, 0.925, "pairwise", fs=4.3, color=COL["ink"], ha="left")
    ax.add_patch(Polygon([(0.73 + hex_r * cos(a), 0.925 + hex_r * sin(a)) for a in np.linspace(0, 2 * pi, 7)[:-1] + pi / 6], transform=ax.transAxes, closed=True, facecolor=single_col, edgecolor="white", lw=0.35))
    text(ax, 0.765, 0.925, "single counterfactual", fs=4.3, color=COL["ink"], ha="left")
    for row, (arch_id, cases) in enumerate(rows):
        y = y0 - row * dy
        label = ARCHETYPE_LABELS.get(arch_id, arch_id.replace("archetype:", "").replace("_", " "))
        text(ax, 0.05, y, wrapped_label(label, 18), fs=4.7, color=COL["ink"], ha="left", weight="bold")
        ax.plot([0.32, 0.92], [y, y], transform=ax.transAxes, color=COL["grid"], lw=0.5, zorder=0)
        for col, case_id in enumerate(cases):
            x = x0 + col * dx
            color = pair_col if case_mode.get(case_id) == "pairwise_archetype_competition" else single_col
            pts = [(x + hex_r * cos(a), y + hex_r * sin(a)) for a in np.linspace(0, 2 * pi, 7)[:-1] + pi / 6]
            ax.add_patch(Polygon(pts, transform=ax.transAxes, closed=True, facecolor=color, edgecolor="white", lw=0.35, alpha=0.92))
        text(ax, 0.95, y, f"{len(cases)}", fs=5.3, color=COL["ink"], ha="center", weight="bold")
    save(fig, "fig_experiment_archetype_coverage")


def main():
    draw_system_architecture()
    draw_knowledge_build_flow()
    draw_knowledge_scale()
    draw_mechanism_overview()
    draw_graph_composition()
    draw_case_quality()
    draw_experiment_matrix()
    draw_relation_density()
    draw_archetype_coverage()
    draw_hypothesis_discrimination()
    draw_case_evidence_richness()


if __name__ == "__main__":
    main()
