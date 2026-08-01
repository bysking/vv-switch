/**
 * Generates a data.js + index.html pair for viewing vv-switch log sessions in a browser.
 * - index.html is a static template (written once)
 * - data.js contains the log data and is updated on each new entry
 */

import fs from 'fs';
import path from 'path';

function scanLogFiles(dir) {
  if (!fs.existsSync(dir)) return [];

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const files = entries
    .filter((f) => f.endsWith('.jsonl'))
    .map((filename) => {
      const filePath = path.join(dir, filename);
      const stat = fs.statSync(filePath);
      const lines = fs
        .readFileSync(filePath, 'utf8')
        .split('\n')
        .filter((l) => l.trim());

      const firstEntry = lines.length > 0 ? safeJsonParse(lines[0]) : null;
      const lastEntry = lines.length > 0 ? safeJsonParse(lines[lines.length - 1]) : null;

      const timestamp = firstEntry?.timestamp || lastEntry?.timestamp || '';
      const entryCount = lines.length;
      const entries = lines.map((l) => safeJsonParse(l)).filter(Boolean);

      // Extract summary info from entries
      const models = new Set();
      const callers = new Set();
      let totalDuration = 0;
      let successCount = 0;
      let errorCount = 0;
      for (const e of entries) {
        if (e.model) models.add(e.model);
        if (e.caller) callers.add(e.caller);
        if (e.durationMs) totalDuration += e.durationMs;
        if (e.responseStatus && e.responseStatus >= 200 && e.responseStatus < 400) successCount++;
        else if (e.responseStatus && e.responseStatus >= 400) errorCount++;
      }

      return {
        filename,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        timestamp,
        model: [...models].join(', '),
        caller: [...callers].join(', '),
        entryCount,
        entries,
        totalDuration,
        successCount,
        errorCount,
      };
    })
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return files;
}

function safeJsonParse(str: string) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Write only the data.js file (updated on each new entry).
 */
export function writeDataJs(dir: string) {
  if (!fs.existsSync(dir)) return;

  const logFiles = scanLogFiles(dir);
  const dataJson = JSON.stringify(
    logFiles.map((f) => ({
      filename: f.filename,
      size: f.size,
      modified: f.modified,
      timestamp: f.timestamp,
      model: f.model,
      caller: f.caller,
      entryCount: f.entryCount,
      entries: f.entries,
      totalDuration: f.totalDuration,
      successCount: f.successCount,
      errorCount: f.errorCount,
    })),
  );

  const content = `window.LOG_DATA = ${dataJson};\nwindow.LOG_GENERATED_AT = "${new Date().toISOString()}";\n`;
  const outputPath = path.join(dir, 'data.js');
  fs.writeFileSync(outputPath, content, 'utf8');
}

/**
 * Write the static index.html template (written once).
 */
function writeIndexHtml(dir) {
  if (!fs.existsSync(dir)) return;

  // Always overwrite: every time the proxy starts in log mode, rebuild
  // index.html so users always run against the latest template.
  const outputPath = path.join(dir, 'index.html');
  fs.writeFileSync(outputPath, INDEX_HTML_TEMPLATE, 'utf8');
  process.stderr.write(`[vv-switch] Generated ${outputPath}\n`);
}

/**
 * Generate both files. Call when the directory is first created.
 */
export function generateAndWriteIndexHtml(dir) {
  if (!fs.existsSync(dir)) return;

  writeIndexHtml(dir);
  writeDataJs(dir);
  process.stderr.write(`[vv-switch] Generated ${path.join(dir, 'data.js')}\n`);
}

