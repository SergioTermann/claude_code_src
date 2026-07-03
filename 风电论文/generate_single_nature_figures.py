#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
from textwrap import fill

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Circle, FancyArrowPatch, FancyBboxPatch, Polygon, Rectangle, Wedge


ROOT = Path(__file__).resolve().parents[1]
FIG_DIR = Path(__file__).resolve().parent / "figures"
EVAL_PATH = ROOT / "generated-knowledge" / "windrise-mechanism-graph-evaluation.json"

P = {
    "ink": "#272727",
    "muted": "#767676",
    "light": "#D8D8D8",
    "pale": "#F7F8FA",
    "blue": "#0F4D92",
    "blue2": "#3775BA",
    "blue_soft": "#E7EFF8",
    "teal": "#42949E",
    "teal_soft": "#E0F0F0",
    "green": "#2E9E44",
    "green_soft": "#DDF3DE",
    "gold": "#C89B2C",
    "gold_soft": "#F4E6C1",
    "red": "#B64342",
    "red_soft": "#F6CFCB",
    "violet": "#7C6CCF",
    "violet_soft": "#E7E3F7",
    "white": "#FFFFFF",
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


def save(fig: plt.Figure, name: str) -> None:
    FIG_DIR.mkdir(exist_ok=True)
    fig.savefig(FIG_DIR / f"{name}.pdf", bbox_inches="tight")
    plt.close(fig)


def blank(figsize=(7.2, 4.8)):
    fig, ax = plt.subplots(figsize=figsize)
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.set_axis_off()
    return fig, ax


def box(ax, x, y, w, h, text, ec=P["blue"], fc=P["white"], fs=6.2, lw=1.0, r=0.02, weight="normal"):
    patch = FancyBboxPatch(
        (x, y),
        w,
        h,
        boxstyle=f"round,pad=0.012,rounding_size={r}",
        transform=ax.transAxes,
        facecolor=fc,
        edgecolor=ec,
        linewidth=lw,
    )
    ax.add_patch(patch)
    ax.text(x + w / 2, y + h / 2, text, transform=ax.transAxes, ha="center", va="center", fontsize=fs, fontweight=weight)
    return patch


def arrow(ax, x1, y1, x2, y2, color=P["muted"], lw=1.0, rad=0.0, ms=9):
    ax.add_patch(
        FancyArrowPatch(
            (x1, y1),
            (x2, y2),
            transform=ax.transAxes,
            arrowstyle="-|>",
            mutation_scale=ms,
            linewidth=lw,
            color=color,
            connectionstyle=f"arc3,rad={rad}",
            shrinkA=2,
            shrinkB=2,
        )
    )


def label(ax, x, y, text, fs=6.2, color=P["muted"], ha="center", weight="normal"):
    ax.text(x, y, text, transform=ax.transAxes, ha=ha, va="center", fontsize=fs, color=color, fontweight=weight)


def title(ax, text):
    ax.text(0.015, 0.975, text, transform=ax.transAxes, ha="left", va="top", fontsize=9, fontweight="bold", color=P["ink"])


def draw_system_architecture():
    fig, ax = blank((7.2, 4.6))
    title(ax, "Evidence-grounded local O&M intelligence architecture")
    ax.add_patch(Rectangle((0.035, 0.08), 0.43, 0.78, transform=ax.transAxes, facecolor=P["pale"], edgecolor=P["light"], lw=0.8))
    ax.add_patch(Rectangle((0.535, 0.08), 0.43, 0.78, transform=ax.transAxes, facecolor="#FBFAFF", edgecolor=P["light"], lw=0.8))
    label(ax, 0.25, 0.835, "local knowledge construction", fs=7.0, color=P["ink"], weight="bold")
    label(ax, 0.75, 0.835, "evidence-bound LLM reasoning", fs=7.0, color=P["ink"], weight="bold")

    left = [
        ("Fault-code\ntables", 0.075, 0.65, P["ink"], P["white"]),
        ("Manuals and\ncase reports", 0.075, 0.45, P["ink"], P["white"]),
        ("Work orders\nQ&A traces", 0.075, 0.25, P["ink"], P["white"]),
        ("Scope-normalized\nfault entries", 0.285, 0.55, P["blue"], P["blue_soft"]),
        ("Source-aware\nknowledge graph", 0.285, 0.35, P["teal"], P["teal_soft"]),
    ]
    for text, x, y, ec, fc in left:
        box(ax, x, y, 0.135, 0.12, text, ec=ec, fc=fc, fs=5.7)
    for y in [0.71, 0.51, 0.31]:
        arrow(ax, 0.21, y, 0.285, 0.61 if y > 0.55 else 0.41, color=P["muted"], rad=0.08)
    arrow(ax, 0.352, 0.55, 0.352, 0.47, color=P["teal"])

    bridge = box(ax, 0.445, 0.405, 0.13, 0.16, "Evidence\npacket\n+ retained state", ec=P["gold"], fc=P["gold_soft"], fs=5.8, weight="bold")
    arrow(ax, 0.420, 0.61, 0.445, 0.50, color=P["gold"], rad=-0.1)
    arrow(ax, 0.420, 0.41, 0.445, 0.47, color=P["gold"], rad=0.1)

    right_nodes = [
        ("Intent routing", 0.62, 0.66, P["violet"], P["violet_soft"]),
        ("Graph-enhanced\nretrieval", 0.79, 0.66, P["blue"], P["blue_soft"]),
        ("Mechanism\nmatching", 0.79, 0.44, P["teal"], P["teal_soft"]),
        ("Field action\ncontract", 0.62, 0.44, P["green"], P["green_soft"]),
        ("Auditable answer\nwith source path", 0.70, 0.22, P["red"], P["red_soft"]),
    ]
    for text, x, y, ec, fc in right_nodes:
        box(ax, x, y, 0.135, 0.12, text, ec=ec, fc=fc, fs=5.7)
    arrow(ax, 0.575, 0.485, 0.62, 0.72, color=P["violet"], rad=0.1)
    arrow(ax, 0.755, 0.72, 0.79, 0.72, color=P["muted"])
    arrow(ax, 0.858, 0.66, 0.858, 0.56, color=P["teal"])
    arrow(ax, 0.79, 0.50, 0.755, 0.50, color=P["green"])
    arrow(ax, 0.687, 0.44, 0.74, 0.34, color=P["red"], rad=-0.1)

    ax.plot([0.50, 0.50], [0.10, 0.84], color=P["light"], ls="--", lw=1.0, transform=ax.transAxes)
    label(ax, 0.50, 0.10, "operator boundary", fs=5.7, color=P["muted"])
    label(ax, 0.24, 0.12, "private documents never need to leave the local deployment", fs=5.8, color=P["muted"])
    label(ax, 0.75, 0.12, "LLM organizes retrieved facts rather than acting as an unconstrained source", fs=5.8, color=P["muted"])
    save(fig, "fig_system_architecture")


def draw_knowledge_build_flow():
    fig, ax = blank((7.2, 4.4))
    title(ax, "Document-to-mechanism graph construction pipeline")
    xs = np.linspace(0.08, 0.88, 7)
    stages = [
        ("Ingest", "files, tables,\nPDF text", P["ink"], P["white"]),
        ("Parse", "records and\nsections", P["blue"], P["blue_soft"]),
        ("Normalize", "aliases, scope,\nmodels", P["blue"], P["blue_soft"]),
        ("Relate", "fault-component-\naction-source", P["teal"], P["teal_soft"]),
        ("Enrich", "mechanism\narchetypes", P["gold"], P["gold_soft"]),
        ("Discriminate", "hypotheses and\ncounterfactuals", P["violet"], P["violet_soft"]),
        ("Publish", "index, wiki,\ngraph view", P["green"], P["green_soft"]),
    ]
    for i, (head, sub, ec, fc) in enumerate(stages):
        x = xs[i]
        box(ax, x - 0.055, 0.50, 0.11, 0.17, f"{head}\n{sub}", ec=ec, fc=fc, fs=5.6, weight="bold" if i in [0, 4, 5, 6] else "normal")
        if i < len(stages) - 1:
            arrow(ax, x + 0.055, 0.585, xs[i + 1] - 0.055, 0.585, color=P["muted"])

    gates = [
        ("scope gate", "same code may mean different faults", xs[2], 0.30, P["blue"]),
        ("evidence gate", "every relation keeps source metadata", xs[3], 0.20, P["teal"]),
        ("closure gate", "observable + test + barrier + rule", xs[5], 0.30, P["violet"]),
    ]
    for head, sub, x, y, col in gates:
        box(ax, x - 0.085, y, 0.17, 0.095, f"{head}\n{sub}", ec=col, fc=P["white"], fs=5.3)
        arrow(ax, x, 0.50, x, y + 0.095, color=col, rad=0.0)

    outputs = [
        ("fault index", 0.18),
        ("reasoning graph", 0.37),
        ("weighted aliases", 0.56),
        ("technician wiki", 0.75),
    ]
    for text, x in outputs:
        box(ax, x - 0.065, 0.08, 0.13, 0.07, text, ec=P["green"], fc=P["green_soft"], fs=5.5)
        arrow(ax, x, 0.20, x, 0.15, color=P["green"])
    label(ax, 0.50, 0.82, "deterministic construction makes the RAG substrate inspectable, reproducible and correctable", fs=6.4, color=P["muted"])
    save(fig, "fig_knowledge_build_flow")


def draw_domain_relationship():
    fig, ax = blank((7.2, 4.7))
    title(ax, "Model-scoped fault-code semantics and evidence traceability")
    positions = {
        "Wind farm": (0.12, 0.72),
        "Brand": (0.12, 0.48),
        "Turbine model": (0.34, 0.62),
        "Fault code": (0.52, 0.50),
        "System": (0.34, 0.30),
        "Component": (0.52, 0.24),
        "Cause": (0.74, 0.64),
        "Action": (0.78, 0.42),
        "Source document": (0.74, 0.20),
    }
    colors = {
        "Wind farm": P["ink"],
        "Brand": P["ink"],
        "Turbine model": P["blue"],
        "Fault code": P["gold"],
        "System": P["blue"],
        "Component": P["teal"],
        "Cause": P["red"],
        "Action": P["green"],
        "Source document": P["violet"],
    }
    for name, (x, y) in positions.items():
        box(ax, x - 0.065, y - 0.045, 0.13, 0.09, name.replace(" ", "\n"), ec=colors[name], fc=P["white"], fs=5.8)
    edges = [
        ("Wind farm", "Turbine model"),
        ("Brand", "Turbine model"),
        ("Turbine model", "Fault code"),
        ("System", "Fault code"),
        ("Fault code", "Cause"),
        ("Fault code", "Action"),
        ("Fault code", "Source document"),
        ("System", "Component"),
        ("Component", "Cause"),
        ("Cause", "Action"),
    ]
    for a, b in edges:
        x1, y1 = positions[a]
        x2, y2 = positions[b]
        arrow(ax, x1, y1, x2, y2, color=P["muted"], rad=0.02)

    ax.add_patch(FancyBboxPatch((0.42, 0.70), 0.47, 0.16, boxstyle="round,pad=0.018,rounding_size=0.025", transform=ax.transAxes, facecolor=P["red_soft"], edgecolor=P["red"], lw=1.0))
    label(ax, 0.655, 0.805, "ambiguity safeguard", fs=6.8, color=P["red"], weight="bold")
    label(ax, 0.655, 0.755, "if several model scopes match, ask for farm/model before recommending action", fs=5.8, color=P["ink"])
    arrow(ax, 0.57, 0.545, 0.53, 0.70, color=P["red"], rad=-0.15)

    chips = [("exact code", P["gold_soft"], P["gold"]), ("model scope", P["blue_soft"], P["blue"]), ("evidence path", P["violet_soft"], P["violet"])]
    for i, (txt, fc, ec) in enumerate(chips):
        box(ax, 0.09 + i * 0.17, 0.09, 0.125, 0.06, txt, ec=ec, fc=fc, fs=5.7)
    label(ax, 0.55, 0.10, "a generated answer must pass all three constraints", fs=6.1, color=P["muted"], ha="left")
    save(fig, "fig_domain_relationship")


def draw_troubleshooting_loop():
    fig, ax = blank((7.2, 4.7))
    title(ax, "Stateful troubleshooting loop converts terse feedback into a diagnostic branch")
    cx, cy = 0.50, 0.52
    ax.add_patch(Circle((cx, cy), 0.16, transform=ax.transAxes, facecolor=P["blue_soft"], edgecolor=P["blue"], lw=1.2))
    label(ax, cx, cy + 0.035, "retained", fs=8, color=P["blue"], weight="bold")
    label(ax, cx, cy - 0.020, "fault state", fs=8, color=P["blue"], weight="bold")
    label(ax, cx, cy - 0.080, "scope + evidence + last action", fs=5.5, color=P["muted"])

    steps = [
        ("Question /\nalarm", 92, P["ink"], P["white"]),
        ("Scope\nbinding", 40, P["blue"], P["blue_soft"]),
        ("Evidence\nretrieval", -12, P["teal"], P["teal_soft"]),
        ("One field\naction", -65, P["gold"], P["gold_soft"]),
        ("Short feedback\n'normal'", -118, P["red"], P["red_soft"]),
        ("Branch\ninterpretation", -170, P["violet"], P["violet_soft"]),
        ("Next action\nor stop", 158, P["green"], P["green_soft"]),
    ]
    coords = []
    for txt, deg, ec, fc in steps:
        rad = np.deg2rad(deg)
        x = cx + 0.34 * np.cos(rad)
        y = cy + 0.36 * np.sin(rad)
        coords.append((x, y))
        box(ax, x - 0.07, y - 0.045, 0.14, 0.09, txt, ec=ec, fc=fc, fs=5.6)
    for (x1, y1), (x2, y2) in zip(coords, coords[1:] + coords[:1]):
        arrow(ax, x1, y1, x2, y2, color=P["muted"], rad=0.16, ms=8)
    for x, y in coords:
        arrow(ax, x, y, cx + (x - cx) * 0.45, cy + (y - cy) * 0.45, color=P["light"], rad=0.0, ms=6)

    box(ax, 0.08, 0.08, 0.25, 0.10, "example criterion:\npressure recovery < 15 s", ec=P["gold"], fc=P["gold_soft"], fs=5.8)
    box(ax, 0.67, 0.08, 0.25, 0.10, "example branch:\nnormal -> inspect sensor chain", ec=P["violet"], fc=P["violet_soft"], fs=5.8)
    arrow(ax, 0.33, 0.13, 0.67, 0.13, color=P["muted"], rad=-0.15)
    save(fig, "fig_troubleshooting_loop")


def draw_knowledge_scale():
    fig, ax = plt.subplots(figsize=(7.2, 3.7))
    vals = np.array([11865, 22680, 79474, 4849, 8295, 66, 29, 18, 12])
    labels = ["raw fault\nrecords", "graph\nnodes", "graph\nrelations", "fault-code\nnodes", "source-doc\nnodes", "turbine\nmodels", "wind\nfarms", "systems", "mechanism\ntemplates"]
    colors = [P["teal"], P["blue"], P["blue"], P["gold"], P["teal"], P["muted"], P["muted"], P["muted"], P["violet"]]
    x = np.arange(len(vals))
    bars = ax.bar(x, vals, color=colors, edgecolor="white", width=0.68)
    ax.set_yscale("log")
    ax.set_ylabel("Count (log scale)")
    ax.set_title("Scale of localized wind-turbine O&M knowledge assets", loc="left", fontsize=9, fontweight="bold")
    ax.set_xticks(x)
    ax.set_xticklabels(labels, fontsize=6)
    ax.grid(axis="y", color="#E6E6E6", lw=0.7, which="both")
    for rect, val in zip(bars, vals):
        ax.text(rect.get_x() + rect.get_width() / 2, val * 1.18, f"{val:,}", ha="center", va="bottom", fontsize=6)
    save(fig, "fig_knowledge_scale")


def draw_mechanism_overview():
    data = load_eval()
    base = data["baseline"]
    mech = data["mechanism"]
    fig, ax = blank((7.2, 4.8))
    title(ax, "Mechanism graph closes the loop from fault matching to falsifiable diagnosis")
    y = 0.60
    nodes = [
        ("fault case", P["ink"], P["white"]),
        ("mechanism\narchetype", P["blue"], P["blue_soft"]),
        ("propagation\npath", P["teal"], P["teal_soft"]),
        ("observable\nsignal", P["gold"], P["gold_soft"]),
        ("verification\ntest", P["green"], P["green_soft"]),
        ("control\nbarrier", P["violet"], P["violet_soft"]),
    ]
    xs = np.linspace(0.08, 0.88, len(nodes))
    for i, (txt, ec, fc) in enumerate(nodes):
        box(ax, xs[i] - 0.055, y - 0.06, 0.11, 0.12, txt, ec=ec, fc=fc, fs=5.7, weight="bold" if i in [0, 1, 5] else "normal")
        if i < len(nodes) - 1:
            arrow(ax, xs[i] + 0.055, y, xs[i + 1] - 0.055, y, color=P["muted"])
    box(ax, 0.36, 0.23, 0.28, 0.11, "diagnostic hypothesis:\nreal mechanism or pseudo-cause?", ec=P["red"], fc=P["red_soft"], fs=6.1, weight="bold")
    arrow(ax, 0.50, y - 0.06, 0.50, 0.34, color=P["red"])
    box(ax, 0.08, 0.20, 0.18, 0.08, "discriminating\nevidence", ec=P["violet"], fc=P["violet_soft"], fs=5.7)
    box(ax, 0.74, 0.20, 0.18, 0.08, "counterfactual\ntest + rule", ec=P["violet"], fc=P["violet_soft"], fs=5.7)
    arrow(ax, 0.36, 0.275, 0.26, 0.24, color=P["violet"], rad=0.10)
    arrow(ax, 0.64, 0.275, 0.74, 0.24, color=P["violet"], rad=-0.10)

    metrics = [
        ("profile\ncomplete", base["complete_profile_rate"], mech["profile_complete_rate"], 0.16),
        ("prevention\nclosure", base["prevention_closure_rate"], mech["prevention_closure_rate"], 0.38),
        ("hypothesis\ndiscrimination", 0, mech["discrimination_coverage_rate"], 0.60),
        ("mechanism\nclosure", 0, mech["coverage_rate"], 0.82),
    ]
    for label_text, b, m, x0 in metrics:
        ax.add_patch(Rectangle((x0 - 0.055, 0.78), 0.035, 0.10 * b, transform=ax.transAxes, facecolor=P["light"], edgecolor="none"))
        ax.add_patch(Rectangle((x0 - 0.010, 0.78), 0.035, 0.10 * m, transform=ax.transAxes, facecolor=P["teal"], edgecolor="none"))
        label(ax, x0, 0.925, f"{m*100:.0f}%", fs=6.2, color=P["teal"], weight="bold")
        label(ax, x0, 0.745, label_text, fs=5.4, color=P["muted"])
    label(ax, 0.50, 0.10, "33/33 cases obtain mechanism, verification, prevention and diagnostic-hypothesis closure", fs=6.4, color=P["ink"], weight="bold")
    save(fig, "fig_nature_mechanism_overview")


def draw_graph_composition():
    data = load_eval()
    node_types = data["mechanism"]["node_types"]
    fig, ax = blank((7.2, 4.6))
    title(ax, "Composition of the mechanism-enhanced reasoning graph")
    center = np.array([0.50, 0.50])
    groups = [
        ("mechanism layer", node_types["mechanism_layer"], P["blue"]),
        ("propagation step", node_types["propagation_step"], P["blue2"]),
        ("observable", node_types["observable"], P["teal"]),
        ("failure mode", node_types["failure_mode"], P["red"]),
        ("verification test", node_types["verification_test"], P["gold"]),
        ("control barrier", node_types["control_barrier"], P["green"]),
        ("evidence", node_types["discriminating_evidence"], P["violet"]),
        ("counterfactual", node_types["counterfactual_test"], P["gold"]),
        ("decision rule", node_types["decision_rule"], P["muted"]),
        ("hypothesis", node_types["diagnostic_hypothesis"], P["violet"]),
        ("archetype", node_types["mechanism_archetype"], P["ink"]),
    ]
    max_v = max(v for _, v, _ in groups)
    angles = np.linspace(90, 450, len(groups), endpoint=False)
    prev = None
    for (name, val, col), deg in zip(groups, angles):
        rad = np.deg2rad(deg)
        length = 0.22 + 0.22 * val / max_v
        end = center + length * np.array([np.cos(rad), np.sin(rad)])
        ax.plot([center[0], end[0]], [center[1], end[1]], transform=ax.transAxes, color=P["light"], lw=1.0)
        ax.add_patch(Circle(tuple(end), 0.018 + 0.028 * val / max_v, transform=ax.transAxes, facecolor=col, edgecolor="white", lw=0.8, alpha=0.92))
        tx = center + (length + 0.075) * np.array([np.cos(rad), np.sin(rad)])
        ha = "left" if np.cos(rad) > 0.15 else "right" if np.cos(rad) < -0.15 else "center"
        ax.text(tx[0], tx[1], f"{name}\n{val}", transform=ax.transAxes, ha=ha, va="center", fontsize=5.6, color=P["ink"])
        if prev is not None:
            ax.plot([prev[0], end[0]], [prev[1], end[1]], transform=ax.transAxes, color=P["rule"] if "rule" in P else P["light"], lw=0.7, alpha=0.8)
        prev = end
    ax.add_patch(Circle(tuple(center), 0.105, transform=ax.transAxes, facecolor=P["blue_soft"], edgecolor=P["blue"], lw=1.1))
    label(ax, center[0], center[1] + 0.025, "1,521", fs=13, color=P["blue"], weight="bold")
    label(ax, center[0], center[1] - 0.035, "mechanism nodes", fs=6.2, color=P["ink"])
    label(ax, 0.50, 0.08, "node counts radiate from the graph core; larger circles indicate more instantiated reasoning elements", fs=6.2, color=P["muted"])
    save(fig, "fig_nature_graph_composition")


def draw_case_quality():
    data = load_eval()
    cases = data["case_metrics"]
    scores = np.array([c["mechanism_score"] for c in cases])
    types = [c.get("discriminator_types", [""])[0] for c in cases]
    order = np.argsort(scores)
    fig, ax = plt.subplots(figsize=(7.2, 4.2))
    colors = [P["blue2"] if types[i] == "pairwise_archetype_competition" else P["gold"] for i in order]
    y = np.arange(len(scores))
    ax.barh(y, scores[order], color=colors, edgecolor="white", height=0.74)
    ax.axvline(scores.mean(), ls="--", lw=1.0, color=P["ink"])
    ax.text(scores.mean() + 0.7, len(scores) - 1, f"mean {scores.mean():.1f}", rotation=90, va="top", ha="left", fontsize=6)
    ax.set_xlim(0, 100)
    ax.set_yticks([])
    ax.set_xlabel("Mechanism quality score")
    ax.set_ylabel("33 fault cases ranked by score")
    ax.set_title("Case-level mechanism quality after graph enrichment", loc="left", fontsize=9, fontweight="bold")
    ax.grid(axis="x", color="#E6E6E6", lw=0.7)
    ax.text(4, 29.5, "blue: pairwise mechanism competition (18 cases)", fontsize=6, color=P["blue2"])
    ax.text(4, 27.8, "gold: single-mechanism counterfactual discrimination (15 cases)", fontsize=6, color=P["gold"])
    ax.text(4, 2.2, "all cases contain observable, verification test and control barrier", fontsize=6, color=P["green"], fontweight="bold")
    save(fig, "fig_nature_case_quality")


def main():
    draw_system_architecture()
    draw_knowledge_build_flow()
    draw_domain_relationship()
    draw_troubleshooting_loop()
    draw_knowledge_scale()
    draw_mechanism_overview()
    draw_graph_composition()
    draw_case_quality()


if __name__ == "__main__":
    main()
