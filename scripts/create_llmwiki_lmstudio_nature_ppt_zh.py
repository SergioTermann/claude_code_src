#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from create_llmwiki_lmstudio_ppt import (
    app_xml,
    base_rels,
    connector,
    content_types,
    core_xml,
    emu,
    presentation_rels,
    presentation_xml,
    shape_text,
    slide_layout_xml,
    slide_master_xml,
    slide_rels,
    slide_xml,
    theme_xml,
)


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "LLMWiki_LM Studio_Local_Integration_Nature_ZH.pptx"

NATURE = {
    "ink": "111827",
    "muted": "4B5563",
    "panel": "FFFFFF",
    "rule": "D6D3C8",
    "teal": "006D6F",
    "blue": "1D4ED8",
    "gold": "A16207",
    "green": "166534",
    "code": "0B1120",
}


def kicker(text: str, sid: int = 98) -> str:
    return shape_text(
        sid,
        emu(0.65),
        emu(0.25),
        emu(4.8),
        emu(0.34),
        [text],
        1050,
        NATURE["teal"],
        None,
        None,
        False,
        False,
        True,
    )


def headline(text: str, subtitle: str | None = None) -> list[str]:
    parts = [
        shape_text(
            2,
            emu(0.65),
            emu(0.42),
            emu(11.8),
            emu(0.95),
            [text],
            2750,
            NATURE["ink"],
            None,
            None,
            False,
            False,
            True,
        ),
    ]
    if subtitle:
        parts.append(
            shape_text(
                3,
                emu(0.68),
                emu(1.18),
                emu(11.5),
                emu(0.45),
                [subtitle],
                1350,
                NATURE["muted"],
            )
        )
    return parts


def figure_label(sid: int, x: float, y: float, text: str) -> str:
    return shape_text(
        sid,
        emu(x),
        emu(y),
        emu(2.0),
        emu(0.32),
        [text],
        950,
        NATURE["muted"],
    )


def evidence_card(
    sid: int,
    x: float,
    y: float,
    title: str,
    value: str,
    note: str,
    accent: str,
) -> str:
    return shape_text(
        sid,
        emu(x),
        emu(y),
        emu(3.65),
        emu(1.45),
        [title, value, note],
        1450,
        NATURE["ink"],
        NATURE["panel"],
        accent,
        True,
    )


def node(sid: int, x: float, y: float, w: float, h: float, lines: list[str], fill: str, accent: str) -> str:
    return shape_text(
        sid,
        emu(x),
        emu(y),
        emu(w),
        emu(h),
        lines,
        1180,
        NATURE["ink"],
        fill,
        accent,
        True,
        False,
        True,
    )


def mini_bar(sid: int, x: float, y: float, label: str, width: float, color: str, value: str) -> str:
    return (
        shape_text(sid, emu(x), emu(y), emu(2.2), emu(0.35), [label], 1050, NATURE["muted"])
        + shape_text(sid + 1, emu(x + 2.25), emu(y + 0.04), emu(width), emu(0.22), [""], 800, NATURE["ink"], color, color, True)
        + shape_text(sid + 2, emu(x + 2.25 + width + 0.12), emu(y), emu(1.4), emu(0.35), [value], 1050, NATURE["ink"], None, None, False, False, True)
    )


