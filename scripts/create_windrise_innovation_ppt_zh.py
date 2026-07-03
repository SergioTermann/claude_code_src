#!/usr/bin/env python3
from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from PIL import Image, ImageDraw, ImageFont

from create_llmwiki_lmstudio_ppt import (
    app_xml,
    base_rels,
    connector,
    emu,
    presentation_rels,
    presentation_xml,
    shape_text,
    slide_layout_xml,
    slide_master_xml,
    theme_xml,
)


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "Windrise项目创新点.pptx"
ASSET_DIR = ROOT / "assets" / "ppt_windrise_innovation"
ASSET_DIR.mkdir(parents=True, exist_ok=True)

INK = "111827"
MUTED = "475569"
BG = "F7F8F5"
PANEL = "FFFFFF"
RULE = "D7D7CE"
TEAL = "0F766E"
BLUE = "2563EB"
GREEN = "15803D"
GOLD = "B7791F"
RED = "B91C1C"
SLATE = "334155"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc" if bold else "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size=size)
    return ImageFont.load_default()


def rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def rounded(draw: ImageDraw.ImageDraw, box, fill: str, outline: str = RULE, radius: int = 22, width: int = 3) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=rgb(fill), outline=rgb(outline), width=width)


def arrow(draw: ImageDraw.ImageDraw, start, end, color: str = TEAL, width: int = 6) -> None:
    draw.line([start, end], fill=rgb(color), width=width)
    sx, sy = start
    ex, ey = end
    if abs(ex - sx) >= abs(ey - sy):
        if ex >= sx:
            pts = [(ex, ey), (ex - 20, ey - 11), (ex - 20, ey + 11)]
        else:
            pts = [(ex, ey), (ex + 20, ey - 11), (ex + 20, ey + 11)]
    else:
        if ey >= sy:
            pts = [(ex, ey), (ex - 11, ey - 20), (ex + 11, ey - 20)]
        else:
            pts = [(ex, ey), (ex - 11, ey + 20), (ex + 11, ey + 20)]
    draw.polygon(pts, fill=rgb(color))


def draw_wrapped(draw: ImageDraw.ImageDraw, xy, text: str, fnt, fill, width: int, spacing: int = 8) -> int:
    x, y = xy
    line = ""
    for ch in text:
        test = line + ch
        if draw.textlength(test, font=fnt) <= width:
            line = test
        else:
            draw.text((x, y), line, font=fnt, fill=fill)
            y += fnt.size + spacing
            line = ch
    if line:
        draw.text((x, y), line, font=fnt, fill=fill)
        y += fnt.size + spacing
    return y


def load_stats() -> dict:
    overview = (ROOT / "wind-llmwiki" / "wiki" / "overview.md").read_text(encoding="utf-8")
    quality = (ROOT / "wind-llmwiki" / "wiki" / "quality-report.md").read_text(encoding="utf-8")
    graph_doc = (ROOT / "wind-llmwiki" / "wiki" / "knowledge-graph.md").read_text(encoding="utf-8")
    mechanism = (ROOT / "wind-llmwiki" / "wiki" / "fault-mechanisms.md").read_text(encoding="utf-8")
    summary = json.loads((ROOT / "wind-llmwiki" / "fault-index-summary.json").read_text(encoding="utf-8"))
    return {
        "overview": overview,
        "quality": quality,
        "graph_doc": graph_doc,
        "mechanism": mechanism,
        "record_count": summary["recordCount"],
        "brand_count": len(summary["byBrand"]),
        "by_brand": summary["byBrand"],
    }


def make_cover_image() -> Path:
    out = ASSET_DIR / "cover.png"
    src = ROOT / "主页.png"
    img = Image.new("RGB", (1600, 900), rgb(BG))
    draw = ImageDraw.Draw(img)
    if src.exists():
        with Image.open(src) as shot:
            shot = shot.convert("RGB")
            shot.thumbnail((920, 630))
            x = 620
            y = 145
            rounded(draw, (x - 18, y - 18, x + shot.width + 18, y + shot.height + 18), "FFFFFF", RULE, 30, 3)
            img.paste(shot, (x, y))
    else:
        rounded(draw, (720, 170, 1460, 690), "FFFFFF", RULE, 30, 3)
    for x, y, c in [(120, 620, TEAL), (230, 700, BLUE), (340, 630, GOLD), (470, 735, GREEN)]:
        draw.ellipse((x, y, x + 58, y + 58), fill=rgb(c))
    draw.line((145, 650, 258, 728, 369, 660, 498, 764), fill=rgb(SLATE), width=5)
    draw.text((90, 85), "Windrise", font=font(80, True), fill=rgb(INK))
    draw.text((96, 178), "风电运维知识助手", font=font(34, True), fill=rgb(TEAL))
    draw_wrapped(
        draw,
        (96, 255),
        "把私有故障码、风场机型、维修经验和故障机理组织成可检索、可追溯、可本地运行的智能诊断系统。",
        font(31),
        rgb(MUTED),
        470,
        14,
    )
    img.save(out)
    return out


