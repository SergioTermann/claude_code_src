#!/usr/bin/env python3
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from textwrap import dedent
from zipfile import ZIP_DEFLATED, ZipFile
from xml.sax.saxutils import escape


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "LLMWiki_LM Studio_Local_Integration.pptx"

SLIDE_W = 12192000
SLIDE_H = 6858000

COLORS = {
    "ink": "1F2937",
    "muted": "64748B",
    "bg": "F7F8FA",
    "panel": "FFFFFF",
    "line": "CBD5E1",
    "accent": "0F766E",
    "accent2": "2563EB",
    "warning": "B45309",
    "soft": "E6F4F1",
    "soft2": "EAF1FF",
    "code": "111827",
}


def emu(inches: float) -> int:
    return int(inches * 914400)


def xml_text(text: str) -> str:
    return escape(text, {"\n": "&#10;"})


def text_runs(lines: list[str], size: int, color: str, bullet: bool = False) -> str:
    paras = []
    for line in lines:
        bullet_xml = (
            '<a:buChar char="•"/><a:buFont typeface="Arial"/>'
            if bullet
            else "<a:buNone/>"
        )
        paras.append(
            f"""
            <a:p>
              <a:pPr marL="{'280000' if bullet else '0'}" indent="{'-180000' if bullet else '0'}">{bullet_xml}</a:pPr>
              <a:r>
                <a:rPr lang="zh-CN" sz="{size}" dirty="0">
                  <a:solidFill><a:srgbClr val="{color}"/></a:solidFill>
                  <a:latin typeface="Arial"/><a:ea typeface="Microsoft YaHei"/>
                </a:rPr>
                <a:t>{xml_text(line)}</a:t>
              </a:r>
            </a:p>
            """
        )
    return "\n".join(paras)


def shape_text(
    shape_id: int,
    x: int,
    y: int,
    w: int,
    h: int,
    lines: list[str],
    size: int = 2400,
    color: str = COLORS["ink"],
    fill: str | None = None,
    line: str | None = None,
    radius: bool = False,
    bullet: bool = False,
    bold: bool = False,
) -> str:
    prst = "roundRect" if radius else "rect"
    fill_xml = (
        f'<a:solidFill><a:srgbClr val="{fill}"/></a:solidFill>'
        if fill
        else "<a:noFill/>"
    )
    line_xml = (
        f'<a:ln w="12700"><a:solidFill><a:srgbClr val="{line}"/></a:solidFill></a:ln>'
        if line
        else "<a:ln><a:noFill/></a:ln>"
    )
    body = text_runs(lines, size, color, bullet)
    if bold:
        body = body.replace('dirty="0">', 'dirty="0" b="1">')
    return f"""
    <p:sp>
      <p:nvSpPr>
        <p:cNvPr id="{shape_id}" name="Text {shape_id}"/>
        <p:cNvSpPr txBox="1"/>
        <p:nvPr/>
      </p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{w}" cy="{h}"/></a:xfrm>
        <a:prstGeom prst="{prst}"><a:avLst/></a:prstGeom>
        {fill_xml}
        {line_xml}
      </p:spPr>
      <p:txBody>
        <a:bodyPr wrap="square" lIns="160000" tIns="120000" rIns="160000" bIns="100000"/>
        <a:lstStyle/>
        {body}
      </p:txBody>
    </p:sp>
    """


def connector(shape_id: int, x1: int, y1: int, x2: int, y2: int, color: str = COLORS["line"]) -> str:
    x = min(x1, x2)
    y = min(y1, y2)
    w = abs(x2 - x1) or 1
    h = abs(y2 - y1) or 1
    flip_h = ' flipH="1"' if x2 < x1 else ""
    flip_v = ' flipV="1"' if y2 < y1 else ""
    return f"""
    <p:cxnSp>
      <p:nvCxnSpPr><p:cNvPr id="{shape_id}" name="Connector {shape_id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>
      <p:spPr>
        <a:xfrm{flip_h}{flip_v}><a:off x="{x}" y="{y}"/><a:ext cx="{w}" cy="{h}"/></a:xfrm>
        <a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom>
        <a:ln w="25400"><a:solidFill><a:srgbClr val="{color}"/></a:solidFill><a:tailEnd type="triangle"/></a:ln>
      </p:spPr>
    </p:cxnSp>
    """


