#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

import json
from pathlib import Path

import matplotlib as mpl
import matplotlib.font_manager as fm
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Circle, FancyArrowPatch, FancyBboxPatch, Polygon, Rectangle


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "assets" / "readme"
ARCH_SVG = OUT_DIR / "windrise-architecture.svg"
ARCH_PNG = OUT_DIR / "windrise-architecture.png"
BANNER_PNG = OUT_DIR / "windrise-banner.png"

INK = "#182033"
TEXT = "#233044"
MUTED = "#667488"
FAINT = "#9AA7B5"
BG = "#FBFCFE"
PANEL = "#FFFFFF"
RULE = "#DDE5EE"
BLUE = "#0F4D92"
BLUE_MID = "#3775BA"
BLUE_SOFT = "#E9F3FF"
GREEN = "#2A8C65"
GREEN_SOFT = "#EAF7F0"
TEAL = "#42949E"
TEAL_SOFT = "#E9F7F8"
GOLD = "#C58A21"
GOLD_SOFT = "#FFF3DE"
ROSE = "#B64342"
NAVY = "#102A43"
WHITE = "#FFFFFF"


def pick_font() -> str:
    preferred = [
        "Microsoft YaHei",
        "Noto Sans CJK SC",
        "Source Han Sans SC",
        "SimHei",
        "Arial Unicode MS",
        "Arial",
        "DejaVu Sans",
    ]
    available = {font.name for font in fm.fontManager.ttflist}
    return next((name for name in preferred if name in available), "DejaVu Sans")


FONT = pick_font()
mpl.rcParams.update(
    {
        "font.family": "sans-serif",
        "font.sans-serif": [FONT, "Arial", "Helvetica", "DejaVu Sans", "sans-serif"],
        "svg.fonttype": "none",
        "pdf.fonttype": 42,
        "font.size": 8,
        "axes.spines.right": False,
        "axes.spines.top": False,
        "axes.linewidth": 0.8,
        "legend.frameon": False,
    }
)


def load_metrics() -> dict[str, str]:
    summary = json.loads((ROOT / "wind-llmwiki" / "fault-index-summary.json").read_text(encoding="utf-8"))
    wind_models = json.loads((ROOT / "src" / "data" / "windFarmModels.json").read_text(encoding="utf-8"))
    turbine_mapping = json.loads((ROOT / "src" / "data" / "turbineMapping.json").read_text(encoding="utf-8"))
    return {
        "records": f"{summary['recordCount']:,}",
        "brands": f"{len(summary.get('byBrand', {})):,}",
        "models": f"{len(wind_models):,}",
        "turbines": f"{len(turbine_mapping):,}",
    }


def clean_svg(path: Path) -> None:
    lines = path.read_text(encoding="utf-8").splitlines()
    path.write_text("\n".join(line.rstrip() for line in lines) + "\n", encoding="utf-8")


def add_text(ax, x, y, s, size=12, weight="normal", color=TEXT, ha="left", va="center", alpha=1.0, **kwargs):
    return ax.text(
        x,
        y,
        s,
        fontsize=size,
        fontweight=weight,
        color=color,
        ha=ha,
        va=va,
        linespacing=1.18,
        alpha=alpha,
        **kwargs,
    )


def rounded_box(ax, x, y, w, h, fc=PANEL, ec=RULE, lw=1.0, radius=18, alpha=1.0, z=2):
    patch = FancyBboxPatch(
        (x, y),
        w,
        h,
        boxstyle=f"round,pad=0,rounding_size={radius}",
        linewidth=lw,
        edgecolor=ec,
        facecolor=fc,
        alpha=alpha,
        zorder=z,
    )
    ax.add_patch(patch)
    return patch


def arrow(ax, start, end, color=BLUE_MID, lw=1.6, rad=0.0, ms=13, alpha=1.0, z=5, style="-|>"):
    ax.add_patch(
        FancyArrowPatch(
            start,
            end,
            arrowstyle=style,
            mutation_scale=ms,
            linewidth=lw,
            color=color,
            connectionstyle=f"arc3,rad={rad}",
            shrinkA=5,
            shrinkB=5,
            alpha=alpha,
            zorder=z,
        )
    )