def make_architecture_image() -> Path:
    out = ASSET_DIR / "architecture.png"
    img = Image.new("RGB", (1600, 900), rgb(BG))
    d = ImageDraw.Draw(img)
    d.text((70, 54), "系统架构：本地模型 + LLMWiki + 风电知识图谱", font=font(43, True), fill=rgb(INK))
    d.text((73, 114), "用同一套入口完成对话、故障码检索、证据链追踪和风场机型查询。", font=font(26), fill=rgb(MUTED))
    boxes = [
        ((80, 270, 310, 410), "用户入口", "CLI / Web\ntrace / search", BLUE),
        ((430, 250, 710, 430), "Windrise 路由", "自动识别故障码\n领域意图触发检索", TEAL),
        ((850, 165, 1190, 330), "本地模型", "LM Studio\nqwen/qwen3.5-9b", GREEN),
        ((850, 480, 1190, 660), "知识层", "LLMWiki 索引\nGraph / Wiki / CSV", GOLD),
        ((1280, 315, 1515, 500), "输出", "结论\n原因\n处理\n来源", RED),
    ]
    for box, title, sub, color in boxes:
        rounded(d, box, "FFFFFF", color, 28, 5)
        d.text((box[0] + 28, box[1] + 28), title, font=font(31, True), fill=rgb(color))
        d.multiline_text((box[0] + 28, box[1] + 82), sub, font=font(25), fill=rgb(INK), spacing=9)
    arrow(d, (310, 340), (430, 340), BLUE)
    arrow(d, (710, 320), (850, 250), TEAL)
    arrow(d, (710, 380), (850, 570), TEAL)
    arrow(d, (1190, 250), (1280, 370), GREEN)
    arrow(d, (1190, 570), (1280, 440), GOLD)
    rounded(d, (455, 680, 1450, 790), "F8FAFC", RULE, 20, 2)
    d.text((490, 708), "关键创新：模型负责综合表达，知识层负责事实 grounding，路由层负责把现场问题送到正确能力。", font=font(27, True), fill=rgb(INK))
    img.save(out)
    return out


def make_scale_image(stats: dict) -> Path:
    out = ASSET_DIR / "scale.png"
    img = Image.new("RGB", (1600, 900), rgb(BG))
    d = ImageDraw.Draw(img)
    d.text((70, 55), "知识底座规模", font=font(45, True), fill=rgb(INK))
    d.text((73, 116), "不是把文档塞给大模型，而是先完成标准化、索引化和图谱化。", font=font(26), fill=rgb(MUTED))
    kpis = [
        ("11,865", "原始故障码记录", TEAL),
        ("4,849", "图谱故障码节点", BLUE),
        ("8,295", "来源文档节点", GOLD),
        ("79,474", "图谱关系", GREEN),
    ]
    x = 88
    for value, label, color in kpis:
        rounded(d, (x, 210, x + 330, 390), "FFFFFF", color, 24, 4)
        d.text((x + 32, 242), value, font=font(52, True), fill=rgb(color))
        d.text((x + 34, 320), label, font=font(25, True), fill=rgb(INK))
        x += 375
    bars = [
        ("明确系统覆盖", 0.931, TEAL),
        ("明确分类覆盖", 0.682, BLUE),
        ("部件关系覆盖", 0.669, GOLD),
        ("复位方式覆盖", 0.556, GREEN),
        ("原因关系覆盖", 0.269, RED),
        ("处理动作覆盖", 0.260, SLATE),
    ]
    y = 485
    for label, pct, color in bars:
        d.text((112, y - 7), label, font=font(23, True), fill=rgb(INK))
        rounded(d, (360, y, 1320, y + 30), "E5E7EB", "E5E7EB", 15, 1)
        rounded(d, (360, y, 360 + int(960 * pct), y + 30), color, color, 15, 1)
        d.text((1345, y - 8), f"{pct * 100:.1f}%", font=font(23, True), fill=rgb(color))
        y += 58
    d.text((95, 835), f"已覆盖 {stats['brand_count']} 个品牌、66 个机型、29 个场站、18 个系统。", font=font(24, True), fill=rgb(MUTED))
    img.save(out)
    return out


