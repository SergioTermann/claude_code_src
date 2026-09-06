#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

import json
from pathlib import Path

import matplotlib as mpl
import matplotlib.font_manager as fm
import matplotlib.pyplot as plt
from matplotlib.patches import Circle, FancyArrowPatch, FancyBboxPatch, Polygon
from matplotlib.path import Path as MplPath
from matplotlib.patches import PathPatch


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "assets" / "readme"
SVG_OUT = OUT_DIR / "windrise-architecture.svg"
PNG_OUT = OUT_DIR / "windrise-architecture.png"

W, H = 1600, 1080

INK = "#172033"
MUTED = "#586474"
FAINT = "#8A97A6"
BG = "#F7F9FB"
PANEL = "#FFFFFF"
RULE = "#D8E0E8"
BLUE = "#0F4D92"
BLUE_2 = "#3775BA"
TEAL = "#42949E"
GREEN = "#2E9E44"
ROSE = "#B64342"
GOLD = "#C58A21"
P_BLUE = "#EAF4FF"
P_GREEN = "#EAF7EF"
P_GOLD = "#FFF4DE"
P_PURPLE = "#F0ECFF"
P_ROSE = "#FDECEC"


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
        "font.sans-serif": [FONT, "Arial", "DejaVu Sans", "sans-serif"],
        "svg.fonttype": "none",
        "pdf.fonttype": 42,
        "font.size": 8,
        "axes.spines.right": False,
        "axes.spines.top": False,
        "legend.frameon": False,
    }
)


def load_metrics() -> dict[str, str]:
    summary_path = ROOT / "wind-llmwiki" / "fault-index-summary.json"
    wind_models_path = ROOT / "src" / "data" / "windFarmModels.json"
    turbine_path = ROOT / "src" / "data" / "turbineMapping.json"

    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    wind_models = json.loads(wind_models_path.read_text(encoding="utf-8"))
    turbine_mapping = json.loads(turbine_path.read_text(encoding="utf-8"))

    return {
        "records": f"{summary['recordCount']:,}",
        "brands": f"{len(summary.get('byBrand', {})):,}",
        "models": f"{len(wind_models):,}",
        "turbines": f"{len(turbine_mapping):,}",
    }


def add_text(ax, x, y, text, size=12, weight="normal", color=INK, ha="left", va="center", **kwargs):
    return ax.text(
        x,
        y,
        text,
        fontsize=size,
        fontweight=weight,
        color=color,
        ha=ha,
        va=va,
        linespacing=1.25,
        **kwargs,
    )


def round_box(ax, x, y, w, h, fc=PANEL, ec=RULE, lw=1.2, radius=16, shadow=True, z=2):
    if shadow:
        ax.add_patch(
            FancyBboxPatch(
                (x + 5, y + 7),
                w,
                h,
                boxstyle=f"round,pad=0.012,rounding_size={radius}",
                linewidth=0,
                facecolor="#0F172A",
                alpha=0.08,
                zorder=z - 1,
            )
        )
    patch = FancyBboxPatch(
        (x, y),
        w,
        h,
        boxstyle=f"round,pad=0.012,rounding_size={radius}",
        linewidth=lw,
        edgecolor=ec,
        facecolor=fc,
        zorder=z,
    )
    ax.add_patch(patch)
    return patch


def panel(ax, x, y, w, h, letter, title, subtitle):
    round_box(ax, x, y, w, h, fc=PANEL, ec=RULE, lw=1.3, radius=22, shadow=True, z=1)
    ax.add_patch(Circle((x + 30, y + 32), 15, facecolor=INK, edgecolor="none", zorder=3))
    add_text(ax, x + 30, y + 32, letter, size=13, weight="bold", color="white", ha="center", va="center", zorder=4)
    add_text(ax, x + 56, y + 30, title, size=18, weight="bold", color=INK, zorder=4)
    add_text(ax, x + 56, y + 57, subtitle, size=10, color=MUTED, zorder=4)
    ax.plot([x + 28, x + w - 28], [y + 82, y + 82], color=RULE, lw=1, ls=(0, (3, 5)), zorder=2)


