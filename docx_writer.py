"""
Minimal Word (.docx) writer using only the Python standard library.

build_docx(doc) -> bytes, where doc is:
{
  "title": "Document title",
  "subtitle": "optional line under the title (e.g. interaction name and date)",
  "sections": [
    {
      "heading": "Section heading",
      "blocks": [
        {"type": "p", "text": "A paragraph"},
        {"type": "text", "text": "Multi-line text; each line becomes a paragraph"},
        {"type": "bullets", "items": ["item", {"text": "item", "note": "smaller note under it"}]},
        {"type": "numbers", "items": [...same as bullets...]},
        {"type": "note", "text": "Small grey italic text"},
        {"type": "qa", "question": "...", "answer": "..."},
        {"type": "table", "columns": ["A", "B"], "rows": [["1", "2"]], "widths": [30, 70]}  (widths optional, relative)
      ]
    }
  ]
}
"""
import io
import zipfile
from xml.sax.saxutils import escape

FONT = "Calibri"
W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' \
       'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'


def _clean(text) -> str:
    """Escape for XML and drop control characters Word rejects."""
    s = "" if text is None else str(text)
    s = "".join(ch for ch in s if ch in "\t\n" or ord(ch) >= 32)
    return escape(s)


def _run(text, bold=False, italic=False, color=None, size=None) -> str:
    props = ""
    if bold:
        props += "<w:b/>"
    if italic:
        props += "<w:i/>"
    if color:
        props += f'<w:color w:val="{color}"/>'
    if size:
        props += f'<w:sz w:val="{size}"/><w:szCs w:val="{size}"/>'
    rpr = f"<w:rPr>{props}</w:rPr>" if props else ""
    # Split on newlines into <w:br/> so a single run never contains a raw \n.
    parts = _clean(text).split("\n")
    body = '<w:br/>'.join(f'<w:t xml:space="preserve">{p}</w:t>' for p in parts)
    return f"<w:r>{rpr}{body}</w:r>"


def _para(runs: str, style=None, num_id=None, keep_next=False, spacing_after=None) -> str:
    ppr = ""
    if style:
        ppr += f'<w:pStyle w:val="{style}"/>'
    if keep_next:
        ppr += "<w:keepNext/>"
    if num_id is not None:
        ppr += f'<w:numPr><w:ilvl w:val="0"/><w:numId w:val="{num_id}"/></w:numPr>'
    if spacing_after is not None:
        ppr += f'<w:spacing w:after="{spacing_after}"/>'
    return f"<w:p><w:pPr>{ppr}</w:pPr>{runs}</w:p>" if ppr else f"<w:p>{runs}</w:p>"


def _item_runs(item) -> str:
    if isinstance(item, dict):
        runs = _run(item.get("text", ""))
        if item.get("note"):
            runs += "<w:r><w:br/></w:r>" + _run(item["note"], italic=True, color="5B6478", size=20)
        return runs
    return _run(item)


TEXT_WIDTH = 9360  # 6.5 inches in twentieths of a point (US Letter, 1-inch margins)


def _cell(text, width, header=False) -> str:
    shade = '<w:shd w:val="clear" w:color="auto" w:fill="E8EEF6"/>' if header else ""
    tcpr = f'<w:tcPr><w:tcW w:w="{width}" w:type="dxa"/>{shade}</w:tcPr>'
    paras = str(text if text is not None else "").split("\n") or [""]
    content = "".join(
        f'<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>{_run(t, bold=header, size=19)}</w:p>' for t in paras)
    return f"<w:tc>{tcpr}{content}</w:tc>"


def _table(columns, rows, widths=None) -> str:
    n = max([len(columns)] + [len(r) for r in rows]) if (columns or rows) else 0
    if not n:
        return ""
    rel = list(widths or [])[:n]
    if len(rel) < n or not all(isinstance(w, (int, float)) and w > 0 for w in rel):
        rel = [1] * n
    total = sum(rel)
    w = [int(TEXT_WIDTH * x / total) for x in rel]
    w[-1] += TEXT_WIDTH - sum(w)
    border = '<w:{0} w:val="single" w:sz="4" w:space="0" w:color="B8C1D1"/>'
    borders = "".join(border.format(side) for side in ("top", "left", "bottom", "right", "insideH", "insideV"))
    tblpr = (f'<w:tblPr><w:tblW w:w="{TEXT_WIDTH}" w:type="dxa"/><w:tblBorders>{borders}</w:tblBorders>'
             '<w:tblLayout w:type="fixed"/>'
             '<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/>'
             '<w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>')
    grid = "<w:tblGrid>" + "".join(f'<w:gridCol w:w="{x}"/>' for x in w) + "</w:tblGrid>"
    out = [f"<w:tbl>{tblpr}{grid}"]
    if columns:
        cells = "".join(_cell(columns[i] if i < len(columns) else "", w[i], header=True) for i in range(n))
        out.append(f'<w:tr><w:trPr><w:tblHeader/></w:trPr>{cells}</w:tr>')
    for r in rows:
        cells = "".join(_cell(r[i] if i < len(r) else "", w[i]) for i in range(n))
        out.append(f"<w:tr>{cells}</w:tr>")
    out.append("</w:tbl>")
    return "".join(out)


