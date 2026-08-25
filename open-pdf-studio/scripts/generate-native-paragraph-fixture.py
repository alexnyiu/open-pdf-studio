from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Table, TableStyle


OUTPUT = Path(__file__).resolve().parents[1] / "tests/fixtures/text/native-paragraph-table.pdf"


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    font_root = Path(__file__).resolve().parents[1] / "public/pdfjs/web/standard_fonts"
    pdfmetrics.registerFont(TTFont("LiberationSans", str(font_root / "LiberationSans-Regular.ttf")))
    pdfmetrics.registerFont(TTFont("LiberationSans-Italic", str(font_root / "LiberationSans-Italic.ttf")))
    pdfmetrics.registerFontFamily(
        "LiberationSans",
        normal="LiberationSans",
        bold="LiberationSans",
        italic="LiberationSans-Italic",
        boldItalic="LiberationSans-Italic",
    )
    styles = getSampleStyleSheet()
    body = styles["BodyText"]
    body.fontName = "LiberationSans"
    body.fontSize = 9
    body.leading = 11

    document = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=letter,
        leftMargin=36,
        rightMargin=36,
        topMargin=36,
        bottomMargin=36,
        title="Open PDF Studio native paragraph table fixture",
    )
    rows = [
        [
            Paragraph("High, execution-sensitive", body),
            Paragraph("ARCALYST penetration <i>(the share of the potential market already using the product)</i> + pipeline", body),
            Paragraph("Adjacent cell", body),
        ],
        [
            Paragraph("Very high", body),
            Paragraph("AI interconnect + aerospace/defense", body),
            Paragraph("Next row", body),
        ],
    ]
    table = Table(rows, colWidths=[130, 300, 70], hAlign="LEFT")
    table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#808080")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    document.build([table])


if __name__ == "__main__":
    main()
