#!/usr/bin/env python3
from __future__ import annotations

import shutil
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from PIL import Image, ImageDraw, ImageFont, ImageOps

from create_llmwiki_lmstudio_ppt import (
    app_xml,
    base_rels,
    connector,
    core_xml,
    emu,
    presentation_rels,
    presentation_xml,
    shape_text,
    slide_layout_xml,
    slide_master_xml,
    theme_xml,
)


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "LLMWiki_LM Studio_Local_Integration_Visual_ZH.pptx"
ASSET_DIR = ROOT / "assets" / "ppt_llmwiki_lmstudio"
ASSET_DIR.mkdir(parents=True, exist_ok=True)

INK = "111827"
MUTED = "4B5563"
PANEL = "FFFFFF"
BG = "FAFAF7"
RULE = "D6D3C8"
TEAL = "006D6F"
BLUE = "1D4ED8"
GOLD = "A16207"
GREEN = "166534"
RED = "991B1B"
CODE = "0B1120"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc" if bold else "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size=size)
    return ImageFont.load_default()


def rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def draw_wrapped(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, fnt, fill, width: int, spacing: int = 10) -> int:
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


def rounded_card(draw, box, fill, outline=RULE, radius=24, width=3):
    draw.rounded_rectangle(box, radius=radius, fill=rgb(fill), outline=rgb(outline), width=width)


def arrow(draw, start, end, color=TEAL, width=6):
    draw.line([start, end], fill=rgb(color), width=width)
    sx, sy = start
    ex, ey = end
    if ex >= sx:
        pts = [(ex, ey), (ex - 22, ey - 12), (ex - 22, ey + 12)]
    else:
        pts = [(ex, ey), (ex + 22, ey - 12), (ex + 22, ey + 12)]
    draw.polygon(pts, fill=rgb(color))


def latest_generated_image() -> Path | None:
    root = Path("/Users/zinger/.codex/generated_images")
    if not root.exists():
        return None
    images = sorted(root.glob("**/*.png"), key=lambda p: p.stat().st_mtime, reverse=True)
    return images[0] if images else None


def prepare_hero() -> Path:
    out = ASSET_DIR / "hero_local_ai.png"
    src = latest_generated_image()
    if src:
        shutil.copy(src, out)
        return out
    img = Image.new("RGB", (1600, 900), rgb("F6F5F0"))
    draw = ImageDraw.Draw(img)
    draw.ellipse((980, 110, 1500, 630), fill=rgb("DFF3F0"))
    draw.rounded_rectangle((850, 360, 1450, 650), radius=36, fill=rgb("FFFFFF"), outline=rgb(RULE), width=4)
    draw.rounded_rectangle((930, 420, 1370, 595), radius=18, fill=rgb("E6F4F1"))
    for i, c in enumerate([TEAL, BLUE, GOLD, GREEN]):
        draw.ellipse((1050 + i * 85, 475, 1090 + i * 85, 515), fill=rgb(c))
    img.save(out)
    return out


def make_architecture() -> Path:
    out = ASSET_DIR / "architecture_flow.png"
    img = Image.new("RGB", (1600, 900), rgb(BG))
    d = ImageDraw.Draw(img)
    title = font(44, True)
    body = font(26)
    small = font(22)
    d.text((70, 55), "本地化推理与知识检索架构", font=title, fill=rgb(INK))
    d.text((72, 115), "保留编码界面，替换模型后端，并把 LLMWiki 作为可检索知识层。", font=body, fill=rgb(MUTED))
    cards = [
        ((85, 255, 315, 385), "Claude Code\n界面", "用户工作流不变", "FFFFFF", RULE),
        ((425, 235, 690, 405), "LM Studio\n适配器", "stream / tools\nthinking:false", "E6F4F1", TEAL),
        ((810, 255, 1045, 385), "LM Studio API", "127.0.0.1:11434", "EFF6FF", BLUE),
        ((1160, 255, 1425, 385), "qwen3.5:9b", "本地推理", "F0FDF4", GREEN),
        ((210, 610, 475, 740), "LLMWiki", "search / read", "FFFBEB", GOLD),
        ((610, 590, 900, 760), ".llm-wiki\n索引", "file-snapshot.json", "FFFFFF", RULE),
        ((1040, 610, 1310, 740), "本地资料", "8,657 个文件", "FFFFFF", RULE),
    ]
    for box, head, sub, fill, outline in cards:
        rounded_card(d, box, fill, outline)
        d.multiline_text((box[0] + 28, box[1] + 25), head, font=font(30, True), fill=rgb(INK), spacing=8)
        d.multiline_text((box[0] + 28, box[1] + 92), sub, font=small, fill=rgb(MUTED), spacing=6)
    arrow(d, (315, 320), (425, 320), TEAL)
    arrow(d, (690, 320), (810, 320), TEAL)
    arrow(d, (1045, 320), (1160, 320), BLUE)
    arrow(d, (475, 675), (610, 675), GOLD)
    arrow(d, (900, 675), (1040, 675), GOLD)
    d.line((560, 405, 560, 590), fill=rgb(TEAL), width=5)
    d.polygon([(560, 590), (548, 568), (572, 568)], fill=rgb(TEAL))
    d.text((80, 820), "图：模型调用与知识检索被拆成两条本地链路，降低远端依赖。", font=small, fill=rgb(MUTED))
    img.save(out)
    return out