def card(ax, x, y, w, h, title, lines, fc=P_BLUE, ec="#BFD5EA", accent=BLUE, title_size=13):
    round_box(ax, x, y, w, h, fc=fc, ec=ec, lw=1.15, radius=13, shadow=False, z=4)
    ax.add_patch(
        FancyBboxPatch(
            (x, y),
            8,
            h,
            boxstyle="round,pad=0.012,rounding_size=12",
            linewidth=0,
            facecolor=accent,
            zorder=5,
        )
    )
    if h <= 55:
        title_y, body_y, body_gap, body_size = y + 18, y + 36, 15, 8.4
    elif h <= 72:
        title_y, body_y, body_gap, body_size = y + 21, y + 43, 16, 8.7
    else:
        title_y, body_y, body_gap, body_size = y + 24, y + 48, 17, 8.8
    add_text(ax, x + 18, title_y, title, size=title_size, weight="bold", color=INK, zorder=6)
    for i, line in enumerate(lines):
        add_text(ax, x + 18, body_y + i * body_gap, line, size=body_size, color=MUTED, zorder=6)


def pill(ax, x, y, w, h, text, fc="#EEF2F7", ec=RULE, color=INK, size=9.5):
    round_box(ax, x, y, w, h, fc=fc, ec=ec, lw=1, radius=h / 2, shadow=False, z=6)
    add_text(ax, x + w / 2, y + h / 2, text, size=size, weight="bold", color=color, ha="center", va="center", zorder=7)


def arrow(ax, start, end, color="#4B5D70", lw=1.7, rad=0.0, ms=12, z=10, style="-|>"):
    ax.add_patch(
        FancyArrowPatch(
            start,
            end,
            arrowstyle=style,
            mutation_scale=ms,
            linewidth=lw,
            color=color,
            connectionstyle=f"arc3,rad={rad}",
            shrinkA=3,
            shrinkB=4,
            zorder=z,
        )
    )


def diamond(ax, cx, cy, w, h, title, lines):
    pts = [(cx, cy - h / 2), (cx + w / 2, cy), (cx, cy + h / 2), (cx - w / 2, cy)]
    ax.add_patch(Polygon([(px + 5, py + 7) for px, py in pts], closed=True, facecolor="#0F172A", alpha=0.08, lw=0, zorder=3))
    ax.add_patch(Polygon(pts, closed=True, facecolor=P_GOLD, edgecolor="#E1B96A", lw=1.4, zorder=4))
    add_text(ax, cx, cy - 12, title, size=13, weight="bold", color=INK, ha="center", zorder=5)
    for i, line in enumerate(lines):
        add_text(ax, cx, cy + 12 + i * 17, line, size=9.5, color=MUTED, ha="center", zorder=5)


def brace(ax, x0, y0, x1, y1, color="#A7B2BF"):
    verts = [
        (x0, y0),
        ((x0 + x1) / 2, y0 - 22),
        (x1, y0),
        ((x0 + x1) / 2, y1 + 22),
        (x0, y1),
    ]
    codes = [MplPath.MOVETO, MplPath.CURVE3, MplPath.CURVE3, MplPath.CURVE3, MplPath.CURVE3]
    ax.add_patch(PathPatch(MplPath(verts, codes), facecolor="none", edgecolor=color, lw=1.2, ls=(0, (4, 5)), zorder=3))


def draw_header(ax, metrics: dict[str, str]):
    ax.add_patch(FancyBboxPatch((0, 0), W, 145, boxstyle="square,pad=0", linewidth=0, facecolor="#102A43", zorder=0))
    ax.add_patch(FancyBboxPatch((0, 119), W, 26, boxstyle="square,pad=0", linewidth=0, facecolor=TEAL, alpha=0.32, zorder=1))
    add_text(ax, 70, 55, "Windrise Evidence Architecture", size=32, weight="bold", color="white", va="center", zorder=2)
    add_text(ax, 72, 96, "资料治理、确定性路由、本地模型生成与运维反馈的一体化链路", size=14, color="#D7ECF2", va="center", zorder=2)

    metric_items = [
        (metrics["records"], "结构化故障记录"),
        (metrics["brands"], "设备品牌"),
        (metrics["models"], "风场/机型配置"),
        (metrics["turbines"], "风机编号映射"),
    ]
    x = 895
    widths = [155, 115, 145, 160]
    for (value, label), width in zip(metric_items, widths):
        round_box(ax, x, 32, width, 76, fc="#173D5C", ec="#315A77", lw=1.1, radius=14, shadow=False, z=2)
        add_text(ax, x + width / 2, 61, value, size=20, weight="bold", color="white", ha="center", zorder=3)
        add_text(ax, x + width / 2, 88, label, size=8.8, weight="bold", color="#CFE6EF", ha="center", zorder=3)
        x += width + 18


