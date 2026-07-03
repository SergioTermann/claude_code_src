#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
from textwrap import fill

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Circle, FancyArrowPatch, FancyBboxPatch, Rectangle
from matplotlib.path import Path as MplPath
from matplotlib.patches import PathPatch


FIG_DIR = Path(__file__).resolve().parent / "figures"

PALETTE = {
    "ink": "#272727",
    "muted": "#767676",
    "rule": "#D8D8D8",
    "blue": "#0F4D92",
    "blue2": "#3775BA",
    "teal": "#42949E",
    "green": "#2E9E44",
    "green_soft": "#DDF3DE",
    "gold": "#C89B2C",
    "gold_soft": "#F4E6C1",
    "red": "#B64342",
    "red_soft": "#F6CFCB",
    "violet": "#7C6CCF",
    "violet_soft": "#E7E3F7",
    "aqua_soft": "#E0F0F0",
    "blue_soft": "#E7EFF8",
    "paper": "#FFFFFF",
    "panel": "#F7F8FA",
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


def save(fig: plt.Figure, name: str) -> None:
    FIG_DIR.mkdir(exist_ok=True)
    fig.savefig(FIG_DIR / f"{name}.pdf", bbox_inches="tight", transparent=False)
    plt.close(fig)


def panel_label(ax, label: str, x: float = -0.03, y: float = 1.04) -> None:
    ax.text(x, y, label, transform=ax.transAxes, fontsize=10, fontweight="bold", va="bottom")


def box(
    ax,
    x,
    y,
    w,
    h,
    text,
    ec=PALETTE["blue"],
    fc="white",
    lw=1.0,
    fontsize=6.4,
    radius=0.018,
    color=PALETTE["ink"],
):
    patch = FancyBboxPatch(
        (x, y),
        w,
        h,
        boxstyle=f"round,pad=0.012,rounding_size={radius}",
        transform=ax.transAxes,
        linewidth=lw,
        edgecolor=ec,
        facecolor=fc,
    )
    ax.add_patch(patch)
    ax.text(x + w / 2, y + h / 2, text, transform=ax.transAxes, ha="center", va="center", fontsize=fontsize, color=color)
    return patch


def arrow(ax, x1, y1, x2, y2, color=PALETTE["muted"], lw=1.0, rad=0.0):
    ax.add_patch(
        FancyArrowPatch(
            (x1, y1),
            (x2, y2),
            transform=ax.transAxes,
            arrowstyle="-|>",
            mutation_scale=8,
            linewidth=lw,
            color=color,
            connectionstyle=f"arc3,rad={rad}",
            shrinkA=2,
            shrinkB=2,
        )
    )


def pill(ax, x, y, text, fc, ec=None, fontsize=5.8):
    ec = ec or fc
    patch = FancyBboxPatch(
        (x, y),
        0.125,
        0.048,
        boxstyle="round,pad=0.01,rounding_size=0.024",
        transform=ax.transAxes,
        facecolor=fc,
        edgecolor=ec,
        linewidth=0.8,
    )
    ax.add_patch(patch)
    ax.text(x + 0.0625, y + 0.024, text, transform=ax.transAxes, ha="center", va="center", fontsize=fontsize)


def setup_blank(ax):
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.set_axis_off()


def fig_system_architecture():
    fig = plt.figure(figsize=(7.2, 5.2))
    gs = fig.add_gridspec(2, 3, height_ratios=[1.25, 1], width_ratios=[1.4, 1.05, 1], hspace=0.42, wspace=0.34)

    ax = fig.add_subplot(gs[0, :2])
    setup_blank(ax)
    panel_label(ax, "a")
    ax.set_title("Local evidence constrains LLM maintenance reasoning", loc="left", fontsize=9, pad=8)
    stages = [
        ("Private O&M\ncorpus", PALETTE["ink"], PALETTE["panel"]),
        ("Structured\nknowledge layer", PALETTE["blue"], PALETTE["blue_soft"]),
        ("Mechanism\nreasoning graph", PALETTE["teal"], PALETTE["aqua_soft"]),
        ("Evidence packet\n+ state", PALETTE["gold"], PALETTE["gold_soft"]),
        ("LLM strategy\nchain", PALETTE["violet"], PALETTE["violet_soft"]),
    ]
    xs = [0.02, 0.22, 0.42, 0.62, 0.82]
    for i, ((text, ec, fc), x) in enumerate(zip(stages, xs)):
        box(ax, x, 0.52, 0.145, 0.20, text, ec=ec, fc=fc, fontsize=6.4)
        if i < len(xs) - 1:
            arrow(ax, x + 0.145, 0.62, xs[i + 1], 0.62, color=PALETTE["muted"])
    for x, label in zip(xs, ["manuals\nrecords", "entities\nrelations", "mechanisms\ntests", "sources\npaths", "answer\ncontract"]):
        ax.text(x + 0.072, 0.43, label, ha="center", va="top", transform=ax.transAxes, fontsize=5.6, color=PALETTE["muted"])

    box(ax, 0.22, 0.12, 0.20, 0.14, "facts remain\ninside operator boundary", ec=PALETTE["green"], fc=PALETTE["green_soft"], fontsize=6.2)
    box(ax, 0.58, 0.12, 0.22, 0.14, "generation is limited\nby retrieved evidence", ec=PALETTE["red"], fc=PALETTE["red_soft"], fontsize=6.2)
    arrow(ax, 0.32, 0.52, 0.32, 0.26, color=PALETTE["green"], rad=-0.10)
    arrow(ax, 0.70, 0.52, 0.69, 0.26, color=PALETTE["red"], rad=0.10)
    ax.plot([0.49, 0.49], [0.04, 0.90], transform=ax.transAxes, color=PALETTE["rule"], lw=0.8, ls="--")
    ax.text(0.505, 0.06, "local / intranet boundary", transform=ax.transAxes, fontsize=5.7, color=PALETTE["muted"])

    axb = fig.add_subplot(gs[0, 2])
    setup_blank(axb)
    panel_label(axb, "b")
    axb.set_title("Answer contract", loc="left", fontsize=8, pad=8)
    rows = [
        ("scope", PALETTE["blue"]),
        ("mechanism", PALETTE["teal"]),
        ("verify one action", PALETTE["gold"]),
        ("acceptance criterion", PALETTE["green"]),
        ("evidence path", PALETTE["violet"]),
    ]
    for i, (text, col) in enumerate(rows):
        y = 0.80 - i * 0.145
        axb.add_patch(Circle((0.08, y + 0.03), 0.027, transform=axb.transAxes, facecolor=col, edgecolor="white", lw=0.8))
        axb.text(0.08, y + 0.03, str(i + 1), transform=axb.transAxes, color="white", ha="center", va="center", fontsize=6, fontweight="bold")
        axb.text(0.16, y + 0.03, text, transform=axb.transAxes, ha="left", va="center", fontsize=6.4)
        axb.plot([0.16, 0.92], [y - 0.025, y - 0.025], transform=axb.transAxes, color=PALETTE["rule"], lw=0.7)

    axc = fig.add_subplot(gs[1, :])
    panel_label(axc, "c", -0.02, 1.04)
    labels = ["raw records", "graph nodes", "relations", "fault codes", "source docs", "models", "farms", "systems", "templates"]
    vals = np.array([11865, 22680, 79474, 4849, 8295, 66, 29, 18, 12])
    colors = [PALETTE["teal"], PALETTE["blue"], PALETTE["blue"], PALETTE["gold"], PALETTE["teal"], PALETTE["muted"], PALETTE["muted"], PALETTE["muted"], PALETTE["violet"]]
    x = np.arange(len(vals))
    axc.bar(x, np.log10(vals), color=colors, edgecolor="white", width=0.68)
    for xi, v in zip(x, vals):
        axc.text(xi, np.log10(v) + 0.08, f"{v:,}", ha="center", va="bottom", fontsize=5.7, rotation=0)
    axc.set_xticks(x)
    axc.set_xticklabels(labels, rotation=25, ha="right", fontsize=6)
    axc.set_ylabel("log$_{10}$ count")
    axc.set_title("Knowledge assets used by the local O&M system", loc="left", fontsize=8)
    axc.grid(axis="y", color="#E6E6E6", lw=0.7)
    save(fig, "fig_system_architecture")


def fig_knowledge_build_flow():
    fig = plt.figure(figsize=(7.2, 4.9))
    gs = fig.add_gridspec(2, 1, height_ratios=[1.35, 1.0], hspace=0.34)
    ax = fig.add_subplot(gs[0])
    setup_blank(ax)
    panel_label(ax, "a", -0.02, 1.02)
    ax.set_title("Deterministic build pipeline with provenance at every stage", loc="left", fontsize=9, pad=8)

    lanes = [
        ("Input", 0.78, PALETTE["ink"]),
        ("Normalization", 0.55, PALETTE["blue"]),
        ("Mechanism enrichment", 0.32, PALETTE["teal"]),
    ]
    for name, y, col in lanes:
        ax.text(0.01, y + 0.045, name, transform=ax.transAxes, ha="left", va="center", fontsize=6.3, fontweight="bold", color=col)
        ax.plot([0.14, 0.96], [y - 0.035, y - 0.035], transform=ax.transAxes, color=PALETTE["rule"], lw=0.8)

    input_nodes = [("fault-code\ntables", 0.18), ("manuals /\nreports", 0.34), ("work orders\nQ&A", 0.50), ("file\nsnapshots", 0.66)]
    for text, x in input_nodes:
        box(ax, x, 0.72, 0.12, 0.13, text, ec=PALETTE["ink"], fc=PALETTE["panel"], fontsize=5.8)
    norm_nodes = [("parse\ntext/table", 0.20), ("normalize\naliases", 0.39), ("bind\nscope", 0.58), ("emit source\npointers", 0.77)]
    for i, (text, x) in enumerate(norm_nodes):
        box(ax, x, 0.49, 0.13, 0.13, text, ec=PALETTE["blue"], fc=PALETTE["blue_soft"], fontsize=5.9)
        if i:
            arrow(ax, x - 0.06, 0.555, x, 0.555, color=PALETTE["blue"])
    mech_nodes = [("fault\nentries", 0.16), ("graph\nrelations", 0.34), ("mechanism\narchetypes", 0.52), ("hypothesis\nrules", 0.70), ("wiki /\nindexes", 0.86)]
    for i, (text, x) in enumerate(mech_nodes):
        box(ax, x, 0.25, 0.12, 0.13, text, ec=PALETTE["teal"], fc=PALETTE["aqua_soft"], fontsize=5.9)
        if i:
            arrow(ax, x - 0.055, 0.315, x, 0.315, color=PALETTE["teal"])
    for x in [0.26, 0.45, 0.64, 0.83]:
        arrow(ax, x, 0.72, x, 0.62, color=PALETTE["muted"])
    for x in [0.25, 0.44, 0.63, 0.82]:
        arrow(ax, x, 0.49, x, 0.38, color=PALETTE["muted"])

    axb = fig.add_subplot(gs[1])
    setup_blank(axb)
    panel_label(axb, "b", -0.02, 1.02)
    axb.set_title("Quality gates convert a document index into an auditable reasoning substrate", loc="left", fontsize=8, pad=8)
    gates = [
        ("scope check", "avoid code ambiguity", PALETTE["blue"]),
        ("evidence check", "retain source path", PALETTE["gold"]),
        ("mechanism check", "attach physical cause", PALETTE["teal"]),
        ("closure check", "test + barrier + rule", PALETTE["green"]),
    ]
    for i, (title, desc, col) in enumerate(gates):
        x = 0.05 + i * 0.235
        box(axb, x, 0.35, 0.18, 0.28, f"{title}\n{desc}", ec=col, fc="white", fontsize=6.1)
        if i:
            arrow(axb, x - 0.05, 0.49, x, 0.49, color=PALETTE["muted"])
    axb.text(0.05, 0.14, "Output artefacts: model-scoped fault index, graph JSON, reasoning graph, weighted aliases, wiki pages and HTML graph view.", transform=axb.transAxes, fontsize=6.4, color=PALETTE["muted"])
    save(fig, "fig_knowledge_build_flow")


def fig_domain_relationship():
    fig = plt.figure(figsize=(7.2, 4.8))
    gs = fig.add_gridspec(1, 2, width_ratios=[1.35, 1.0], wspace=0.34)
    ax = fig.add_subplot(gs[0])
    setup_blank(ax)
    panel_label(ax, "a")
    ax.set_title("Fault-code meaning is resolved by model, component and evidence context", loc="left", fontsize=9, pad=8)
    nodes = {
        "Wind farm": (0.08, 0.74, PALETTE["ink"]),
        "Brand": (0.08, 0.50, PALETTE["ink"]),
        "Turbine model": (0.29, 0.64, PALETTE["blue"]),
        "Fault code /\nalarm": (0.50, 0.50, PALETTE["gold"]),
        "System": (0.29, 0.32, PALETTE["blue"]),
        "Component": (0.50, 0.20, PALETTE["teal"]),
        "Cause": (0.72, 0.64, PALETTE["red"]),
        "Action": (0.72, 0.40, PALETTE["green"]),
        "Source\ndocument": (0.72, 0.16, PALETTE["violet"]),
    }
    centers = {}
    for text, (x, y, col) in nodes.items():
        box(ax, x, y, 0.15, 0.105, text, ec=col, fc="white", fontsize=5.9)
        centers[text] = (x + 0.075, y + 0.052)
    links = [
        ("Wind farm", "Turbine model"),
        ("Brand", "Turbine model"),
        ("Turbine model", "Fault code /\nalarm"),
        ("System", "Fault code /\nalarm"),
        ("Fault code /\nalarm", "Cause"),
        ("Fault code /\nalarm", "Action"),
        ("Fault code /\nalarm", "Source\ndocument"),
        ("System", "Component"),
        ("Component", "Cause"),
        ("Cause", "Action"),
    ]
    for a, b in links:
        arrow(ax, *centers[a], *centers[b], color=PALETTE["muted"])
    pill(ax, 0.44, 0.78, "exact code", PALETTE["gold_soft"], PALETTE["gold"])
    pill(ax, 0.58, 0.78, "scope", PALETTE["blue_soft"], PALETTE["blue"])
    pill(ax, 0.72, 0.78, "source", PALETTE["violet_soft"], PALETTE["violet"])

    axb = fig.add_subplot(gs[1])
    setup_blank(axb)
    panel_label(axb, "b")
    axb.set_title("Ambiguity handling", loc="left", fontsize=8, pad=8)
    box(axb, 0.10, 0.72, 0.30, 0.13, "user enters\nfault code", ec=PALETTE["gold"], fc=PALETTE["gold_soft"], fontsize=6.2)
    box(axb, 0.58, 0.72, 0.30, 0.13, "multiple model\nscopes found", ec=PALETTE["red"], fc=PALETTE["red_soft"], fontsize=6.2)
    box(axb, 0.10, 0.43, 0.30, 0.13, "context from\nsession/farm", ec=PALETTE["blue"], fc=PALETTE["blue_soft"], fontsize=6.2)
    box(axb, 0.58, 0.43, 0.30, 0.13, "scoped fault\ncandidate", ec=PALETTE["green"], fc=PALETTE["green_soft"], fontsize=6.2)
    box(axb, 0.34, 0.16, 0.32, 0.13, "if missing:\nask one scope question", ec=PALETTE["violet"], fc=PALETTE["violet_soft"], fontsize=6.2)
    arrow(axb, 0.40, 0.785, 0.58, 0.785, color=PALETTE["red"])
    arrow(axb, 0.25, 0.72, 0.25, 0.56, color=PALETTE["blue"])
    arrow(axb, 0.40, 0.495, 0.58, 0.495, color=PALETTE["green"])
    arrow(axb, 0.72, 0.72, 0.55, 0.29, color=PALETTE["violet"], rad=-0.15)
    axb.text(0.10, 0.03, "The graph prevents a numeric code from being interpreted outside its turbine-model scope.", transform=axb.transAxes, fontsize=6.2, color=PALETTE["muted"])
    save(fig, "fig_domain_relationship")


def fig_troubleshooting_loop():
    fig = plt.figure(figsize=(7.2, 4.9))
    gs = fig.add_gridspec(1, 2, width_ratios=[1.35, 1.0], wspace=0.34)
    ax = fig.add_subplot(gs[0])
    setup_blank(ax)
    panel_label(ax, "a")
    ax.set_title("Stateful troubleshooting loop for short field feedback", loc="left", fontsize=9, pad=8)
    center = (0.50, 0.50)
    steps = [
        ("Question /\nalarm", 90, PALETTE["ink"]),
        ("Scope\nbinding", 38, PALETTE["blue"]),
        ("Evidence\nretrieval", -14, PALETTE["teal"]),
        ("One-step\naction", -66, PALETTE["gold"]),
        ("Technician\nfeedback", -118, PALETTE["red"]),
        ("State\nupdate", -170, PALETTE["violet"]),
        ("Next\nbranch", 158, PALETTE["green"]),
    ]
    positions = []
    for text, deg, col in steps:
        rad = np.deg2rad(deg)
        x = center[0] + 0.32 * np.cos(rad)
        y = center[1] + 0.34 * np.sin(rad)
        positions.append((x, y))
        box(ax, x - 0.075, y - 0.052, 0.15, 0.105, text, ec=col, fc="white", fontsize=5.9)
    for (x1, y1), (x2, y2) in zip(positions, positions[1:] + positions[:1]):
        arrow(ax, x1, y1, x2, y2, color=PALETTE["muted"], rad=0.18)
    ax.add_patch(Circle(center, 0.13, transform=ax.transAxes, facecolor=PALETTE["blue_soft"], edgecolor=PALETTE["blue"], lw=1.0))
    ax.text(center[0], center[1], "retained\nfault state", transform=ax.transAxes, ha="center", va="center", fontsize=7, fontweight="bold", color=PALETTE["blue"])
    ax.text(0.12, 0.05, "Short replies such as 'normal' are interpreted as branch outcomes, not as new unrelated questions.", transform=ax.transAxes, fontsize=6.3, color=PALETTE["muted"])

    axb = fig.add_subplot(gs[1])
    setup_blank(axb)
    panel_label(axb, "b")
    axb.set_title("From evidence to one executable action", loc="left", fontsize=8, pad=8)
    rows = [
        ("retrieved evidence", "fault meaning + source path", PALETTE["teal"]),
        ("mechanism match", "why this signal matters", PALETTE["blue"]),
        ("verification action", "what to measure now", PALETTE["gold"]),
        ("branch criterion", "normal / abnormal threshold", PALETTE["green"]),
        ("next recommendation", "repair, inspect or ask scope", PALETTE["violet"]),
    ]
    for i, (a, b, col) in enumerate(rows):
        y = 0.80 - i * 0.15
        axb.add_patch(Rectangle((0.08, y), 0.035, 0.035, transform=axb.transAxes, facecolor=col, edgecolor="none"))
        axb.text(0.15, y + 0.018, a, transform=axb.transAxes, ha="left", va="center", fontsize=6.5, fontweight="bold")
        axb.text(0.15, y - 0.035, b, transform=axb.transAxes, ha="left", va="center", fontsize=5.8, color=PALETTE["muted"])
        if i < len(rows) - 1:
            arrow(axb, 0.095, y - 0.010, 0.095, y - 0.090, color=PALETTE["muted"])
    save(fig, "fig_troubleshooting_loop")


def fig_knowledge_scale():
    fig = plt.figure(figsize=(7.2, 3.6))
    ax = fig.add_subplot(111)
    panel_label(ax, "a", -0.04, 1.05)
    labels = ["Raw fault\nrecords", "Graph\nnodes", "Graph\nrelations", "Fault-code\nnodes", "Source-doc\nnodes", "Turbine\nmodels", "Wind\nfarms", "Systems", "Mechanism\ntemplates"]
    vals = np.array([11865, 22680, 79474, 4849, 8295, 66, 29, 18, 12])
    colors = [PALETTE["teal"], PALETTE["blue"], PALETTE["blue"], PALETTE["gold"], PALETTE["teal"], PALETTE["muted"], PALETTE["muted"], PALETTE["muted"], PALETTE["violet"]]
    x = np.arange(len(vals))
    bars = ax.bar(x, vals, color=colors, edgecolor="white", width=0.68)
    ax.set_yscale("log")
    ax.set_ylabel("Count (log scale)")
    ax.set_title("Scale of localized wind-turbine O&M knowledge assets", loc="left", fontsize=9, pad=8)
    ax.set_xticks(x)
    ax.set_xticklabels(labels, fontsize=6)
    ax.grid(axis="y", color="#E6E6E6", lw=0.7, which="both")
    for rect, val in zip(bars, vals):
        ax.text(rect.get_x() + rect.get_width() / 2, val * 1.18, f"{val:,}", ha="center", va="bottom", fontsize=6)
    save(fig, "fig_knowledge_scale")


def main():
    fig_system_architecture()
    fig_knowledge_build_flow()
    fig_domain_relationship()
    fig_troubleshooting_loop()
    fig_knowledge_scale()


if __name__ == "__main__":
    main()