def title_block(title: str, subtitle: str | None = None) -> list[str]:
    shapes = [
        shape_text(2, emu(0.55), emu(0.35), emu(12.2), emu(0.65), [title], 3000, COLORS["ink"], bold=True)
    ]
    if subtitle:
        shapes.append(shape_text(3, emu(0.57), emu(0.95), emu(11.8), emu(0.38), [subtitle], 1500, COLORS["muted"]))
    return shapes


def slide_xml(shapes: list[str]) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="{COLORS['bg']}"/></a:solidFill></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      {''.join(shapes)}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>
"""


def content_types(slide_count: int) -> str:
    slides = "\n".join(
        f'<Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        for i in range(1, slide_count + 1)
    )
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  {slides}
</Types>
"""


def presentation_xml(slide_count: int) -> str:
    ids = "\n".join(
        f'<p:sldId id="{255 + i}" r:id="rId{i}"/>' for i in range(1, slide_count + 1)
    )
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
                xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId{slide_count + 1}"/></p:sldMasterIdLst>
  <p:sldIdLst>{ids}</p:sldIdLst>
  <p:sldSz cx="{SLIDE_W}" cy="{SLIDE_H}" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
  <p:defaultTextStyle/>
</p:presentation>
"""


def presentation_rels(slide_count: int) -> str:
    rels = [
        f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{i}.xml"/>'
        for i in range(1, slide_count + 1)
    ]
    rels.append(
        f'<Relationship Id="rId{slide_count + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
    )
    rels.append(
        f'<Relationship Id="rId{slide_count + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>'
    )
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  {''.join(rels)}
</Relationships>
"""


def slide_rels() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>
"""


def base_rels() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>
"""


def app_xml(slide_count: int) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
            xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Codex</Application>
  <PresentationFormat>On-screen Show (16:9)</PresentationFormat>
  <Slides>{slide_count}</Slides>
</Properties>
"""


def core_xml() -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                   xmlns:dc="http://purl.org/dc/elements/1.1/"
                   xmlns:dcterms="http://purl.org/dc/terms/"
                   xmlns:dcmitype="http://purl.org/dc/dcmitype/"
                   xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>LLMWiki + LM Studio 本地化集成方案</dc:title>
  <dc:creator>Codex</dc:creator>
  <cp:lastModifiedBy>Codex</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified>
</cp:coreProperties>
"""


def theme_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Local">
  <a:themeElements>
    <a:clrScheme name="Local">
      <a:dk1><a:srgbClr val="1F2937"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="334155"/></a:dk2><a:lt2><a:srgbClr val="F7F8FA"/></a:lt2>
      <a:accent1><a:srgbClr val="0F766E"/></a:accent1><a:accent2><a:srgbClr val="2563EB"/></a:accent2>
      <a:accent3><a:srgbClr val="B45309"/></a:accent3><a:accent4><a:srgbClr val="64748B"/></a:accent4>
      <a:accent5><a:srgbClr val="14B8A6"/></a:accent5><a:accent6><a:srgbClr val="93C5FD"/></a:accent6>
      <a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="0F766E"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Local"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface="Microsoft YaHei"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface="Microsoft YaHei"/></a:minorFont></a:fontScheme>
    <a:fmtScheme name="Local"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme>
  </a:themeElements>
</a:theme>
"""


def slide_master_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
             xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
             xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>
"""


def slide_layout_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
             xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
             xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
  <p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>