def make_graph_image() -> Path:
    out = ASSET_DIR / "graph.png"
    img = Image.new("RGB", (1600, 900), rgb(BG))
    d = ImageDraw.Draw(img)
    d.text((70, 55), "图谱化表达：让答案能沿关系追溯", font=font(43, True), fill=rgb(INK))
    d.text((73, 116), "风场、机型、品牌、系统、部件、原因、处理动作和来源文档被组织成关系网络。", font=font(25), fill=rgb(MUTED))
    nodes = [
        ("风场", 170, 420, BLUE),
        ("机型", 430, 270, TEAL),
        ("品牌", 430, 570, GREEN),
        ("故障码", 800, 420, RED),
        ("系统", 1120, 270, GOLD),
        ("部件", 1390, 420, TEAL),
        ("处理动作", 1120, 570, GREEN),
        ("来源文档", 800, 205, SLATE),
        ("原因", 800, 650, GOLD),
    ]

    def shortened(a: int, b: int, gap: int = 70):
        _, x1, y1, _ = nodes[a]
        _, x2, y2, _ = nodes[b]
        dx = x2 - x1
        dy = y2 - y1
        dist = max(1, (dx * dx + dy * dy) ** 0.5)
        return (
            (x1 + dx / dist * gap, y1 + dy / dist * gap),
            (x2 - dx / dist * gap, y2 - dy / dist * gap),
        )

    edge_pairs = [(0, 1), (1, 2), (3, 1), (3, 4), (3, 5), (3, 6), (3, 7), (3, 8), (8, 6)]
    for a, b in edge_pairs:
        _, _, _, c = nodes[a]
        start, end = shortened(a, b)
        arrow(d, start, end, c, 4)

    for label, x, y, color in nodes:
        d.ellipse((x - 60, y - 60, x + 60, y + 60), fill=rgb(color))
        tw = d.textlength(label, font=font(24, True))
        d.text((x - tw / 2, y - 14), label, font=font(24, True), fill=(255, 255, 255))

    labels = [
        ("USES_MODEL", 242, 325),
        ("MADE_BY", 330, 420),
        ("OCCURS_ON_MODEL", 542, 315),
        ("BELONGS_TO_SYSTEM", 920, 315),
        ("INVOLVES_COMPONENT", 1128, 400),
        ("REQUIRES_ACTION", 922, 515),
        ("HAS_SOURCE", 688, 292),
        ("MAY_BE_CAUSED_BY", 612, 526),
    ]
    for text, x, y in labels:
        rounded(d, (x, y, x + 218, y + 34), "FFFFFF", RULE, 14, 1)
        d.text((x + 11, y + 6), text, font=font(17, True), fill=rgb(MUTED))
    img.save(out)
    return out


def make_trace_image() -> Path:
    out = ASSET_DIR / "trace.png"
    img = Image.new("RGB", (1600, 900), rgb(BG))
    d = ImageDraw.Draw(img)
    d.text((70, 55), "诊断闭环：从故障码到处理验证", font=font(45, True), fill=rgb(INK))
    d.text((73, 116), "以 303804 为例，系统输出的是可执行路径，而不是泛化建议。", font=font(26), fill=rgb(MUTED))
    steps = [
        ("输入", "303804\n或现场描述", BLUE),
        ("命中", "24V主电源\n开关故障", RED),
        ("解释", "断开 / 短路\n反馈丢失", GOLD),
        ("处置", "查线路\n查开关反馈", TEAL),
        ("闭环", "手动复位\n确认启动", GREEN),
    ]
    xs = [85, 380, 675, 970, 1265]
    for i, (title, text, color) in enumerate(steps):
        x = xs[i]
        rounded(d, (x, 300, x + 245, 500), "FFFFFF", color, 28, 5)
        d.text((x + 28, 330), title, font=font(30, True), fill=rgb(color))
        d.multiline_text((x + 28, 390), text, font=font(28, True), fill=rgb(INK), spacing=8)
        if i < len(steps) - 1:
            arrow(d, (x + 245, 400), (xs[i + 1], 400), color, 6)
    rounded(d, (175, 650, 1425, 760), "FFFDF7", RULE, 20, 2)
    d.text((215, 683), "创新点：将“故障码查询”升级为“证据链 + 机理解释 + 操作建议 + 复位条件”的现场决策闭环。", font=font(27, True), fill=rgb(INK))
    img.save(out)
    return out


def make_deployment_image() -> Path:
    out = ASSET_DIR / "deployment.png"
    img = Image.new("RGB", (1600, 900), rgb(BG))
    d = ImageDraw.Draw(img)
    d.text((70, 55), "Local-first 部署：私有知识不出现场", font=font(45, True), fill=rgb(INK))
    d.text((73, 116), "模型、索引、图谱、命令入口都能在本机或内网环境中运行。", font=font(26), fill=rgb(MUTED))
    cards = [
        ((100, 250, 430, 560), "隐私", "运维文档、故障码、场站信息保留在本地，不依赖外部 API。", TEAL),
        ((475, 250, 805, 560), "可用性", "支持离线知识库和本地 LM Studio，网络不稳定时仍可查询。", BLUE),
        ((850, 250, 1180, 560), "成本", "推理成本按本地算力消耗核算，不受云端 token 价格影响。", GREEN),
        ((1225, 250, 1510, 560), "可交付", "提供 macOS、Windows、Ubuntu Web 等打包脚本和烟测脚本。", GOLD),
    ]
    for box, title, body, color in cards:
        rounded(d, box, "FFFFFF", color, 28, 5)
        d.text((box[0] + 34, box[1] + 32), title, font=font(34, True), fill=rgb(color))
        draw_wrapped(d, (box[0] + 34, box[1] + 105), body, font(27), rgb(INK), box[2] - box[0] - 68, 12)
    d.text((122, 730), "关键脚本：package:offline、package:windows-web、package:ubuntu-simple-web、smoke:wind-llmwiki、smoke:lmstudio", font=font(25, True), fill=rgb(MUTED))
    img.save(out)
    return out


