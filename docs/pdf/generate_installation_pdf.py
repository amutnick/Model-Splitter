#!/usr/bin/env python3
"""Generate the illustrated Model Splitter installation guide PDF.

Run from the repository root after installing docs/pdf/requirements.txt:

    python docs/pdf/generate_installation_pdf.py
"""

from __future__ import annotations

import argparse
import html
from pathlib import Path

from reportlab.graphics.shapes import Circle, Drawing, String
from reportlab.lib import colors
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.fonts import addMapping
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch, mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    HRFlowable,
    Image,
    KeepTogether,
    ListFlowable,
    ListItem,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Preformatted,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.tableofcontents import TableOfContents
from svglib.svglib import svg2rlg

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT = ROOT / "Model-Splitter-Installation-Guide.pdf"

INK = HexColor("#172033")
MUTED = HexColor("#5D6B82")
NAVY = HexColor("#0F172A")
NAVY_DARK = HexColor("#08111F")
NAVY_LIGHT = HexColor("#172554")
LINE = HexColor("#DBE4EF")
SOFT = HexColor("#F4F7FB")
BLUE = HexColor("#0284C7")
CYAN = HexColor("#0EA5E9")
ORANGE = HexColor("#EA580C")
GREEN = HexColor("#15803D")
PURPLE = HexColor("#7E22CE")
WHITE = colors.white

PAGE_W, PAGE_H = letter
LEFT = 17 * mm
RIGHT = 17 * mm
TOP = 16 * mm
BOTTOM = 17 * mm
CONTENT_W = PAGE_W - LEFT - RIGHT
CONTENT_H = PAGE_H - TOP - BOTTOM


def register_fonts() -> None:
    font_root = Path("/usr/share/fonts/truetype/dejavu")
    fonts = {
        "GuideSans": "DejaVuSans.ttf",
        "GuideSans-Bold": "DejaVuSans-Bold.ttf",
        "GuideMono": "DejaVuSansMono.ttf",
        "GuideMono-Bold": "DejaVuSansMono-Bold.ttf",
    }
    for name, filename in fonts.items():
        path = font_root / filename
        if not path.exists():
            raise FileNotFoundError(f"Required font not found: {path}")
        pdfmetrics.registerFont(TTFont(name, str(path)))
    addMapping("GuideSans", 0, 0, "GuideSans")
    addMapping("GuideSans", 1, 0, "GuideSans-Bold")
    addMapping("GuideMono", 0, 0, "GuideMono")
    addMapping("GuideMono", 1, 0, "GuideMono-Bold")


register_fonts()

BASE = getSampleStyleSheet()
STYLES = {
    "body": ParagraphStyle(
        "GuideBody",
        parent=BASE["BodyText"],
        fontName="GuideSans",
        fontSize=9.25,
        leading=13.4,
        textColor=INK,
        spaceAfter=6,
        allowWidows=0,
        allowOrphans=0,
    ),
    "lead": ParagraphStyle(
        "GuideLead",
        parent=BASE["BodyText"],
        fontName="GuideSans",
        fontSize=10.8,
        leading=15.8,
        textColor=HexColor("#43526A"),
        spaceAfter=10,
    ),
    "small": ParagraphStyle(
        "GuideSmall",
        parent=BASE["BodyText"],
        fontName="GuideSans",
        fontSize=7.8,
        leading=10.8,
        textColor=MUTED,
        spaceAfter=4,
    ),
    "eyebrow": ParagraphStyle(
        "GuideEyebrow",
        parent=BASE["BodyText"],
        fontName="GuideSans-Bold",
        fontSize=7.5,
        leading=9,
        textColor=BLUE,
        tracking=1.2,
        spaceAfter=4,
    ),
    "section": ParagraphStyle(
        "GuideSection",
        parent=BASE["Heading1"],
        fontName="GuideSans-Bold",
        fontSize=21.5,
        leading=25,
        textColor=NAVY,
        spaceAfter=9,
        keepWithNext=True,
    ),
    "h3": ParagraphStyle(
        "GuideH3",
        parent=BASE["Heading2"],
        fontName="GuideSans-Bold",
        fontSize=12.2,
        leading=14.5,
        textColor=NAVY,
        spaceBefore=4,
        spaceAfter=5,
        keepWithNext=True,
    ),
    "h4": ParagraphStyle(
        "GuideH4",
        parent=BASE["Heading3"],
        fontName="GuideSans-Bold",
        fontSize=9.8,
        leading=12,
        textColor=NAVY,
        spaceBefore=2,
        spaceAfter=3,
        keepWithNext=True,
    ),
    "card_title": ParagraphStyle(
        "GuideCardTitle",
        parent=BASE["Heading3"],
        fontName="GuideSans-Bold",
        fontSize=11.2,
        leading=13.5,
        textColor=NAVY,
        spaceAfter=5,
        keepWithNext=True,
    ),
    "card_body": ParagraphStyle(
        "GuideCardBody",
        parent=BASE["BodyText"],
        fontName="GuideSans",
        fontSize=8.25,
        leading=11.6,
        textColor=INK,
        spaceAfter=5,
    ),
    "code": ParagraphStyle(
        "GuideCode",
        parent=BASE["Code"],
        fontName="GuideMono",
        fontSize=7.5,
        leading=11,
        textColor=HexColor("#E0F2FE"),
        leftIndent=0,
        rightIndent=0,
        spaceBefore=0,
        spaceAfter=0,
    ),
    "toc": ParagraphStyle(
        "GuideTOC",
        parent=BASE["BodyText"],
        fontName="GuideSans-Bold",
        fontSize=9.2,
        leading=15,
        textColor=INK,
        leftIndent=0,
        firstLineIndent=0,
        spaceBefore=1,
    ),
    "toc_sub": ParagraphStyle(
        "GuideTOCSub",
        parent=BASE["BodyText"],
        fontName="GuideSans",
        fontSize=8.4,
        leading=13,
        textColor=MUTED,
        leftIndent=12,
        firstLineIndent=0,
    ),
    "center_small": ParagraphStyle(
        "GuideCenterSmall",
        parent=BASE["BodyText"],
        fontName="GuideSans",
        fontSize=7.8,
        leading=11,
        textColor=MUTED,
        alignment=TA_CENTER,
    ),
}