def make_evidence() -> Path:
    out = ASSET_DIR / "evidence_dashboard.png"
    img = Image.new("RGB", (1600, 900), rgb(BG))
    d = ImageDraw.Draw(img)
    d.text((70, 55), "可复现验证", font=font(44, True), fill=rgb(INK))
    d.text((72, 115), "同一套脚本同时验证模型、知识库和成本口径。", font=font(26), fill=rgb(MUTED))
    kpis = [
        ("模型字段", "qwen3.5:9b", "JSON init.model", TEAL),
        ("知识库规模", "8,657", "file-snapshot indexed files", BLUE),
        ("本地成本", "$0", "total_cost_usd", GREEN),
    ]
    x = 80
    for label, value, note, color in kpis:
        rounded_card(d, (x, 220, x + 430, 410), "FFFFFF", color, 28, 4)
        d.text((x + 32, 245), label, font=font(26, True), fill=rgb(MUTED))
        d.text((x + 32, 292), value, font=font(56, True), fill=rgb(color))
        d.text((x + 32, 360), note, font=font(22), fill=rgb(MUTED))
        x += 500
    bars = [
        ("LM Studio 服务", 1.0, TEAL),
        ("qwen3.5:9b 模型", 1.0, BLUE),
        ("LLMWiki 快路径", 1.0, GOLD),
        ("云端 API 费用", 0.0, GREEN),
    ]
    y = 515
    for label, pct, color in bars:
        d.text((95, y - 8), label, font=font(24, True), fill=rgb(INK))
        rounded_card(d, (350, y, 1250, y + 34), "ECEFF3", "ECEFF3", 16, 1)
        fill_w = int(900 * pct)
        if fill_w > 0:
            rounded_card(d, (350, y, 350 + fill_w, y + 34), color, color, 16, 1)
        d.text((1280, y - 8), "通过" if pct else "归零", font=font(24, True), fill=rgb(color))
        y += 82
    d.text((80, 840), "验证命令：npm run print:lmstudio -- --output-format json --verbose \"只回答两个字：你好\"", font=font(21), fill=rgb(MUTED))
    img.save(out)
    return out


def make_faultcode() -> Path:
    out = ASSET_DIR / "faultcode_retrieval.png"
    img = Image.new("RGB", (1600, 900), rgb(BG))
    d = ImageDraw.Draw(img)
    d.text((70, 55), "故障码 303804 的检索路径", font=font(44, True), fill=rgb(INK))
    d.text((72, 115), "从一个代码输入，到本地资料命中，再到可执行的维修说明。", font=font(26), fill=rgb(MUTED))
    steps = [
        ((90, 300, 355, 420), "输入", "303804", BLUE),
        ((500, 270, 805, 450), "命中资料", "CSV / Markdown\n风机故障码", GOLD),
        ((960, 250, 1480, 470), "输出", "24V主电源开关故障\n原因、处理、故障逻辑", TEAL),
    ]
    for box, label, text, color in steps:
        rounded_card(d, box, "FFFFFF", color, 28, 5)
        d.text((box[0] + 28, box[1] + 24), label, font=font(27, True), fill=rgb(color))
        d.multiline_text((box[0] + 28, box[1] + 68), text, font=font(32, True), fill=rgb(INK), spacing=10)
    arrow(d, (355, 360), (500, 360), BLUE, 7)
    arrow(d, (805, 360), (960, 360), GOLD, 7)
    rounded_card(d, (175, 610, 1420, 750), "FFFDF7", RULE, 22, 2)
    d.text((215, 635), "关键信息摘录", font=font(28, True), fill=rgb(INK))
    d.text((215, 690), "原因：变桨24V主电源开关断开    处理：检查线路短路/断路    复位：恢复后需手动复位并启动", font=font(25), fill=rgb(MUTED))
    d.text((80, 825), "图：检索给出的不是泛化回答，而是来自本地项目语料的可追溯记录。", font=font(22), fill=rgb(MUTED))
    img.save(out)
    return out


