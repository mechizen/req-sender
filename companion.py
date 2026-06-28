#!/usr/bin/env python3
"""Local companion server for req-sender.

Spawns real client binaries (curl, python, go) so requests carry the
client's actual TLS/HTTP fingerprint rather than the browser's.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "7777"))
HOST = "127.0.0.1"

ALLOWED_ORIGINS = {
    "https://req-sender.echi1000.workers.dev",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://localhost:3000",
    "null",
}

TIMEOUT_SEC = 60


def detect_clients() -> dict[str, str]:
    out: dict[str, str] = {}
    if shutil.which("curl"):
        out["curl"] = "curl"
    if shutil.which("python3"):
        out["python"] = "python3 urllib"
        try:
            subprocess.run(
                ["python3", "-c", "import requests"],
                check=True, capture_output=True, timeout=5,
            )
            out["requests"] = "python3 + requests"
        except Exception:
            pass
    if shutil.which("go"):
        out["go"] = "go net/http"
    return out


CLIENTS = detect_clients()


def now_ms(t0: float) -> int:
    return int((time.time() - t0) * 1000)


def send_via_curl(spec: dict, t0: float) -> dict:
    args = ["curl", "-i", "-s", "--http2", "--max-time", str(TIMEOUT_SEC),
            "-X", spec["method"]]
    for k, v in (spec.get("headers") or {}).items():
        args += ["-H", f"{k}: {v}"]
    body = spec.get("body") or ""
    if body:
        args += ["--data-binary", "@-"]
    args.append(spec["url"])
    try:
        p = subprocess.run(args, input=body.encode() if body else None,
                           capture_output=True, timeout=TIMEOUT_SEC + 10)
        return parse_curl_output(p.stdout.decode("utf-8", errors="replace"), t0)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "curl timed out", "duration_ms": now_ms(t0)}
    except Exception as e:
        return {"ok": False, "error": f"curl spawn: {e}", "duration_ms": now_ms(t0)}


def parse_curl_output(raw: str, t0: float) -> dict:
    rest = raw
    headers_text = ""
    while True:
        sep = rest.find("\r\n\r\n")
        if sep < 0:
            headers_text = rest
            rest = ""
            break
        headers_text = rest[:sep]
        rest = rest[sep + 4:]
        if not headers_text.startswith("HTTP/"):
            break
        line = headers_text.split("\r\n", 1)[0]
        parts = line.split(" ", 2)
        if len(parts) < 2 or not parts[1].startswith("1"):
            break
    lines = headers_text.split("\r\n")
    status_line = lines[0] if lines else ""
    status, status_text = 0, ""
    parts = status_line.split(" ", 2)
    if len(parts) >= 2 and parts[0].startswith("HTTP/"):
        try:
            status = int(parts[1])
            status_text = parts[2] if len(parts) > 2 else ""
        except ValueError:
            pass
    hdrs: dict[str, str] = {}
    for line in lines[1:]:
        idx = line.find(":")
        if idx <= 0:
            continue
        k = line[:idx].strip().lower()
        v = line[idx + 1:].strip()
        hdrs[k] = (hdrs[k] + ", " + v) if k in hdrs else v
    return {"ok": True, "status": status, "statusText": status_text,
            "headers": hdrs, "body": rest, "duration_ms": now_ms(t0)}


PYTHON_URLLIB_SCRIPT = r"""
import json, sys, urllib.request, urllib.error
spec = json.loads(sys.stdin.read())
req = urllib.request.Request(spec['url'], method=spec['method'])
for k, v in (spec.get('headers') or {}).items():
    req.add_header(k, v)
body = spec.get('body') or ''
data = body.encode() if body else None
try:
    r = urllib.request.urlopen(req, data=data, timeout=60)
    payload = {
        'status': r.status,
        'statusText': r.reason,
        'headers': {k.lower(): v for k, v in r.headers.items()},
        'body': r.read().decode('utf-8', errors='replace'),
    }
except urllib.error.HTTPError as e:
    payload = {
        'status': e.code,
        'statusText': e.reason,
        'headers': {k.lower(): v for k, v in e.headers.items()},
        'body': e.read().decode('utf-8', errors='replace'),
    }
