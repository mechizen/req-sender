#!/usr/bin/env node
"use strict";

const http = require("http");
const { spawn } = require("child_process");

const PORT = parseInt(process.env.PORT || "7777", 10);
const HOST = "127.0.0.1";

const ALLOWED_ORIGINS = new Set([
  "https://req-sender.echi1000.workers.dev",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://localhost:3000",
  "null",
]);

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : "null";
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      try { resolve(buf ? JSON.parse(buf) : {}); }
      catch (e) { reject(new Error(`invalid JSON: ${e.message}`)); }
    });
    req.on("error", reject);
  });
}

function runCurl({ url, method, headers, body }) {
  return new Promise((resolve) => {
    const args = ["-i", "-s", "--http2", "--max-time", "60", "-X", method];
    for (const [k, v] of Object.entries(headers || {})) {
      args.push("-H", `${k}: ${v}`);
    }
    if (body) args.push("--data-binary", "@-");
    args.push(url);

    const t0 = Date.now();
    const proc = spawn("curl", args);
    const chunks = [];
    let err = "";

    proc.stdout.on("data", (d) => chunks.push(d));
    proc.stderr.on("data", (d) => (err += d.toString()));

    proc.on("error", (e) => {
      resolve({ ok: false, error: `spawn failed: ${e.message}`, duration_ms: Date.now() - t0 });
    });

    proc.on("close", (code) => {
      const dur = Date.now() - t0;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (code !== 0 && raw.length === 0) {
        resolve({ ok: false, error: `curl exit ${code}: ${err.trim()}`, duration_ms: dur });
        return;
      }
      resolve({ ok: true, ...parseCurlOutput(raw), duration_ms: dur, raw_size: raw.length });
    });

    if (body) {
      proc.stdin.write(body);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }
  });
}

function parseCurlOutput(raw) {
  let rest = raw;
  let headersText = "";
  while (true) {
    const sep = rest.indexOf("\r\n\r\n");
    if (sep < 0) {
      headersText = rest;
      rest = "";
      break;
    }
    headersText = rest.slice(0, sep);
    rest = rest.slice(sep + 4);
    if (!/^HTTP\/[\d.]+ 1\d\d/.test(headersText)) break;
  }
  const lines = headersText.split(/\r\n/);
  const m = (lines[0] || "").match(/^HTTP\/([\d.]+) (\d+) ?(.*)$/);
  const status = m ? parseInt(m[2], 10) : 0;
  const statusText = m ? m[3] : "";
  const httpVersion = m ? m[1] : "?";
  const responseHeaders = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(":");
    if (idx <= 0) continue;
    const k = lines[i].slice(0, idx).trim().toLowerCase();
    const v = lines[i].slice(idx + 1).trim();
    responseHeaders[k] = responseHeaders[k] ? `${responseHeaders[k]}, ${v}` : v;
  }
  return { status, statusText, http_version: httpVersion, headers: responseHeaders, body: rest };
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "null";
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ ok: true, client: "curl", version: process.version }));
    return;
  }

  if (req.method === "POST" && req.url === "/send") {
    try {
      const spec = await readJson(req);
      if (!spec.url || !spec.method) {
        res.writeHead(400, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: false, error: "url and method are required" }));
        return;
      }
      const result = await runCurl(spec);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  res.writeHead(404, cors);
  res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`req-sender companion (curl) listening on http://${HOST}:${PORT}`);
  console.log(`Allowed origins:`);
  for (const o of ALLOWED_ORIGINS) console.log(`  - ${o}`);
});