def esc(value: str) -> str:
    return html.escape(value, quote=False).replace("\n", "<br/>")


def p(text: str, style: str = "body") -> Paragraph:
    return Paragraph(text, STYLES[style])


def h3(text: str) -> Paragraph:
    return p(text, "h3")


def external(url: str, label: str | None = None) -> str:
    label = label or url
    return f'<link href="{url}" color="#0369A1">{html.escape(label)}</link>'


def inline_code(text: str) -> str:
    return f'<font name="GuideMono" color="#075985">{html.escape(text)}</font>'


def section_heading(label: str, title: str, anchor: str, lead: str) -> list:
    heading = Paragraph(f'<a name="{anchor}"/>{title}', STYLES["section"])
    heading._toc_level = 0
    heading._bookmark = anchor
    heading._bookmark_text = title
    return [p(label.upper(), "eyebrow"), heading, p(lead, "lead")]


def code_block(text: str, small: bool = False) -> Table:
    style = ParagraphStyle(
        f"Code{'Small' if small else 'Normal'}",
        parent=STYLES["code"],
        fontSize=6.35 if small else STYLES["code"].fontSize,
        leading=9.2 if small else STYLES["code"].leading,
    )
    pre = Preformatted(text, style, maxLineLength=120)
    table = Table([[pre]], colWidths=[None], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), HexColor("#0B1220")),
                ("LINEBEFORE", (0, 0), (0, -1), 3, CYAN),
                ("LEFTPADDING", (0, 0), (-1, -1), 9),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
        )
    )
    return table


def bullet_list(items: list[str], style: str = "body", bullet_color: HexColor = BLUE) -> ListFlowable:
    return ListFlowable(
        [ListItem(p(item, style), leftIndent=9) for item in items],
        bulletType="bullet",
        start="circle",
        bulletFontName="GuideSans",
        bulletFontSize=6,
        bulletColor=bullet_color,
        leftIndent=13,
        bulletOffsetY=1.5,
        spaceAfter=4,
    )


def numbered_list(items: list[str], style: str = "body") -> ListFlowable:
    return ListFlowable(
        [ListItem(p(item, style), leftIndent=10) for item in items],
        bulletType="1",
        start="1",
        bulletFontName="GuideSans-Bold",
        bulletFontSize=8,
        bulletColor=BLUE,
        leftIndent=15,
        bulletOffsetY=1,
        spaceAfter=4,
    )


def badge(text: str, color: HexColor = BLUE) -> Table:
    tint = colors.Color(
        min(1, color.red + 0.82),
        min(1, color.green + 0.82),
        min(1, color.blue + 0.82),
    )
    label = Paragraph(
        f'<font name="GuideSans-Bold" size="6.8" color="{color.hexval()}">{html.escape(text.upper())}</font>',
        STYLES["small"],
    )
    table = Table([[label]], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), tint),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ]
        )
    )
    return table