def draw_panel_a(ax):
    panel(ax, 50, 175, 700, 365, "a", "离线知识生产线", "把原始资料变成可查询、可回溯、可验证的知识资产")
    sources = [
        ("厂家手册", ["PDF/Markdown · 控制逻辑"], P_BLUE, BLUE),
        ("故障码表", ["代码/原因 · 处理/复位"], P_BLUE, BLUE),
        ("资产映射", ["风场/厂家/机型/风机号"], P_GREEN, GREEN),
        ("现场复盘", ["交接记录 · 维护经验"], P_GOLD, GOLD),
    ]
    for i, (title, lines, fc, accent) in enumerate(sources):
        y = 275 + i * 53
        card(ax, 82, y, 205, 44, title, lines, fc=fc, ec=RULE, accent=accent, title_size=11.5)

    round_box(ax, 342, 307, 155, 112, fc="#FFFFFF", ec="#C7D2DE", lw=1.2, radius=16, shadow=False, z=4)
    add_text(ax, 419.5, 336, "解析清洗", size=13, weight="bold", ha="center", zorder=6)
    add_text(ax, 419.5, 363, "字段标准化", size=10, color=MUTED, ha="center", zorder=6)
    add_text(ax, 419.5, 386, "工业编号消歧", size=10, color=MUTED, ha="center", zorder=6)

    outputs = [
        ("fault-index", ["结构化故障索引"], P_GREEN, GREEN),
        ("windFarmModels", ["风场/机型配置"], P_GREEN, GREEN),
        ("turbineMapping", ["风机编号映射"], P_GREEN, GREEN),
        ("LLMWiki", ["知识页面与图谱"], P_GREEN, GREEN),
    ]
    for i, (title, lines, fc, accent) in enumerate(outputs):
        y = 247 + i * 63
        card(ax, 560, y, 150, 50, title, lines, fc=fc, ec="#BFDCC7", accent=accent, title_size=10.5)

    for y in [292, 350, 408, 466]:
        arrow(ax, (287, y), (342, 363), color="#7B8794", lw=1.1, ms=9, z=7)
    for y in [272, 335, 398, 461]:
        arrow(ax, (497, 363), (560, y), color=GREEN, lw=1.4, ms=10, z=7)

    pill(ax, 93, 492, 590, 30, "构建后验证：短码边界 · 同码多义 · 名称反查 · 多轮上下文", fc="#F8FAFC", ec=RULE, color=INK, size=9.4)


def draw_panel_b(ax):
    panel(ax, 790, 175, 760, 365, "b", "在线路由与完备性闸门", "先识别对象和意图，再决定澄清、确定性查询或检索生成")
    card(ax, 826, 260, 170, 68, "现场输入", ["报警码 / 风机编号", "风场 / 机型 / 现象"], fc=P_GOLD, ec="#EBD3A2", accent=GOLD)
    card(ax, 1050, 252, 185, 84, "预处理与槽位", ["术语规范、错别字", "抽取风场/厂家/机型", "抽取故障码/部件/症状"], fc=P_GOLD, ec="#EBD3A2", accent=GOLD)
    card(ax, 1290, 252, 200, 84, "意图与状态", ["设备查询 / 故障处理", "理论问答 / 工具任务", "补充、追问、纠正、切换"], fc=P_GOLD, ec="#EBD3A2", accent=GOLD)
    diamond(ax, 1168, 415, 205, 122, "完备性闸门", ["会影响现场判断时", "先澄清再检索"])

    branches = [
        (830, "缺条件", ["返回澄清问题"], P_ROSE, ROSE),
        (1010, "风机编号", ["映射设备范围"], P_BLUE, BLUE),
        (1190, "故障码", ["精确匹配"], P_GREEN, GREEN),
        (1370, "理论/联网", ["走独立路径"], P_PURPLE, TEAL),
    ]
    for x, title, lines, fc, accent in branches:
        card(ax, x, 462, 150, 54, title, lines, fc=fc, ec=RULE, accent=accent, title_size=10.8)

    arrow(ax, (996, 294), (1050, 294), color=GOLD, lw=1.5, ms=10)
    arrow(ax, (1235, 294), (1290, 294), color=GOLD, lw=1.5, ms=10)
    arrow(ax, (1390, 336), (1230, 376), color=GOLD, lw=1.4, ms=10, rad=0.18)
    arrow(ax, (1168, 476), (905, 462), color=ROSE, lw=1.2, ms=9, rad=0.15)
    arrow(ax, (1168, 476), (1085, 462), color=BLUE, lw=1.2, ms=9, rad=0.06)
    arrow(ax, (1168, 476), (1265, 462), color=GREEN, lw=1.2, ms=9, rad=-0.06)
    arrow(ax, (1168, 476), (1445, 462), color=TEAL, lw=1.2, ms=9, rad=-0.16)