def content_types(slide_count: int) -> str:
    slides = "\n".join(
        f'<Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        for i in range(1, slide_count + 1)
    )
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  {slides}
</Types>
"""


def core_xml() -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                   xmlns:dc="http://purl.org/dc/elements/1.1/"
                   xmlns:dcterms="http://purl.org/dc/terms/"
                   xmlns:dcmitype="http://purl.org/dc/dcmitype/"
                   xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Windrise 项目创新点</dc:title>
  <dc:creator>Codex</dc:creator>
  <cp:lastModifiedBy>Codex</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified>
</cp:coreProperties>
"""


def pic(shape_id: int, rel_id: str, x: float, y: float, w: float, h: float, src_rect: str = "") -> str:
    return f"""
    <p:pic>
      <p:nvPicPr><p:cNvPr id="{shape_id}" name="Picture {shape_id}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
      <p:blipFill><a:blip r:embed="{rel_id}"/><a:srcRect {src_rect}/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
      <p:spPr><a:xfrm><a:off x="{emu(x)}" y="{emu(y)}"/><a:ext cx="{emu(w)}" cy="{emu(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
    </p:pic>
    """


def pic_contain(shape_id: int, rel_id: str, x: float, y: float, box_w: float, box_h: float, img_w: int = 1600, img_h: int = 900) -> str:
    img_ratio = img_w / img_h
    box_ratio = box_w / box_h
    if box_ratio > img_ratio:
        h = box_h
        w = h * img_ratio
        px = x + (box_w - w) / 2
        py = y
    else:
        w = box_w
        h = w / img_ratio
        px = x
        py = y + (box_h - h) / 2
    return pic(shape_id, rel_id, px, py, w, h)


def pic_cover(shape_id: int, rel_id: str, x: float, y: float, box_w: float, box_h: float, img_w: int = 1600, img_h: int = 900) -> str:
    img_ratio = img_w / img_h
    box_ratio = box_w / box_h
    if box_ratio > img_ratio:
        visible_h = img_w / box_ratio
        crop = max(0, int((1 - visible_h / img_h) * 50000))
        src = f't="{crop}" b="{crop}"'
    else:
        visible_w = img_h * box_ratio
        crop = max(0, int((1 - visible_w / img_w) * 50000))
        src = f'l="{crop}" r="{crop}"'
    return pic(shape_id, rel_id, x, y, box_w, box_h, src)


def slide_xml(shapes: list[str]) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="{BG}"/></a:solidFill></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      {''.join(shapes)}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>
"""


def slide_rels_for(images: list[tuple[str, str]]) -> str:
    rels = [
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
    ]
    for rel_id, target in images:
        rels.append(f'<Relationship Id="{rel_id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/{target}"/>')
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  {''.join(rels)}
</Relationships>
"""


def title(text: str, sub: str | None = None) -> list[str]:
    items = [
        shape_text(2, emu(0.65), emu(0.42), emu(11.95), emu(0.78), [text], 2580, INK, None, None, False, False, True)
    ]
    if sub:
        items.append(shape_text(3, emu(0.68), emu(1.12), emu(11.5), emu(0.45), [sub], 1250, MUTED))
    return items