def card(content: list, accent: HexColor = CYAN, background: HexColor = colors.white) -> Table:
    table = Table([[content]], colWidths=[None], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), background),
                ("BOX", (0, 0), (-1, -1), 0.65, LINE),
                ("LINEABOVE", (0, 0), (-1, 0), 3.2, accent),
                ("LEFTPADDING", (0, 0), (-1, -1), 11),
                ("RIGHTPADDING", (0, 0), (-1, -1), 11),
                ("TOPPADDING", (0, 0), (-1, -1), 10),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
        )
    )
    return table


def columns(left: list, right: list, widths: tuple[float, float] | None = None, gap: float = 10) -> Table:
    if widths is None:
        widths = ((CONTENT_W - gap) / 2, (CONTENT_W - gap) / 2)
    table = Table([[left, "", right]], colWidths=[widths[0], gap, widths[1]], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )
    return table


def callout(text: str, kind: str = "info") -> Table:
    palette = {
        "info": (CYAN, HexColor("#EFF6FF"), HexColor("#075985")),
        "tip": (HexColor("#22C55E"), HexColor("#ECFDF5"), HexColor("#166534")),
        "warn": (HexColor("#F97316"), HexColor("#FFF7ED"), HexColor("#9A3412")),
    }
    accent, background, heading = palette[kind]
    content = Paragraph(text.replace("<strong>", f'<font name="GuideSans-Bold" color="{heading.hexval()}">').replace("</strong>", "</font>"), STYLES["card_body"])
    table = Table([["", content]], colWidths=[5, CONTENT_W - 5], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (0, -1), accent),
                ("BACKGROUND", (1, 0), (1, -1), background),
                ("LEFTPADDING", (0, 0), (0, -1), 0),
                ("RIGHTPADDING", (0, 0), (0, -1), 0),
                ("LEFTPADDING", (1, 0), (1, -1), 10),
                ("RIGHTPADDING", (1, 0), (1, -1), 10),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
        )
    )
    return table


def illustration(relative_path: str, max_height: float = 74 * mm) -> Drawing:
    path = ROOT / relative_path
    drawing = svg2rlg(str(path))
    if drawing is None:
        raise ValueError(f"Unable to parse SVG: {path}")
    scale = min(CONTENT_W / drawing.width, max_height / drawing.height)
    drawing.scale(scale, scale)
    drawing.width *= scale
    drawing.height *= scale
    drawing.hAlign = "CENTER"
    return drawing


def step_row(number: int, title: str, text: str, code: str | None = None) -> Table:
    circle = Drawing(24, 24)
    circle.add(Circle(12, 12, 11, fillColor=BLUE, strokeColor=None))
    circle.add(String(12, 8.4, str(number), fontName="GuideSans-Bold", fontSize=8.5, fillColor=WHITE, textAnchor="middle"))
    details = [p(title, "h4"), p(text, "card_body")]
    if code:
        details.append(code_block(code))
    table = Table([[circle, details]], colWidths=[31, CONTENT_W - 31], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    return table


def requirements_table(rows: list[list[str]], widths: list[float] | None = None, font_size: float = 8.1) -> Table:
    data = [[p(f'<font color="#FFFFFF"><b>{cell}</b></font>', "small") for cell in rows[0]]]
    for row in rows[1:]:
        data.append([p(cell, "small") for cell in row])
    table = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), HexColor("#1E293B")),
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
        ("INNERGRID", (0, 1), (-1, -1), 0.35, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]
    for index in range(2, len(data), 2):
        style.append(("BACKGROUND", (0, index), (-1, index), HexColor("#F8FAFC")))
    table.setStyle(TableStyle(style))
    return table


class GuideDocTemplate(BaseDocTemplate):
    def __init__(self, filename: str, **kwargs):
        super().__init__(filename, **kwargs)
        self._outline_keys: set[str] = set()

    def beforeDocument(self):
        # multiBuild performs a dry pass for the table of contents. Reset this
        # pass-local state so bookmarks are also emitted on the final pass.
        self._outline_keys.clear()
        super().beforeDocument()

    def afterFlowable(self, flowable):
        level = getattr(flowable, "_toc_level", None)
        key = getattr(flowable, "_bookmark", None)
        if level is None or key is None:
            return
        text = getattr(flowable, "_bookmark_text", flowable.getPlainText())
        self.canv.bookmarkPage(key)
        if key not in self._outline_keys:
            self.canv.addOutlineEntry(text, key, level=level, closed=False)
            self._outline_keys.add(key)
        self.notify("TOCEntry", (level, text, self.page, key))