def draw_metric_card(ax, x, y, value, label, width=138, dark=False):
    if dark:
        rounded_box(ax, x, y, width, 58, fc="#173D5C", ec="#38637F", lw=1.0, radius=12, z=4)
        add_text(ax, x + width / 2, y + 22, value, size=18, weight="bold", color=WHITE, ha="center", zorder=5)
        add_text(ax, x + width / 2, y + 44, label, size=7.6, weight="bold", color="#CFE1EC", ha="center", zorder=5)
    else:
        rounded_box(ax, x, y, width, 58, fc=WHITE, ec=RULE, lw=1.0, radius=12, z=3)
        add_text(ax, x + width / 2, y + 22, value, size=17, weight="bold", color=INK, ha="center", zorder=4)
        add_text(ax, x + width / 2, y + 44, label, size=7.4, weight="bold", color=MUTED, ha="center", zorder=4)


def draw_turbine(ax, cx, cy, scale=1.0, color=WHITE, alpha=1.0, z=4):
    ax.plot([cx, cx], [cy, cy - 118 * scale], color=color, lw=3.0 * scale, alpha=alpha, zorder=z)
    ax.plot([cx - 36 * scale, cx + 36 * scale], [cy, cy], color=color, lw=2.4 * scale, alpha=alpha * 0.6, zorder=z)
    hub = (cx, cy - 124 * scale)
    ax.add_patch(Circle(hub, 8 * scale, facecolor=color, edgecolor="none", alpha=alpha, zorder=z + 2))
    for dx, dy in [(-88, -38), (80, -45), (10, 92)]:
        ax.plot([hub[0], hub[0] + dx * scale], [hub[1], hub[1] + dy * scale], color=color, lw=3.2 * scale, alpha=alpha, zorder=z + 1)


def icon_field(ax, cx, cy, color):
    rounded_box(ax, cx - 24, cy - 18, 48, 36, fc=WHITE, ec=color, lw=1.5, radius=12, z=7)
    ax.add_patch(Polygon([(cx - 8, cy + 18), (cx + 3, cy + 18), (cx - 11, cy + 30)], closed=True, fc=WHITE, ec=color, lw=1.5, zorder=7))
    for yy in [cy - 7, cy + 3, cy + 13]:
        ax.plot([cx - 10, cx + 12], [yy, yy], color=color, lw=1.2, zorder=8)


def icon_scope(ax, cx, cy, color):
    for r, alpha in [(26, 0.10), (17, 0.16), (8, 0.95)]:
        ax.add_patch(Circle((cx, cy), r, facecolor=color, edgecolor="none", alpha=alpha, zorder=7))
    ax.plot([cx - 28, cx + 28], [cy, cy], color=color, lw=1.1, alpha=0.65, zorder=8)
    ax.plot([cx, cx], [cy - 28, cy + 28], color=color, lw=1.1, alpha=0.65, zorder=8)


def icon_index(ax, cx, cy, color):
    for dx, dy in [(-18, -16), (18, -13), (-2, 18)]:
        ax.add_patch(Circle((cx + dx, cy + dy), 7, facecolor=color, edgecolor="none", alpha=0.9, zorder=8))
    ax.plot([cx - 18, cx + 18], [cy - 16, cy - 13], color=color, lw=1.4, alpha=0.65, zorder=7)
    ax.plot([cx - 18, cx - 2], [cy - 16, cy + 18], color=color, lw=1.4, alpha=0.65, zorder=7)
    ax.plot([cx + 18, cx - 2], [cy - 13, cy + 18], color=color, lw=1.4, alpha=0.65, zorder=7)


def icon_gates(ax, cx, cy, color):
    for i, yy in enumerate([-18, 0, 18]):
        ax.plot([cx - 25, cx + 25], [cy + yy, cy + yy], color=color, lw=1.6, zorder=8)
        ax.add_patch(Circle((cx - 9 + i * 9, cy + yy), 5, facecolor=color, edgecolor=WHITE, lw=0.8, zorder=9))


def icon_llm(ax, cx, cy, color):
    rounded_box(ax, cx - 28, cy - 22, 56, 44, fc=WHITE, ec=color, lw=1.5, radius=15, z=7)
    for dx in [-14, 0, 14]:
        ax.add_patch(Circle((cx + dx, cy), 4.5, facecolor=color, edgecolor="none", zorder=8))


