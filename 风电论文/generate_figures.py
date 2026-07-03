#!/usr/bin/env python3
from __future__ import annotations

import json
from math import atan2, cos, log10, sin
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUT = Path(__file__).parent / "figures"
OUT.mkdir(exist_ok=True)

# Nature-style figure palette: high-contrast black/grey with sparse muted accents.
INK = (0.06, 0.06, 0.06)
MUTED = (0.32, 0.32, 0.32)
RULE = (0.78, 0.78, 0.78)
BLUE = (0.18, 0.36, 0.56)
TEAL = (0.10, 0.52, 0.48)
GOLD = (0.66, 0.48, 0.16)
GREEN = (0.25, 0.50, 0.34)
RED = (0.62, 0.28, 0.22)
PURPLE = (0.40, 0.36, 0.62)
WHITE = (1, 1, 1)


def esc(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


class Pdf:
    def __init__(self, width: float, height: float):
        self.width = width
        self.height = height
        self.ops: list[str] = []

    def _rgb(self, color, stroke=True):
        op = "RG" if stroke else "rg"
        self.ops.append(f"{color[0]:.3f} {color[1]:.3f} {color[2]:.3f} {op}")

    def line(self, x1, y1, x2, y2, color=MUTED, lw=0.7):
        self._rgb(color, True)
        self.ops.append(f"{lw:.2f} w {x1:.2f} {y1:.2f} m {x2:.2f} {y2:.2f} l S")

    def rect(self, x, y, w, h, edge=INK, fill=WHITE, lw=0.7):
        self._rgb(fill, False)
        self.ops.append(f"{x:.2f} {y:.2f} {w:.2f} {h:.2f} re f")
        self._rgb(edge, True)
        self.ops.append(f"{lw:.2f} w {x:.2f} {y:.2f} {w:.2f} {h:.2f} re S")

    def filled_rect(self, x, y, w, h, fill=BLUE):
        self._rgb(fill, False)
        self.ops.append(f"{x:.2f} {y:.2f} {w:.2f} {h:.2f} re f")

    def circle(self, x, y, r, edge=INK, fill=WHITE, lw=0.7):
        c = 0.5522847498 * r
        self._rgb(fill, False)
        self.ops.append(
            f"{x+r:.2f} {y:.2f} m "
            f"{x+r:.2f} {y+c:.2f} {x+c:.2f} {y+r:.2f} {x:.2f} {y+r:.2f} c "
            f"{x-c:.2f} {y+r:.2f} {x-r:.2f} {y+c:.2f} {x-r:.2f} {y:.2f} c "
            f"{x-r:.2f} {y-c:.2f} {x-c:.2f} {y-r:.2f} {x:.2f} {y-r:.2f} c "
            f"{x+c:.2f} {y-r:.2f} {x+r:.2f} {y-c:.2f} {x+r:.2f} {y:.2f} c f"
        )
        self._rgb(edge, True)
        self.ops.append(
            f"{lw:.2f} w {x+r:.2f} {y:.2f} m "
            f"{x+r:.2f} {y+c:.2f} {x+c:.2f} {y+r:.2f} {x:.2f} {y+r:.2f} c "
            f"{x-c:.2f} {y+r:.2f} {x-r:.2f} {y+c:.2f} {x-r:.2f} {y:.2f} c "
            f"{x-r:.2f} {y-c:.2f} {x-c:.2f} {y-r:.2f} {x:.2f} {y-r:.2f} c "
            f"{x+c:.2f} {y-r:.2f} {x+r:.2f} {y-c:.2f} {x+r:.2f} {y:.2f} c S"
        )

    def text(self, x, y, text, size=7, color=INK, bold=False, align="left", leading=1.2):
        font = "F2" if bold else "F1"
        lines = text.split("\n")
        for i, line in enumerate(lines):
            tx = x
            if align != "left":
                tx = x - len(line) * size * (0.25 if align == "center" else 0.5)
            self._rgb(color, False)
            self.ops.append(f"BT /{font} {size:.2f} Tf {tx:.2f} {y - i * size * leading:.2f} Td ({esc(line)}) Tj ET")

    def label(self, x, y, label):
        self.text(x, y, label, size=10, color=INK, bold=True)

    def arrow(self, x1, y1, x2, y2, color=MUTED, lw=0.7):
        self.line(x1, y1, x2, y2, color, lw)
        angle = atan2(y2 - y1, x2 - x1)
        size = 4.0
        a1 = angle + 2.65
        a2 = angle - 2.65
        p1 = (x2 + size * cos(a1), y2 + size * sin(a1))
        p2 = (x2 + size * cos(a2), y2 + size * sin(a2))
        self._rgb(color, False)
        self.ops.append(f"{x2:.2f} {y2:.2f} m {p1[0]:.2f} {p1[1]:.2f} l {p2[0]:.2f} {p2[1]:.2f} l f")

    def node(self, x, y, w, h, text, edge=RULE, size=6.6):
        self.rect(x, y, w, h, edge=edge, fill=WHITE, lw=0.55)
        lines = text.split("\n")
        total = (len(lines) - 1) * size * 1.15
        self.text(x + w / 2, y + h / 2 + total / 2 - size * 0.35, text, size=size, color=INK, align="center")

    def save(self, path: Path):
        stream = "\n".join(self.ops).encode("latin-1", "replace")
        objects: list[bytes] = []
        objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
        objects.append(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {self.width:.2f} {self.height:.2f}] "
            f"/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>".encode()
        )
        objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
        objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>")
        objects.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream")
        offsets = []
        data = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        for i, obj in enumerate(objects, 1):
            offsets.append(len(data))
            data.extend(f"{i} 0 obj\n".encode())
            data.extend(obj)
            data.extend(b"\nendobj\n")
        xref = len(data)
        data.extend(f"xref\n0 {len(objects)+1}\n0000000000 65535 f \n".encode())
        for off in offsets:
            data.extend(f"{off:010d} 00000 n \n".encode())
        data.extend(f"trailer << /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
        path.write_bytes(data)


def load_mechanism_eval():
    path = ROOT / "generated-knowledge" / "windrise-mechanism-graph-evaluation.json"
    return json.loads(path.read_text(encoding="utf-8"))


def percent(value):
    return f"{value * 100:.0f}%"


def bar_chart(p, x0, y0, w, h, labels, values, colors, max_value=None, value_suffix="", label_size=5.4):
    max_value = max_value or max(values) or 1
    p.line(x0, y0, x0 + w, y0, INK, 0.55)
    p.line(x0, y0, x0, y0 + h, INK, 0.55)
    slot = w / len(values)
    bar_w = min(22, slot * 0.55)
    for i, (label, value, color) in enumerate(zip(labels, values, colors)):
        bh = h * value / max_value
        x = x0 + slot * i + (slot - bar_w) / 2
        p.filled_rect(x, y0, bar_w, bh, color)
        shown = f"{value:.0f}{value_suffix}" if value_suffix else f"{value:.0f}"
        p.text(x + bar_w / 2, y0 + bh + 7, shown, size=5.1, color=INK, align="center")
        p.text(x + bar_w / 2, y0 - 10, label, size=label_size, color=MUTED, align="center")


def nature_figure_1_system_architecture():
    p = Pdf(520, 330)
    p.label(18, 304, "a")
    p.text(42, 304, "Evidence-grounded O&M architecture", size=8.5, bold=True)
    layers = [
        ("Data", 252, BLUE, ["Fault-code\ntables", "Manuals /\nreports", "Work\norders", "File\nsnapshot"]),
        ("Knowledge", 196, TEAL, ["Scope\nnormalization", "Fault\nentries", "Mechanism\ntemplates", "Graph +\nwiki"]),
        ("Reasoning", 140, GOLD, ["Intent\nrouting", "Hybrid\nretrieval", "Strategy\nchain", "Evidence\npacket"]),
        ("Applications", 84, PURPLE, ["Web /\nCLI", "Multi-turn\nrepair", "Evidence\nbacktrack", "On-premise\nservice"]),
    ]
    xs = [50, 128, 206, 284]
    for title, y, color, items in layers:
        p.line(42, y + 37, 358, y + 37, RULE, 0.6)
        p.text(42, y + 45, title, size=7.2, color=INK, bold=True)
        for x, item in zip(xs, items):
            p.node(x, y, 58, 30, item, edge=color, size=5.9)
        for i in range(3):
            p.arrow(xs[i] + 58, y + 15, xs[i + 1] - 3, y + 15)
    for x in [79, 157, 235, 313]:
        p.arrow(x, 252, x, 226)
        p.arrow(x, 196, x, 170)
        p.arrow(x, 140, x, 114)
    p.line(58, 54, 344, 54, INK, 0.55)
    p.text(185, 42, "local / intranet boundary", size=6.4, color=MUTED, align="center")

    p.label(382, 304, "b")
    p.text(402, 304, "Evidence-bound generation", size=8.2, bold=True)
    p.node(385, 250, 54, 28, "User\nquestion", edge=INK, size=5.8)
    p.node(458, 250, 54, 28, "Evidence\npacket", edge=TEAL, size=5.8)
    p.arrow(439, 264, 458, 264)
    p.node(385, 202, 54, 28, "LLM\nstrategy", edge=GOLD, size=5.8)
    p.node(458, 202, 54, 28, "Answer +\nsource path", edge=BLUE, size=5.8)
    p.arrow(412, 250, 412, 230)
    p.arrow(439, 216, 458, 216)
    p.text(385, 171, "Retrieved facts define the\nanswerable maintenance state.", size=6.2, color=MUTED)

    p.label(382, 132, "c")
    p.text(402, 132, "Knowledge-base scale", size=8.2, bold=True)
    labels = ["rec.", "nodes", "edges", "codes", "src.", "model", "farm", "temp."]
    vals = [11865, 22680, 79474, 4849, 8295, 66, 29, 12]
    max_log = log10(max(vals))
    x0, y0, bw = 382, 36, 11
    p.line(x0, y0, 508, y0, INK, 0.5)
    p.line(x0, y0, x0, 112, INK, 0.5)
    for i, (lab, val) in enumerate(zip(labels, vals)):
        h = 70 * log10(val) / max_log
        x = x0 + 10 + i * 14
        p.filled_rect(x, y0, bw, h, fill=[TEAL, BLUE, BLUE, GOLD, TEAL, MUTED, MUTED, GOLD][i])
        p.text(x - 1, y0 - 9, lab, size=4.8, color=MUTED)
    p.text(x0 - 13, 76, "log count", size=5.2, color=MUTED)
    p.save(OUT / "fig_system_architecture.pdf")


def nature_figure_2_knowledge_build_flow():
    p = Pdf(520, 230)
    p.label(18, 206, "a")
    p.text(42, 206, "Document-to-knowledge pipeline", size=8.5, bold=True)
    steps = [
        ("Ingest\nfiles", BLUE),
        ("Extract\ntext", BLUE),
        ("Normalize\naliases", TEAL),
        ("Build\nrelations", TEAL),
        ("Attach\nmechanisms", GOLD),
        ("Generate\nindex/wiki", GOLD),
    ]
    x0, y = 36, 132
    for i, (txt, color) in enumerate(steps):
        x = x0 + i * 62
        p.text(x + 22, y + 43, f"S{i+1}", size=6.8, color=color, bold=True, align="center")
        p.node(x, y, 44, 32, txt, edge=color, size=5.7)
        if i:
            p.arrow(x - 15, y + 16, x - 2, y + 16)
    outputs = [("fault index", 92), ("graph", 216), ("mechanisms", 278), ("wiki pages", 340)]
    for txt, x in outputs:
        p.node(x, 52, 50, 22, txt, edge=RULE, size=5.7)
        p.arrow(x + 25, 132, x + 25, 74)
    p.text(42, 28, "All generated artefacts preserve provenance metadata for later audit.", size=6.5, color=MUTED)

    p.label(390, 206, "b")
    p.text(410, 206, "Quality controls", size=8.5, bold=True)
    controls = [("scope\ncheck", TEAL), ("evidence\ncheck", BLUE), ("mechanism\ncheck", GOLD), ("human\naudit", PURPLE)]
    coords = [(390, 146), (458, 146), (390, 86), (458, 86)]
    for (txt, color), (x, yy) in zip(controls, coords):
        p.node(x, yy, 48, 32, txt, edge=color, size=5.8)
    p.arrow(438, 162, 458, 162)
    p.arrow(482, 146, 482, 118)
    p.arrow(458, 102, 438, 102)
    p.arrow(414, 118, 414, 146)
    p.save(OUT / "fig_knowledge_build_flow.pdf")


def nature_figure_3_domain_relationship():
    p = Pdf(520, 260)
    p.label(18, 236, "a")
    p.text(42, 236, "Model-constrained fault semantics", size=8.5, bold=True)
    nodes = {
        "Wind\nfarm": (44, 178, INK),
        "Turbine\nmodel": (126, 178, INK),
        "Fault\ncode": (208, 126, GOLD),
        "System": (126, 72, INK),
        "Component": (208, 50, INK),
        "Cause": (306, 180, RED),
        "Action": (318, 118, GREEN),
        "Source\ndocument": (306, 50, BLUE),
    }
    centers = {}
    for txt, (x, y, color) in nodes.items():
        p.node(x, y, 54, 30, txt, edge=color, size=5.8)
        centers[txt] = (x + 27, y + 15)
    links = [
        ("Wind\nfarm", "Turbine\nmodel"),
        ("Turbine\nmodel", "Fault\ncode"),
        ("Fault\ncode", "System"),
        ("System", "Component"),
        ("Fault\ncode", "Cause"),
        ("Fault\ncode", "Action"),
        ("Fault\ncode", "Source\ndocument"),
        ("Cause", "Action"),
    ]
    for a, b in links:
        p.arrow(*centers[a], *centers[b])

    p.label(390, 236, "b")
    p.text(410, 236, "Ambiguity resolution", size=8.5, bold=True)
    p.node(396, 178, 58, 30, "Fault code\n303804", edge=GOLD, size=5.8)
    p.node(396, 108, 58, 30, "Farm/model\ncontext", edge=TEAL, size=5.8)
    p.node(466, 178, 42, 30, "multiple\nscopes", edge=RED, size=5.8)
    p.node(466, 108, 42, 30, "scoped\nmatch", edge=GREEN, size=5.8)
    p.arrow(454, 193, 466, 193)
    p.arrow(454, 123, 466, 123)
    p.arrow(487, 178, 487, 138, RED)
    p.text(392, 70, "If scope is missing, the system asks\nfor a disambiguating condition.", size=6.1, color=MUTED)
    p.save(OUT / "fig_domain_relationship.pdf")


def nature_figure_4_troubleshooting_loop():
    p = Pdf(520, 250)
    p.label(18, 226, "a")
    p.text(42, 226, "Stateful field troubleshooting", size=8.5, bold=True)
    steps = [
        ("Question /\nalarm", 42, 166, INK),
        ("Scope\nbinding", 128, 166, TEAL),
        ("Evidence\nretrieval", 214, 166, BLUE),
        ("One-step\naction", 300, 166, GOLD),
        ("Short\nfeedback", 300, 84, RED),
        ("State\nupdate", 214, 84, TEAL),
        ("Next\nbranch", 128, 84, GREEN),
    ]
    centers = []
    for txt, x, y, color in steps:
        p.node(x, y, 55, 32, txt, edge=color, size=5.8)
        centers.append((x + 27.5, y + 16))
    for i in range(3):
        p.arrow(*centers[i], *centers[i + 1])
    p.arrow(*centers[3], *centers[4])
    p.arrow(*centers[4], *centers[5])
    p.arrow(*centers[5], *centers[6])
    p.arrow(*centers[6], *centers[1])
    p.text(42, 50, "Retained state prevents terse field replies from being treated as unrelated questions.", size=6.3, color=MUTED)

    p.label(390, 226, "b")
    p.text(410, 226, "Answer contract", size=8.5, bold=True)
    rows = ["Fault meaning", "Applicable scope", "Likely mechanism", "Verify one action", "Acceptance criterion", "Evidence path"]
    colors = [BLUE, TEAL, GOLD, GREEN, MUTED, PURPLE]
    for i, (row, color) in enumerate(zip(rows, colors), 1):
        y = 190 - (i - 1) * 24
        p.text(398, y, str(i), size=7, color=color, bold=True)
        p.line(418, y + 2, 506, y + 2, RULE, 0.6)
        p.text(422, y, row, size=6.4, color=INK)
    p.save(OUT / "fig_troubleshooting_loop.pdf")


def nature_figure_5_knowledge_scale():
    p = Pdf(420, 230)
    p.label(18, 206, "a")
    p.text(42, 206, "Knowledge-base coverage", size=8.5, bold=True)
    labels = ["records", "nodes", "edges", "codes", "sources", "models", "farms", "systems", "templates"]
    vals = [11865, 22680, 79474, 4849, 8295, 66, 29, 18, 12]
    colors = [TEAL, BLUE, BLUE, GOLD, TEAL, MUTED, MUTED, MUTED, GOLD]
    x0, y0, w, h = 48, 48, 320, 130
    p.line(x0, y0, x0 + w, y0, INK, 0.55)
    p.line(x0, y0, x0, y0 + h, INK, 0.55)
    max_log = log10(max(vals))
    for i, (lab, val, color) in enumerate(zip(labels, vals, colors)):
        bh = h * log10(val) / max_log
        x = x0 + 15 + i * 32
        p.filled_rect(x, y0, 18, bh, color)
        p.text(x - 2, y0 - 12, lab, size=5, color=MUTED)
        p.text(x + 9, y0 + bh + 6, f"{val:,}", size=4.8, color=INK, align="center")
    p.text(18, 118, "log count", size=6, color=MUTED)
    p.save(OUT / "fig_knowledge_scale.pdf")


def nature_figure_6_mechanism_ablation():
    data = load_mechanism_eval()
    base = data["baseline"]
    mech = data["mechanism"]
    p = Pdf(520, 260)
    p.label(18, 236, "a")
    p.text(42, 236, "Structural closure after mechanism enhancement", size=8.5, bold=True)
    metrics = [
        ("profile", base["complete_profile_rate"], mech["profile_complete_rate"]),
        ("validation", base["validation_closure_rate"], mech["validation_closure_rate"]),
        ("prevention", base["prevention_closure_rate"], mech["prevention_closure_rate"]),
        ("hypothesis", 0, mech["discrimination_coverage_rate"]),
    ]
    x0, y0, h = 58, 56, 142
    p.line(x0, y0, 348, y0, INK, 0.55)
    p.line(x0, y0, x0, y0 + h, INK, 0.55)
    p.text(26, 132, "coverage", size=6, color=MUTED)
    for i, (label, b, m) in enumerate(metrics):
        x = x0 + 30 + i * 67
        p.filled_rect(x, y0, 18, h * b, MUTED)
        p.filled_rect(x + 22, y0, 18, h * m, TEAL)
        p.text(x + 9, y0 + h * b + 7, percent(b), size=5, color=MUTED, align="center")
        p.text(x + 31, y0 + h * m + 7, percent(m), size=5, color=INK, align="center")
        p.text(x + 20, y0 - 11, label, size=5.5, color=MUTED, align="center")
    p.filled_rect(248, 222, 8, 8, MUTED)
    p.text(260, 222, "baseline", size=5.8, color=MUTED)
    p.filled_rect(302, 222, 8, 8, TEAL)
    p.text(314, 222, "mechanism graph", size=5.8, color=MUTED)

    p.label(382, 236, "b")
    p.text(402, 236, "Discrimination design", size=8.5, bold=True)
    total = mech["discriminated_case_count"]
    pairwise = 18
    single = 15
    p.circle(450, 158, 52, edge=RULE, fill=WHITE, lw=0.7)
    p.filled_rect(400, 112, 48, 92, BLUE)
    p.filled_rect(448, 112, 40, 92, GOLD)
    p.text(424, 160, f"{pairwise}\npairwise", size=7, color=WHITE, bold=True, align="center")
    p.text(468, 160, f"{single}\nsingle", size=7, color=WHITE, bold=True, align="center")
    p.text(450, 86, f"{total}/33 cases with falsifiable hypotheses", size=6.1, color=INK, align="center")
    p.text(392, 58, "Pairwise hypotheses separate competing\nmechanisms; single-mechanism hypotheses\nseparate true faults from pseudo-causes.", size=5.8, color=MUTED)
    p.save(OUT / "fig_mechanism_ablation.pdf")


def nature_figure_7_mechanism_graph_composition():
    data = load_mechanism_eval()
    node_types = data["mechanism"]["node_types"]
    relation_types = data["mechanism"]["relation_types"]
    p = Pdf(520, 300)
    p.label(18, 276, "a")
    p.text(42, 276, "Mechanism node composition", size=8.5, bold=True)
    node_items = [
        ("arch.", node_types["mechanism_archetype"], MUTED),
        ("layer", node_types["mechanism_layer"], TEAL),
        ("prop.", node_types["propagation_step"], BLUE),
        ("failure", node_types["failure_mode"], RED),
        ("obs.", node_types["observable"], GREEN),
        ("test", node_types["verification_test"], GOLD),
        ("barrier", node_types["control_barrier"], PURPLE),
        ("hyp.", node_types["diagnostic_hypothesis"], INK),
        ("evid.", node_types["discriminating_evidence"], TEAL),
        ("cf.test", node_types["counterfactual_test"], GOLD),
        ("rule", node_types["decision_rule"], BLUE),
    ]
    bar_chart(
        p,
        42,
        62,
        438,
        170,
        [item[0] for item in node_items],
        [item[1] for item in node_items],
        [item[2] for item in node_items],
        max_value=240,
        label_size=4.9,
    )
    p.text(18, 144, "count", size=6, color=MUTED)

    p.label(18, 32, "b")
    p.text(42, 32, "Relation distribution is dominated by propagation, layer, observable, and validation edges.", size=6.2, color=MUTED)
    top_rel = sorted(relation_types.items(), key=lambda item: item[1], reverse=True)[:8]
    x, y = 310, 35
    for i, (name, count) in enumerate(top_rel):
        yy = y - i * 14
        p.filled_rect(x, yy - 5, min(96, count / top_rel[0][1] * 96), 7, [TEAL, BLUE, GOLD, GREEN, RED, PURPLE, MUTED, INK][i % 8])
        p.text(x + 102, yy - 4, f"{name.replace('_', ' ')} ({count})", size=4.8, color=MUTED)
    p.save(OUT / "fig_mechanism_graph_composition.pdf")


def nature_figure_8_case_quality_distribution():
    data = load_mechanism_eval()
    cases = data["case_metrics"]
    p = Pdf(520, 240)
    p.label(18, 216, "a")
    p.text(42, 216, "Per-case mechanism quality", size=8.5, bold=True)
    scores = [case["mechanism_score"] for case in cases]
    depths = [case["max_mechanism_depth"] for case in cases]
    bins = [(80, 85), (85, 90), (90, 95), (95, 100)]
    counts = []
    for lo, hi in bins:
        counts.append(sum(1 for score in scores if lo <= score < hi))
    bar_chart(
        p,
        56,
        58,
        188,
        130,
        [f"{lo}-{hi}" for lo, hi in bins],
        counts,
        [BLUE, TEAL, GOLD, GREEN],
        max_value=max(counts) or 1,
        label_size=5.1,
    )
    p.text(28, 124, "cases", size=6, color=MUTED)
    p.text(150, 36, "mechanism score", size=6, color=MUTED, align="center")

    p.label(286, 216, "b")
    p.text(310, 216, "Depth and closure", size=8.5, bold=True)
    p.node(294, 156, 54, 30, "case", edge=INK, size=6.2)
    p.node(372, 156, 54, 30, "mechanism\nchain", edge=TEAL, size=5.8)
    p.node(450, 156, 54, 30, "verification\nclosure", edge=GOLD, size=5.8)
    p.arrow(348, 171, 372, 171)
    p.arrow(426, 171, 450, 171)
    p.text(398, 116, f"average depth = {sum(depths)/len(depths):.2f}", size=7, color=INK, align="center")
    p.text(398, 94, f"max depth = {max(depths)}", size=7, color=INK, align="center")
    p.text(398, 70, "33/33 cases have observable,\nverification, and control barrier.", size=6.1, color=MUTED, align="center")
    p.save(OUT / "fig_case_quality_distribution.pdf")


if __name__ == "__main__":
    nature_figure_1_system_architecture()
    nature_figure_2_knowledge_build_flow()
    nature_figure_3_domain_relationship()
    nature_figure_4_troubleshooting_loop()
    nature_figure_5_knowledge_scale()
    nature_figure_6_mechanism_ablation()
    nature_figure_7_mechanism_graph_composition()
    nature_figure_8_case_quality_distribution()
