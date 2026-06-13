#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from create_llmwiki_lmstudio_ppt import (
    COLORS,
    OUT as _ORIGINAL_OUT,
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
    title_block,
)


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "LLMWiki_LM Studio_Local_Integration_Nature_Edit.pptx"

NATURE = {
    "ink": "111827",
    "muted": "4B5563",
    "paper": "FAFAF7",
    "panel": "FFFFFF",
    "rule": "D6D3C8",
    "teal": "006D6F",
    "blue": "1D4ED8",
    "gold": "A16207",
    "green": "166534",
    "red": "991B1B",
    "code": "0B1120",
}


def kicker(text: str, sid: int = 98) -> str:
    return shape_text(
        sid,
        emu(0.65),
        emu(0.25),
        emu(4.8),
        emu(0.34),
        [text.upper()],
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
        kicker("Nature-style technical briefing"),
        shape_text(
            2,
            emu(0.65),
            emu(0.62),
            emu(11.8),
            emu(0.95),
            [text],
            2850,
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
                emu(1.35),
                emu(11.5),
                emu(0.45),
                [subtitle],
                1350,
                NATURE["muted"],
            )
        )
    return parts


def evidence_card(sid: int, x: float, y: float, title: str, value: str, note: str, accent: str) -> str:
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
        False,
        False,
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
                    ["A local knowledge engine for domain-specific AI work"],
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
                    ["Claude Code was re-routed to a local LM Studio model and grounded in an indexed LLMWiki corpus."],
                    1650,
                    NATURE["muted"],
                ),
                evidence_card(4, 0.78, 3.05, "Model", "qwen3.5:9b", "served by LM Studio on localhost", NATURE["teal"]),
                evidence_card(5, 4.55, 3.05, "Corpus", "8,657 files", "available through .llm-wiki index", NATURE["blue"]),
                evidence_card(6, 8.32, 3.05, "Cost signal", "$0", "local inference is treated as free", NATURE["green"]),
                shape_text(
                    7,
                    emu(0.78),
                    emu(5.55),
                    emu(11.25),
                    emu(0.65),
                    ["This is a systems integration story: preserve the coding interface, replace the remote model path, and make local project knowledge first-class."],
                    1400,
                    NATURE["muted"],
                ),
            ]
        )
    )

    deck.append(
        slide_xml(
            headline(
                "The bottleneck was not only the model; it was access to local knowledge.",
                "A local assistant must answer with both reasoning capacity and project-specific memory.",
            )
            + [
                shape_text(
                    4,
                    emu(0.75),
                    emu(2.0),
                    emu(5.55),
                    emu(3.75),
                    [
                        "Before",
                        "Remote API assumptions stayed embedded in the client",
                        "Local fault-code documents were outside the assistant’s default context",
                        "Slash-command behaviour was inconsistent in non-interactive runs",
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
                        "After",
                        "Model calls are routed to LM Studio",
                        "LLMWiki exposes indexed files and prior project knowledge",
                        "Headless checks can query the corpus without invoking the model",
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
                "The interface was retained, while the inference path was replaced.",
                "The design minimizes change to the user workflow and isolates local-model adaptation.",
            )
            + [
                shape_text(4, emu(0.7), emu(2.05), emu(2.35), emu(0.92), ["Claude Code UI", "unchanged workflow"], 1300, NATURE["ink"], NATURE["panel"], NATURE["rule"], True),
                connector(5, emu(3.0), emu(2.5), emu(4.05), emu(2.5), NATURE["teal"]),
                shape_text(6, emu(4.05), emu(1.9), emu(2.65), emu(1.2), ["Anthropic-compatible adapter", "stream + tools + token estimate"], 1250, NATURE["ink"], "E6F4F1", NATURE["teal"], True),
                connector(7, emu(6.7), emu(2.5), emu(7.75), emu(2.5), NATURE["teal"]),
                shape_text(8, emu(7.75), emu(1.9), emu(2.45), emu(1.2), ["LM Studio /api/chat", "localhost:11434"], 1300, NATURE["ink"], "EFF6FF", NATURE["blue"], True),
                connector(9, emu(10.2), emu(2.5), emu(11.05), emu(2.5), NATURE["blue"]),
                shape_text(10, emu(11.05), emu(1.9), emu(1.45), emu(1.2), ["qwen3.5:9b", "local"], 1300, NATURE["ink"], "F0FDF4", NATURE["green"], True),
                shape_text(11, emu(1.0), emu(4.55), emu(3.25), emu(1.0), ["LLMWiki", "search/read/tree/path"], 1300, NATURE["ink"], "FFFBEB", NATURE["gold"], True),
                connector(12, emu(4.25), emu(5.05), emu(5.4), emu(5.05), NATURE["gold"]),
                shape_text(13, emu(5.4), emu(4.55), emu(3.15), emu(1.0), [".llm-wiki index", "file-snapshot.json"], 1300, NATURE["ink"], NATURE["panel"], NATURE["rule"], True),
                connector(14, emu(8.55), emu(5.05), emu(9.75), emu(5.05), NATURE["gold"]),
                shape_text(15, emu(9.75), emu(4.55), emu(2.15), emu(1.0), ["Local corpus", "8,657 files"], 1300, NATURE["ink"], NATURE["panel"], NATURE["rule"], True),
            ]
        )
    )

    deck.append(
        slide_xml(
            headline(
                "Three engineering decisions made the system usable.",
                "The important changes are small, but they remove the highest-friction failure modes.",
            )
            + [
                shape_text(
                    4,
                    emu(0.75),
                    emu(1.95),
                    emu(3.65),
                    emu(3.95),
                    [
                        "1. Provider switch",
                        "ANTHROPIC_MODEL_PROVIDER=lmstudio selects a local client",
                        "The rest of the query pipeline still sees Anthropic-like messages",
                    ],
                    1450,
                    NATURE["ink"],
                    NATURE["panel"],
                    NATURE["teal"],
                    True,
                    False,
                ),
                shape_text(
                    5,
                    emu(4.65),
                    emu(1.95),
                    emu(3.65),
                    emu(3.95),
                    [
                        "2. Thinking control",
                        "qwen3.5 emits a thinking stream by default",
                        "think:false keeps the visible answer in content",
                    ],
                    1450,
                    NATURE["ink"],
                    NATURE["panel"],
                    NATURE["blue"],
                    True,
                    False,
                ),
                shape_text(
                    6,
                    emu(8.55),
                    emu(1.95),
                    emu(3.65),
                    emu(3.95),
                    [
                        "3. Local command fast path",
                        "Headless /llmwiki is executed directly",
                        "Corpus retrieval no longer depends on model interpretation of slash commands",
                    ],
                    1450,
                    NATURE["ink"],
                    NATURE["panel"],
                    NATURE["gold"],
                    True,
                    False,
                ),
            ]
        )
    )

    deck.append(
        slide_xml(
            headline(
                "The evidence is concrete: a local model answers, and the local index retrieves.",
                "The verification uses command-line paths that can be repeated without a cloud API key.",
            )
            + [
                shape_text(
                    4,
                    emu(0.75),
                    emu(2.0),
                    emu(5.65),
                    emu(2.25),
                    [
                        "Model call",
                        "npm run print:lmstudio -- \"只回答两个字：你好\"",
                        "Output: 你好",
                    ],
                    1450,
                    "FFFFFF",
                    NATURE["code"],
                    None,
                    True,
                ),
                shape_text(
                    5,
                    emu(6.72),
                    emu(2.0),
                    emu(5.55),
                    emu(2.25),
                    [
                        "LLMWiki query",
                        "npm run print:lmstudio -- \"/llmwiki search 303804 --limit 2\"",
                        "Output: local fault-code records",
                    ],
                    1370,
                    "FFFFFF",
                    NATURE["code"],
                    None,
                    True,
                ),
                shape_text(
                    6,
                    emu(0.75),
                    emu(4.85),
                    emu(11.7),
                    emu(0.75),
                    ["JSON verification reports model=qwen3.5:9b and total_cost_usd=0."],
                    1500,
                    NATURE["teal"],
                    "E6F4F1",
                    NATURE["teal"],
                    True,
                    False,
                    True,
                ),
            ]
        )
    )

    deck.append(
        slide_xml(
            headline(
                "A domain example shows why indexing matters.",
                "The assistant can retrieve a fault-code record precisely instead of relying on generic language-model memory.",
            )
            + [
                shape_text(
                    4,
                    emu(0.75),
                    emu(1.95),
                    emu(11.75),
                    emu(3.7),
                    [
                        "Fault code 303804",
                        "Name: 24V主电源开关故障",
                        "Cause: 变桨24V主电源开关断开",
                        "Action: 检查24V主电源开关线路是否存在短路、断路情况",
                        "Logic: 反馈信号丢失时报故障；恢复后不会自动复位，需手动复位并启动",
                    ],
                    1500,
                    NATURE["ink"],
                    NATURE["panel"],
                    NATURE["rule"],
                    True,
                    False,
                ),
                shape_text(
                    5,
                    emu(0.78),
                    emu(5.75),
                    emu(11.5),
                    emu(0.42),
                    ["Source path: raw/sources/风机故障码/HW2S2000(103)型风力发电机/...303804.md"],
                    1200,
                    NATURE["muted"],
                ),
            ]
        )
    )

    deck.append(
        slide_xml(
            headline(
                "The result is a controlled local assistant, not merely an offline chatbot.",
                "The key distinction is that model, corpus and cost accounting now align with the deployment environment.",
            )
            + [
                evidence_card(4, 0.78, 2.05, "Control", "Local model", "No remote Claude call required", NATURE["teal"]),
                evidence_card(5, 4.55, 2.05, "Grounding", "LLMWiki", "Project files become queryable", NATURE["blue"]),
                evidence_card(6, 8.32, 2.05, "Accounting", "$0", "Local runs no longer mimic cloud pricing", NATURE["green"]),
                shape_text(
                    7,
                    emu(1.0),
                    emu(4.55),
                    emu(11.1),
                    emu(0.95),
                    ["The preserved Claude Code shell remains useful because the integration changes the substrate, not the operator workflow."],
                    1500,
                    NATURE["ink"],
                    "F3F4F6",
                    NATURE["rule"],
                    True,
                    False,
                    True,
                ),
            ]
        )
    )

    deck.append(
        slide_xml(
            headline(
                "Limitations should be explicit.",
                "Local substitution changes the risk profile; it does not magically reproduce Claude’s full behaviour.",
            )
            + [
                shape_text(
                    4,
                    emu(0.75),
                    emu(1.9),
                    emu(11.75),
                    emu(4.2),
                    [
                        "The UI still carries Claude branding; requests are local only when the LM Studio provider script/env is used",
                        "Tool-call reliability is bounded by qwen3.5:9b’s function-calling behaviour",
                        "Large context and retrieval quality depend on LLMWiki indexing, ranking and file hygiene",
                        "Images/documents are currently represented as text omissions in the LM Studio adapter",
                        "Interactive slash commands work through the CLI; headless /llmwiki is handled by the run script",
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
                "The next step is retrieval-augmented local reasoning.",
                "The current system retrieves; the product-level version should retrieve, synthesize and cite.",
            )
            + [
                shape_text(
                    4,
                    emu(0.75),
                    emu(1.9),
                    emu(3.65),
                    emu(4.0),
                    [
                        "Short term",
                        "Add /lmstudio doctor",
                        "Expose model and corpus health",
                        "Make failure messages actionable",
                    ],
                    1450,
                    NATURE["ink"],
                    NATURE["panel"],
                    NATURE["teal"],
                    True,
                    True,
                ),
                shape_text(
                    5,
                    emu(4.65),
                    emu(1.9),
                    emu(3.65),
                    emu(4.0),
                    [
                        "Medium term",
                        "Add /llmwiki ask",
                        "Retrieve top passages",
                        "Ask qwen3.5 to synthesize with citations",
                    ],
                    1450,
                    NATURE["ink"],
                    NATURE["panel"],
                    NATURE["blue"],
                    True,
                    True,
                ),
                shape_text(
                    6,
                    emu(8.55),
                    emu(1.9),
                    emu(3.65),
                    emu(4.0),
                    [
                        "Long term",
                        "Introduce BM25/vector ranking",
                        "Track answer quality",
                        "Separate local product identity from Claude UI text",
                    ],
                    1450,
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
            [
                kicker("Closing assessment"),
                shape_text(
                    2,
                    emu(0.75),
                    emu(1.05),
                    emu(11.65),
                    emu(1.1),
                    ["The important shift is from a cloud assistant to a local knowledge instrument."],
                    3000,
                    NATURE["ink"],
                    None,
                    None,
                    False,
                    False,
                    True,
                ),
                shape_text(
                    3,
                    emu(0.78),
                    emu(2.45),
                    emu(11.2),
                    emu(2.35),
                    [
                        "The implementation keeps the familiar coding interface, routes inference to qwen3.5:9b, and makes the LLMWiki corpus directly searchable.",
                        "For engineering teams with private operational documents, that is a practical local-first pattern: controllable, inspectable and cheap to run.",
                    ],
                    1750,
                    NATURE["ink"],
                    NATURE["panel"],
                    NATURE["rule"],
                    True,
                ),
                shape_text(
                    4,
                    emu(0.78),
                    emu(5.45),
                    emu(11.4),
                    emu(0.5),
                    ["Recommended demo: model prompt → /llmwiki search 303804 → /llmwiki read source file"],
                    1350,
                    NATURE["teal"],
                    "E6F4F1",
                    NATURE["teal"],
                    True,
                    False,
                    True,
                ),
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