def make_roadmap() -> Path:
    out = ASSET_DIR / "roadmap.png"
    img = Image.new("RGB", (1600, 900), rgb(BG))
    d = ImageDraw.Draw(img)
    d.text((70, 55), "从本地检索走向本地推理", font=font(44, True), fill=rgb(INK))
    d.text((72, 115), "下一步不是堆功能，而是把检索、综合和引用闭环。", font=font(26), fill=rgb(MUTED))
    xs = [170, 610, 1050]
    titles = ["短期", "中期", "长期"]
    bodies = [
        ["增加 /lmstudio doctor", "检查模型、服务、知识库路径"],
        ["增加 /llmwiki ask", "检索 top passages 后综合回答"],
        ["引入排序与评估", "BM25/向量检索 + 质量追踪"],
    ]
    colors = [TEAL, BLUE, GOLD]
    d.line((250, 420, 1230, 420), fill=rgb(RULE), width=8)
    for i, x in enumerate(xs):
        d.ellipse((x + 120, 382, x + 196, 458), fill=rgb(colors[i]))
        rounded_card(d, (x, 505, x + 340, 705), "FFFFFF", colors[i], 28, 4)
        d.text((x + 32, 535), titles[i], font=font(32, True), fill=rgb(colors[i]))
        d.text((x + 32, 592), bodies[i][0], font=font(25, True), fill=rgb(INK))
        d.text((x + 32, 640), bodies[i][1], font=font(22), fill=rgb(MUTED))
    d.text((80, 820), "路线图：先保证可诊断，再做可引用问答，最后评估检索质量。", font=font(22), fill=rgb(MUTED))
    img.save(out)
    return out


def find_screenshots() -> list[Path]:
    return sorted(ROOT.glob("截屏*.png"))


def content_types_visual(slide_count: int) -> str:
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
        # Need more width; crop top and bottom.
        visible_h = img_w / box_ratio
        crop = max(0, int((1 - visible_h / img_h) * 50000))
        src = f't="{crop}" b="{crop}"'
    else:
        # Need more height; crop left and right.
        visible_w = img_h * box_ratio
        crop = max(0, int((1 - visible_w / img_w) * 50000))
        src = f'l="{crop}" r="{crop}"'
    return pic(shape_id, rel_id, x, y, box_w, box_h, src)