"""


def slides() -> list[str]:
    deck: list[str] = []

    deck.append(slide_xml([
        shape_text(2, emu(0.65), emu(0.55), emu(12.0), emu(1.0), ["LLMWiki + LM Studio 本地化集成"], 3600, COLORS["ink"], bold=True),
        shape_text(3, emu(0.72), emu(1.55), emu(10.4), emu(0.55), ["用本机 qwen3.5:9b 替代 Claude，并接入本地项目知识库"], 1900, COLORS["muted"]),
        shape_text(4, emu(0.75), emu(2.45), emu(3.7), emu(1.35), ["核心目标", "不依赖远端 Claude API，直接调用本机 LM Studio"], 1700, COLORS["ink"], COLORS["soft"], COLORS["line"], True),
        shape_text(5, emu(4.85), emu(2.45), emu(3.7), emu(1.35), ["知识增强", "LLMWiki 索引 8657 个本地文件，支持 search/read"], 1700, COLORS["ink"], COLORS["soft2"], COLORS["line"], True),
        shape_text(6, emu(8.95), emu(2.45), emu(3.35), emu(1.35), ["运行方式", "npm run run:lmstudio / npm run print:lmstudio"], 1700, COLORS["ink"], "FFF7ED", COLORS["line"], True),
        shape_text(7, emu(0.75), emu(5.75), emu(11.7), emu(0.45), ["当前版本：Claude Code recovered 2.1.88 · 模型：LM Studio qwen3.5:9b · Wiki：/Users/zinger/111"], 1250, COLORS["muted"]),
    ]))

    deck.append(slide_xml(title_block("为什么要做这个集成", "把代码助手从远端 API 改成本地可控的知识增强助手") + [
        shape_text(4, emu(0.75), emu(1.55), emu(5.6), emu(3.9), [
            "原始痛点",
            "需要 Claude API 或订阅环境",
            "本地资料无法自然进入模型上下文",
            "headless / slash command 验证不稳定",
            "本地故障码、历史资料检索成本高",
        ], 1700, COLORS["ink"], COLORS["panel"], COLORS["line"], True, True),
        shape_text(5, emu(6.75), emu(1.55), emu(5.6), emu(3.9), [
            "优化方向",
            "请求转发到本机 LM Studio",
            "默认模型 qwen3.5:9b",
            "LLMWiki 作为本地知识入口",
            "命令脚本化，便于复现和演示",
        ], 1700, COLORS["ink"], COLORS["panel"], COLORS["line"], True, True),
    ]))

    deck.append(slide_xml(title_block("总体架构", "Claude Code UI 保留，底层模型和知识来源切到本地") + [
        shape_text(4, emu(0.7), emu(2.0), emu(2.3), emu(0.85), ["CLI / TUI", "npm run run:lmstudio"], 1450, COLORS["ink"], COLORS["panel"], COLORS["line"], True),
        connector(5, emu(3.0), emu(2.43), emu(4.0), emu(2.43), COLORS["accent"]),
        shape_text(6, emu(4.0), emu(1.85), emu(2.5), emu(1.15), ["LM Studio Adapter", "Anthropic Messages API 兼容层"], 1450, COLORS["ink"], COLORS["soft"], COLORS["accent"], True),
        connector(7, emu(6.5), emu(2.43), emu(7.55), emu(2.43), COLORS["accent"]),
        shape_text(8, emu(7.55), emu(1.85), emu(2.3), emu(1.15), ["LM Studio API", "127.0.0.1:11434"], 1450, COLORS["ink"], COLORS["soft2"], COLORS["accent2"], True),
        connector(9, emu(9.85), emu(2.43), emu(10.75), emu(2.43), COLORS["accent2"]),
        shape_text(10, emu(10.75), emu(1.85), emu(1.75), emu(1.15), ["qwen3.5:9b", "本地推理"], 1450, COLORS["ink"], "F0FDF4", COLORS["line"], True),
        shape_text(11, emu(1.0), emu(4.25), emu(3.2), emu(1.05), ["LLMWiki Command", "/llmwiki search/read"], 1450, COLORS["ink"], "FFF7ED", COLORS["line"], True),
        connector(12, emu(4.2), emu(4.78), emu(5.4), emu(4.78), COLORS["warning"]),
        shape_text(13, emu(5.4), emu(4.25), emu(3.2), emu(1.05), [".llm-wiki", "file-snapshot.json"], 1450, COLORS["ink"], COLORS["panel"], COLORS["line"], True),
        connector(14, emu(8.6), emu(4.78), emu(9.8), emu(4.78), COLORS["warning"]),
        shape_text(15, emu(9.8), emu(4.25), emu(2.15), emu(1.05), ["本地资料", "8657 files"], 1450, COLORS["ink"], COLORS["panel"], COLORS["line"], True),
    ]))

    deck.append(slide_xml(title_block("已实现的关键改动", "集中在模型 provider、LM Studio 适配、LLMWiki 命令和启动脚本") + [
        shape_text(4, emu(0.72), emu(1.45), emu(11.8), emu(4.6), [
            "src/services/api/client.ts：provider=lmstudio 时返回本地 LM Studio Anthropic 兼容客户端",
            "src/services/api/lmstudioClient.ts：适配 /api/chat、stream、tool_calls、countTokens 粗估",
            "src/commands/llmwiki/llmwiki.ts：支持搜索 wiki/ 与 .llm-wiki/file-snapshot.json 索引文件",
            "src/skills/bundled/llmwiki.ts：把本地 LLMWiki 作为自动可用技能注入",
            "scripts/run-lmstudio-claude.mjs：封装 LM Studio 预检、默认环境变量、headless /llmwiki 快路径",
            "src/utils/modelCost.ts：LM Studio 本地成本归零；UI 显示 LM Studio Local",
        ], 1550, COLORS["ink"], COLORS["panel"], COLORS["line"], True, True),
    ]))

    deck.append(slide_xml(title_block("运行方式", "给使用者只保留两个主命令") + [
        shape_text(4, emu(0.75), emu(1.55), emu(5.7), emu(2.2), [
            "交互式运行",
            "cd /Users/zinger/claude_code_src",
            "npm run run:lmstudio",
        ], 1700, COLORS["ink"], COLORS["panel"], COLORS["line"], True),
        shape_text(5, emu(6.75), emu(1.55), emu(5.6), emu(2.2), [
            "命令行验证",
            "npm run print:lmstudio -- \"只回答两个字：你好\"",
            "npm run print:lmstudio -- \"/llmwiki search 303804 --limit 2\"",
        ], 1500, COLORS["ink"], COLORS["panel"], COLORS["line"], True),
        shape_text(6, emu(0.85), emu(4.35), emu(11.4), emu(1.2), [
            "可覆盖环境变量：LMSTUDIO_MODEL、LMSTUDIO_BASE_URL、LLMWIKI_PROJECT、ANTHROPIC_MODEL_PROVIDER",
            "默认值：qwen3.5:9b / http://127.0.0.1:11434 / /Users/zinger/111 / lmstudio",
        ], 1450, COLORS["muted"], COLORS["soft"], COLORS["line"], True),
    ]))

    deck.append(slide_xml(title_block("验证结果", "本地模型、成本、LLMWiki 三条链路都已跑通") + [
        shape_text(4, emu(0.75), emu(1.45), emu(3.6), emu(3.9), [
            "LM Studio 模型",
            "lmstudio list 中存在 qwen3.5:9b",
            "CLI 输出模型字段：qwen3.5:9b",
            "普通 prompt 输出：你好",
        ], 1500, COLORS["ink"], COLORS["panel"], COLORS["line"], True, True),
        shape_text(5, emu(4.85), emu(1.45), emu(3.6), emu(3.9), [
            "本地成本",
            "total_cost_usd = 0",
            "modelUsage.costUSD = 0",
            "UI billing：LM Studio Local",
        ], 1500, COLORS["ink"], COLORS["panel"], COLORS["line"], True, True),
        shape_text(6, emu(8.95), emu(1.45), emu(3.4), emu(3.9), [
            "LLMWiki",
            "索引文件数：8657",
            "303804 命中故障码资料",
            "支持 search/read/path/tree",
        ], 1500, COLORS["ink"], COLORS["panel"], COLORS["line"], True, True),
    ]))

    deck.append(slide_xml(title_block("LLMWiki 示例：故障码 303804", "从本地知识库直接检索，不经过远端服务") + [
        shape_text(4, emu(0.75), emu(1.55), emu(11.75), emu(0.75), [
            "命令：npm run print:lmstudio -- \"/llmwiki search 303804 --limit 2\""
        ], 1450, "FFFFFF", COLORS["code"], None, True),
        shape_text(5, emu(0.75), emu(2.55), emu(11.75), emu(2.6), [
            "命中结果",
            "303804, 24V主电源开关故障",
            "故障原因：变桨24V主电源开关断开",
            "故障处理：检查24V主电源开关线路是否存在短路、断路情况",
            "故障逻辑：反馈信号丢失时报故障；恢复后需手动复位和手动启动",
        ], 1500, COLORS["ink"], COLORS["panel"], COLORS["line"], True, True),
        shape_text(6, emu(0.75), emu(5.35), emu(11.75), emu(0.7), [
            "资料路径：raw/sources/风机故障码/HW2S2000(103)型风力发电机/...303804.md"
        ], 1300, COLORS["muted"]),
    ]))

    deck.append(slide_xml(title_block("当前边界与注意事项", "本地模型能跑，但能力边界与 Claude 不完全等价") + [
        shape_text(4, emu(0.75), emu(1.45), emu(11.75), emu(4.4), [
            "UI 品牌仍然保留 Claude Code，这是产品外壳文案，不影响请求走 LM Studio",
            "qwen3.5:9b 支持 tools/thinking，但复杂工具调用能力取决于本地模型表现",
            "默认传 think:false，避免 thinking 流污染最终输出；可用 LMSTUDIO_THINK=1 打开",
            "headless /llmwiki 走脚本快路径；交互式 /llmwiki 仍走 CLI 本地命令",
            "本地模型上下文、速度、质量由 LM Studio 模型文件和机器性能决定",
        ], 1550, COLORS["ink"], COLORS["panel"], COLORS["line"], True, True),
    ]))

    deck.append(slide_xml(title_block("下一步优化建议", "让本地知识助手更稳定、更像产品") + [
        shape_text(4, emu(0.75), emu(1.45), emu(5.6), emu(4.35), [
            "短期",
            "增加 /lmstudio doctor：检查服务、模型、LLMWiki 路径",
            "补一个 /llmwiki ask：检索后再交给 qwen3.5 总结",
            "把 303804 这类故障码检索做成标准模板",
        ], 1550, COLORS["ink"], COLORS["panel"], COLORS["line"], True, True),
        shape_text(5, emu(6.75), emu(1.45), emu(5.6), emu(4.35), [
            "中期",
            "为 LLMWiki 做向量检索或 BM25 排序",
            "记录本地模型调用日志，便于评估质量",
            "做一个真正的本地化品牌入口，减少 Claude 文案干扰",
        ], 1550, COLORS["ink"], COLORS["panel"], COLORS["line"], True, True),
    ]))

    return deck


def write_pptx() -> None:
    slide_docs = slides()
    with ZipFile(OUT, "w", ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types(len(slide_docs)))
        z.writestr("_rels/.rels", base_rels())
        z.writestr("docProps/app.xml", app_xml(len(slide_docs)))
        z.writestr("docProps/core.xml", core_xml())
        z.writestr("ppt/presentation.xml", presentation_xml(len(slide_docs)))
        z.writestr("ppt/_rels/presentation.xml.rels", presentation_rels(len(slide_docs)))
        z.writestr("ppt/theme/theme1.xml", theme_xml())
        z.writestr("ppt/slideMasters/slideMaster1.xml", slide_master_xml())
        z.writestr("ppt/slideMasters/_rels/slideMaster1.xml.rels", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>""")
        z.writestr("ppt/slideLayouts/slideLayout1.xml", slide_layout_xml())
        z.writestr("ppt/slideLayouts/_rels/slideLayout1.xml.rels", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>""")
        for i, doc in enumerate(slide_docs, start=1):
            z.writestr(f"ppt/slides/slide{i}.xml", doc)
            z.writestr(f"ppt/slides/_rels/slide{i}.xml.rels", slide_rels())


if __name__ == "__main__":
    write_pptx()
    print(OUT)
