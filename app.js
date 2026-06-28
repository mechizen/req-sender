"use strict";

const $ = (id) => document.getElementById(id);
const els = {
  target: $('target'),
  method: $('method'),
  path: $('path'),
  headers: $('headers'),
  body: $('body'),
  send: $('send'),
  sendBurst: $('sendBurst'),
  burst: $('burst'),
  copyCurl: $('copyCurl'),
  clearHistory: $('clearHistory'),
  presetList: $('presetList'),
  tabs: $('tabs'),
  meta: $('meta'),
  sentView: $('sentView'),
  echoView: $('echoView'),
  resHeaders: $('resHeaders'),
  resBody: $('resBody'),
  historyList: $('historyList'),
};

const STORAGE_KEY = 'reqsender.history.v1';
let history = loadHistory();
let currentCat = 'basic';

// ---- presets ----
function renderPresets() {
  const items = window.PRESETS.filter(p => p.cat === currentCat);
  els.presetList.innerHTML = items.map((p, i) => `
    <li data-i="${window.PRESETS.indexOf(p)}">
      <div class="pname">${escapeHtml(p.name)}</div>
      <div class="pmeta">${p.method} ${escapeHtml(p.path)}</div>
      ${p.note ? `<div class="pnote">${escapeHtml(p.note)}</div>` : ''}
    </li>
  `).join('');
}

els.tabs.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cat]');
  if (!b) return;
  [...els.tabs.children].forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  currentCat = b.dataset.cat;
  renderPresets();
});

els.presetList.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  const p = window.PRESETS[+li.dataset.i];
  applyPreset(p);
});

function applyPreset(p) {
  els.method.value = p.method;
  let path = p.path;
  if (path.includes('__RAND__')) {
    path = path.replaceAll('__RAND__', Math.random().toString(36).slice(2, 10));
  }
  els.path.value = path;
  els.headers.value = p.headers || '';
  let body = p.body || '';
  if (body === '__BIG_BODY_1MB__') {
    body = 'A'.repeat(1024 * 1024);
  }
  els.body.value = body;
}

// ---- send ----
async function send() {
  const req = buildRequest();
  if (!req) return;
  showMeta('送信中…', null);
  els.echoView.textContent = '';
  els.resHeaders.textContent = '';
  els.resBody.textContent = '';
  els.sentView.textContent = renderSent(req);

  const t0 = performance.now();
  let res, err;
  try {
    res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: 'follow',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (e) {
    err = e;
  }
  const dur = Math.round(performance.now() - t0);

  if (err) {
    showMeta(`ネットワークエラー: ${err.message}  (${dur} ms)`, 0);
    pushHistory({ ...req, status: 0, dur, error: err.message });
    return;
  }

  const headersObj = {};
  res.headers.forEach((v, k) => { headersObj[k] = v; });
  const text = await res.text();
  showMeta(`${res.status} ${res.statusText}  •  ${dur} ms  •  ${formatBytes(text.length)}  •  ${res.url}`, res.status);
  els.resHeaders.textContent = formatHeaders(headersObj);
  els.resBody.textContent = text.slice(0, 4096) + (text.length > 4096 ? `\n\n…(+${text.length - 4096} bytes)` : '');

  // echo parse
  try {
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) {
      const j = JSON.parse(text);
      els.echoView.textContent = JSON.stringify(j, null, 2);
    } else {
      els.echoView.textContent = '(JSONレスポンスではないため echo パース不可)';
    }
  } catch {
    els.echoView.textContent = '(JSONパース失敗)';
  }

  pushHistory({ ...req, status: res.status, dur });
}

async function sendBurst() {
  const n = Math.max(1, Math.min(500, +els.burst.value || 1));
  const req = buildRequest();
  if (!req) return;
  showMeta(`連打中… (${n}並列)`, null);
  const t0 = performance.now();
  const results = await Promise.all(
    Array.from({ length: n }, async () => {
      const t = performance.now();
      try {
        const r = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          redirect: 'follow',
          mode: 'cors',
          credentials: 'omit',
          cache: 'no-store',
        });
        return { status: r.status, dur: performance.now() - t };
      } catch (e) {
        return { status: 0, dur: performance.now() - t, error: e.message };
      }
    })
  );
  const dur = Math.round(performance.now() - t0);
  const buckets = {};
  for (const r of results) buckets[r.status] = (buckets[r.status] || 0) + 1;
  const summary = Object.entries(buckets).sort().map(([s, c]) => `${s}×${c}`).join('  ');
  const avg = Math.round(results.reduce((a, b) => a + b.dur, 0) / results.length);
  showMeta(`連打完了: 合計 ${dur}ms / 平均 ${avg}ms / ${summary}`, null);
  pushHistory({ ...req, status: 'burst', dur, summary: `${n}並列: ${summary}` });
}

