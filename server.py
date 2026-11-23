#!/usr/bin/env python3
"""
Think-First Workbench - local server.

Serves the web pages in ./static and forwards LLM requests to OpenAI,
so your API key never appears in browser code.

Run:   python3 server.py        (Windows: python server.py)
Open:  http://localhost:8000

With no OPENAI_API_KEY set (in a .env file or the environment), the server
runs in MOCK mode and returns the sample responses in ./mocks instead.

Adding a new interaction on the server side needs no code changes:
  prompts/<interaction-id>/<step>.txt   - system prompt for that step
  mocks/<interaction-id>/<step>.json    - sample response for mock mode
Prompt files are re-read on every request, so edits take effect immediately.
"""
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from docx_writer import build_docx
from extract import extract_text

ROOT = Path(__file__).resolve().parent


def load_env(path: Path) -> None:
    """Minimal .env loader (KEY=value lines). Real environment variables win."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env(ROOT / ".env")

HOST = "127.0.0.1"  # local only - not reachable from other machines
PORT = int(os.environ.get("PORT", "8000"))
MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
MOCK = os.environ.get("MOCK", "").lower() in ("1", "true", "yes") or not API_KEY
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
MOCK_CALLS = {}  # how many times each sequenced mock has been used


def openai_chat(body: dict, timeout: int = 120) -> str:
    """Send a Chat Completions request and return the reply text."""
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {API_KEY}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        try:
            detail = json.loads(detail)["error"]["message"]
        except Exception:
            pass
        raise RuntimeError(f"OpenAI returned {e.code}: {detail}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Could not reach OpenAI: {e.reason}")
    return data["choices"][0]["message"]["content"] or ""


def call_openai(system_prompt: str, payload) -> dict:
    content = openai_chat({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(payload, indent=2, ensure_ascii=False)},
        ],
        "response_format": {"type": "json_object"},
    })
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        raise RuntimeError("The model did not return valid JSON. Try again.")


def openai_pdf_text(filename: str, data: bytes) -> str:
    """Ask the model to transcribe a PDF (used when pypdf isn't installed)."""
    b64 = base64.b64encode(data).decode("ascii")
    return openai_chat({
        "model": MODEL,
        "messages": [{"role": "user", "content": [
            {"type": "file", "file": {"filename": filename, "file_data": f"data:application/pdf;base64,{b64}"}},
            {"type": "text", "text": "Transcribe all of the text in this document as plain text, in order. "
                                     "Keep headings. Write tables row by row. Output only the document's text."},
        ]}],
    }, timeout=300)


MAX_DOC_CHARS = 80_000      # per document, to keep requests a sensible size
MAX_UPLOAD_BYTES = 25_000_000


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "static"), **kwargs)

    def end_headers(self):
        # Always serve fresh files so edits show up on a normal reload.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, status: int, obj) -> None:
        data = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/api/status":
            return self.send_json(200, {"mock": MOCK, "model": MODEL})
        return super().do_GET()

    def do_POST(self):
        if self.path == "/api/docx":
            return self.make_docx()
        if self.path == "/api/extract":
            return self.extract()
        if self.path != "/api/llm":
            return self.send_json(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(length) or b"{}")
            interaction = str(req.get("interaction", ""))
            step = str(req.get("step", ""))
            payload = req.get("payload", {})
            if not (NAME_RE.match(interaction) and NAME_RE.match(step)):
                return self.send_json(400, {"error": "Bad interaction or step name"})

            if MOCK:
                mock_file = ROOT / "mocks" / interaction / f"{step}.json"
                if not mock_file.exists():
                    return self.send_json(404, {"error": f"No mock response for {interaction}/{step}"})
                time.sleep(0.8)  # feel a little like a real call
                result = json.loads(mock_file.read_text(encoding="utf-8"))
                if isinstance(result, dict) and "_sequence" in result:
                    # A mock can hold several responses, returned in turn (e.g. a check, then a re-check).
                    key = f"{interaction}/{step}"
                    seq = result["_sequence"]
                    result = seq[MOCK_CALLS.get(key, 0) % len(seq)]
                    MOCK_CALLS[key] = MOCK_CALLS.get(key, 0) + 1
            else:
                prompt_file = ROOT / "prompts" / interaction / f"{step}.txt"
                if not prompt_file.exists():
                    return self.send_json(404, {"error": f"No prompt for {interaction}/{step}"})
                result = call_openai(prompt_file.read_text(encoding="utf-8"), payload)

            self.send_json(200, {"result": result})
        except Exception as e:  # report every failure back to the page
            self.send_json(500, {"error": str(e)})

    def extract(self):
        """Pull the text out of an uploaded document: { filename, data (base64) }."""
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length > MAX_UPLOAD_BYTES * 4 // 3 + 10_000:
                return self.send_json(413, {"error": "That file is too large (limit about 25 MB)."})
            req = json.loads(self.rfile.read(length) or b"{}")
            filename = str(req.get("filename", "document"))
            data = base64.b64decode(req.get("data", ""))
            text, note = extract_text(filename, data, None if MOCK else openai_pdf_text)
        except ValueError as e:
            return self.send_json(400, {"error": str(e)})
        except Exception as e:
            return self.send_json(500, {"error": f"Could not read the file: {e}"})
        truncated = len(text) > MAX_DOC_CHARS
        if truncated:
            text = text[:MAX_DOC_CHARS]
            note = (note + "; " if note else "") + "Long document: only the first part is used"
        self.send_json(200, {"text": text, "chars": len(text), "truncated": truncated, "note": note})

    def make_docx(self):
        """Turn a document description from the page into a Word file."""
        try:
            length = int(self.headers.get("Content-Length", 0))
            doc = json.loads(self.rfile.read(length) or b"{}")
            data = build_docx(doc)
        except Exception as e:
            return self.send_json(500, {"error": f"Could not build the Word document: {e}"})
        self.send_response(200)
        self.send_header("Content-Type",
                         "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    mode = "MOCK (sample responses - no API key set)" if MOCK else f"LIVE (OpenAI model: {MODEL})"
    print(f"Think-First Workbench running at http://localhost:{PORT}")
    print(f"Mode: {mode}")
    print("Press Ctrl+C to stop.")
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