def draw_cover(canvas, doc) -> None:
    canvas.saveState()
    canvas.setTitle("Model Splitter — Illustrated Installation Guide")
    canvas.setAuthor("Model Splitter contributors")
    canvas.setSubject("How to get, install, run, and update Model Splitter")
    canvas.setKeywords("Model Splitter, STL, OBJ, installation, Tauri, macOS")

    canvas.setFillColor(NAVY_DARK)
    canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    canvas.setFillColor(NAVY_LIGHT)
    canvas.circle(PAGE_W + 10, PAGE_H + 5, 220, fill=1, stroke=0)
    canvas.setFillColor(HexColor("#102D54"))
    canvas.circle(PAGE_W + 15, PAGE_H + 10, 155, fill=1, stroke=0)

    canvas.setStrokeColor(HexColor("#FB6A2A"))
    canvas.setLineWidth(7)
    canvas.line(300, 235, 650, 485)
    canvas.setStrokeColor(HexColor("#FB923C"))
    canvas.setLineWidth(1.3)
    canvas.line(285, 224, 661, 493)

    icon_path = ROOT / "src-tauri/icons/app-icon.png"
    canvas.drawImage(str(icon_path), 58, 585, width=128, height=128, mask="auto", preserveAspectRatio=True)

    canvas.setFillColor(HexColor("#0C3755"))
    canvas.roundRect(58, 535, 142, 24, 12, fill=1, stroke=0)
    canvas.setFillColor(HexColor("#BAE6FD"))
    canvas.setFont("GuideSans-Bold", 8.2)
    canvas.drawString(71, 543, "GET  •  INSTALL  •  RUN")

    canvas.setFillColor(WHITE)
    canvas.setFont("GuideSans-Bold", 38)
    canvas.drawString(58, 465, "Model Splitter")
    canvas.setFillColor(HexColor("#CBD5E1"))
    canvas.setFont("GuideSans", 15)
    subtitle = canvas.beginText(60, 430)
    subtitle.setLeading(22)
    subtitle.textLine("A clear, illustrated guide to downloading,")
    subtitle.textLine("installing, launching, and updating the application.")
    canvas.drawText(subtitle)

    canvas.setStrokeColor(HexColor("#43516A"))
    canvas.setLineWidth(0.6)
    canvas.line(58, 96, PAGE_W - 58, 96)
    canvas.setFillColor(HexColor("#E2E8F0"))
    canvas.setFont("GuideSans-Bold", 9.5)
    canvas.drawString(58, 73, "Browser + native desktop workflows")
    canvas.setFillColor(HexColor("#94A3B8"))
    canvas.setFont("GuideSans", 8.6)
    canvas.drawString(58, 57, "Browser: macOS · Windows · Linux")
    canvas.drawString(58, 43, "Desktop: macOS 11.3 or newer")

    canvas.setFillColor(HexColor("#E2E8F0"))
    canvas.setFont("GuideSans-Bold", 9.5)
    canvas.drawRightString(PAGE_W - 58, 73, "INSTALLATION GUIDE")
    canvas.setFillColor(HexColor("#94A3B8"))
    canvas.setFont("GuideSans", 8.6)
    canvas.drawRightString(PAGE_W - 58, 57, "Edition 1.0 · July 2026")
    canvas.drawRightString(PAGE_W - 58, 43, "Application version 0.1.0")
    canvas.restoreState()


def draw_body(canvas, doc) -> None:
    canvas.saveState()
    canvas.setStrokeColor(HexColor("#D7E1EC"))
    canvas.setLineWidth(0.5)
    canvas.line(LEFT, PAGE_H - 31, PAGE_W - RIGHT, PAGE_H - 31)
    canvas.setFillColor(CYAN)
    canvas.circle(LEFT + 3, PAGE_H - 23, 2.5, fill=1, stroke=0)
    canvas.setFillColor(HexColor("#64748B"))
    canvas.setFont("GuideSans-Bold", 7.2)
    canvas.drawString(LEFT + 11, PAGE_H - 26, "MODEL SPLITTER")
    canvas.setFont("GuideSans", 7.2)
    canvas.drawRightString(PAGE_W - RIGHT, PAGE_H - 26, "ILLUSTRATED INSTALLATION GUIDE")

    canvas.setStrokeColor(HexColor("#E2E8F0"))
    canvas.line(LEFT, 31, PAGE_W - RIGHT, 31)
    canvas.setFillColor(HexColor("#7C8BA1"))
    canvas.setFont("GuideSans", 7)
    canvas.drawString(LEFT, 18, "Installation guide  •  v0.1.0")
    canvas.setFont("GuideMono", 7)
    canvas.drawRightString(PAGE_W - RIGHT, 18, f"PAGE {doc.page}")
    canvas.restoreState()