def build_deck() -> tuple[list[tuple[str, list[tuple[str, str]]]], dict[Path, str]]:
    stats = load_stats()
    cover = make_cover_image()
    arch = make_architecture_image()
    scale = make_scale_image(stats)
    graph = make_graph_image()
    trace = make_trace_image()
    deployment = make_deployment_image()
    logo = ROOT / "logo.png"
    logo_asset = ASSET_DIR / "logo.png"
    if logo.exists():
        shutil.copy(logo, logo_asset)
    media = [cover, arch, scale, graph, trace, deployment]
    if logo_asset.exists():
        media.append(logo_asset)
    media_names = {p: f"image{i}.png" for i, p in enumerate(media, start=1)}

    slides: list[tuple[str, list[tuple[str, str]]]] = []

    slides.append((
        slide_xml([
            pic_cover(2, "rId2", 0, 0, 13.333, 7.5),
            shape_text(3, emu(0.78), emu(5.85), emu(5.4), emu(0.55), ["项目创新点汇报"], 1700, "FFFFFF", TEAL, TEAL, True, False, True),
            shape_text(4, emu(0.78), emu(6.46), emu(6.1), emu(0.32), ["本地化、图谱化、可追溯的风电运维智能诊断系统"], 1050, "FFFFFF"),
        ]),
        [("rId2", media_names[cover])],
    ))

    slides.append((
        slide_xml(title("项目定位：面向风电现场的私有知识助手", "把运维资料从“散落文档”转成“可问、可查、可追溯”的诊断能力。") + [
            shape_text(4, emu(0.78), emu(1.82), emu(3.75), emu(4.35), ["现场痛点", "故障码资料分散在不同品牌、机型、风场文档中", "同一故障码可能跨机型含义不同，不能只按号码解释", "现场人员需要快速知道先查哪里、如何复位、如何验证", "经验沉淀在报告和口头交流里，难以复用到下一次故障"], 1180, INK, PANEL, RED, True, True),
            shape_text(5, emu(4.82), emu(1.82), emu(3.75), emu(4.35), ["Windrise 解法", "本地 LLMWiki 统一索引资料，保留原始来源路径", "知识图谱表达风场、机型、故障码、系统、部件和动作", "本地模型负责综合回答，多轮追问由会话记忆承接", "把“查资料”变成“诊断流程协同”"], 1180, INK, PANEL, TEAL, True, True),
            shape_text(6, emu(8.86), emu(1.82), emu(3.65), emu(4.35), ["核心价值", "减少凭经验翻手册，缩短定位时间", "让答案带来源、证据路径和复核依据", "支持内网、离线和私有资料场景，适合风场交付", "形成可持续更新的运维知识资产，而不是一次性问答"], 1180, INK, PANEL, BLUE, True, True),
        ]),
        [],
    ))

    slides.append((
        slide_xml(title("汇报口径：创新不是“加一个聊天框”", "项目重点在于把风电运维知识组织成可运行、可追溯、可交付的系统能力。") + [
            shape_text(4, emu(0.78), emu(1.72), emu(5.65), emu(4.9), ["为什么有创新性", "Windrise 没有把大模型当成单独入口，而是把它放在知识工程、图谱检索、故障机理和现场流程之间。", "回答不是从模型记忆里猜，而是由本地故障码、来源文档、机型关系和诊断阶段共同约束。", "这使系统能从“问答工具”进一步变成“风电运维决策辅助基础设施”。"], 1240, INK, PANEL, TEAL, True, False),
            shape_text(5, emu(6.78), emu(1.72), emu(5.55), emu(4.9), ["建议讲述顺序", "先讲场景痛点：资料分散、机型差异、追溯困难、现场需要闭环。", "再讲技术抓手：本地知识库、知识图谱、机理模板、自动路由、多轮上下文。", "最后讲落地价值：私有化部署、低成本运行、可审计来源、可持续扩展到 SCADA/工单/备件。"], 1240, INK, PANEL, BLUE, True, False),
        ]),
        [],
    ))

    slides.append((slide_xml(title("创新点一：领域知识工程化，不是简单 RAG", "先标准化和结构化，再让模型基于事实综合回答。") + [
        pic_contain(4, "rId2", 0.68, 1.55, 12.0, 5.35)
    ]), [("rId2", media_names[scale])]))

    slides.append((slide_xml(title("创新点二：故障诊断知识图谱", "把“风场-机型-故障码-系统-部件-原因-动作-来源”连成可追溯关系。") + [
        pic_contain(4, "rId2", 0.68, 1.55, 12.0, 5.35)
    ]), [("rId2", media_names[graph])]))

    slides.append((
        slide_xml(title("知识图谱带来的能力变化", "图谱不是展示用图，而是让系统回答时具备关系约束和证据路径。") + [
            shape_text(4, emu(0.78), emu(1.72), emu(2.75), emu(4.65), ["跨机型 disambiguation", "同一个故障码在不同品牌、机型、控制系统下可能含义不同。", "图谱把故障码和风场、机型、品牌关系绑定，减少误判。"], 1120, INK, PANEL, BLUE, True, False),
            shape_text(5, emu(3.67), emu(1.72), emu(2.75), emu(4.65), ["从现象到部件", "现场描述通常不是标准故障码，而是压力上不来、通讯中断、电机不动作。", "图谱把现象引到系统、部件和处理动作。"], 1120, INK, PANEL, TEAL, True, False),
            shape_text(6, emu(6.56), emu(1.72), emu(2.75), emu(4.65), ["来源可复核", "答案可以回到源文档、质量报告和图谱关系。", "适合故障复盘、培训材料整理和后续人工审校。"], 1120, INK, PANEL, GOLD, True, False),
            shape_text(7, emu(9.45), emu(1.72), emu(2.85), emu(4.65), ["持续增长", "新增报告进入知识库后，可继续抽取故障码、原因、动作和来源。", "知识资产随现场积累持续扩展。"], 1120, INK, PANEL, GREEN, True, False),
        ]),
        [],
    ))

    slides.append((
        slide_xml(title("创新点三：机理模板把经验升级为推理路径", "本地故障码不只按关键词匹配，还挂接到可解释的故障机理。") + [
            shape_text(4, emu(0.78), emu(1.82), emu(2.72), emu(1.18), ["12", "机理模板"], 1750, INK, "E6F4F1", TEAL, True, False, True),
            shape_text(5, emu(3.82), emu(1.82), emu(2.72), emu(1.18), ["3,499", "已挂接故障记录"], 1750, INK, "EFF6FF", BLUE, True, False, True),
            shape_text(6, emu(6.86), emu(1.82), emu(2.72), emu(1.18), ["3,733", "机理图谱节点"], 1750, INK, "FFFBEB", GOLD, True, False, True),
            shape_text(7, emu(9.90), emu(1.82), emu(2.45), emu(1.18), ["4,892", "机理关系"], 1750, INK, "F0FDF4", GREEN, True, False, True),
            shape_text(8, emu(0.78), emu(3.45), emu(11.7), emu(2.55), ["典型机理包括：PLC 输入输出反馈链路异常、变桨执行机构卡滞或位置反馈异常、发电机轴承热-润滑-对中失效、变流器直流母线或电网电压扰动、偏航驱动/制动/限位链路异常、变桨 24V 控制电源或开关反馈丢失。", "作用：把“报了什么故障”进一步拆成“哪个信号异常、可能影响哪个执行机构、下一步验证什么、处理后如何确认恢复”。"], 1260, INK, PANEL, RULE, True),
            shape_text(9, emu(1.02), emu(6.10), emu(10.95), emu(0.55), ["效果：同一个现场问题可以从故障码查询延展到根因、诊断信号、检查步骤和预防复发。"], 1250, TEAL, "E6F4F1", TEAL, True, False, True),
        ]),
        [],
    ))

    slides.append((slide_xml(title("创新点四：故障码问答变成诊断闭环", "答案需要同时覆盖结论、原因、处理、复位和来源。") + [
        pic_contain(4, "rId2", 0.68, 1.55, 12.0, 5.35)
    ]), [("rId2", media_names[trace])]))

    slides.append((
        slide_xml(title("创新点五：自动路由现场问题到正确能力", "用户直接输入自然语言，系统判断是否需要知识库、风场机型表、联网或普通对话。") + [
            shape_text(4, emu(0.88), emu(1.75), emu(2.9), emu(3.75), ["故障码识别", "303804", "303804 是什么故障", "故障码/报警码/告警码", "自动进入本地故障知识库"], 1120, INK, PANEL, BLUE, True, True),
            shape_text(5, emu(3.98), emu(1.75), emu(2.9), emu(3.75), ["领域意图识别", "变桨、偏航、主控、变流、24V、PLC", "原因、处理、复位、排查", "短反馈也能承接前文"], 1120, INK, PANEL, TEAL, True, True),
            shape_text(6, emu(7.08), emu(1.75), emu(2.9), emu(3.75), ["工具入口", "search / trace / read / tree", "farm / web / fetch / weather", "doctor / skills", "按任务选择能力而非让用户选菜单"], 1120, INK, PANEL, GOLD, True, True),
            shape_text(7, emu(10.18), emu(1.75), emu(2.25), emu(3.75), ["回答控制", "本地资料优先", "不输出隐藏推理", "来源路径归一", "控制输出为现场可执行步骤"], 1120, INK, PANEL, GREEN, True, True),
            connector(8, emu(3.78), emu(3.55), emu(3.98), emu(3.55), BLUE),
            connector(9, emu(6.88), emu(3.55), emu(7.08), emu(3.55), TEAL),
            connector(10, emu(9.98), emu(3.55), emu(10.18), emu(3.55), GOLD),
            shape_text(11, emu(1.0), emu(6.05), emu(10.95), emu(0.6), ["价值：用户不用学习命令体系，系统在后台判断是否查故障码、查图谱、走普通对话或继续上一轮诊断。"], 1180, TEAL, "E6F4F1", TEAL, True, False, True),
        ]),
        [],
    ))

    slides.append((
        slide_xml(title("创新点六：多轮诊断上下文记忆", "让系统像现场工程师一样沿着同一条排查链继续问，而不是每轮重新开始。") + [
            shape_text(4, emu(0.78), emu(1.72), emu(3.65), emu(4.75), ["记住什么", "当前故障主题：如偏航液压/制动系统", "已知现象：SCADA 报警、压力上不来、电机动作次数", "已给动作：释放刹车、恢复刹车、观察建压", "等待反馈：最低压力、恢复时间、最高压力"], 1120, INK, PANEL, TEAL, True, True),
            shape_text(5, emu(4.83), emu(1.72), emu(3.65), emu(4.75), ["如何实现", "前端保存 conversation_id，刷新页面后仍能延续会话", "服务端维护结构化 memory 和最近轮次", "通用追问会自动附带前文上下文", "常见现场短反馈走稳定诊断模板，减少模型漂移"], 1120, INK, PANEL, BLUE, True, True),
            shape_text(6, emu(8.88), emu(1.72), emu(3.45), emu(4.75), ["演示效果", "用户说“动作一次”也能理解为液压站电机动作一次", "回答继续判断蓄能器、内泄或补压效率", "外网访问同样走 /api/chat，具备上下文记忆", "更接近真实运维问诊流程"], 1120, INK, PANEL, GOLD, True, True),
        ]),
        [],
    ))

    slides.append((slide_xml(title("创新点七：Local-first 私有化落地", "适合风场、运维公司和设备厂商的内网知识资产场景。") + [
        pic_contain(4, "rId2", 0.68, 1.55, 12.0, 5.35)
    ]), [("rId2", media_names[deployment])]))

    slides.append((slide_xml(title("总体技术路线", "用户工作流保持简单，复杂度沉到工程层。") + [
        pic_contain(4, "rId2", 0.68, 1.55, 12.0, 5.35)
    ]), [("rId2", media_names[arch])]))

    slides.append((
        slide_xml(title("相对传统方案的差异化", "不是单点聊天，而是围绕风电运维决策链做系统化设计。") + [
            shape_text(4, emu(0.75), emu(1.85), emu(11.85), emu(0.62), ["对比维度          通用大模型问答                         Windrise"], 1350, "FFFFFF", SLATE, SLATE, True, False, True),
            shape_text(5, emu(0.75), emu(2.55), emu(11.85), emu(3.72), ["知识来源          依赖模型记忆或临时上传文档               本地故障码、Wiki、图谱、来源文档统一索引", "准确性            容易泛化回答                             按故障码、机型、风场、系统关系 grounding", "可追溯            来源弱或不可复核                         可读源文件、图谱路径、三元组、质量报告", "部署方式          多依赖云端 API                            LM Studio + LLMWiki 本地/内网运行", "现场闭环          多停留在建议文本                           结论、原因、处理动作、复位方式、验证路径"], 1320, INK, PANEL, RULE, True, False),
            shape_text(6, emu(1.0), emu(6.55), emu(10.9), emu(0.48), ["一句话：Windrise 的创新在于把大模型交互、领域知识工程和风电故障诊断闭环做成一个可运行系统。"], 1200, TEAL, "E6F4F1", TEAL, True, False, True),
        ]),
        [],
    ))

    slides.append((
        slide_xml(title("下一步演进方向", "从可用原型走向可审计、可协同、可持续更新的产品。") + [
            shape_text(4, emu(0.78), emu(1.78), emu(3.65), emu(4.1), ["短期", "完善 /doctor 健康检查", "增加典型故障演示脚本", "补齐更多处理动作和原因抽取", "增加会话持久化，服务重启后不丢历史"], 1180, INK, PANEL, TEAL, True, True),
            shape_text(5, emu(4.83), emu(1.78), emu(3.65), emu(4.1), ["中期", "引入 BM25 + 向量混合检索", "答案强制引用来源", "建立人工审校与版本管理", "把高频故障沉淀为标准诊断流程"], 1180, INK, PANEL, BLUE, True, True),
            shape_text(6, emu(8.88), emu(1.78), emu(3.45), emu(4.1), ["长期", "接入 SCADA/工单/备件系统", "形成故障知识持续学习闭环", "沉淀行业级风电运维知识资产", "支持多风场、多角色、多版本协同"], 1180, INK, PANEL, GOLD, True, True),
            shape_text(7, emu(1.05), emu(6.16), emu(10.8), emu(0.55), ["汇报重点：这个项目的核心不是“用了大模型”，而是把风电运维知识变成了可运行、可追溯、可本地交付的智能诊断基础设施。"], 1220, "FFFFFF", TEAL, TEAL, True, False, True),
        ]),
        [],
    ))

    return slides, media_names