def draw_panel_c(ax):
    panel(ax, 50, 575, 865, 360, "c", "证据驱动的本地生成", "确定性服务先收敛范围，模型只负责组织证据化答案")
    services = [
        ("风机编号映射", ["机号 -> 风场 / 厂家 / 机型"], P_BLUE, BLUE),
        ("故障码精确检索", ["短码边界、字母数字代码"], P_GREEN, GREEN),
        ("设备范围过滤", ["按风场、品牌、机型收敛"], P_GOLD, GOLD),
        ("同码多义分组", ["保留差异，不只返回第一条"], P_PURPLE, TEAL),
    ]
    for i, (title, lines, fc, accent) in enumerate(services):
        card(ax, 84, 660 + i * 60, 220, 52, title, lines, fc=fc, ec=RULE, accent=accent, title_size=10.5)

    round_box(ax, 365, 675, 218, 160, fc="#FFFFFF", ec="#BFD5EA", lw=1.4, radius=18, shadow=False, z=4)
    add_text(ax, 474, 708, "Evidence packet", size=15, weight="bold", color=BLUE, ha="center", zorder=5)
    add_text(ax, 474, 742, "对象范围", size=10.2, color=INK, ha="center", zorder=5)
    add_text(ax, 474, 769, "故障字段", size=10.2, color=INK, ha="center", zorder=5)
    add_text(ax, 474, 796, "来源位置", size=10.2, color=INK, ha="center", zorder=5)
    pill(ax, 392, 847, 164, 28, "可复查，不凭空补全", fc="#EAF4FF", ec="#BED7EF", color=BLUE, size=8.8)

    card(ax, 642, 684, 208, 72, "本地大模型", ["vLLM / LM Studio", "OpenAI 兼容接口"], fc=P_PURPLE, ec="#D9CEF6", accent=BLUE_2, title_size=12.5)
    card(ax, 642, 792, 208, 86, "结构化回答", ["结论、对象、原因", "处理、复位、风险提示", "来源文件与字段"], fc="#FFFFFF", ec="#CCD6E0", accent=INK, title_size=12.5)

    for y in [686, 746, 806, 866]:
        arrow(ax, (304, y), (365, 755), color="#7B8794", lw=1.1, ms=8, rad=0.04)
    arrow(ax, (583, 755), (642, 720), color=BLUE, lw=1.7, ms=11)
    arrow(ax, (746, 756), (746, 792), color=BLUE, lw=1.7, ms=11)
    brace(ax, 84, 652, 304, 894)
    add_text(ax, 196, 910, "确定性服务", size=9.5, weight="bold", color=FAINT, ha="center", zorder=5)