function buildRequest() {
  const target = els.target.value.replace(/\/+$/, '');
  let path = els.path.value || '/';
  if (!path.startsWith('/') && !path.startsWith('http')) path = '/' + path;
  const url = path.startsWith('http') ? path : target + path;
  const method = els.method.value;
  const headers = parseHeaders(els.headers.value);
  const body = ['GET', 'HEAD'].includes(method) ? undefined : (els.body.value || undefined);
  return { url, method, headers, body };
}

function parseHeaders(raw) {
  const h = {};
  for (const line of (raw || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const i = s.indexOf(':');
    if (i <= 0) continue;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim();
    if (k) h[k] = v;
  }
  return h;
}

// ---- view helpers ----
function renderSent(req) {
  const u = new URL(req.url);
  let s = `${req.method} ${u.pathname}${u.search} HTTP/?\nHost: ${u.host}\n`;
  for (const [k, v] of Object.entries(req.headers)) s += `${k}: ${v}\n`;
  if (req.body) {
    const b = typeof req.body === 'string' ? req.body : '[binary]';
    s += `\n${b.length > 1024 ? b.slice(0, 1024) + `\n…(+${b.length - 1024} bytes)` : b}`;
  }
  return s;
}

function formatHeaders(obj) {
  return Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join('\n');
}

function showMeta(msg, status) {
  const cls = status == null ? '' : `status-${String(status)[0]}`;
  els.meta.innerHTML = `<span class="${cls}">${escapeHtml(msg)}</span>`;
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- curl ----
function toCurl(req) {
  const parts = [`curl -i -X ${req.method} '${req.url}'`];
  for (const [k, v] of Object.entries(req.headers)) {
    parts.push(`  -H '${k}: ${v.replace(/'/g, "'\\''")}'`);
  }
  if (req.body) {
    const b = String(req.body).replace(/'/g, "'\\''");
    parts.push(`  --data-binary '${b.length > 200 ? b.slice(0, 200) + '...(truncated)' : b}'`);
  }
  return parts.join(' \\\n');
}

els.copyCurl.addEventListener('click', async () => {
  const req = buildRequest();
  if (!req) return;
  const c = toCurl(req);
  try {
    await navigator.clipboard.writeText(c);
    showMeta('curl をクリップボードにコピーしました', null);
  } catch {
    els.sentView.textContent = c;
    showMeta('クリップボード不可。送信パネルに表示しました', null);
  }
});

// ---- history ----
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
}
function saveHistory() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(0, 100))); } catch {}
}
function pushHistory(entry) {
  entry.at = new Date().toISOString();
  // bodyが巨大なら履歴では落とす
  if (entry.body && entry.body.length > 4096) entry.body = `__OMITTED_${entry.body.length}_BYTES__`;
  history.unshift(entry);
  history = history.slice(0, 100);
  saveHistory();
  renderHistory();
}
function renderHistory() {
  els.historyList.innerHTML = history.map((h, i) => {
    const t = h.at ? h.at.slice(11, 19) : '';
    const sc = String(h.status);
    const cls = `status-${sc[0]}`;
    return `<li data-i="${i}">
      <span class="hstatus ${cls}">${escapeHtml(sc)}</span>
      <span class="hmethod">${escapeHtml(h.method)}</span>
      <span class="hurl" title="${escapeHtml(h.url)}">${escapeHtml(h.url)}</span>
      <span class="hdur">${h.dur}ms</span>
      <span class="htime">${t}</span>
    </li>`;
  }).join('');
}
els.historyList.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  const h = history[+li.dataset.i];
  try {
    const u = new URL(h.url);
    els.target.value = `${u.protocol}//${u.host}`;
    els.path.value = u.pathname + u.search;
  } catch {}
  els.method.value = h.method;
  els.headers.value = Object.entries(h.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  els.body.value = typeof h.body === 'string' && !h.body.startsWith('__OMITTED_') ? h.body : '';
});
els.clearHistory.addEventListener('click', () => {
  if (!confirm('履歴を全削除しますか？')) return;
  history = [];
  saveHistory();
  renderHistory();
});

// ---- bind ----
els.send.addEventListener('click', send);
els.sendBurst.addEventListener('click', sendBurst);
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send();
});

// ---- init ----
renderPresets();
renderHistory();
