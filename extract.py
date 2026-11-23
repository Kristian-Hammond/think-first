"""
Pull plain text out of uploaded documents, using only the Python standard library
(plus pypdf for PDFs, if it happens to be installed).

extract_text(filename, data, pdf_fallback=None) -> (text, note)
  pdf_fallback: optional function(filename, data) -> text, used for PDFs when pypdf
                isn't installed or finds no text (e.g. scanned pages).
Raises ValueError with a user-friendly message when a file can't be read.
"""
import io
import re
import zipfile
import xml.etree.ElementTree as ET
from html import unescape
from pathlib import PurePath

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
X = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

TEXT_TYPES = {".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".log"}
HTML_TYPES = {".html", ".htm"}


def _decode(data: bytes) -> str:
    for enc in ("utf-8-sig", "utf-16"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1", errors="replace")


def _tidy(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _num(name: str) -> int:
    m = re.search(r"(\d+)\.xml$", name)
    return int(m.group(1)) if m else 0


def _docx(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    lines = []
    for p in root.iter(W + "p"):
        parts = []
        for node in p.iter():
            if node.tag == W + "t" and node.text:
                parts.append(node.text)
            elif node.tag == W + "tab":
                parts.append("\t")
        lines.append("".join(parts))
    return "\n".join(lines)


def _pptx(data: bytes) -> str:
    out = []
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        slides = sorted((n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)), key=_num)
        for name in slides:
            root = ET.fromstring(z.read(name))
            paras = ["".join(t.text or "" for t in p.iter(A + "t")) for p in root.iter(A + "p")]
            paras = [p for p in paras if p.strip()]
            if paras:
                out.append(f"--- Slide {_num(name)} ---\n" + "\n".join(paras))
    return "\n\n".join(out)


def _xlsx(data: bytes) -> str:
    out = []
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in root.iter(X + "si"):
                shared.append("".join(t.text or "" for t in si.iter(X + "t")))
        sheets = sorted((n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n)), key=_num)
        for name in sheets:
            root = ET.fromstring(z.read(name))
            rows = []
            for row in root.iter(X + "row"):
                cells = []
                for c in row.iter(X + "c"):
                    kind = c.get("t")
                    v = c.find(X + "v")
                    if kind == "s" and v is not None and v.text is not None:
                        try:
                            cells.append(shared[int(v.text)])
                        except (ValueError, IndexError):
                            cells.append("")
                    elif kind == "inlineStr":
                        cells.append("".join(t.text or "" for t in c.iter(X + "t")))
                    else:
                        cells.append(v.text if v is not None and v.text else "")
                if any(x.strip() for x in cells):
                    rows.append("\t".join(cells))
            if rows:
                out.append(f"--- Sheet {_num(name)} ---\n" + "\n".join(rows))
    return "\n\n".join(out)


def _html(data: bytes) -> str:
    s = _decode(data)
    s = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?i)<br\s*/?>|</(p|div|li|h\d|tr)>", "\n", s)
    s = re.sub(r"<[^>]+>", " ", s)
    return unescape(s)


def _pdf_local(data: bytes) -> str:
    try:
        from pypdf import PdfReader  # optional: pip3 install pypdf
    except ImportError:
        return ""
    try:
        reader = PdfReader(io.BytesIO(data))
        pages = []
        for i, page in enumerate(reader.pages, 1):
            t = page.extract_text() or ""
            if t.strip():
                pages.append(f"--- Page {i} ---\n{t}")
        return "\n\n".join(pages)
    except Exception:
        return ""


def extract_text(filename: str, data: bytes, pdf_fallback=None):
    ext = PurePath(filename or "").suffix.lower()
    note = ""
    try:
        if ext in TEXT_TYPES:
            text = _decode(data)
        elif ext in HTML_TYPES:
            text = _html(data)
        elif ext == ".docx":
            text = _docx(data)
        elif ext == ".pptx":
            text = _pptx(data)
        elif ext == ".xlsx":
            text = _xlsx(data)
        elif ext == ".pdf":
            text = _pdf_local(data)
            if not text.strip():
                if pdf_fallback is None:
                    raise ValueError(
                        "This PDF can't be read in sample mode. Add your OpenAI key, or run "
                        "'pip3 install pypdf' in Terminal and restart the server, or paste the text instead.")
                text = pdf_fallback(filename, data)
                note = "Text read by the AI from the PDF"
        elif ext in (".doc", ".ppt", ".xls"):
            raise ValueError(f"Older {ext} files aren't supported. Save it as {ext}x (or PDF) and upload again.")
        else:
            raise ValueError("Unsupported file type. Use PDF, Word (.docx), PowerPoint (.pptx), "
                             "Excel (.xlsx), text, Markdown, CSV or HTML.")
    except zipfile.BadZipFile:
        raise ValueError("The file looks damaged or isn't really a " + ext + " file.")
    except ET.ParseError:
        raise ValueError("Couldn't read the contents of this file.")

    text = _tidy(text)
    if not text:
        raise ValueError("No text was found in this file. If it's a scanned document, paste the text instead.")
    return text, note