def build_focused_deck() -> tuple[list[tuple[str, list[tuple[str, str]]]], dict[Path, str]]:
    stats = load_stats()
    cover = make_cover_image()
    scale = make_scale_image(stats)
    trace = make_trace_image()
    deployment = make_deployment_image()
    logo = ROOT / "logo.png"
    logo_asset = ASSET_DIR / "logo.png"
    if logo.exists():
        shutil.copy(logo, logo_asset)
    media = [cover, scale, trace, deployment]
    if logo_asset.exists():
        media.append(logo_asset)
    media_names = {p: f"image{i}.png" for i, p in enumerate(media, start=1)}

    slides: list[tuple[str, list[tuple[str, str]]]] = []

    slides.append((
        slide_xml([
            pic_cover(2, "rId2", 0, 0, 13.333, 7.5),
            shape_text(3, emu(0.78), emu(5.62), emu(5.9), emu(0.62), ["Windrise 项目创新点"], 1850, "FFFFFF", TEAL, TEAL, True, False, True),
            shape_text(4, emu(0.78), emu(6.30), emu(6.55), emu(0.62), ["风电运维知识工程 + 故障诊断闭环 + 本地化交付"], 1150, "FFFFFF"),
        ]),
        [("rId2", media_names[cover])],
    ))

    slides.append((
        slide_xml(title("创新点一：把风电资料变成可计算知识底座", "不是简单把文档喂给大模型，而是先完成标准化、索引化、图谱化。") + [
            shape_text(4, emu(0.78), emu(1.72), emu(4.05), emu(4.85), ["核心创新", "将故障码、风场、机型、品牌、系统、部件、原因、处理动作和来源文档拆成结构化关系。", "模型回答时不再只依赖通用语料，而是被本地知识底座约束。", "同一故障码可结合机型和来源重新定位，降低泛化回答和误判风险。"], 1180, INK, PANEL, TEAL, True, False),
            shape_text(5, emu(5.05), emu(1.72), emu(3.35), emu(4.85), ["已有基础", "11,865 条原始故障码记录", "4,849 个图谱故障码节点", "79,474 条图谱关系", "覆盖品牌、机型、场站、系统等多维信息"], 1180, INK, PANEL, BLUE, True, True),
            pic_contain(6, "rId2", 8.65, 1.80, 3.72, 4.72),
        ]),
        [("rId2", media_names[scale])],
    ))

    slides.append((
        slide_xml(title("创新点二：把故障码问答升级为诊断闭环", "回答不是“是什么”，而是能落到现场执行的排查路径。") + [
            pic_contain(4, "rId2", 0.65, 1.48, 6.25, 4.95),
            shape_text(5, emu(7.20), emu(1.72), emu(5.05), emu(4.65), ["闭环能力", "从故障码或现场现象出发，给出结论、可能原因、检查动作、复位条件和验证方式。", "答案保留来源路径，便于班组复核、故障复盘和培训沉淀。", "现场追问会沿着同一条诊断链继续推进，而不是每次重新生成泛化建议。"], 1200, INK, PANEL, GOLD, True, False),
        ]),
        [("rId2", media_names[trace])],
    ))

    slides.append((
        slide_xml(title("创新点三：多轮上下文现场问诊", "让系统记住当前故障阶段，支持像工程师一样连续追问。") + [
            shape_text(4, emu(0.78), emu(1.72), emu(3.65), emu(4.75), ["记住现场上下文", "当前故障主题", "已知现象", "已做动作", "等待反馈", "关键数值，如压力、时间、动作次数"], 1120, INK, PANEL, TEAL, True, True),
            shape_text(5, emu(4.83), emu(1.72), emu(3.65), emu(4.75), ["解决的问题", "用户输入“动作一次”“还是上不来”这类短反馈时，系统能理解它属于上一轮偏航液压诊断。", "避免每轮都把问题当成新问题，减少答非所问和诊断跳线。"], 1120, INK, PANEL, BLUE, True, False),
            shape_text(6, emu(8.88), emu(1.72), emu(3.45), emu(4.75), ["演示价值", "外网访问也走同一个 /api/chat 服务", "浏览器保存 conversation_id", "服务端维护结构化 memory", "适合现场边查边反馈的真实工作流"], 1120, INK, PANEL, GREEN, True, True),
        ]),
        [],
    ))

    slides.append((
        slide_xml(title("创新点四：Local-first 私有化交付", "适合风场、运维公司和设备厂商的私有知识资产场景。") + [
            shape_text(4, emu(0.78), emu(1.72), emu(4.0), emu(4.8), ["为什么重要", "风电运维资料包含场站、设备、故障记录和处理经验，很多场景不适合直接上传云端。", "Windrise 支持本地模型、本地索引、本地图谱和内网/Web 演示部署。", "这样既能使用大模型交互能力，又能保留私有资料和交付可控性。"], 1180, INK, PANEL, TEAL, True, False),
            shape_text(5, emu(5.02), emu(1.72), emu(3.35), emu(4.8), ["落地价值", "私有资料不出现场", "降低云端 API 依赖", "支持离线/内网演示", "可打包到不同系统环境", "后续可接 SCADA、工单、备件系统"], 1120, INK, PANEL, BLUE, True, True),
            pic_contain(6, "rId2", 8.62, 1.82, 3.75, 4.55),
        ]),
        [("rId2", media_names[deployment])],
    ))

    return slides, media_names


