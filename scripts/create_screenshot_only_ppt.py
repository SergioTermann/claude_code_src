#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from PIL import Image

from create_llmwiki_lmstudio_ppt import (
    app_xml,
    base_rels,
    content_types,
    core_xml,
    emu,
    presentation_rels,
    presentation_xml,
    shape_text,
    slide_layout_xml,
    slide_master_xml,
    theme_xml,
)
from create_llmwiki_lmstudio_visual_ppt_zh import pic_contain, slide_rels_for, slide_xml


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "LLMWiki_LM Studio_Screenshots.pptx"

INK = "111827"
MUTED = "6B7280"
BG = "FAFAF7"
PANEL = "FFFFFF"
RULE = "D6D3C8"


def screenshots() -> list[Path]:
    return sorted(ROOT.glob("截屏*.png"))


def content_types_with_png(slide_count: int) -> str:
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


def picture_slide(path: Path, index: int, total: int, rel_id: str) -> str:
    with Image.open(path) as im:
        w, h = im.size
    return slide_xml(
        [
            shape_text(
                2,
                emu(0.55),
                emu(0.2),
                emu(8.8),
                emu(0.34),
                [path.stem],
                1050,
                MUTED,
            ),
            shape_text(
                3,
                emu(11.4),
                emu(0.2),
                emu(1.2),
                emu(0.34),
                [f"{index}/{total}"],
                1050,
                MUTED,
            ),
            shape_text(
                4,
                emu(0.45),
                emu(0.62),
                emu(12.45),
                emu(6.55),
                [""],
                800,
                INK,
                PANEL,
                RULE,
                True,
            ),
            pic_contain(5, rel_id, 0.62, 0.78, 12.11, 6.18, w, h),
        ]
    )


def write_pptx() -> None:
    shots = screenshots()
    if not shots:
        raise SystemExit("No 截屏*.png files found")

    with ZipFile(OUT, "w", ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types_with_png(len(shots)))
        z.writestr("_rels/.rels", base_rels())
        z.writestr("docProps/app.xml", app_xml(len(shots)))
        z.writestr("docProps/core.xml", core_xml())
        z.writestr("ppt/presentation.xml", presentation_xml(len(shots)))
        z.writestr("ppt/_rels/presentation.xml.rels", presentation_rels(len(shots)))
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

        for idx, path in enumerate(shots, start=1):
            rel_id = "rId2"
            z.writestr(f"ppt/slides/slide{idx}.xml", picture_slide(path, idx, len(shots), rel_id))
            z.writestr(
                f"ppt/slides/_rels/slide{idx}.xml.rels",
                slide_rels_for([(rel_id, f"image{idx}.png")]),
            )
            z.write(path, f"ppt/media/image{idx}.png")


if __name__ == "__main__":
    write_pptx()
    print(OUT)
