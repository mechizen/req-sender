"use strict";

const $ = (id) => document.getElementById(id);
const els = {
  target: $('target'),
  mode: $('mode'),
  companionUrl: $('companionUrl'),
  companionStatus: $('companionStatus'),
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

  const mode = els.mode.value;
  const result = mode.startsWith('companion:')
    ? await sendViaCompanion(req, mode.slice('companion:'.length))
    : await sendViaBrowser(req);

  if (!result.ok) {
    showMeta(`${result.error}  (${result.dur} ms)`, 0);
    pushHistory({ ...req, status: 0, dur: result.dur, error: result.error, mode });
    return;
  }

  showMeta(`${result.status} ${result.statusText}  •  ${result.dur} ms  •  ${formatBytes(result.body.length)}  •  via ${modeLabel(mode)}`, result.status);
  els.resHeaders.textContent = formatHeaders(result.headers);
  els.resBody.textContent = result.body.slice(0, 4096) + (result.body.length > 4096 ? `\n\n…(+${result.body.length - 4096} bytes)` : '');

  try {
    const ct = (result.headers['content-type'] || '').toLowerCase();
    if (ct.includes('json')) {
      els.echoView.textContent = JSON.stringify(JSON.parse(result.body), null, 2);
    } else {
      els.echoView.textContent = '(JSONレスポンスではないため echo パース不可)';
    }
  } catch {
    els.echoView.textContent = '(JSONパース失敗)';
  }

  pushHistory({ ...req, status: result.status, dur: result.dur, mode });
}

async function sendViaBrowser(req) {
  const t0 = performance.now();
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: 'follow',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
    });
    const dur = Math.round(performance.now() - t0);
    const headers = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const body = await res.text();
    return { ok: true, status: res.status, statusText: res.statusText, headers, body, dur };
  } catch (e) {
    return { ok: false, error: `ネットワークエラー: ${e.message}`, dur: Math.round(performance.now() - t0) };
  }
}

async function sendViaCompanion(req, client) {
  const t0 = performance.now();
  try {
    const r = await fetch(els.companionUrl.value.replace(/\/+$/, '') + '/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: req.url, method: req.method, headers: req.headers, body: req.body, client }),
    });
    const dur = Math.round(performance.now() - t0);
    if (!r.ok) return { ok: false, error: `companion HTTP ${r.status}`, dur };
    const j = await r.json();
    if (!j.ok) return { ok: false, error: `companion: ${j.error}`, dur: j.duration_ms || dur };
    return {
      ok: true,
      status: j.status,
      statusText: j.statusText || '',
      headers: j.headers || {},
      body: j.body || '',
      dur: j.duration_ms || dur,
    };
  } catch (e) {
    return { ok: false, error: `companion接続失敗 (起動してる? CORS?): ${e.message}`, dur: Math.round(performance.now() - t0) };
  }
}

function modeLabel(mode) {
  if (mode === 'browser') return 'Browser';
  if (mode.startsWith('companion:')) return `Companion · ${mode.slice('companion:'.length)}`;
  return mode;
}

async function sendBurst() {
  const n = Math.max(1, Math.min(500, +els.burst.value || 1));
  const req = buildRequest();
  if (!req) return;
  const mode = els.mode.value;
  showMeta(`連打中… (${n}並列, via ${modeLabel(mode)})`, null);
  const t0 = performance.now();
  const client = mode.startsWith('companion:') ? mode.slice('companion:'.length) : null;
  const sender = client ? (r) => sendViaCompanion(r, client) : sendViaBrowser;
  const results = await Promise.all(Array.from({ length: n }, () => sender(req)));
  const dur = Math.round(performance.now() - t0);
  const buckets = {};
  for (const r of results) buckets[r.ok ? r.status : 0] = (buckets[r.ok ? r.status : 0] || 0) + 1;
  const summary = Object.entries(buckets).sort().map(([s, c]) => `${s}×${c}`).join('  ');
  const avg = Math.round(results.reduce((a, b) => a + b.dur, 0) / results.length);
  showMeta(`連打完了: 合計 ${dur}ms / 平均 ${avg}ms / ${summary} (via ${modeLabel(mode)})`, null);
  pushHistory({ ...req, status: 'burst', dur, summary: `${n}並列: ${summary}`, mode });
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

// ---- companion health / UI toggle ----
let healthTimer;
let availableClients = null;

function toggleCompanionRow() {
  const isCompanion = els.mode.value.startsWith('companion:');
  document.querySelectorAll('.companion-only').forEach(el => {
    if (isCompanion) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
  });
}

function setStatus(text, kind) {
  els.companionStatus.textContent = text || '';
  els.companionStatus.className = 'via-status' + (kind ? ' ' + kind : '');
}

async function checkCompanion() {
  toggleCompanionRow();
  if (!els.mode.value.startsWith('companion:')) { setStatus(''); return; }
  setStatus('確認中…');
  try {
    const r = await fetch(els.companionUrl.value.replace(/\/+$/, '') + '/health');
    const j = await r.json();
    availableClients = j.clients || {};
    const client = els.mode.value.slice('companion:'.length);
    if (client in availableClients) {
      setStatus(`✓ ${availableClients[client]}`, 'ok');
    } else {
      setStatus(`✗ ${client} 未検出 (${Object.keys(availableClients).join(', ') || 'none'})`, 'err');
    }
  } catch (e) {
    setStatus('✗ companion 未起動', 'err');
  }
}

function scheduleHealth() {
  clearTimeout(healthTimer);
  healthTimer = setTimeout(checkCompanion, 300);
}
els.mode.addEventListener('change', checkCompanion);
els.companionUrl.addEventListener('input', scheduleHealth);

// ---- bind ----
els.send.addEventListener('click', send);
els.sendBurst.addEventListener('click', sendBurst);
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send();
});

// ---- init ----
renderPresets();
renderHistory();
checkCompanion();