def slide_rels_for(images: list[tuple[str, str]]) -> str:
    rels = ['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>']
    for rel_id, target in images:
        rels.append(f'<Relationship Id="{rel_id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/{target}"/>')
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  {''.join(rels)}
</Relationships>
"""


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


def title(text: str, sub: str | None = None) -> list[str]:
    items = [
        shape_text(2, emu(0.65), emu(0.42), emu(11.9), emu(0.8), [text], 2650, INK, None, None, False, False, True)
    ]
    if sub:
        items.append(shape_text(3, emu(0.68), emu(1.12), emu(11.4), emu(0.4), [sub], 1250, MUTED))
    return items


def screenshot_card(shape_id: int, rel_id: str, path: Path, x: float, y: float, w: float, h: float) -> str:
    with Image.open(path) as im:
        img_w, img_h = im.size
    return (
        shape_text(shape_id, emu(x), emu(y), emu(w), emu(h), [""], 800, INK, PANEL, RULE, True)
        + pic_contain(shape_id + 1, rel_id, x + 0.12, y + 0.18, w - 0.24, h - 0.52, img_w, img_h)
        + shape_text(shape_id + 2, emu(x + 0.16), emu(y + h - 0.38), emu(w - 0.32), emu(0.25), [path.stem], 850, MUTED)
    )


def make_deck():
    hero = prepare_hero()
    arch = make_architecture()
    evidence = make_evidence()
    fault = make_faultcode()
    roadmap = make_roadmap()
    screenshots = find_screenshots()
    media = [hero, arch, evidence, fault, roadmap, *screenshots]
    media_names = {p: f"image{i}.png" for i, p in enumerate(media, start=1)}

    slides = []

    slides.append((
        slide_xml([
            pic_cover(2, "rId2", 6.15, 0.0, 7.18, 7.5),
            shape_text(3, emu(0.72), emu(0.78), emu(5.25), emu(1.25), ["面向领域工作的本地知识引擎"], 3300, INK, None, None, False, False, True),
            shape_text(4, emu(0.76), emu(2.02), emu(5.25), emu(0.85), ["将 Claude Code 的推理路径切换到本机 LM Studio，并用 LLMWiki 索引库提供项目知识。"], 1600, MUTED),
            shape_text(5, emu(0.78), emu(3.35), emu(1.55), emu(0.7), ["模型\nqwen3.5:9b"], 1200, INK, "E6F4F1", TEAL, True, False, True),
            shape_text(6, emu(2.48), emu(3.35), emu(1.55), emu(0.7), ["语料\n8,657 文件"], 1200, INK, "EFF6FF", BLUE, True, False, True),
            shape_text(7, emu(4.18), emu(3.35), emu(1.35), emu(0.7), ["成本\n$0"], 1200, INK, "F0FDF4", GREEN, True, False, True),
            shape_text(8, emu(0.78), emu(5.65), emu(5.25), emu(0.7), ["保留原有编码界面，同时把模型、知识库和成本控制放回本地。"], 1300, MUTED),
        ]),
        [("rId2", media_names[hero])]
    ))

    slides.append((
        slide_xml(title("瓶颈不只是模型，而是模型能否接触到本地知识。", "一个可用的本地助手，必须同时具备推理能力和项目记忆。") + [
            shape_text(4, emu(0.75), emu(2.0), emu(5.55), emu(3.75), ["改造前", "客户端仍默认依赖远端 Claude API", "故障码、历史资料等本地文档不在默认上下文中", "非交互模式下 slash command 行为不稳定"], 1500, INK, PANEL, RULE, True, True),
            shape_text(5, emu(6.75), emu(2.0), emu(5.55), emu(3.75), ["改造后", "模型请求被路由到本机 LM Studio", "LLMWiki 把索引文件和项目知识变成可检索入口", "脚本模式可直接查询知识库，不依赖模型理解命令"], 1500, INK, PANEL, TEAL, True, True),
            connector(6, emu(6.3), emu(3.85), emu(6.75), emu(3.85), TEAL),
        ]),
        []
    ))

    slides.append((slide_xml(title("界面被保留下来，推理链路被替换掉。", "下图展示了两条本地链路：模型调用链路和知识检索链路。") + [pic_contain(4, "rId2", 0.72, 1.55, 11.85, 5.35)]), [("rId2", media_names[arch])]))

    slides.append((
        slide_xml(title("三个工程决策让系统真正可用。", "改动并不庞大，但解决了最容易卡住的失败模式。") + [
            shape_text(4, emu(0.75), emu(1.8), emu(3.65), emu(3.95), ["1", "Provider 切换", "ANTHROPIC_MODEL_PROVIDER=lmstudio 选择本地客户端"], 1500, INK, PANEL, TEAL, True, False, True),
            shape_text(5, emu(4.65), emu(1.8), emu(3.65), emu(3.95), ["2", "关闭 thinking 输出", "think:false 让可见答案稳定进入 content"], 1500, INK, PANEL, BLUE, True, False, True),
            shape_text(6, emu(8.55), emu(1.8), emu(3.65), emu(3.95), ["3", "本地命令快路径", "headless /llmwiki 由脚本直接执行"], 1500, INK, PANEL, GOLD, True, False, True),
        ]),
        []
    ))

    slides.append((slide_xml(title("证据是可复现的：本地模型能答，本地索引能查。", "验证命令不需要云端 API key。") + [pic_contain(4, "rId2", 0.72, 1.55, 11.85, 5.35)]), [("rId2", media_names[evidence])]))

    slides.append((slide_xml(title("一个领域案例说明了索引的价值。", "助手检索到的是项目资料中的精确记录，而不是泛化语言模型记忆。") + [pic_contain(4, "rId2", 0.72, 1.55, 11.85, 5.35)]), [("rId2", media_names[fault])]))

    if screenshots:
        first = screenshots[:4]
        rels = [(f"rId{i + 2}", media_names[p]) for i, p in enumerate(first)]
        positions = [(0.72, 1.55), (6.66, 1.55), (0.72, 4.05), (6.66, 4.05)]
        shapes = title("实机截图：本地化链路已经跑通。", "以下截图来自当前机器上的实际运行和验证过程。")
        for idx, (path, pos) in enumerate(zip(first, positions)):
            shapes.append(screenshot_card(10 + idx * 10, f"rId{idx + 2}", path, pos[0], pos[1], 5.55, 2.2))
        slides.append((slide_xml(shapes), rels))

    if len(screenshots) > 4:
        second = screenshots[4:]
        rels = [(f"rId{i + 2}", media_names[p]) for i, p in enumerate(second)]
        shapes = title("实机截图：命令输出与界面细节。", "截图保留原始比例，用于展示演示时的真实界面。")
        if len(second) == 3:
            positions = [(0.75, 1.85, 3.85, 3.65), (4.85, 1.85, 3.85, 3.65), (8.95, 1.85, 3.85, 3.65)]
        else:
            positions = [(0.72, 1.55, 5.55, 2.2), (6.66, 1.55, 5.55, 2.2), (0.72, 4.05, 5.55, 2.2), (6.66, 4.05, 5.55, 2.2)]
        for idx, (path, pos) in enumerate(zip(second, positions)):
            shapes.append(screenshot_card(60 + idx * 10, f"rId{idx + 2}", path, pos[0], pos[1], pos[2], pos[3]))
        slides.append((slide_xml(shapes), rels))

    slides.append((
        slide_xml(title("它不是离线聊天机器人，而是受控的本地知识助手。", "模型、语料和成本统计都与本地部署环境一致。") + [
            shape_text(4, emu(0.85), emu(2.05), emu(3.35), emu(1.55), ["控制权", "本地模型", "无需远端 Claude 调用"], 1450, INK, PANEL, TEAL, True, False, True),
            shape_text(5, emu(4.85), emu(2.05), emu(3.35), emu(1.55), ["知识 grounding", "LLMWiki", "项目文件成为可检索对象"], 1450, INK, PANEL, BLUE, True, False, True),
            shape_text(6, emu(8.85), emu(2.05), emu(3.05), emu(1.55), ["成本口径", "$0", "本地运行不再模拟云端计费"], 1450, INK, PANEL, GREEN, True, False, True),
            shape_text(7, emu(1.0), emu(4.85), emu(11.1), emu(0.9), ["保留 Claude Code 外壳仍有价值：用户工作流不变，底层推理和知识来源被本地化。"], 1450, INK, "F3F4F6", RULE, True, False, True),
        ]),
        []
    ))

    slides.append((
        slide_xml(title("边界必须说清楚。", "本地替换改变了风险和约束，但不会自动复制 Claude 的全部行为。") + [
            shape_text(4, emu(0.75), emu(1.75), emu(11.75), emu(4.6), ["界面仍保留 Claude 品牌；只有使用 LM Studio provider 脚本/环境变量时，请求才走本地", "工具调用可靠性取决于 qwen3.5:9b 的 function-calling 表现", "检索质量取决于 LLMWiki 索引、排序和文件质量", "图像/文档在 LM Studio 适配器中目前以文本省略说明表示", "交互式 /llmwiki 走 CLI 本地命令；headless /llmwiki 由启动脚本快路径处理"], 1500, INK, PANEL, GOLD, True, True),
        ]),
        []
    ))

    slides.append((slide_xml(title("下一步是检索增强的本地推理。", "当前系统已经能检索；产品化版本应该能检索、综合并引用来源。") + [pic_contain(4, "rId2", 0.72, 1.55, 11.85, 5.35)]), [("rId2", media_names[roadmap])]))

    slides.append((
        slide_xml([
            pic_cover(2, "rId2", 7.05, 0.0, 6.28, 7.5),
            shape_text(3, emu(0.75), emu(1.05), emu(6.3), emu(1.1), ["真正的转变，是从云端助手走向本地知识仪器。"], 2850, INK, None, None, False, False, True),
            shape_text(4, emu(0.78), emu(2.65), emu(6.0), emu(2.35), ["这个实现保留了熟悉的编码界面，把推理切换到 qwen3.5:9b，并让 LLMWiki 语料可以直接被查询。", "对于掌握大量私有运维资料、故障码文档和项目记录的团队，这是一个实用的 local-first 模式。"], 1650, INK, PANEL, RULE, True),
            shape_text(5, emu(0.78), emu(5.65), emu(6.0), emu(0.55), ["推荐演示：模型问答 → /llmwiki search 303804 → /llmwiki read 源文件"], 1250, TEAL, "E6F4F1", TEAL, True, False, True),
        ]),
        [("rId2", media_names[hero])]
    ))

    return slides, media_names


def write_pptx() -> None:
    slides, media_names = make_deck()
    with ZipFile(OUT, "w", ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types_visual(len(slides)))
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