def icon_answer(ax, cx, cy, color):
    rounded_box(ax, cx - 25, cy - 28, 50, 56, fc=WHITE, ec=color, lw=1.5, radius=10, z=7)
    for yy in [-15, -3, 9, 21]:
        ax.plot([cx - 12, cx + 14], [cy + yy, cy + yy], color=color, lw=1.2, alpha=0.75, zorder=8)
    ax.add_patch(Circle((cx - 13, cy - 15), 2.7, facecolor=color, edgecolor="none", zorder=8))


def chain_node(ax, x, y, w, h, title, subtitle, accent, soft, icon_fn, body_lines=None, dark=False):
    if dark:
        rounded_box(ax, x, y, w, h, fc=NAVY, ec=NAVY, lw=1.0, radius=26, z=3)
        rounded_box(ax, x + 12, y + 12, 64, 64, fc=WHITE, ec=WHITE, lw=0, radius=22, alpha=0.10, z=4)
        icon_fn(ax, x + 44, y + 44, WHITE)
        add_text(ax, x + 94, y + 34, title, size=18, weight="bold", color=WHITE, zorder=6)
        add_text(ax, x + 94, y + 61, subtitle, size=9.2, color="#CFE1EC", zorder=6)
        line_color = "#D8EAF7"
    else:
        rounded_box(ax, x, y, w, h, fc=PANEL, ec=RULE, lw=1.1, radius=24, z=3)
        rounded_box(ax, x + 13, y + 15, 58, 58, fc=soft, ec="none", lw=0, radius=18, z=4)
        icon_fn(ax, x + 42, y + 44, accent)
        add_text(ax, x + 88, y + 32, title, size=15.2, weight="bold", color=INK, zorder=6)
        add_text(ax, x + 88, y + 56, subtitle, size=8.6, color=MUTED, zorder=6)
        line_color = accent
    if body_lines:
        for i, line in enumerate(body_lines):
            yy = y + 86 + i * 19
            ax.add_patch(Circle((x + 26, yy), 3.4, facecolor=line_color, edgecolor="none", alpha=0.95, zorder=6))
            add_text(ax, x + 39, yy, line, size=8.0, color=WHITE if dark else TEXT, zorder=6)