const INDEX_HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VV-Switch Log Viewer</title>
<style>
  :root {
    --bg: #fdfdf6;
    --surface: #ffffff;
    --border: #e0e0d6;
    --text: #1a1a1a;
    --text-muted: #6b6b6b;
    --accent: #2563eb;
    --green: #16a34a;
    --orange: #d97706;
    --red: #dc2626;
    --mono: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: var(--sans);
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    min-height: 100vh;
  }
  .header {
    padding: 20px 24px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    position: sticky;
    top: 0;
    z-index: 100;
  }
  .header h1 { font-size: 18px; font-weight: 600; margin-bottom: 12px; }
  .header h1 span { color: var(--accent); }
  .header-row { display: flex; align-items: center; gap: 12px; }
  .search-input {
    flex: 1;
    padding: 8px 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 14px;
    font-family: var(--mono);
  }
  .search-input:focus { outline: none; border-color: var(--accent); }
  .refresh-btn {
    padding: 6px 14px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 13px;
    transition: all 0.15s;
  }
  .refresh-btn:hover { border-color: var(--accent); color: var(--text); }
  .auto-refresh-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
    user-select: none;
    transition: all 0.15s;
  }
  .auto-refresh-toggle:hover { border-color: var(--accent); color: var(--text); }
  .auto-refresh-toggle.active { background: rgba(63, 185, 80, 0.15); border-color: var(--green); color: var(--green); }
  .stats {
    padding: 12px 24px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    color: var(--text-muted);
    display: flex;
    gap: 16px;
  }
  .stat-item strong { color: var(--text); }
  .container { max-width: 1400px; margin: 0 auto; padding: 16px 24px; }
  .session-list { display: flex; flex-direction: column; gap: 8px; }
  .session-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .session-card:hover { border-color: var(--accent); transform: translateY(-1px); }
  .session-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    flex-wrap: wrap;
  }
  .session-title { font-family: var(--mono); font-size: 14px; font-weight: 500; word-break: break-all; }
  .session-meta { display: flex; gap: 12px; flex-shrink: 0; }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 500;
    font-family: var(--mono);
  }
  .badge-entries { background: rgba(63, 185, 80, 0.15); color: var(--green); }
  .badge-size { background: rgba(210, 153, 34, 0.15); color: var(--orange); }
  .badge-ok { background: rgba(63, 185, 80, 0.15); color: var(--green); }
  .badge-err { background: rgba(248, 81, 73, 0.15); color: var(--red); }
  .badge-claude { background: rgba(106, 39, 189, 0.15); color: #6a27bd; }
  .badge-codex { background: rgba(6, 182, 212, 0.15); color: #06b6d4; }
  .session-details {
    margin-top: 12px;
    font-size: 12px;
    color: var(--text-muted);
    font-family: var(--mono);
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
  }
  .detail-item span { color: var(--text); }
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.7);
    z-index: 200;
    display: none;
  }
  .modal-overlay.open { display: block; }
  .modal {
    position: fixed;
    inset: 24px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .modal-header {
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: var(--surface);
    flex-shrink: 0;
  }
  .modal-header h2 { font-size: 16px; font-family: var(--mono); }
  .modal-close {
    background: none; border: none; color: var(--text-muted);
    cursor: pointer; font-size: 24px; padding: 0 8px; line-height: 1;
  }
  .modal-close:hover { color: var(--text); }
  .modal-tabs {
    display: flex; gap: 0; padding: 0 20px;
    border-bottom: 1px solid var(--border); background: var(--surface); flex-shrink: 0; align-items: center;
  }
  .tab-btn {
    padding: 10px 16px; background: none; border: none; color: var(--text-muted);
    cursor: pointer; font-size: 13px; border-bottom: 2px solid transparent; transition: all 0.15s;
  }
  .tab-btn:hover { color: var(--text); }
  .tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }
  .filter-btn {
    padding: 4px 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 16px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 12px;
    transition: all 0.15s;
  }
  .filter-btn:hover { border-color: var(--accent); color: var(--text); }
  .filter-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .modal-body { flex: 1; overflow: auto; padding: 16px 20px; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .entry-table { width: 100%; border-collapse: collapse; font-size: 12px; font-family: var(--mono); }
  .entry-table th {
    text-align: left; padding: 8px 12px; background: var(--surface);
    border-bottom: 1px solid var(--border); color: var(--text-muted);
    font-weight: 500; position: sticky; top: 0; z-index: 10;
  }
  .entry-table td { padding: 6px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  .entry-table tr:hover td { background: rgba(88, 166, 255, 0.05); }
  .entry-table tr.active-row td { background: rgba(88, 166, 255, 0.1); }
  .view-btn {
    padding: 2px 10px;
    background: none;
    border: 1px solid var(--accent);
    border-radius: 4px;
    color: var(--accent);
    cursor: pointer;
    font-size: 12px;
    font-family: var(--mono);
    transition: all 0.15s;
    white-space: nowrap;
  }
  .view-btn:hover { background: var(--accent); color: #fff; }
  .copy-btn {
    padding: 2px 10px;
    background: none;
    border: 1px solid var(--green);
    border-radius: 4px;
    color: var(--green);
    cursor: pointer;
    font-size: 12px;
    font-family: var(--mono);
    transition: all 0.15s;
    white-space: nowrap;
    margin-right: 4px;
  }
  .copy-btn:hover { background: var(--green); color: #fff; }
  .copy-btn.copied { border-color: var(--text-muted); color: var(--text-muted); }
  .method-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; }
  .method-POST { background: rgba(88, 166, 255, 0.2); color: var(--accent); }
  .method-GET { background: rgba(63, 185, 80, 0.2); color: var(--green); }
  .status-ok { color: var(--green); }
  .status-err { color: var(--red); }
  .json-view {
    font-family: var(--mono); font-size: 12px; white-space: pre-wrap;
    word-break: break-all; color: var(--text); line-height: 1.5;
  }
  .json-view .json-key { color: #0d7c5f; }
  .json-view .json-string { color: #c41a16; }
  .json-view .json-number { color: #1c00db; }
  .json-view .json-bool { color: #881391; }
  .json-view .json-null { color: #808080; }
  .json-view .search-highlight {
    background: #fef08a;
    border-radius: 2px;
    padding: 0 2px;
  }
  /* Collapsible JSON tree */
  .jt { font-family: var(--mono); font-size: 12px; line-height: 1.55; color: var(--text); }
  .jt-node { white-space: pre; }
  .jt-toggle {
    display: inline-block;
    width: 14px;
    margin-left: -14px;
    color: var(--text-muted);
    cursor: pointer;
    user-select: none;
    text-align: center;
  }
  .jt-toggle:hover { color: var(--accent); }
  .jt-node.collapsed > .jt-children { display: none; }
  .jt-node.collapsed > .jt-summary { display: inline; }
  .jt-node:not(.collapsed) > .jt-summary { display: none; }
  .jt-children { display: block; padding-left: 16px; border-left: 1px dashed transparent; }
  .jt-node:hover > .jt-children { border-left-color: var(--border); }
  .jt-key { color: #0d7c5f; }
  .jt-str { color: #c41a16; white-space: pre-wrap; word-break: break-word; }
  .jt-num { color: #1c00db; }
  .jt-bool { color: #881391; }
  .jt-null { color: #808080; }
  .jt-meta { color: var(--text-muted); }
  .jt-str-more {
    color: var(--accent);
    cursor: pointer;
    margin-left: 4px;
    text-decoration: underline dotted;
  }
  .jt-actions { display: flex; gap: 6px; margin-bottom: 8px; }
  .jt-actions button {
    padding: 2px 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 11px;
    font-family: var(--mono);
  }
  .jt-actions button:hover { border-color: var(--accent); color: var(--text); }
  .entry-detail {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(800px, 70vw);
    background: var(--bg);
    border-left: 1px solid var(--border);
    box-shadow: -8px 0 32px rgba(0,0,0,0.4);
    display: flex;
    flex-direction: column;
    z-index: 250;
    transform: translateX(100%);
    transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .entry-detail.visible { transform: translateX(0); }
  .entry-detail-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    flex-shrink: 0;
  }
  .entry-detail-header h3 {
    font-size: 14px;
    font-family: var(--mono);
    font-weight: 500;
  }
  .entry-detail-close {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    cursor: pointer;
    font-size: 18px;
    padding: 2px 8px;
    border-radius: 4px;
    line-height: 1;
  }
  .entry-detail-close:hover { color: var(--text); border-color: var(--accent); }
  .entry-detail-body {
    flex: 1;
    overflow: auto;
    padding: 16px 20px;
  }
  .drawer-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.3);
    z-index: 240;
    display: none;
  }
  .drawer-backdrop.visible { display: block; }
  .empty-state { text-align: center; padding: 60px 20px; color: var(--text-muted); }
  .empty-state p { font-size: 14px; }
  .last-updated { font-size: 11px; color: var(--text-muted); padding: 4px 24px; background: var(--surface); border-bottom: 1px solid var(--border); }
  .stream-badge { background: rgba(210, 153, 34, 0.15); color: var(--orange); }
  .session-delete-btn {
    background: none;
    border: 1px solid transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 16px;
    padding: 2px 8px;
    border-radius: 4px;
    transition: all 0.15s;
    opacity: 0;
    line-height: 1;
  }
  .session-card:hover .session-delete-btn { opacity: 1; }
  .session-delete-btn:hover { color: var(--red); border-color: var(--red); background: rgba(220, 38, 38, 0.05); }
</style>
</head>
<body>
<div class="header">
  <h1><span>&#9670;</span> VV-Switch Log Viewer</h1>
  <div class="header-row">
    <input type="text" class="search-input" id="searchInput" placeholder="Search by model, endpoint, status...">
    <div class="auto-refresh-toggle" id="autoRefreshBtn" title="Auto-refresh every 3s">Auto</div>
    <button class="refresh-btn" id="refreshBtn">Refresh</button>
  </div>
</div>
<div class="stats" id="stats"></div>
<div class="last-updated" id="lastUpdated"></div>
<div class="container">
  <div class="session-list" id="sessionList"></div>
</div>

<div class="modal-overlay" id="modalOverlay">
  <div class="modal">
    <div class="modal-header">
      <h2 id="modalTitle"></h2>
      <button class="modal-close" id="modalClose">&times;</button>
    </div>
    <div class="modal-tabs">
      <button class="tab-btn active" data-tab="table">Table</button>
      <button class="tab-btn" data-tab="json">JSON</button>
      <button class="filter-btn active" data-filter="all" style="margin-left:auto;">All</button>
      <button class="filter-btn" data-filter="claude">Claude</button>
      <button class="filter-btn" data-filter="codex">Codex</button>
      <input type="text" class="search-input" id="modalSearchInput" placeholder="Search entries..." style="width:200px;">
    </div>
    <div class="modal-body">
      <div class="tab-content active" id="tabTable"></div>
      <div class="tab-content" id="tabJson"></div>
    </div>
  </div>
</div>

<div class="drawer-backdrop" id="drawerBackdrop"></div>
<div class="entry-detail" id="entryDetail">
  <div class="entry-detail-header">
    <h3 id="entryDetailTitle">Entry Detail</h3>
    <div style="display:flex;gap:8px;align-items:center;">
      <button class="copy-btn" id="entryDetailCopy">Copy</button>
      <button class="entry-detail-close" id="entryDetailClose">&times;</button>
    </div>
  </div>
  <div class="entry-detail-body" id="entryDetailBody"></div>
</div>

<script src="data.js"></script>
<script>
let searchTerm = '';
let modalSearchTerm = '';
let callerFilter = 'all';
let currentSortedEntries = [];
let autoRefreshInterval = null;
let currentEntryDetail = null;

function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 1500);
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
function formatDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}
function formatTimeMs(ts) {
  // ts is now in "YYYY-MM-DD HH:mm:ss" format, just return as-is
  if (!ts) return 'N/A';
  return ts;
}
function formatTimestamp(ts) {
  if (!ts) return 'N/A';
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}
function highlightJson(obj) {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/("(\\\\u[a-zA-Z0-9]{4}|\\\\[^u]|[^\\\\"])*"(\\s*:)?|\\b(true|false|null)\\b|-?\\d+(?:\\.\\d*)?(?:[eE][+\\-]?\\d+)?)/g, (match) => {
    if (/^"/.test(match)) {
      if (/:$/.test(match)) return '<span class="json-key">' + match + '</span>';
      return '<span class="json-string">' + match + '</span>';
    }
    if (/true|false/.test(match)) return '<span class="json-bool">' + match + '</span>';
    if (/null/.test(match)) return '<span class="json-null">' + match + '</span>';
    return '<span class="json-number">' + match + '</span>';
  });
}
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Collapsible JSON tree -----------------------------------------------
// Renders any value as a tree with click-to-toggle nodes. Objects/arrays
// deeper than autoExpandDepth start collapsed; long strings are truncated
// with a "show all" affordance. Use renderJsonTree(value) to get HTML; the
// outer container needs class="jt" plus a click delegate (wired in init).
var __jtLongStringLimit = 200;
function jtTypeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
function jtRenderString(str) {
  var s = String(str);
  if (s.length <= __jtLongStringLimit) {
    return '<span class="jt-str">' + escapeHtml(JSON.stringify(s)) + '</span>';
  }
  var head = s.slice(0, __jtLongStringLimit);
  return (
    '<span class="jt-str" data-jt-str-full="' + escapeHtml(s) + '">' +
      escapeHtml(JSON.stringify(head)) +
      '<span class="jt-meta"> …' + (s.length - __jtLongStringLimit) + ' chars</span>' +
    '</span>' +
    '<span class="jt-str-more" data-action="expand-string">show all</span>'
  );
}
function jtRenderPrimitive(v) {
  if (v === null) return '<span class="jt-null">null</span>';
  if (typeof v === 'boolean') return '<span class="jt-bool">' + String(v) + '</span>';
  if (typeof v === 'number') return '<span class="jt-num">' + String(v) + '</span>';
  if (typeof v === 'string') return jtRenderString(v);
  return '<span class="jt-meta">' + escapeHtml(String(v)) + '</span>';
}
function jtSummaryFor(v) {
  if (Array.isArray(v)) return '<span class="jt-meta">[ … ' + v.length + ' items ]</span>';
  if (v && typeof v === 'object') {
    var keys = Object.keys(v);
    var preview = keys.slice(0, 3).join(', ');
    if (keys.length > 3) preview += ', …';
    return '<span class="jt-meta">{ ' + escapeHtml(preview) + ' · ' + keys.length + ' keys }</span>';
  }
  return '';
}
function jtRenderValue(v, depth, autoExpandDepth) {
  var t = jtTypeOf(v);
  if (t === 'object' || t === 'array') {
    var isObj = t === 'object';
    var keys = isObj ? Object.keys(v) : null;
    var len = isObj ? keys.length : v.length;
    if (len === 0) return isObj ? '<span class="jt-meta">{}</span>' : '<span class="jt-meta">[]</span>';
    var collapsed = depth >= autoExpandDepth;
    var open = isObj ? '{' : '[';
    var close = isObj ? '}' : ']';
    var html = '<span class="jt-node' + (collapsed ? ' collapsed' : '') + '">';
    html += '<span class="jt-toggle" data-action="toggle">' + (collapsed ? '▶' : '▼') + '</span>';
    html += '<span class="jt-meta">' + open + '</span>';
    html += '<span class="jt-summary">' + jtSummaryFor(v) + '<span class="jt-meta">' + close + '</span></span>';
    html += '<span class="jt-children">';
    if (isObj) {
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        html += '<div class="jt-line">' +
          '<span class="jt-key">"' + escapeHtml(k) + '"</span>' +
          '<span class="jt-meta">: </span>' +
          jtRenderValue(v[k], depth + 1, autoExpandDepth) +
          (i < keys.length - 1 ? '<span class="jt-meta">,</span>' : '') +
          '</div>';
      }
    } else {
      for (var j = 0; j < v.length; j++) {
        html += '<div class="jt-line">' +
          jtRenderValue(v[j], depth + 1, autoExpandDepth) +
          (j < v.length - 1 ? '<span class="jt-meta">,</span>' : '') +
          '</div>';
      }
    }
    html += '</span>';
    html += '<span class="jt-meta">' + close + '</span>';
    html += '</span>';
    return html;
  }
  return jtRenderPrimitive(v);
}
function renderJsonTree(value, opts) {
  opts = opts || {};
  var autoExpandDepth = opts.autoExpandDepth != null ? opts.autoExpandDepth : 2;
  return (
    '<div class="jt-actions">' +
      '<button data-jt-action="expand-all">Expand all</button>' +
      '<button data-jt-action="collapse-all">Collapse all</button>' +
    '</div>' +
    '<div class="jt">' + jtRenderValue(value, 0, autoExpandDepth) + '</div>'
  );
}
function bindJsonTree(rootEl) {
  if (!rootEl || rootEl.__jtBound) return;
  rootEl.__jtBound = true;
  rootEl.addEventListener('click', function(e) {
    var t = e.target;
    if (!t) return;
    var action = t.getAttribute && t.getAttribute('data-action');
    if (action === 'toggle') {
      var node = t.parentElement;
      if (!node) return;
      var willCollapse = !node.classList.contains('collapsed');
      node.classList.toggle('collapsed');
      t.textContent = willCollapse ? '▶' : '▼';
      e.stopPropagation();
      return;
    }
    if (action === 'expand-string') {
      var sib = t.previousElementSibling;
      if (sib && sib.dataset && sib.dataset.jtStrFull != null) {
        sib.textContent = JSON.stringify(sib.dataset.jtStrFull);
        t.remove();
      }
      e.stopPropagation();
      return;
    }
    var btnAction = t.getAttribute && t.getAttribute('data-jt-action');
    if (btnAction === 'expand-all' || btnAction === 'collapse-all') {
      var collapse = btnAction === 'collapse-all';
      var nodes = rootEl.querySelectorAll('.jt-node');
      nodes.forEach(function(n) {
        n.classList.toggle('collapsed', collapse);
        var tog = n.querySelector(':scope > .jt-toggle');
        if (tog) tog.textContent = collapse ? '▶' : '▼';
      });
      e.stopPropagation();
    }
  });
}

function highlightSearchTerm(html, term) {
  if (!term) return html;
  var escapeRegex = new RegExp('[.*+?^' + String.fromCharCode(36) + '{}()|[\\]\\\\]', 'g');
  var escaped = term.replace(escapeRegex, '\\\\$&');
  var textRegex = new RegExp('>([^<]*)<', 'g');
  return html.replace(textRegex, function(match, text) {
    var termRegex = new RegExp(escaped, 'gi');
    var highlighted = text.replace(termRegex, '<span class="search-highlight">$&</span>');
    return '>' + highlighted + '<';
  });
}

function renderSessionList() {
  const list = document.getElementById('sessionList');
  const stats = document.getElementById('stats');
  const lastUpdated = document.getElementById('lastUpdated');

  if (typeof window.LOG_DATA === 'undefined') {
    list.innerHTML = '<div class="empty-state"><p>No log data found. Run vv-switch with --logs first.</p></div>';
    stats.innerHTML = '';
    return;
  }

  const data = window.LOG_DATA;

  let filtered = data.filter((s) => {
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      const searchable = [s.filename, s.model, s.timestamp, s.modified].join(' ').toLowerCase();
      const entrySearch = s.entries.some((e) => JSON.stringify(e).toLowerCase().includes(term));
      if (!searchable.includes(term) && !entrySearch) return false;
    }
    return true;
  });

  const totalEntries = data.reduce((sum, s) => sum + s.entryCount, 0);
  const totalSize = data.reduce((sum, s) => sum + s.size, 0);
  const totalSuccess = data.reduce((sum, s) => sum + (s.successCount || 0), 0);
  const totalErrors = data.reduce((sum, s) => sum + (s.errorCount || 0), 0);
  stats.innerHTML =
    '<div class="stat-item"><strong>' + data.length + '</strong> sessions</div>' +
    '<div class="stat-item"><strong>' + totalEntries + '</strong> total requests</div>' +
    '<div class="stat-item"><strong>' + formatSize(totalSize) + '</strong> total size</div>' +
    '<div class="stat-item"><strong style="color:var(--green)">' + totalSuccess + '</strong> ok</div>' +
    '<div class="stat-item"><strong style="color:var(--red)">' + totalErrors + '</strong> errors</div>' +
    '<div class="stat-item">Showing <strong>' + filtered.length + '</strong></div>';

  if (window.LOG_GENERATED_AT) {
    lastUpdated.textContent = 'Last updated: ' + new Date(window.LOG_GENERATED_AT).toLocaleTimeString();
  }

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state"><p>No sessions found.</p></div>';
    return;
  }

  let html = '';
  for (let i = filtered.length - 1; i >= 0; i--) {
    const s = filtered[i];
    html += '<div class="session-card" data-index="' + data.indexOf(s) + '">' +
      '<div class="session-header">' +
        '<div><div class="session-title">' + escapeHtml(s.filename) + '</div></div>' +
        '<div class="session-meta">' +
          '<span class="badge badge-entries">' + s.entryCount + ' requests</span>' +
          '<span class="badge badge-size">' + formatSize(s.size) + '</span>' +
          (s.successCount ? '<span class="badge badge-ok">' + s.successCount + ' ok</span>' : '') +
          (s.errorCount ? '<span class="badge badge-err">' + s.errorCount + ' err</span>' : '') +
          '<button class="session-delete-btn" data-filename="' + escapeHtml(s.filename) + '" title="Delete log" onclick="event.stopPropagation();deleteLog(this.dataset.filename)">&#x2715;</button>' +
        '</div>' +
      '</div>' +
      '<div class="session-details">' +
        '<div class="detail-item">Time: <span>' + formatTimestamp(s.timestamp) + '</span></div>' +
        (s.model ? '<div class="detail-item">Model: <span>' + escapeHtml(s.model) + '</span></div>' : '') +
        (s.caller ? '<div class="detail-item">Caller: <span>' + escapeHtml(s.caller) + '</span></div>' : '') +
        '<div class="detail-item">Avg Duration: <span>' + formatDuration(s.entryCount ? (s.totalDuration || 0) / s.entryCount : 0) + '</span></div>' +
      '</div>' +
    '</div>';
  }
  list.innerHTML = html;

  list.querySelectorAll('.session-card').forEach((card) => {
    card.addEventListener('click', () => openSession(parseInt(card.dataset.index)));
  });
}

function openSession(idx) {
  const data = window.LOG_DATA;
  const s = data[idx];
  if (!s) return;

  document.getElementById('modalTitle').textContent = s.filename;
  document.getElementById('modalOverlay').classList.add('open');

  // Hide entry detail
  hideEntryDetail();

  // Clear modal search and caller filter when opening a new session
  modalSearchTerm = '';
  callerFilter = 'all';
  document.getElementById('modalSearchInput').value = '';
  document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
  document.querySelector('.filter-btn[data-filter="all"]').classList.add('active');

  // Sort entries by timestamp before rendering
  currentSortedEntries = s.entries.slice().sort((a, b) => {
    const ta = a.timestamp || '';
    const tb = b.timestamp || '';
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

  renderModalContent();
}

function renderModalContent() {
  const sortedEntries = currentSortedEntries;
  if (sortedEntries.length === 0) return;

  // Filter entries based on modal search term and caller filter
  let filteredEntries = sortedEntries;
  if (callerFilter !== 'all') {
    filteredEntries = sortedEntries.filter((e) => e.caller === callerFilter);
  }
  if (modalSearchTerm) {
    const term = modalSearchTerm.toLowerCase();
    filteredEntries = filteredEntries.filter((e) => JSON.stringify(e).toLowerCase().includes(term));
  }

  let tableHtml = '<table class="entry-table"><thead><tr>' +
    '<th>#</th><th>Time</th><th>Caller</th><th>Model</th><th>Stream</th><th>Endpoint</th><th>Status</th><th>Duration</th><th>Actions</th>' +
    '</tr></thead><tbody>';

  filteredEntries.forEach((e) => {
    const originalIdx = sortedEntries.indexOf(e);
    const model = e.model || '-';
    const caller = e.caller || '-';
    const stream = e.stream ? 'Yes' : 'No';
    const endpoint = e.endpoint || e.path || '-';
    const status = e.responseStatus ?? '-';
    const duration = e.durationMs != null ? formatDuration(e.durationMs) : '-';
    const statusClass = (typeof status === 'number' && status >= 400) ? 'status-err' : 'status-ok';
    const callerBadge = caller !== '-' ? '<span class="badge badge-' + escapeHtml(caller) + '">' + escapeHtml(caller) + '</span>' : '-';
    tableHtml += '<tr data-entry-idx="' + originalIdx + '" data-caller="' + escapeHtml(caller) + '">' +
      '<td>' + (originalIdx + 1) + '</td>' +
      '<td>' + (e.timestamp ? formatTimeMs(e.timestamp) : '-') + '</td>' +
      '<td>' + callerBadge + '</td>' +
      '<td>' + escapeHtml(model) + '</td>' +
      '<td>' + (e.stream ? '<span class="badge stream-badge">stream</span>' : 'no') + '</td>' +
      '<td>' + escapeHtml(endpoint) + '</td>' +
      '<td class="' + statusClass + '">' + escapeHtml(String(status)) + '</td>' +
      '<td>' + escapeHtml(duration) + '</td>' +
      '<td><button class="copy-btn" data-entry-idx="' + originalIdx + '">Copy</button>' +
          '<button class="view-btn" data-entry-idx="' + originalIdx + '">View</button></td>' +
    '</tr>';
  });

  tableHtml += '</tbody></table>';

  if (filteredEntries.length === 0) {
    tableHtml = '<div class="empty-state"><p>No entries match the search term.</p></div>';
  }

  document.getElementById('tabTable').innerHTML = tableHtml;

  // Render JSON tab (collapsible tree)
  const jsonTab = document.getElementById('tabJson');
  if (filteredEntries.length === 0) {
    jsonTab.innerHTML = '<div class="empty-state"><p>No entries match the search term.</p></div>';
  } else {
    jsonTab.innerHTML = renderJsonTree(filteredEntries, { autoExpandDepth: 6 });
    bindJsonTree(jsonTab);
  }

  // Use event delegation on the modal-body for View and Copy buttons
  document.getElementById('tabTable').addEventListener('click', (e) => {
    const btn = e.target.closest('.view-btn, .copy-btn');
    if (btn) {
      const idx = parseInt(btn.dataset.entryIdx);
      const entry = sortedEntries[idx];
      if (!entry) return;
      if (btn.classList.contains('copy-btn')) {
        copyToClipboard(JSON.stringify(entry, null, 2), btn);
      } else {
        showEntryDetail(idx, entry);
      }
    }
  });
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
}

function renderConversation(entry) {
  const body = entry && entry.requestBody;
  const messages = body && Array.isArray(body.messages) ? body.messages : null;
  if (!messages || messages.length === 0) return '';

  // Preserve original order (oldest \u2192 newest); the last user message is the
  // most-recent input and ends up at the bottom of the panel.
  const items = messages.map(function(m, i) {
    var role = m.role || 'unknown';
    var text;
    if (typeof m.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content
        .map(function(c) {
          if (c == null) return '';
          if (typeof c === 'string') return c;
          if (typeof c.text === 'string') return c.text;
          if (c.type === 'tool_use') return '[tool_use ' + (c.name || '') + ' ' + JSON.stringify(c.input || {}) + ']';
          if (c.type === 'tool_result') return '[tool_result] ' + (typeof c.content === 'string' ? c.content : JSON.stringify(c.content));
          return JSON.stringify(c);
        })
        .join('\\n');
    } else {
      text = JSON.stringify(m.content);
    }
    var isLast = i === messages.length - 1;
    var color = role === 'user' ? 'var(--accent)' : role === 'assistant' ? 'var(--green)' : 'var(--text-muted)';
    return (
      '<div style="margin-bottom:12px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;' +
      (isLast ? 'box-shadow:0 0 0 2px ' + color + ';' : '') +
      '">' +
        '<div style="font-family:var(--mono);font-size:11px;color:' + color + ';margin-bottom:6px;">' +
          '#' + (i + 1) + ' \u00b7 ' + escapeHtml(role) + (isLast ? ' \u00b7 latest' : '') +
        '</div>' +
        '<div style="font-family:var(--mono);font-size:12px;white-space:pre-wrap;word-break:break-word;">' +
          escapeHtml(text) +
        '</div>' +
      '</div>'
    );
  });

  return (
    '<div style="margin-bottom:16px;">' +
      '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">Conversation (oldest \u2192 newest, ' + messages.length + ' messages)</div>' +
      items.join('') +
    '</div>'
  );
}

function renderAssistantResponse(entry) {
  if (!entry) return '';
  var text = entry.responseText || '';
  var thinking = entry.thinkingText || '';
  var toolCalls = Array.isArray(entry.toolCalls) ? entry.toolCalls : [];
  if (!text && !thinking && toolCalls.length === 0) return '';

  var parts = [];
  if (thinking) {
    parts.push(
      '<div style="margin-bottom:12px;padding:10px 12px;border:1px dashed var(--border);border-radius:8px;background:rgba(0,0,0,0.02);">' +
        '<div style="font-family:var(--mono);font-size:11px;color:var(--text-muted);margin-bottom:6px;">thinking</div>' +
        '<div style="font-family:var(--mono);font-size:12px;white-space:pre-wrap;word-break:break-word;color:var(--text-muted);">' +
          escapeHtml(thinking) +
        '</div>' +
      '</div>'
    );
  }
  if (text) {
    parts.push(
      '<div style="margin-bottom:12px;padding:10px 12px;border:1px solid var(--green);border-radius:8px;background:rgba(22,163,74,0.04);">' +
        '<div style="font-family:var(--mono);font-size:11px;color:var(--green);margin-bottom:6px;">assistant \u00b7 response</div>' +
        '<div style="font-family:var(--mono);font-size:12px;white-space:pre-wrap;word-break:break-word;">' +
          escapeHtml(text) +
        '</div>' +
      '</div>'
    );
  }
  toolCalls.forEach(function(tc) {
    var args = tc && tc.arguments;
    if (typeof args === 'string') {
      try { args = JSON.stringify(JSON.parse(args), null, 2); } catch (e) {}
    } else {
      args = JSON.stringify(args, null, 2);
    }
    parts.push(
      '<div style="margin-bottom:12px;padding:10px 12px;border:1px solid var(--orange);border-radius:8px;background:rgba(217,119,6,0.04);">' +
        '<div style="font-family:var(--mono);font-size:11px;color:var(--orange);margin-bottom:6px;">tool_use \u00b7 ' + escapeHtml(tc && tc.name || '') + '</div>' +
        '<div style="font-family:var(--mono);font-size:12px;white-space:pre-wrap;word-break:break-word;">' +
          escapeHtml(args || '') +
        '</div>' +
      '</div>'
    );
  });

  var stopReason = entry.stopReason ? ' \u00b7 stop=' + entry.stopReason : '';
  var tokens = '';
  if (entry.inputTokens != null || entry.outputTokens != null) {
    tokens = ' \u00b7 in=' + (entry.inputTokens || 0) + ' out=' + (entry.outputTokens || 0);
  }
  return (
    '<div style="margin-bottom:16px;">' +
      '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">Response' + stopReason + tokens + '</div>' +
      parts.join('') +
    '</div>'
  );
}

function showEntryDetail(idx, entry) {
  const panel = document.getElementById('entryDetail');
  const title = document.getElementById('entryDetailTitle');
  const body = document.getElementById('entryDetailBody');
  const backdrop = document.getElementById('drawerBackdrop');

  currentEntryDetail = entry;
  title.textContent = '#' + (idx + 1) + ' \u2014 Entry Detail';
  body.innerHTML =
    renderConversation(entry) +
    renderAssistantResponse(entry) +
    '<div style="font-size:12px;color:var(--text-muted);margin:8px 0;">Raw entry</div>' +
    renderJsonTree(entry, { autoExpandDepth: 8 });
  bindJsonTree(body);
  panel.classList.add('visible');
  backdrop.classList.add('visible');

  // Highlight active row
  document.querySelectorAll('.entry-table tbody tr').forEach((r) => r.classList.remove('active-row'));
  const row = document.querySelector('.entry-table tbody tr[data-entry-idx="' + idx + '"]');
  if (row) row.classList.add('active-row');

  // Scroll latest message into view so the most-recent user input is visible
  setTimeout(function() {
    var lastMsg = body.querySelector('div[style*="box-shadow"]');
    if (lastMsg) lastMsg.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, 60);
}

function hideEntryDetail() {
  currentEntryDetail = null;
  document.getElementById('entryDetail').classList.remove('visible');
  document.getElementById('drawerBackdrop').classList.remove('visible');
  document.querySelectorAll('.entry-table tbody tr').forEach((r) => r.classList.remove('active-row'));
}

document.getElementById('entryDetailClose').addEventListener('click', hideEntryDetail);
document.getElementById('drawerBackdrop').addEventListener('click', hideEntryDetail);
document.getElementById('entryDetailCopy').addEventListener('click', function() {
  if (currentEntryDetail) {
    copyToClipboard(JSON.stringify(currentEntryDetail, null, 2), this);
  }
});

function reloadData() {
  const oldScript = document.querySelector('script[src="data.js"]');
  if (oldScript) oldScript.remove();

  const newScript = document.createElement('script');
  newScript.src = 'data.js?v=' + Date.now();
  newScript.onload = () => {
    renderSessionList();
  };
  document.head.appendChild(newScript);
}

async function deleteLog(filename) {
  if (!await confirmDialog('Delete log file "' + filename + '"?')) return;

  try {
    const res = await fetch('/api/logs/' + encodeURIComponent(filename), {
      method: 'DELETE',
    });
    const result = await res.json();
    if (!result.success) {
      showToast('Delete failed: ' + (result.error || 'Unknown error'), 'error');
      return;
    }
    showToast('Deleted: ' + filename, 'success');
    reloadData();
  } catch (e) {
    showToast('Delete failed: ' + e.message, 'error');
  }
}

function confirmDialog(message) {
  return new Promise(function(resolve) {
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;';
    var box = document.createElement('div');
    box.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:400px;width:90%;text-align:center;';
    box.innerHTML = '<p style="margin-bottom:20px;font-size:14px;">' + escapeHtml(message) + '</p>' +
      '<div style="display:flex;gap:12px;justify-content:center;">' +
      '<button id="_confirmCancel" style="padding:8px 24px;border:1px solid var(--border);border-radius:6px;background:var(--bg);cursor:pointer;font-size:14px;">Cancel</button>' +
      '<button id="_confirmOk" style="padding:8px 24px;border:none;border-radius:6px;background:var(--red);color:#fff;cursor:pointer;font-size:14px;">Delete</button>' +
      '</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    document.getElementById('_confirmOk').onclick = function() { document.body.removeChild(overlay); resolve(true); };
    document.getElementById('_confirmCancel').onclick = function() { document.body.removeChild(overlay); resolve(false); };
    overlay.addEventListener('click', function(e) { if (e.target === overlay) { document.body.removeChild(overlay); resolve(false); } });
  });
}

function showToast(message, type) {
  var toast = document.createElement('div');
  var colors = type === 'success' ? 'var(--green)' : 'var(--red)';
  var bg = type === 'success' ? 'rgba(63,185,80,0.15)' : 'rgba(248,81,73,0.15)';
  toast.style.cssText = 'position:fixed;bottom:24px;right:24px;padding:12px 20px;border-radius:8px;font-size:13px;font-weight:500;background:' + bg + ';color:' + colors + ';border:1px solid ' + colors + ';z-index:9999;animation:slideIn .3s ease;';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(function() { toast.style.opacity = '0'; toast.style.transition = 'opacity .3s'; setTimeout(function() { toast.remove(); }, 300); }, 3000);
}

function applyFilters() {
  searchTerm = document.getElementById('searchInput').value.trim();
  renderSessionList();
}

document.getElementById('searchInput').addEventListener('input', applyFilters);
document.getElementById('refreshBtn').addEventListener('click', reloadData);
document.getElementById('autoRefreshBtn').addEventListener('click', function() {
  this.classList.toggle('active');
  if (this.classList.contains('active')) {
    autoRefreshInterval = setInterval(reloadData, 3000);
  } else {
    clearInterval(autoRefreshInterval);
  }
});

document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal();
});

document.getElementById('modalSearchInput').addEventListener('input', () => {
  modalSearchTerm = document.getElementById('modalSearchInput').value.trim();
  renderModalContent();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.getElementById('entryDetail').classList.contains('visible')) {
      hideEntryDetail();
    } else {
      closeModal();
    }
  }
  if (e.key === '/' && !e.ctrlKey && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    document.getElementById('searchInput').focus();
  }
  if (e.key === 'r' && !e.ctrlKey && document.activeElement.tagName !== 'INPUT') {
    reloadData();
  }
});

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(tab === 'table' ? 'tabTable' : 'tabJson').classList.add('active');
    hideEntryDetail();
  });
});

document.querySelectorAll('.filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    callerFilter = btn.dataset.filter;
    renderModalContent();
  });
});

renderSessionList();
</script>
</body>
</html>`;
