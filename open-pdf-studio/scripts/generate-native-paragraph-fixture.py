from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Table, TableStyle
from reportlab.pdfgen import canvas


OUTPUT = Path(__file__).resolve().parents[1] / "tests/fixtures/text/native-paragraph-table.pdf"
SIDE_BY_SIDE_OUTPUT = Path(__file__).resolve().parents[1] / "tests/fixtures/text/native-side-by-side-color.pdf"
HELVETICA_WIDTH_OUTPUT = Path(__file__).resolve().parents[1] / "tests/fixtures/text/native-helvetica-width-compensation.pdf"


def deterministic_canvas(*args, **kwargs) -> canvas.Canvas:
    kwargs.pop("invariant", None)
    return canvas.Canvas(*args, invariant=1, **kwargs)


def draw_runs(pdf: canvas.Canvas, x: float, y: float, runs: list[tuple[str, str, float]]) -> None:
    cursor = x
    for text, color, size in runs:
        pdf.setFont("LiberationSans", size)
        pdf.setFillColor(colors.HexColor(color))
        pdf.drawString(cursor, y, text)
        cursor += pdfmetrics.stringWidth(text, "LiberationSans", size)


def build_side_by_side_fixture() -> None:
    pdf = canvas.Canvas(str(SIDE_BY_SIDE_OUTPUT), pagesize=letter, invariant=1)
    pdf.setTitle("Open PDF Studio side-by-side native color fixture")
    left_x = 52.6
    right_x = 311.08
    heading_y = 700
    leading = 11.2

    pdf.setStrokeColor(colors.HexColor("#c8d2dc"))
    pdf.rect(46, 612, 248, 105, stroke=1, fill=0)
    pdf.rect(304, 578, 248, 139, stroke=1, fill=0)
    draw_runs(pdf, left_x, heading_y, [("WHY IT IS GROWING", "#0057a8", 7.2)])
    draw_runs(pdf, right_x, heading_y, [("CAN THE GROWTH CONTINUE?", "#0057a8", 7.2)])

    left_lines = [
        [("Mounjaro and Zepbound continue expanding as obesity", "#111111", 8.7)],
        [("and diabetes adoption ", "#111111", 8.7), ("(gray explanation)", "#666666", 6.8)],
        [("grows globally while manufacturing capacity expands", "#111111", 8.7)],
        [("and next-generation medicines add another runway", "#111111", 8.7)],
        [("including ", "#111111", 8.7), ("blue emphasis", "#0057a8", 8.7), (" and ", "#111111", 8.7),
         ("pale detail", "#f4f4f4", 6.8)],
        [("after the current franchise matures.", "#111111", 8.7)],
    ]
    right_lines = [
        [("The growth runway remains unusually long because the", "#111111", 8.7)],
        [("market is large and still underpenetrated ", "#111111", 8.7), ("(only a", "#666666", 6.8)],
        [("small share of customers currently use the", "#666666", 6.8)],
        [("product),", "#666666", 6.8), (" but growth should normalize as revenue", "#111111", 8.7)],
        [("base becomes enormous. Sustained growth depends on", "#111111", 8.7)],
        [("manufacturing capacity, broader reimbursement ", "#111111", 8.7), ("(whether", "#666666", 6.8)],
        [("insurers or government programs will pay for treatment)", "#666666", 6.8), (",", "#111111", 8.7)],
        [("successful launches retain strong efficacy and safety", "#111111", 8.7)],
        [("versus competitors.", "#111111", 8.7)],
    ]
    for index, runs in enumerate(left_lines):
        draw_runs(pdf, left_x, heading_y - 12 - index * leading, runs)
    for index, runs in enumerate(right_lines):
        draw_runs(pdf, right_x, heading_y - 12 - index * leading, runs)

    pdf.showPage()
    pdf.save()


def build_helvetica_width_fixture() -> None:
    """Reproduce the harmless page-3 packaged-substitute width delta."""
    pdf = canvas.Canvas(str(HELVETICA_WIDTH_OUTPUT), pagesize=letter, invariant=1)
    pdf.setTitle("Open PDF Studio Helvetica substitution width fixture")
    source_width = 215.199998
    substitute_width = 215.593555
    x = 180.0
    baseline = 706.0
    font_size = 6.792646389957232
    leading = 9.0
    lines = [
        "EUV (extreme ultraviolet lithography; advanced chip-printing technology",
        "used for leading-edge semiconductors)/High-NA (high numerical",
        "aperture; a next-generation EUV system capable of printing even",
        "smaller circuit patterns onto wafers)",
    ]
    source_advance = pdfmetrics.stringWidth(lines[0], "Helvetica", font_size)
    horizontal_scale = source_width / source_advance * 100

    text = pdf.beginText(x, baseline)
    text.setFont("Helvetica", font_size)
    text.setLeading(leading)
    text.setHorizScale(horizontal_scale)
    for line in lines:
        text.textLine(line)
    pdf.drawText(text)

    # A neighboring column starts 12.84 pt beyond the immutable source edge,
    # matching the clearance that permits only the 0.393557 pt far-edge grow.
    neighbor_x = x + source_width + 12.84
    pdf.setFont("Helvetica", font_size)
    for index in range(len(lines)):
        pdf.drawString(neighbor_x, baseline - index * leading, f"Adjacent column {index + 1}")
    pdf.setStrokeColor(colors.HexColor("#c8d2dc"))
    pdf.line(x + source_width + 12.84 / 2, baseline - leading * 4, x + source_width + 12.84 / 2, baseline + leading)
    pdf.setAuthor(f"source={source_width:.6f}; substitute={substitute_width:.6f}")
    pdf.showPage()
    pdf.save()


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
    document.build([table], canvasmaker=deterministic_canvas)
    build_side_by_side_fixture()
    build_helvetica_width_fixture()


if __name__ == "__main__":
    main()