def slides() -> list[str]:
    deck: list[str] = []

    deck.append(
        slide_xml(
            [
                shape_text(
                    2,
                    emu(0.72),
                    emu(0.72),
                    emu(11.6),
                    emu(1.25),
                    ["面向领域工作的本地知识引擎"],
                    3400,
                    NATURE["ink"],
                    None,
                    None,
                    False,
                    False,
                    True,
                ),
                shape_text(
                    3,
                    emu(0.76),
                    emu(1.82),
                    emu(10.7),
                    emu(0.65),
                    ["将 Claude Code 的推理路径切换到本机 LM Studio，并用 LLMWiki 索引库提供项目知识。"],
                    1650,
                    NATURE["muted"],
                ),
                evidence_card(4, 0.78, 3.05, "模型", "qwen3.5:9b", "由本机 LM Studio 提供推理服务", NATURE["teal"]),
                evidence_card(5, 4.55, 3.05, "语料", "8,657 个文件", "通过 .llm-wiki 索引暴露给助手", NATURE["blue"]),
                evidence_card(6, 8.32, 3.05, "成本信号", "$0", "本地推理按零 API 成本统计", NATURE["green"]),
                node(8, 1.2, 4.8, 1.85, 0.55, ["LM Studio"], "E6F4F1", NATURE["teal"]),
                connector(9, emu(3.05), emu(5.08), emu(4.2), emu(5.08), NATURE["teal"]),
                node(10, 4.2, 4.8, 1.85, 0.55, ["qwen3.5:9b"], "F0FDF4", NATURE["green"]),
                node(11, 6.8, 4.8, 1.85, 0.55, ["LLMWiki"], "FFFBEB", NATURE["gold"]),
                connector(12, emu(8.65), emu(5.08), emu(9.8), emu(5.08), NATURE["gold"]),
                node(13, 9.8, 4.8, 1.85, 0.55, ["本地答案"], "EFF6FF", NATURE["blue"]),
                figure_label(14, 5.85, 5.38, "图 1  本地推理与本地知识库合流"),
                shape_text(
                    7,
                    emu(0.78),
                    emu(5.95),
                    emu(11.25),
                    emu(0.65),
                    ["这不是简单换一个模型，而是保留原有编码界面，同时把模型、知识库和成本控制都放回本地。"],
                    1400,
                    NATURE["muted"],
                ),
            ]
        )
    )

    deck.append(
        slide_xml(
            headline(
                "瓶颈不只是模型，而是模型能否接触到本地知识。",
                "一个可用的本地助手，必须同时具备推理能力和项目记忆。",
            )
            + [
                shape_text(
                    4,
                    emu(0.75),
                    emu(2.0),
                    emu(5.55),
                    emu(3.75),
                    [
                        "改造前",
                        "客户端仍默认依赖远端 Claude API",
                        "故障码、历史资料等本地文档不在默认上下文中",
                        "非交互模式下 slash command 行为不稳定",
                    ],
                    1550,
                    NATURE["ink"],
                    NATURE["panel"],
                    NATURE["rule"],
                    True,
                    True,
                ),
                shape_text(
                    5,
                    emu(6.75),
                    emu(2.0),
                    emu(5.55),
                    emu(3.75),
                    [
                        "改造后",
                        "模型请求被路由到本机 LM Studio",
                        "LLMWiki 把索引文件和项目知识变成可检索入口",
                        "脚本模式可直接查询知识库，不依赖模型理解命令",
                    ],
                    1550,
                    NATURE["ink"],
                    NATURE["panel"],
                    NATURE["teal"],
                    True,
                    True,
                ),
            ]
        )
    )

    deck.append(
        slide_xml(
            headline(
                "界面被保留下来，推理链路被替换掉。",
                "设计目标是尽量少改变用户工作流，把本地模型适配隔离在后端。",
            )
            + [
                shape_text(4, emu(0.7), emu(2.05), emu(2.35), emu(0.92), ["Claude Code 界面", "工作流保持不变"], 1300, NATURE["ink"], NATURE["panel"], NATURE["rule"], True),
                connector(5, emu(3.0), emu(2.5), emu(4.05), emu(2.5), NATURE["teal"]),
                shape_text(6, emu(4.05), emu(1.9), emu(2.65), emu(1.2), ["Anthropic 兼容适配器", "stream / tools / token 估算"], 1250, NATURE["ink"], "E6F4F1", NATURE["teal"], True),
                connector(7, emu(6.7), emu(2.5), emu(7.75), emu(2.5), NATURE["teal"]),
                shape_text(8, emu(7.75), emu(1.9), emu(2.45), emu(1.2), ["LM Studio /api/chat", "localhost:11434"], 1300, NATURE["ink"], "EFF6FF", NATURE["blue"], True),
                connector(9, emu(10.2), emu(2.5), emu(11.05), emu(2.5), NATURE["blue"]),
                shape_text(10, emu(11.05), emu(1.9), emu(1.45), emu(1.2), ["qwen3.5:9b", "本地推理"], 1300, NATURE["ink"], "F0FDF4", NATURE["green"], True),
                shape_text(11, emu(1.0), emu(4.55), emu(3.25), emu(1.0), ["LLMWiki", "search/read/tree/path"], 1300, NATURE["ink"], "FFFBEB", NATURE["gold"], True),
                connector(12, emu(4.25), emu(5.05), emu(5.4), emu(5.05), NATURE["gold"]),
                shape_text(13, emu(5.4), emu(4.55), emu(3.15), emu(1.0), [".llm-wiki 索引", "file-snapshot.json"], 1300, NATURE["ink"], NATURE["panel"], NATURE["rule"], True),
                connector(14, emu(8.55), emu(5.05), emu(9.75), emu(5.05), NATURE["gold"]),
                shape_text(15, emu(9.75), emu(4.55), emu(2.15), emu(1.0), ["本地语料", "8,657 个文件"], 1300, NATURE["ink"], NATURE["panel"], NATURE["rule"], True),
            ]
        )
    )

    deck.append(
        slide_xml(
            headline(
                "三个工程决策让系统真正可用。",
                "改动并不庞大，但它们解决了最容易卡住的失败模式。",
            )
            + [
                shape_text(4, emu(0.75), emu(1.95), emu(3.65), emu(3.95), ["1. Provider 切换", "ANTHROPIC_MODEL_PROVIDER=lmstudio 选择本地客户端", "主查询链路仍看到 Anthropic-like messages"], 1450, NATURE["ink"], NATURE["panel"], NATURE["teal"], True),
                shape_text(5, emu(4.65), emu(1.95), emu(3.65), emu(3.95), ["2. 关闭 thinking 输出", "qwen3.5 默认会流式输出 thinking", "think:false 让可见答案稳定进入 content"], 1450, NATURE["ink"], NATURE["panel"], NATURE["blue"], True),
                shape_text(6, emu(8.55), emu(1.95), emu(3.65), emu(3.95), ["3. 本地命令快路径", "headless /llmwiki 由脚本直接执行", "知识库检索不再依赖模型解释 slash command"], 1450, NATURE["ink"], NATURE["panel"], NATURE["gold"], True),
            ]
        )
    )

    deck.append(
        slide_xml(
            headline(
                "证据是可复现的：本地模型能答，本地索引能查。",
                "验证命令不需要云端 API key。",
            )
            + [
                shape_text(4, emu(0.75), emu(2.0), emu(5.65), emu(2.25), ["模型调用", "npm run print:lmstudio -- \"只回答两个字：你好\"", "输出：你好"], 1450, "FFFFFF", NATURE["code"], None, True),
                shape_text(5, emu(6.72), emu(2.0), emu(5.55), emu(2.25), ["知识库查询", "npm run print:lmstudio -- \"/llmwiki search 303804 --limit 2\"", "输出：本地故障码记录"], 1370, "FFFFFF", NATURE["code"], None, True),
                shape_text(6, emu(0.75), emu(4.85), emu(11.7), emu(0.75), ["JSON 验证显示：model=qwen3.5:9b，total_cost_usd=0。"], 1500, NATURE["teal"], "E6F4F1", NATURE["teal"], True, False, True),
                mini_bar(7, 1.0, 5.9, "模型确认", 2.15, NATURE["teal"], "qwen3.5:9b"),
                mini_bar(10, 5.0, 5.9, "索引规模", 2.35, NATURE["blue"], "8,657 files"),
                mini_bar(13, 9.0, 5.9, "API 成本", 1.55, NATURE["green"], "$0"),
            ]
        )
    )

    deck.append(
        slide_xml(
            headline(
                "一个领域案例说明了索引的价值。",
                "助手检索到的是项目资料中的精确记录，而不是泛化语言模型的记忆。",
            )
            + [
                shape_text(
                    4,
                    emu(0.75),
                    emu(1.95),
                    emu(11.75),
                    emu(3.35),
                    [
                        "故障码 303804",
                        "名称：24V主电源开关故障",
                        "原因：变桨24V主电源开关断开",
                        "处理：检查24V主电源开关线路是否存在短路、断路情况",
                        "逻辑：反馈信号丢失时报故障；恢复后不会自动复位，需手动复位并启动",
                    ],
                    1500,
                    NATURE["ink"],
                    NATURE["panel"],
                    NATURE["rule"],
                    True,
                ),
                node(5, 1.0, 5.55, 2.2, 0.55, ["输入：303804"], "EFF6FF", NATURE["blue"]),
                connector(6, emu(3.2), emu(5.83), emu(4.25), emu(5.83), NATURE["blue"]),
                node(7, 4.25, 5.55, 2.45, 0.55, ["命中：CSV / MD"], "FFFBEB", NATURE["gold"]),
                connector(8, emu(6.7), emu(5.83), emu(7.75), emu(5.83), NATURE["gold"]),
                node(9, 7.75, 5.55, 3.5, 0.55, ["输出：故障原因与处理建议"], "E6F4F1", NATURE["teal"]),
                figure_label(10, 1.0, 6.16, "图 2  故障码检索路径"),
            ]
        )
    )

    deck.append(
        slide_xml(
            headline(
                "它不是离线聊天机器人，而是受控的本地知识助手。",
                "关键变化在于：模型、语料和成本统计都与本地部署环境一致。",
            )
            + [
                evidence_card(4, 0.78, 2.05, "控制权", "本地模型", "无需远端 Claude 调用", NATURE["teal"]),
                evidence_card(5, 4.55, 2.05, "知识 grounding", "LLMWiki", "项目文件成为可检索对象", NATURE["blue"]),
                evidence_card(6, 8.32, 2.05, "成本口径", "$0", "本地运行不再模拟云端计费", NATURE["green"]),
                shape_text(7, emu(1.0), emu(4.55), emu(11.1), emu(0.95), ["保留 Claude Code 外壳仍有价值：用户工作流不变，底层推理和知识来源被本地化。"], 1500, NATURE["ink"], "F3F4F6", NATURE["rule"], True, False, True),
            ]
        )
    )

    deck.append(
        slide_xml(
            headline(
                "边界必须说清楚。",
                "本地替换改变了风险和约束，但不会自动复制 Claude 的全部行为。",
            )
            + [
                shape_text(
                    4,
                    emu(0.75),
                    emu(1.9),
                    emu(11.75),
                    emu(4.2),
                    [
                        "界面仍保留 Claude 品牌；只有使用 LM Studio provider 脚本/环境变量时，请求才走本地",
                        "工具调用可靠性取决于 qwen3.5:9b 的 function-calling 表现",
                        "检索质量取决于 LLMWiki 索引、排序和文件质量",
                        "图像/文档在 LM Studio 适配器中目前以文本省略说明表示",
                        "交互式 /llmwiki 走 CLI 本地命令；headless /llmwiki 由启动脚本快路径处理",
                    ],
                    1550,
                    NATURE["ink"],
                    NATURE["panel"],
                    NATURE["gold"],
                    True,
                    True,
                ),
            ]
        )
    )

    deck.append(
        slide_xml(
            headline(
                "下一步是检索增强的本地推理。",
                "当前系统已经能检索；产品化版本应该能检索、综合并引用来源。",
            )
            + [
                shape_text(4, emu(0.75), emu(1.9), emu(3.65), emu(4.0), ["短期", "增加 /lmstudio doctor", "显示服务、模型和 LLMWiki 路径健康状态", "让失败提示更可操作"], 1450, NATURE["ink"], NATURE["panel"], NATURE["teal"], True, True),
                shape_text(5, emu(4.65), emu(1.9), emu(3.65), emu(4.0), ["中期", "增加 /llmwiki ask", "先检索 top passages", "再让 qwen3.5 综合并给出引用"], 1450, NATURE["ink"], NATURE["panel"], NATURE["blue"], True, True),
                shape_text(6, emu(8.55), emu(1.9), emu(3.65), emu(4.0), ["长期", "引入 BM25 或向量排序", "记录回答质量", "把本地产品身份与 Claude UI 文案分离"], 1450, NATURE["ink"], NATURE["panel"], NATURE["gold"], True, True),
            ]
        )
    )

    deck.append(
        slide_xml(
            [
                kicker("结论"),
                shape_text(2, emu(0.75), emu(1.05), emu(11.65), emu(1.1), ["真正的转变，是从云端助手走向本地知识仪器。"], 3100, NATURE["ink"], None, None, False, False, True),
                shape_text(
                    3,
                    emu(0.78),
                    emu(2.45),
                    emu(11.2),
                    emu(2.35),
                    [
                        "这个实现保留了熟悉的编码界面，把推理切换到 qwen3.5:9b，并让 LLMWiki 语料可以直接被查询。",
                        "对于掌握大量私有运维资料、故障码文档和项目记录的团队，这是一个实用的 local-first 模式：可控、可检查、低成本。",
                    ],
                    1750,
                    NATURE["ink"],
                    NATURE["panel"],
                    NATURE["rule"],
                    True,
                ),
                shape_text(4, emu(0.78), emu(5.45), emu(11.4), emu(0.5), ["推荐演示路径：普通模型问答 → /llmwiki search 303804 → /llmwiki read 源文件"], 1350, NATURE["teal"], "E6F4F1", NATURE["teal"], True, False, True),
            ]
        )
    )

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
        z.writestr(
            "ppt/slideMasters/_rels/slideMaster1.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>',
        )
        z.writestr("ppt/slideLayouts/slideLayout1.xml", slide_layout_xml())
        z.writestr(
            "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>',
        )
        for i, doc in enumerate(slide_docs, start=1):
            z.writestr(f"ppt/slides/slide{i}.xml", doc)
            z.writestr(f"ppt/slides/_rels/slide{i}.xml.rels", slide_rels())


if __name__ == "__main__":
    write_pptx()
    print(OUT)