print(json.dumps(payload))
"""


PYTHON_REQUESTS_SCRIPT = r"""
import json, sys, requests
spec = json.loads(sys.stdin.read())
r = requests.request(
    spec['method'], spec['url'],
    headers=spec.get('headers') or {},
    data=(spec.get('body') or '').encode() if spec.get('body') else None,
    timeout=60, allow_redirects=True,
)
print(json.dumps({
    'status': r.status_code,
    'statusText': r.reason,
    'headers': {k.lower(): v for k, v in r.headers.items()},
    'body': r.text,
}))
"""


GO_SCRIPT = r"""
package main
import (
    "bytes"; "encoding/json"; "io"; "net/http"; "os"; "strings"
)
func main() {
    var spec map[string]interface{}
    json.NewDecoder(os.Stdin).Decode(&spec)
    method, _ := spec["method"].(string)
    url, _ := spec["url"].(string)
    body, _ := spec["body"].(string)
    req, err := http.NewRequest(method, url, bytes.NewReader([]byte(body)))
    if err != nil { json.NewEncoder(os.Stdout).Encode(map[string]any{"_err": err.Error()}); return }
    if h, ok := spec["headers"].(map[string]interface{}); ok {
        for k, v := range h { if vs, ok := v.(string); ok { req.Header.Set(k, vs) } }
    }
    resp, err := http.DefaultClient.Do(req)
    if err != nil { json.NewEncoder(os.Stdout).Encode(map[string]any{"_err": err.Error()}); return }
    defer resp.Body.Close()
    buf, _ := io.ReadAll(resp.Body)
    hdrs := map[string]string{}
    for k, vs := range resp.Header { hdrs[strings.ToLower(k)] = strings.Join(vs, ", ") }
    json.NewEncoder(os.Stdout).Encode(map[string]any{
        "status": resp.StatusCode,
        "statusText": resp.Status,
        "headers": hdrs,
        "body": string(buf),
    })
}
"""


def send_via_script(cmd: list[str], spec: dict, t0: float, label: str) -> dict:
    try:
        p = subprocess.run(cmd, input=json.dumps(spec).encode(),
                           capture_output=True, timeout=TIMEOUT_SEC + 30)
        if p.returncode != 0:
            err = p.stderr.decode("utf-8", errors="replace").strip()
            return {"ok": False, "error": f"{label}: {err or 'exit ' + str(p.returncode)}",
                    "duration_ms": now_ms(t0)}
        try:
            out = json.loads(p.stdout.decode("utf-8", errors="replace"))
        except json.JSONDecodeError as e:
            return {"ok": False, "error": f"{label} json parse: {e}",
                    "duration_ms": now_ms(t0)}
        if "_err" in out:
            return {"ok": False, "error": f"{label}: {out['_err']}",
                    "duration_ms": now_ms(t0)}
        out["ok"] = True
        out["duration_ms"] = now_ms(t0)
        return out
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"{label} timed out", "duration_ms": now_ms(t0)}
    except Exception as e:
        return {"ok": False, "error": f"{label} spawn: {e}", "duration_ms": now_ms(t0)}


def send_via_python_urllib(spec: dict, t0: float) -> dict:
    return send_via_script(["python3", "-c", PYTHON_URLLIB_SCRIPT], spec, t0, "python")


def send_via_python_requests(spec: dict, t0: float) -> dict:
    return send_via_script(["python3", "-c", PYTHON_REQUESTS_SCRIPT], spec, t0, "requests")


def send_via_go(spec: dict, t0: float) -> dict:
    with tempfile.NamedTemporaryFile("w", suffix=".go", delete=False) as f:
        f.write(GO_SCRIPT)
        fname = f.name
    try:
        return send_via_script(["go", "run", fname], spec, t0, "go")
    finally:
        try: os.unlink(fname)
        except OSError: pass


CLIENT_HANDLERS = {
    "curl": send_via_curl,
    "python": send_via_python_urllib,
    "requests": send_via_python_requests,
    "go": send_via_go,
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        sys.stderr.write(f"[{self.log_date_time_string()}] {format % args}\n")

    def _cors(self):
        origin = self.headers.get("Origin", "null")
        allow = origin if origin in ALLOWED_ORIGINS else "null"
        return {
            "Access-Control-Allow-Origin": allow,
            "Vary": "Origin",
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "600",
        }

    def _write_json(self, code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for k, v in self._cors().items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in self._cors().items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._write_json(200, {
                "ok": True,
                "clients": CLIENTS,
                "python": sys.version.split()[0],
            })
            return
        self._write_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/send":
            self._write_json(404, {"ok": False, "error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        try:
            spec = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError as e:
            self._write_json(400, {"ok": False, "error": f"invalid JSON: {e}"})
            return
        if not spec.get("url") or not spec.get("method"):
            self._write_json(400, {"ok": False, "error": "url and method required"})
            return
        client = spec.get("client", "curl")
        handler = CLIENT_HANDLERS.get(client)
        if not handler:
            self._write_json(400, {"ok": False, "error": f"unknown client: {client}"})
            return
        if client not in CLIENTS:
            self._write_json(400, {
                "ok": False,
                "error": f"{client} not available on this machine. Detected: {list(CLIENTS)}",
            })
            return
        result = handler(spec, time.time())
        self._write_json(200, result)


def main():
    print(f"req-sender companion listening on http://{HOST}:{PORT}")
    print(f"detected clients: {CLIENTS}")
    print(f"allowed origins:")
    for o in ALLOWED_ORIGINS:
        print(f"  - {o}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