def build_docx(doc: dict) -> bytes:
    body = []
    numbering_nums = []   # one <w:num> per list so numbered lists restart at 1
    next_num = 1

    title = doc.get("title") or "Document"
    body.append(_para(_run(title), style="Title"))
    if doc.get("subtitle"):
        body.append(_para(_run(doc["subtitle"]), style="Subtitle"))

    for section in doc.get("sections", []):
        blocks = section.get("blocks", [])
        if not blocks:
            continue
        if section.get("heading"):
            body.append(_para(_run(section["heading"]), style="Heading1"))
        for b in blocks:
            kind = b.get("type")
            if kind == "p" and b.get("text"):
                body.append(_para(_run(b["text"])))
            elif kind == "text" and b.get("text"):
                for line in str(b["text"]).splitlines():
                    body.append(_para(_run(line)) if line.strip() else _para("", spacing_after=0))
            elif kind == "note" and b.get("text"):
                body.append(_para(_run(b["text"], italic=True, color="5B6478", size=20)))
            elif kind in ("bullets", "numbers"):
                items = [i for i in b.get("items", []) if i]
                if not items:
                    continue
                abstract = 0 if kind == "bullets" else 1
                num_id = next_num
                next_num += 1
                numbering_nums.append(
                    f'<w:num w:numId="{num_id}"><w:abstractNumId w:val="{abstract}"/>'
                    f'<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>')
                for item in items:
                    body.append(_para(_item_runs(item), style="ListParagraph", num_id=num_id))
            elif kind == "table":
                body.append(_table(b.get("columns") or [], b.get("rows") or [], b.get("widths")))
                body.append(_para("", spacing_after=60))
            elif kind == "qa":
                body.append(_para(_run(b.get("question", ""), bold=True), keep_next=True, spacing_after=40))
                body.append(_para(_run(b.get("answer", ""))))

    # US Letter, 1-inch margins
    sect = ('<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
            '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" '
            'w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>')
    document_xml = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                    f'<w:document {W_NS}><w:body>{"".join(body)}{sect}</w:body></w:document>')

    numbering_xml = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering {W_NS}>'
        '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>'
        '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/>'
        '<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>'
        f'<w:rPr><w:rFonts w:ascii="{FONT}" w:hAnsi="{FONT}"/></w:rPr></w:lvl></w:abstractNum>'
        '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/>'
        '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/>'
        '<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>'
        f'{"".join(numbering_nums)}</w:numbering>')

    styles_xml = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles {W_NS}>'
        '<w:docDefaults><w:rPrDefault><w:rPr>'
        f'<w:rFonts w:ascii="{FONT}" w:hAnsi="{FONT}" w:eastAsia="{FONT}" w:cs="{FONT}"/>'
        '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>'
        '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>'
        '</w:docDefaults>'
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
        '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>'
        '<w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="0" w:after="60"/></w:pPr>'
        f'<w:rPr><w:rFonts w:ascii="{FONT}" w:hAnsi="{FONT}"/><w:b/><w:color w:val="1F3A5F"/>'
        '<w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>'
        '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/>'
        '<w:next w:val="Normal"/><w:qFormat/><w:pPr>'
        '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="8" w:color="C9D3E3"/></w:pBdr>'
        '<w:spacing w:before="0" w:after="240"/></w:pPr>'
        f'<w:rPr><w:rFonts w:ascii="{FONT}" w:hAnsi="{FONT}"/><w:color w:val="5B6478"/>'
        '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>'
        '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>'
        '<w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="320" w:after="120"/>'
        f'<w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:ascii="{FONT}" w:hAnsi="{FONT}"/><w:b/>'
        '<w:color w:val="1F3A5F"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>'
        '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/>'
        '<w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="80"/><w:ind w:left="720"/></w:pPr></w:style>'
        '</w:styles>')

    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        '</Types>')

    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        '</Relationships>')

    doc_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
        '</Relationships>')

    core = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/">'
        f'<dc:title>{_clean(title)}</dc:title><dc:creator>Think-First Workbench</dc:creator>'
        '</cp:coreProperties>')

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:  # files only, no folder entries
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", root_rels)
        z.writestr("docProps/core.xml", core)
        z.writestr("word/document.xml", document_xml)
        z.writestr("word/styles.xml", styles_xml)
        z.writestr("word/numbering.xml", numbering_xml)
        z.writestr("word/_rels/document.xml.rels", doc_rels)
    return buf.getvalue()