def write_pptx() -> None:
    slides, media_names = build_focused_deck()
    with ZipFile(OUT, "w", ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types(len(slides)))
        z.writestr("_rels/.rels", base_rels())
        z.writestr("docProps/app.xml", app_xml(len(slides)))
        z.writestr("docProps/core.xml", core_xml())
        z.writestr("ppt/presentation.xml", presentation_xml(len(slides)))
        z.writestr("ppt/_rels/presentation.xml.rels", presentation_rels(len(slides)))
        z.writestr("ppt/theme/theme1.xml", theme_xml())
        z.writestr("ppt/slideMasters/slideMaster1.xml", slide_master_xml())
        z.writestr("ppt/slideMasters/_rels/slideMaster1.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>')
        z.writestr("ppt/slideLayouts/slideLayout1.xml", slide_layout_xml())
        z.writestr("ppt/slideLayouts/_rels/slideLayout1.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>')
        for i, (doc, rel_images) in enumerate(slides, start=1):
            z.writestr(f"ppt/slides/slide{i}.xml", doc)
            z.writestr(f"ppt/slides/_rels/slide{i}.xml.rels", slide_rels_for(rel_images))
        for path, name in media_names.items():
            z.write(path, f"ppt/media/{name}")


if __name__ == "__main__":
    write_pptx()
    print(OUT)