def draw_architecture(metrics: dict[str, str]) -> None:
    width, height = 1800, 980
    fig = plt.figure(figsize=(18, 9.8), facecolor=BG)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, width)
    ax.set_ylim(height, 0)
    ax.axis("off")
    ax.set_facecolor(BG)

    add_text(ax, 82, 60, "Windrise evidence architecture", size=31, weight="bold", color=INK)
    add_text(ax, 84, 101, "Local wind-turbine O&M intelligence with deterministic scope, evidence and review controls.", size=11.6, color=MUTED)
    add_text(ax, 84, 132, "Core claim: the model speaks only after the asset scope and evidence packet are fixed.", size=10.4, weight="bold", color=BLUE)

    metric_items = [
        (metrics["records"], "fault records"),
        (metrics["brands"], "brands"),
        (metrics["models"], "site-model maps"),
        (metrics["turbines"], "turbine IDs"),
    ]
    for i, (value, label) in enumerate(metric_items):
        draw_metric_card(ax, 1090 + i * 155, 52, value, label, width=135)
    ax.plot([82, 1718], [172, 172], color=RULE, lw=1.1)

    rounded_box(ax, 76, 214, 1648, 608, fc=WHITE, ec=RULE, lw=1.05, radius=32, z=1)
    add_text(ax, 118, 256, "Schematic overview", size=13.5, weight="bold", color=INK, zorder=3)
    add_text(ax, 118, 283, "Field context, evidence package and traceable answer.", size=8.8, color=MUTED, zorder=3)

    # Left: field and knowledge inputs.
    rounded_box(ax, 118, 330, 340, 316, fc="#F8FAFC", ec="#DCE5EE", lw=0.9, radius=24, z=2)
    add_text(ax, 150, 364, "Field signal", size=12.0, weight="bold", color=INK, zorder=4)
    add_text(ax, 150, 391, "what the operator actually provides", size=7.8, color=MUTED, zorder=4)
    ax.plot([150, 398], [417, 417], color="#DEE7F0", lw=0.9, zorder=4)
    field_rows = [
        ("Fault code", "ZC09 / 303804", BLUE),
        ("Turbine ID", "farm unit number", GREEN),
        ("Symptom", "yaw alarm, temperature, vibration", GOLD),
        ("Knowledge", "manuals, fault tables, asset maps", TEAL),
    ]
    for i, (label, value, color) in enumerate(field_rows):
        yy = 444 + i * 44
        rounded_box(ax, 150, yy, 244, 31, fc=WHITE, ec="#D8E3EE", lw=0.85, radius=14, z=5)
        ax.add_patch(Circle((172, yy + 15.5), 5.0, facecolor=color, edgecolor="none", zorder=6))
        add_text(ax, 188, yy + 10, label, size=7.6, weight="bold", color=INK, zorder=6)
        add_text(ax, 188, yy + 23, value, size=6.8, color=MUTED, zorder=6)

    # Center: evidence operating system, with a strong visual core.
    rounded_box(ax, 548, 304, 704, 366, fc=NAVY, ec=NAVY, lw=0, radius=34, z=2)
    for r, alpha in [(235, 0.10), (170, 0.10), (108, 0.13)]:
        ax.add_patch(Circle((900, 488), r, facecolor="#77BFE2", edgecolor="none", alpha=alpha, zorder=3))
    add_text(ax, 590, 350, "Evidence operating system", size=20, weight="bold", color=WHITE, zorder=5)
    add_text(ax, 592, 382, "Deterministic services package evidence before generation.", size=9.2, color="#CFE1EC", zorder=5)

    # Graph motif inside the dark core.
    graph_nodes = [(750, 466), (840, 420), (924, 486), (1014, 438), (1118, 492), (940, 568), (790, 552)]
    for a, b in [(0, 1), (1, 2), (2, 3), (3, 4), (2, 5), (5, 6), (6, 0), (1, 5)]:
        ax.plot([graph_nodes[a][0], graph_nodes[b][0]], [graph_nodes[a][1], graph_nodes[b][1]], color="#9ACBE2", lw=1.1, alpha=0.45, zorder=4)
    for i, (gx, gy) in enumerate(graph_nodes):
        col = [BLUE_MID, TEAL, GOLD, GREEN][i % 4]
        ax.add_patch(Circle((gx, gy), 12, facecolor=col, edgecolor=WHITE, lw=1.2, alpha=0.96, zorder=5))

    # Internal contract steps.
    step_y = 602
    step_specs = [("scope", GREEN), ("retrieve", BLUE_MID), ("gate", GOLD), ("generate", TEAL)]
    sx = 632
    for label, color in step_specs:
        rounded_box(ax, sx, step_y, 126, 38, fc="#173D5C", ec="#38637F", lw=0.9, radius=18, z=6)
        ax.add_patch(Circle((sx + 22, step_y + 19), 5.5, facecolor=color, edgecolor="none", zorder=7))
        add_text(ax, sx + 38, step_y + 19, label, size=8.6, weight="bold", color=WHITE, zorder=7)
        sx += 150
    for x1, x2 in [(758, 782), (908, 932), (1058, 1082)]:
        arrow(ax, (x1, step_y + 19), (x2, step_y + 19), color="#A7CFE1", lw=1.0, ms=8, alpha=0.9, z=8)

    # Orbiting controls around the core.
    controls = [
        (632, 286, "exact code", BLUE),
        (810, 256, "asset scope", GREEN),
        (992, 256, "ambiguity hold", ROSE),
        (1178, 286, "source trace", TEAL),
    ]
    for cx, cy, label, color in controls:
        rounded_box(ax, cx - 63, cy - 16, 126, 32, fc=WHITE, ec="#DCE5EF", lw=0.85, radius=16, z=6)
        ax.add_patch(Circle((cx - 41, cy), 4.8, facecolor=color, edgecolor="none", zorder=7))
        add_text(ax, cx - 27, cy, label, size=7.4, weight="bold", color=TEXT, zorder=7)
    ax.plot([696, 342, 548], [470, 470, 470], color="#D6E7F6", lw=13, solid_capstyle="round", zorder=1)
    arrow(ax, (382, 470), (548, 470), color=BLUE_MID, lw=1.8, ms=14, alpha=0.95, z=6)

    # Right: answer object.
    rounded_box(ax, 1340, 330, 300, 316, fc="#F8FAFC", ec="#DCE5EE", lw=0.9, radius=24, z=2)
    add_text(ax, 1372, 364, "Traceable answer", size=12.0, weight="bold", color=INK, zorder=4)
    add_text(ax, 1372, 391, "not just a generated paragraph", size=7.8, color=MUTED, zorder=4)
    for i, (k, v, color) in enumerate(
        [
            ("Object", "wind farm / model / unit", GREEN),
            ("Fault", "code, name, trigger", BLUE),
            ("Evidence", "source field + match reason", TEAL),
            ("Action", "handling and reset conditions", GOLD),
            ("Limit", "field verification required", ROSE),
        ]
    ):
        yy = 436 + i * 37
        ax.add_patch(Circle((1375, yy), 6, facecolor=color, edgecolor="none", zorder=5))
        add_text(ax, 1392, yy - 2, k, size=8.2, weight="bold", color=INK, zorder=5)
        add_text(ax, 1452, yy - 2, v, size=7.2, color=MUTED, zorder=5)
    rounded_box(ax, 1372, 608, 220, 24, fc=BLUE_SOFT, ec="#C9DAEB", lw=0.8, radius=12, z=4)
    add_text(ax, 1482, 620, "scope + evidence + boundary", size=7.0, weight="bold", color=BLUE, ha="center", zorder=5)
    arrow(ax, (1252, 470), (1340, 470), color=BLUE_MID, lw=1.8, ms=14, alpha=0.95, z=6)

    # Quiet feedback band.
    rounded_box(ax, 260, 720, 1280, 58, fc="#F8FAFC", ec="#E1E9F2", lw=0.9, radius=20, z=2)
    add_text(ax, 300, 749, "Reviewed feedback loop", size=9.2, weight="bold", color=INK, zorder=4)
    loop_x = 650
    for label, color in [("logs", TEAL), ("human review", BLUE), ("curate", GREEN), ("rebuild / eval", GOLD)]:
        ax.add_patch(Circle((loop_x, 749), 8, facecolor=color, edgecolor="none", zorder=4))
        add_text(ax, loop_x + 16, 749, label, size=8.1, weight="bold", color=TEXT, zorder=4)
        loop_x += 178
    arrow(ax, (1490, 646), (1260, 720), color="#91A0AF", lw=1.0, ms=9, rad=0.25, alpha=0.72, z=3)
    arrow(ax, (1166, 720), (916, 648), color=GREEN, lw=1.10, ms=9, rad=-0.14, alpha=0.78, z=3)

    rounded_box(ax, 86, 872, 1628, 58, fc=WHITE, ec=RULE, lw=1.0, radius=18, z=2)
    add_text(ax, 118, 901, "Boundary", size=9.5, weight="bold", color=ROSE, zorder=3)
    add_text(
        ax,
        198,
        901,
        "Windrise supports field diagnosis and knowledge handoff; HMI/SCADA data, safety rules and OEM documents remain the operational authority.",
        size=8.8,
        color=MUTED,
        zorder=3,
    )

    fig.savefig(ARCH_SVG, format="svg", bbox_inches="tight", pad_inches=0.04, metadata={"Date": None})
    fig.savefig(ARCH_PNG, format="png", dpi=220, bbox_inches="tight", pad_inches=0.04, metadata={"Software": "matplotlib"})
    plt.close(fig)
    clean_svg(ARCH_SVG)