def build_story() -> list:
    story: list = []

    # Cover page. Content is drawn by the page template.
    story.extend([Spacer(1, PAGE_H - 2), NextPageTemplate("body"), PageBreak()])

    # Start / contents.
    story += section_heading(
        "Start here",
        "Choose your route",
        "start",
        "Model Splitter runs from the same source code in two ways. Browser mode is the shortest path; native mode adds a macOS window and native file dialogs.",
    )
    browser_card = card(
        [
            badge("Fastest", BLUE),
            Spacer(1, 5),
            p("Browser mode", "card_title"),
            p("Best for trying the app or using it on macOS, Windows, or Linux.", "card_body"),
            p(f"<b>Needs:</b> Node.js + npm<br/><b>Launch:</b> {inline_code('npm run dev')}", "small"),
        ],
        CYAN,
    )
    native_card = card(
        [
            badge("macOS", ORANGE),
            Spacer(1, 5),
            p("Native desktop mode", "card_title"),
            p("Best for a desktop window, native open/save dialogs, and building a DMG.", "card_body"),
            p(f"<b>Also needs:</b> Xcode tools + Rust<br/><b>Launch:</b> {inline_code('npm run tauri:dev')}", "small"),
        ],
        ORANGE,
    )
    story += [columns([browser_card], [native_card]), Spacer(1, 8)]
    story += [
        callout(
            "<strong>Source distribution.</strong> There is no prebuilt installer in the repository yet. Both routes begin by downloading the source and installing its dependencies.",
            "warn",
        ),
        Spacer(1, 9),
        h3("Contents"),
    ]
    toc = TableOfContents()
    toc.levelStyles = [STYLES["toc"], STYLES["toc_sub"]]
    toc.dotsMinLevel = 0
    story += [toc, Spacer(1, 8), h3("Requirements at a glance")]
    story.append(
        requirements_table(
            [
                ["Run mode", "Operating system", "Required software"],
                ["<b>Browser</b>", "macOS, Windows, or Linux", "Node.js and npm"],
                ["<b>Native desktop</b>", "macOS 11.3+", "Node.js, npm, Xcode tools, and Rust"],
            ],
            [100, 155, CONTENT_W - 255],
        )
    )
    story.append(PageBreak())

    # Get the source.
    story += section_heading(
        "Step 1",
        "Get the source code",
        "get",
        f"Open {external('https://github.com/amutnick/Model-Splitter', 'github.com/amutnick/Model-Splitter')}, select the green <b>Code</b> button, and choose one download method.",
    )
    story += [illustration("docs/images/get-source.svg", 71 * mm), Spacer(1, 7)]
    clone = card(
        [
            badge("Recommended", BLUE),
            Spacer(1, 4),
            p("A. Clone with Git", "card_title"),
            p(f"Install {external('https://git-scm.com/downloads', 'Git')}, then open Terminal or PowerShell.", "card_body"),
            code_block("git clone https://github.com/amutnick/Model-Splitter.git\ncd Model-Splitter", small=True),
            Spacer(1, 4),
            p("This is the easiest route for future updates.", "small"),
        ],
        CYAN,
    )
    download = card(
        [
            badge("No Git needed", ORANGE),
            Spacer(1, 4),
            p("B. Download ZIP", "card_title"),
            numbered_list(
                [
                    "Select <b>Code → Download ZIP</b>.",
                    "Extract the downloaded file.",
                    "Open a terminal in the extracted folder.",
                ],
                "card_body",
            ),
            code_block("# macOS / Linux\ncd ~/Downloads/Model-Splitter-main\n\n# Windows PowerShell\ncd \"$HOME\\Downloads\\Model-Splitter-main\"", small=True),
        ],
        ORANGE,
    )
    story += [columns([clone], [download]), Spacer(1, 8)]
    story.append(
        callout(
            f"<strong>Easy folder shortcut.</strong> Type {inline_code('cd ')} with a trailing space, drag the project folder into the terminal window, and press Return/Enter.",
            "tip",
        )
    )
    story.append(PageBreak())

    # Install.
    story += section_heading(
        "Steps 2–3",
        "Install the prerequisites",
        "install",
        "Install Node.js once, then restore Model Splitter’s exact dependency versions inside the project folder.",
    )
    story += [illustration("docs/images/install-flow.svg", 57 * mm), Spacer(1, 7)]
    node_card = card(
        [
            p("2 · Install Node.js", "card_title"),
            numbered_list(
                [
                    f"Visit {external('https://nodejs.org/', 'nodejs.org')}.",
                    "Download a current <b>LTS</b> installer.",
                    "Run it with the default options.",
                    "Close and reopen the terminal.",
                ],
                "card_body",
            ),
            p("Supported: Node 20.19+ within 20.x, or Node 22.12+.", "small"),
            code_block("node --version\nnpm --version"),
        ],
        GREEN,
    )
    deps_card = card(
        [
            p("3 · Install dependencies", "card_title"),
            p("Confirm the terminal is in <b>Model-Splitter</b> or <b>Model-Splitter-main</b>, then run:", "card_body"),
            code_block("npm ci"),
            Spacer(1, 6),
            p(f"npm reads {inline_code('package-lock.json')} and creates a local {inline_code('node_modules')} folder.", "card_body"),
            p("A successful install returns to the prompt without a red error.", "small"),
        ],
        CYAN,
    )
    story += [columns([node_card], [deps_card]), Spacer(1, 8)]
    story.append(
        callout(
            "<strong>Command not found?</strong> Restart the computer or reinstall Node.js with its “Add to PATH” option enabled, then check the version commands again.",
            "warn",
        )
    )
    story.append(PageBreak())

    # Browser.
    story += section_heading(
        "Step 4 · Choice A",
        "Run in a browser",
        "browser",
        "This is the fastest route and works on macOS, Windows, and Linux.",
    )
    story += [illustration("docs/images/run-modes.svg", 68 * mm), Spacer(1, 7)]
    story += [
        step_row(1, "Start the development server", "Run this in the project folder:", "npm run dev"),
        step_row(2, "Wait for the local address", "Vite prints an address when it is ready:", "VITE ready\nLocal: http://localhost:5173/"),
        step_row(3, "Open the app", f"Visit {external('http://localhost:5173', 'http://localhost:5173')} in Chrome, Edge, Firefox, or Safari."),
        step_row(4, "Keep Terminal open", "The terminal process is serving the application."),
        step_row(5, "Stop when finished", "Return to Terminal and press <b>Control+C</b>."),
        Spacer(1, 5),
    ]
    prod = card([p("Production check", "card_title"), p("Validate TypeScript and create an optimized build.", "card_body"), code_block("npm run build")], CYAN, SOFT)
    preview = card([p("Preview the build", "card_title"), p("Serve the generated production files locally.", "card_body"), code_block("npm run preview")], PURPLE, SOFT)
    story.append(columns([prod], [preview]))
    story.append(PageBreak())

    # Native.
    story += section_heading(
        "Step 4 · Choice B",
        "Run the native macOS app",
        "native",
        "Native mode requires macOS 11.3 or newer. Complete these one-time platform setup steps before launching it.",
    )
    xcode = card(
        [p("1 · Install Xcode command-line tools", "card_title"), code_block("xcode-select --install"), Spacer(1, 5), p("Follow the macOS installer prompts. If the tools are already installed, continue.", "card_body")],
        CYAN,
    )
    rust = card(
        [
            p("2 · Install Rust", "card_title"),
            code_block("curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh", small=True),
            Spacer(1, 5),
            p("Choose the default installation, reopen Terminal, and verify:", "card_body"),
            code_block("source \"$HOME/.cargo/env\"\nrustc --version\ncargo --version"),
        ],
        ORANGE,
    )
    launch = card(
        [
            p("3 · Launch Model Splitter", "card_title"),
            code_block("npm run tauri:dev"),
            Spacer(1, 5),
            p("The first launch downloads and compiles Rust dependencies, so it can take several minutes. Later launches are much faster.", "card_body"),
        ],
        GREEN,
    )
    story += [xcode, Spacer(1, 9), rust, Spacer(1, 9), launch, Spacer(1, 9)]
    story.append(
        callout(
            "<strong>Expected result.</strong> A native window titled <i>Model Splitter</i> opens. Press Control+C in Terminal to stop the development process.",
            "tip",
        )
    )
    story.append(PageBreak())

    # Use.
    story += section_heading(
        "Step 5",
        "Use Model Splitter",
        "use",
        "The browser and native versions share the same modeling workflow. All geometry processing stays on your computer.",
    )
    story += [illustration("docs/images/use-workflow.svg", 57 * mm), Spacer(1, 7)]
    left_steps = numbered_list(
        [
            "Select <b>Browse Files</b> or drop a model into the window.",
            "Inspect the model in the 3D viewport.",
            "Choose a segmentation strategy and adjust its options.",
            "Select <b>Slice Model</b>.",
        ]
    )
    right_steps = numbered_list(
        [
            "Review the generated parts and cut planes.",
            "Adjust cuts if needed.",
            "Select <b>Download .ZIP</b> to export segmented STL files.",
        ]
    )
    story += [columns([left_steps], [right_steps]), Spacer(1, 8), h3("Supported input")]
    file_cards = [
        card([badge("STL", BLUE), Spacer(1, 5), p("Binary or ASCII", "card_body")], CYAN),
        card([badge("OBJ", PURPLE), Spacer(1, 5), p("Wavefront mesh", "card_body")], PURPLE),
        card([badge("MTL", ORANGE), Spacer(1, 5), p("Optional with OBJ", "card_body")], ORANGE),
    ]
    third = (CONTENT_W - 16) / 3
    file_table = Table([[file_cards[0], "", file_cards[1], "", file_cards[2]]], colWidths=[third, 8, third, 8, third])
    file_table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0)]))
    story += [file_table, Spacer(1, 9)]
    story.append(
        callout(
            "<strong>Saving differs by mode.</strong> Browser mode downloads through the browser. Native mode opens the macOS Save dialog.",
            "info",
        )
    )
    story.append(PageBreak())

    # Package.
    story += section_heading(
        "Step 6 · Optional",
        "Build and install the macOS app",
        "package",
        "Create a reusable application and disk image so Model Splitter can launch without a development command.",
    )
    story += [
        step_row(1, "Build on a Mac", "Create the release bundle:", "npm run tauri:build"),
        step_row(2, "Open the generated bundle folder", "Reveal the results in Finder:", "open src-tauri/target/release/bundle"),
        step_row(3, "Open the DMG", f"Enter the {inline_code('dmg')} folder and double-click the generated disk image."),
        step_row(4, "Install", "Drag <i>Model Splitter</i> into the <i>Applications</i> folder."),
        step_row(5, "Launch", "Open Model Splitter from Applications."),
        Spacer(1, 6),
    ]
    path_card = card(
        [p("Where the files go", "card_title"), code_block("src-tauri/\n└── target/\n    └── release/\n        └── bundle/\n            ├── macos/   ← Model Splitter.app\n            └── dmg/     ← installable disk image")],
        CYAN,
        SOFT,
    )
    story += [path_card, Spacer(1, 9)]
    story += [
        callout(
            "<strong>About macOS security.</strong> Local builds are not automatically signed or notarized. If macOS blocks your own build, Control-click the app in Finder, choose <b>Open</b>, and confirm. Never bypass a warning for an app from an untrusted source.",
            "warn",
        ),
        Spacer(1, 6),
        callout(
            f"<strong>Platform note.</strong> A macOS {inline_code('.app')} or {inline_code('.dmg')} must be built on macOS. Windows and Linux users should use browser mode.",
            "info",
        ),
    ]
    story.append(PageBreak())

    # Update and troubleshoot.
    story += section_heading(
        "Keep it current",
        "Update and troubleshoot",
        "update",
        "Update the project using the same method you used to download it, then use the quick fixes below for common setup problems.",
    )
    git_update = card([p("Git clone", "card_title"), p("Update the existing folder:", "card_body"), code_block("git pull\nnpm ci")], CYAN)
    zip_update = card([p("Downloaded ZIP", "card_title"), p("Download and extract a fresh ZIP, open its folder, then run:", "card_body"), code_block("npm ci")], ORANGE)
    story += [columns([git_update], [zip_update]), Spacer(1, 11), h3("Common problems")]
    story.append(
        requirements_table(
            [
                ["Problem", "What to do"],
                [f"{inline_code('node')} or {inline_code('npm')} not found", f"Reinstall Node.js LTS, reopen Terminal, and check {inline_code('node --version')}."] ,
                [f"{inline_code('npm ci')} network error", "Check the internet connection, VPN, proxy, or firewall, then retry."],
                ["Port 5173 is in use", "Stop the old Vite process with Control+C, close old terminal sessions, and retry."],
                ["Browser does not open", f"Open {external('http://localhost:5173', 'http://localhost:5173')} manually."],
                [f"{inline_code('cargo')} not found", "Reopen Terminal or run " + inline_code('source "$HOME/.cargo/env"') + "."],
                ["Xcode or linker error", f"Run {inline_code('xcode-select --install')}, finish the installer, and retry."],
                ["Native build on Windows/Linux", "Use browser mode. Build the app and DMG on macOS."],
                ["3D view is blank or slow", "Update the browser and graphics drivers, enable hardware acceleration, or try a smaller model."],
                ["macOS blocks the app", "Control-click and choose Open only if you built the app yourself."],
            ],
            [145, CONTENT_W - 145],
        )
    )
    story += [Spacer(1, 8), callout("<strong>Still stuck?</strong> Copy the complete terminal error—not only its final line—when asking for help. It usually identifies the missing tool or failed step.", "tip")]
    story.append(PageBreak())

    # Reference.
    story += section_heading(
        "Reference",
        "Commands at a glance",
        "reference",
        "Run these commands from the project folder.",
    )
    commands = [
        ("npm ci", "Install the exact JavaScript dependencies."),
        ("npm run dev", "Start browser development mode at localhost:5173."),
        ("npm run build", "Type-check and create the optimized web build."),
        ("npm run preview", "Preview the generated web build."),
        ("npm run tauri:dev", "Compile and launch the native macOS development app."),
        ("npm run tauri:build", "Create the native app and DMG release bundle."),
    ]
    command_rows = []
    for command, description in commands:
        command_rows.append([code_block(command), p(description, "card_body")])
    command_table = Table(command_rows, colWidths=[185, CONTENT_W - 185], hAlign="LEFT")
    command_table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LINEBELOW", (0, 0), (-1, -2), 0.35, LINE),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (0, -1), 12),
                ("RIGHTPADDING", (1, 0), (1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    story += [command_table, Spacer(1, 12)]
    mac_clean = card([p("Clean reinstall · macOS/Linux", "card_title"), code_block("rm -rf node_modules\nnpm ci")], CYAN, SOFT)
    win_clean = card([p("Clean reinstall · PowerShell", "card_title"), code_block("Remove-Item -Recurse -Force node_modules\nnpm ci", small=True)], PURPLE, SOFT)
    story += [columns([mac_clean], [win_clean]), Spacer(1, 11)]
    checklist = card(
        [
            p("Ready-to-run checklist", "card_title"),
            bullet_list(
                [
                    "The project folder is downloaded or cloned.",
                    f"{inline_code('node --version')} and {inline_code('npm --version')} work.",
                    f"{inline_code('npm ci')} completes without an error.",
                    "Browser mode opens localhost:5173—or native prerequisites are installed.",
                    "An STL or OBJ model is ready to load.",
                ],
                "card_body",
                GREEN,
            ),
        ],
        GREEN,
    )
    story += [checklist, Spacer(1, 10)]
    story.append(
        callout(
            f"<strong>More information.</strong> Repository: {external('https://github.com/amutnick/Model-Splitter', 'github.com/amutnick/Model-Splitter')}<br/>Developer-focused native notes: {inline_code('TAURI_SETUP.md')}",
            "info",
        )
    )
    story += [Spacer(1, 15), p("Model Splitter · local-first STL and OBJ feature slicing for multi-colour 3D printing", "center_small")]
    return story


def generate(output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    cover_frame = Frame(0, 0, PAGE_W, PAGE_H, id="cover-frame", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    body_frame = Frame(LEFT, BOTTOM + 17, CONTENT_W, CONTENT_H - 25, id="body-frame", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc = GuideDocTemplate(
        str(output),
        pagesize=letter,
        leftMargin=LEFT,
        rightMargin=RIGHT,
        topMargin=TOP,
        bottomMargin=BOTTOM,
        title="Model Splitter — Illustrated Installation Guide",
        author="Model Splitter contributors",
        subject="How to get, install, run, and update Model Splitter",
    )
    doc.addPageTemplates(
        [
            PageTemplate(id="cover", frames=[cover_frame], onPage=draw_cover),
            PageTemplate(id="body", frames=[body_frame], onPage=draw_body),
        ]
    )
    doc.multiBuild(build_story())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", nargs="?", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    generate(args.output.resolve())
    print(args.output.resolve())


if __name__ == "__main__":
    main()