def draw_panel_d(ax):
    panel(ax, 955, 575, 595, 360, "d", "运营治理与持续改进", "把使用记录、运行状态和回归评测接回知识生产线")
    top = [
        (1000, "健康检查", "模型/知识库/服务"),
        (1190, "会话沉淀", "导出/交接/复盘"),
        (1380, "回归评测", "短码/同码/上下文"),
    ]
    for x, title, line in top:
        card(ax, x, 672, 150, 60, title, [line], fc="#FFFFFF", ec="#CDD7E2", accent=TEAL, title_size=10.4)
    card(ax, 1100, 782, 170, 60, "资料补充", ["新手册/表格/经验"], fc=P_GREEN, ec="#BFDCC7", accent=GREEN, title_size=10.4)
    card(ax, 1300, 782, 170, 60, "重建上线", ["索引/Wiki/映射"], fc=P_GREEN, ec="#BFDCC7", accent=GREEN, title_size=10.4)

    arrow(ax, (1150, 702), (1190, 702), color=TEAL, lw=1.35, ms=10)
    arrow(ax, (1340, 702), (1380, 702), color=TEAL, lw=1.35, ms=10)
    arrow(ax, (1455, 733), (1385, 782), color=TEAL, lw=1.25, ms=10, rad=0.15)
    arrow(ax, (1300, 812), (1270, 812), color=TEAL, lw=1.25, ms=10)
    arrow(ax, (1100, 812), (1035, 733), color=TEAL, lw=1.25, ms=10, rad=0.16)

    round_box(ax, 995, 862, 510, 48, fc="#F8FAFC", ec=RULE, lw=1.1, radius=15, shadow=False, z=3)
    add_text(ax, 1250, 881, "部署边界：内网优先 · 离线迁移 · 私有模型 · 来源可追溯", size=11.2, weight="bold", color=INK, ha="center", zorder=4)
    add_text(ax, 1250, 902, "现场处置仍以 HMI/SCADA、趋势数据、安全规程和厂家正式文件为准", size=8.7, color=MUTED, ha="center", zorder=4)
    pill(ax, 1112, 622, 282, 30, "反馈闭环：补资料 -> 重建 -> 评测 -> 上线", fc="#EAF7EF", ec="#BFDCC7", color=GREEN, size=9.2)


def draw_cross_panel_arrows(ax):
    arrow(ax, (750, 360), (790, 360), color=BLUE, lw=2.2, ms=14)
    add_text(ax, 770, 337, "知识资产装载", size=9.5, color=BLUE, weight="bold", ha="center", zorder=20)
    ax.plot([1170, 1170, 600], [540, 558, 558], color=BLUE, lw=1.8, zorder=8)
    arrow(ax, (600, 558), (600, 575), color=BLUE, lw=1.8, ms=12, z=9)
    add_text(ax, 888, 548, "路由结果进入证据包", size=9.3, color=BLUE, weight="bold", ha="center", zorder=20)
    arrow(ax, (915, 760), (955, 760), color=TEAL, lw=2.2, ms=14)
    add_text(ax, 935, 737, "答案与日志", size=9.3, color=TEAL, weight="bold", ha="center", zorder=20)


def draw_footer(ax):
    footer_y = 970
    round_box(ax, 70, footer_y, 1460, 62, fc="#FFFFFF", ec=RULE, lw=1.2, radius=18, shadow=False, z=2)
    items = [
        ("确定性优先", "能查映射和代码就不交给模型猜", BLUE),
        ("先检索后生成", "故障资料进入证据包再组织答案", GREEN),
        ("先澄清后处置", "缺风场/机型/代码时避免硬答", GOLD),
        ("本地可部署", "适配内网、离线迁移和私有模型", TEAL),
    ]
    x = 105
    for title, line, color in items:
        ax.add_patch(Circle((x, footer_y + 31), 7, facecolor=color, edgecolor="none", zorder=4))
        add_text(ax, x + 18, footer_y + 22, title, size=10.5, weight="bold", color=INK, zorder=4)
        add_text(ax, x + 18, footer_y + 43, line, size=8.7, color=MUTED, zorder=4)
        x += 350


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    metrics = load_metrics()

    fig = plt.figure(figsize=(16, 10.8), facecolor=BG)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, W)
    ax.set_ylim(H, 0)
    ax.axis("off")
    ax.set_facecolor(BG)

    draw_header(ax, metrics)
    draw_panel_a(ax)
    draw_panel_b(ax)
    draw_panel_c(ax)
    draw_panel_d(ax)
    draw_cross_panel_arrows(ax)
    draw_footer(ax)

    fig.savefig(SVG_OUT, format="svg", bbox_inches="tight", pad_inches=0.08, metadata={"Date": None})
    fig.savefig(PNG_OUT, format="png", dpi=220, bbox_inches="tight", pad_inches=0.08, metadata={"Software": "matplotlib"})
    plt.close(fig)

    cleaned_svg = "\n".join(line.rstrip() for line in SVG_OUT.read_text(encoding="utf-8").splitlines()) + "\n"
    SVG_OUT.write_text(cleaned_svg, encoding="utf-8")

    print(f"font={FONT}")
    print(f"wrote={SVG_OUT.relative_to(ROOT)}")
    print(f"wrote={PNG_OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
