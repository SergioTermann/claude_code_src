#!/usr/bin/env python3
"""Regenerate fig_knowledge_scale.pdf from the current knowledge-base scale.

The figure is a single-column horizontal bar chart on a logarithmic x-axis,
matching the numbers reported in Table I (Knowledge-Base Scale) of the paper.
Run from the paper directory:

    python3 regenerate_scale_figure.py

Requires matplotlib.
"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# (short label, count) in the same order as Table I of the manuscript.
ITEMS = [
    ("Raw fault records", 14_118),
    ("Graph nodes", 38_926),
    ("Graph relations", 118_012),
    ("Fault-code nodes", 10_804),
    ("Fault-name nodes", 12_024),
    ("Source-document nodes", 9_435),
    ("Brands", 12),
    ("Systems", 40),
    ("Components", 28),
    ("Wind-farm model configs", 28),
    ("Turbine-number mappings", 1_265),
    ("Mechanism templates", 12),
]

labels = [name for name, _ in ITEMS]
values = [value for _, value in ITEMS]

fig, ax = plt.subplots(figsize=(3.5, 3.4))
y = list(range(len(ITEMS)))[::-1]

bars = ax.barh(y, values, height=0.6, color="#2b6cb0", edgecolor="none")

ax.set_yticks(y)
ax.set_yticklabels(labels, fontsize=7)
ax.set_xscale("log")
ax.set_xlim(1, 1_000_000)
ax.set_xlabel("Count (log scale)", fontsize=8)
ax.tick_params(axis="x", labelsize=7)
ax.tick_params(axis="y", labelsize=7)

# Value labels at the end of each bar.
for yi, value in zip(y, values):
    ax.text(value, yi, f" {value:,}", va="center", ha="left", fontsize=6.5)

ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)

fig.tight_layout()
out = "figures/fig_knowledge_scale.pdf"
fig.savefig(out, bbox_inches="tight", dpi=300)
print(f"wrote {out}")