def add_banner_flow_line(ax, x0, y0, x1, y1, color, alpha=0.35, lw=1.2):
    xs = np.linspace(x0, x1, 160)
    ys = np.linspace(y0, y1, 160) + np.sin(np.linspace(0, np.pi * 2.4, 160)) * 8
    ax.plot(xs, ys, color=color, lw=lw, alpha=alpha, zorder=2)


def draw_banner(metrics: dict[str, str]) -> None:
    width, height = 1600, 480
    fig = plt.figure(figsize=(16, 4.8), facecolor=NAVY)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, width)
    ax.set_ylim(height, 0)
    ax.axis("off")

    x = np.linspace(0, 1, width)
    y = np.linspace(0, 1, height)
    xx, yy = np.meshgrid(x, y)
    base = np.zeros((height, width, 3))
    left = np.array([10, 31, 47]) / 255
    right = np.array([18, 58, 84]) / 255
    for i in range(3):
        base[:, :, i] = left[i] * (1 - xx) + right[i] * xx
    glow = np.exp(-((xx - 0.78) ** 2 / 0.030 + (yy - 0.38) ** 2 / 0.22))
    base[:, :, 1] += glow * 0.10
    base[:, :, 2] += glow * 0.13
    ax.imshow(np.clip(base, 0, 1), extent=[0, width, height, 0], zorder=0)

    for yy0 in [108, 152, 204, 262]:
        add_banner_flow_line(ax, 790, yy0, 1515, yy0 + 28, "#A5D6D9", alpha=0.11, lw=1.0)
    ax.add_patch(Polygon([(0, 400), (235, 374), (520, 389), (790, 360), (1110, 383), (1600, 342), (1600, 480), (0, 480)], fc="#0B1C28", ec="none", alpha=0.76, zorder=1))
    ax.add_patch(Polygon([(0, 435), (300, 408), (650, 424), (1020, 392), (1600, 414), (1600, 480), (0, 480)], fc="#091720", ec="none", alpha=0.82, zorder=2))

    for cx, cy, sc, alpha in [(1170, 388, 0.70, 0.40), (1332, 364, 0.96, 0.78), (1476, 396, 0.61, 0.38)]:
        draw_turbine(ax, cx, cy, sc, color="#DCEFF6", alpha=alpha, z=4)

    # Glass product motif on the right.
    rounded_box(ax, 928, 104, 556, 186, fc="#F7FBFE", ec="#83AFC3", lw=0.8, radius=30, alpha=0.13, z=3)
    add_text(ax, 972, 139, "Evidence packet", size=12.5, weight="bold", color="#EFF8FB", zorder=5)
    add_text(ax, 972, 165, "asset scope  ·  fault semantics  ·  source trace", size=8.8, color="#BFD6DE", zorder=5)
    px = 998
    for label, color in [("scope", GREEN), ("evidence", BLUE_MID), ("gates", GOLD), ("answer", TEAL)]:
        ax.add_patch(Circle((px, 226), 20, facecolor=color, edgecolor="#DAEEF5", lw=1.0, zorder=5))
        add_text(ax, px, 226, label[0].upper(), size=10.0, weight="bold", color=WHITE, ha="center", zorder=6)
        add_text(ax, px, 263, label, size=7.8, weight="bold", color="#D8E7EC", ha="center", zorder=6)
        px += 126
    for x1, x2 in [(1018, 1104), (1144, 1230), (1270, 1356)]:
        arrow(ax, (x1, 226), (x2, 226), color="#A7D3DE", lw=1.0, ms=9, alpha=0.76, z=6)

    ax.add_patch(Rectangle((78, 68), 8, 28, facecolor="#8ED6AF", edgecolor="none", zorder=5))
    add_text(ax, 108, 81, "WIND ENERGY / OPERATIONS INTELLIGENCE", size=15.5, color="#C5D5D2", va="center", zorder=5)
    add_text(ax, 78, 177, "Windrise", size=80, weight="bold", color=WHITE, zorder=5)
    add_text(ax, 84, 248, "Evidence-grounded intelligence for wind turbine operations.", size=18.5, color="#D6E1DF", zorder=5)
    add_text(ax, 84, 286, "面向风电运维现场的本地知识智能体", size=17.0, color="#A8E0C2", weight="bold", zorder=5)

    ax.plot([82, 700], [332, 332], color="#6E8792", lw=1.0, alpha=0.45, zorder=5)
    for bx, (num, label) in zip(
        [82, 370, 668],
        [("01", "LOCAL INFERENCE"), ("02", "TRACEABLE KNOWLEDGE"), ("03", "CONTEXT ROUTING")],
    ):
        add_text(ax, bx, 386, num, size=11.0, weight="bold", color="#8ED6AF", zorder=5)
        add_text(ax, bx + 42, 386, label, size=11.0, color=WHITE, zorder=5)

    draw_metric_card(ax, 1016, 332, metrics["records"], "fault records", width=126, dark=True)
    draw_metric_card(ax, 1160, 332, metrics["brands"], "brands", width=98, dark=True)
    draw_metric_card(ax, 1276, 332, metrics["models"], "site maps", width=108, dark=True)
    draw_metric_card(ax, 1402, 332, metrics["turbines"], "turbines", width=118, dark=True)

    fig.savefig(BANNER_PNG, format="png", dpi=200, bbox_inches="tight", pad_inches=0, metadata={"Software": "matplotlib"})
    plt.close(fig)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    metrics = load_metrics()
    draw_architecture(metrics)
    draw_banner(metrics)
    print(f"font={FONT}")
    print(f"wrote={ARCH_SVG.relative_to(ROOT)}")
    print(f"wrote={ARCH_PNG.relative_to(ROOT)}")
    print(f"wrote={BANNER_PNG.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
