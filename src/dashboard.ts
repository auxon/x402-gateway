/**
 * Analytics dashboard page.
 *
 * Owner view: ?service=<slug> + admin key (kept in sessionStorage).
 * Public view: ?token=<dashboard token> — read-only, created/revoked by the owner.
 * Pro services see the per-day series, route breakdown, and call log.
 */
export function dashboardHtml(base: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>x402 Gateway — Analytics</title>
<meta name="robots" content="noindex,nofollow">
<style>
  :root { --bg:#0b0e14; --panel:#121722; --panel-2:#0d1320; --line:#232c3d; --text:#e8edf5; --muted:#8b97ab; --accent:#6ee7b7; --accent2:#38bdf8; --danger:#f87171; --warn:#fbbf24; }
  * { box-sizing:border-box; }
  body { margin:0; background:radial-gradient(1200px 600px at 20% -10%, #16233a 0%, var(--bg) 55%); color:var(--text); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:1020px; margin:0 auto; padding:32px 20px 70px; }
  a { color:var(--accent2); text-decoration:none; }
  h1 { font-size:24px; margin:0 0 4px; letter-spacing:-.4px; }
  h2 { font-size:15px; margin:26px 0 10px; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; }
  .row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:18px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .card .k { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
  .card .v { font-size:24px; font-weight:700; margin-top:3px; }
  .card .sub { color:var(--muted); font-size:12px; }
  .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:1px 9px; font-size:11px; color:var(--muted); }
  .pill.pro { color:var(--accent); border-color:var(--accent); }
  .pill.free { color:var(--warn); border-color:var(--warn); }
  input, select, button { font:inherit; }
  input, select { background:var(--panel-2); border:1px solid var(--line); border-radius:8px; color:var(--text); padding:9px 11px; }
  input { min-width:260px; }
  button { background:var(--accent); color:#08130f; border:0; border-radius:8px; padding:9px 14px; font-weight:700; cursor:pointer; }
  button.ghost { background:transparent; color:var(--accent); border:1px solid var(--accent); }
  button:disabled { opacity:.5; cursor:default; }
  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  th,td { text-align:left; padding:7px 9px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.05em; }
  td.num, th.num { text-align:right; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  .chart { margin-top:6px; }
  .chart svg { display:block; width:100%; height:74px; }
  .chart .lbl { color:var(--muted); font-size:11px; }
  .bar { background:var(--panel-2); border-radius:3px; height:6px; min-width:60px; overflow:hidden; }
  .bar i { display:block; height:100%; background:var(--accent); }
  .lock { background:var(--panel-2); border:1px dashed var(--line); border-radius:12px; padding:20px; text-align:center; color:var(--muted); }
  .err { color:var(--danger); }
  .muted { color:var(--muted); }
  .head { display:flex; justify-content:space-between; align-items:flex-start; gap:14px; flex-wrap:wrap; }
  @media (max-width:700px){ input { min-width:0; width:100%; } }
</style></head>
<body><div class="wrap">
  <div class="head">
    <div>
      <h1 id="title">Service analytics</h1>
      <div class="row" id="subtitle"><span class="muted">Loading…</span></div>
    </div>
    <div class="row">
      <select id="days">
        <option value="7">7 days</option>
        <option value="30" selected>30 days</option>
        <option value="90">90 days</option>
      </select>
      <button class="ghost" id="refresh">Refresh</button>
      <a href="${base}/">← Gateway</a>
    </div>
  </div>

  <div id="auth" class="panel" style="margin-top:18px; display:none">
    <h2 style="margin-top:0">Open a dashboard</h2>
    <div class="row">
      <input id="slug" placeholder="service slug (e.g. dns-resolver)">
      <input id="key" type="password" placeholder="admin key (xgw_admin_…)" autocomplete="off" spellcheck="false">
      <button id="open">Open</button>
    </div>
    <p class="muted" style="font-size:13px">Analytics are Pro: owners can also create a public read-only link from the panel below.</p>
  </div>

  <div id="error" class="panel err" style="margin-top:16px; display:none"></div>

  <div id="dash" style="display:none">
    <h2>Overview</h2>
    <div class="cards" id="cards"></div>

    <div id="proCharts">
      <h2>Calls per day</h2>
      <div class="panel chart" id="chartCalls"></div>
      <h2>Sats earned per day</h2>
      <div class="panel chart" id="chartSats"></div>

      <h2>Routes</h2>
      <div class="panel" id="routesPanel"></div>

      <h2>Recent calls</h2>
      <div class="panel" id="recentPanel" style="overflow-x:auto"></div>

      <div id="sharePanel"></div>
    </div>

    <h2>Uptime</h2>
    <div class="panel" id="watchPanel" style="overflow-x:auto"><span class="muted">Loading…</span></div>

    <div id="locked" class="lock" style="margin-top:22px; display:none">
      Per-day charts, the route breakdown, the call log, and uptime alerts are <strong>Pro</strong> features.<br>
      <button class="ghost" id="upgradeMonthly" style="margin-top:12px">Upgrade to Pro — monthly</button>
      <button class="ghost" id="upgradeAnnual" style="margin-top:12px">Upgrade to Pro — annual, save 20%</button>
    </div>
  </div>
</div>
<script>
const BASE = '${base}';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const params = new URLSearchParams(location.search);
const token = params.get('token') || '';

function keyFor(slug) { return sessionStorage.getItem('xgw_admin:' + slug) || ''; }
function setKey(slug, key) { sessionStorage.setItem('xgw_admin:' + slug, key); }

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const json = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(json && json.error || ('HTTP ' + res.status)), { status: res.status, body: json });
  return json;
}

function svgBars(rows, key, color) {
  if (!rows.length) return '<span class="muted">No calls in this window yet.</span>';
  const max = Math.max(1, ...rows.map((r) => r[key]));
  const w = 10, gap = 2, h = 64, total = rows.length * (w + gap);
  const rects = rows.map((r, i) => {
    const v = r[key];
    const bh = Math.max(v > 0 ? 2 : 0, Math.round((v / max) * h));
    return '<rect x="' + (i * (w + gap)) + '" y="' + (h - bh) + '" width="' + w + '" height="' + bh + '" rx="2" fill="' + color + '">' +
      '<title>' + esc(r.day) + ': ' + fmt(v) + '</title></rect>';
  }).join('');
  return '<svg viewBox="0 0 ' + total + ' ' + h + '" preserveAspectRatio="none">' + rects + '</svg>' +
    '<div class="lbl">' + esc(rows[0].day) + ' → ' + esc(rows[rows.length - 1].day) + ' · max ' + fmt(max) + '</div>';
}

function statCard(k, v, sub) {
  return '<div class="card"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="sub">' + (sub || '') + '</div></div>';
}

async function load(showError = true) {
  const slug = params.get('service') || $('slug').value.trim();
  const days = $('days').value;
  if (!slug && !token) { $('auth').style.display = 'block'; return; }

  const headers = {};
  let url = '/api/services/' + encodeURIComponent(slug || '') + '/analytics?days=' + days;
  if (token) {
    url = '/api/dashboards/' + encodeURIComponent(token) + '/analytics?days=' + days;
  } else if (keyFor(slug)) {
    headers['X-Admin-Key'] = keyFor(slug);
  } else if ($('key').value.trim()) {
    headers['X-Admin-Key'] = $('key').value.trim();
  } else {
    $('auth').style.display = 'block';
    return;
  }

  try {
    const d = await api(url, { headers });
    if (!token && headers['X-Admin-Key']) setKey(d.service.slug, headers['X-Admin-Key']);
    $('auth').style.display = 'none';
    $('error').style.display = 'none';
    $('dash').style.display = 'block';
    document.title = d.service.name + ' — Analytics';
    $('title').textContent = d.service.name;
    $('subtitle').innerHTML =
      '<span class="pill ' + (d.pro ? 'pro' : 'free') + '">' + (d.pro ? 'Pro' : 'Free') + '</span>' +
      '<span class="pill">' + esc(d.service.slug) + '</span>' +
      (token ? '<span class="pill">public link</span>' : '') +
      '<span class="muted">last ' + d.windowDays + ' days · generated ' + esc(d.generatedAt.slice(0, 16).replace('T', ' ')) + ' UTC</span>';

    $('cards').innerHTML =
      statCard('Calls', fmt(d.totals.calls), fmt(d.totals.paidCalls) + ' paid · ' + fmt(d.totals.freeCalls) + ' free') +
      statCard('Sats earned', fmt(d.totals.sats), 'settled to the service payTo') +
      statCard('Success rate', d.totals.successRate === null ? '—' : d.totals.successRate + '%', fmt(d.totals.errors) + ' errors');

    const dot = (s) => s === 'ok'
      ? '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#6ee7b7"></span>'
      : s === 'failing'
        ? '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#f87171"></span>'
        : '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#8b97ab"></span>';
    const watches = (d.watch && d.watch.watches) || [];
    $('watchPanel').innerHTML = watches.length === 0
      ? '<span class="muted">No endpoints monitored yet. Owners add watches from the service admin API; paid routes are watched automatically.</span>'
      : '<table><thead><tr><th></th><th>Endpoint</th><th>Status</th><th class="num">HTTP</th><th class="num">ms</th><th class="num">Sats</th><th>Last checked (UTC)</th></tr></thead><tbody>' +
        watches.map((w) =>
          '<tr><td>' + dot(w.status) + '</td><td><a class="mono" href="' + BASE + '/watch/' + encodeURIComponent(w.id) + '" target="_blank" rel="noreferrer">' + esc(w.label || w.targetUrl) + '</a>' +
          '<div class="muted mono" style="font-size:11px">' + esc(w.targetUrl) + '</div></td>' +
          '<td>' + esc(w.status) + (w.consecutiveFailures > 1 ? ' ×' + w.consecutiveFailures : '') + '</td>' +
          '<td class="num">' + (w.lastStatus === null || w.lastStatus === undefined ? '—' : w.lastStatus) + '</td>' +
          '<td class="num">' + (w.lastLatencyMs === null || w.lastLatencyMs === undefined ? '—' : w.lastLatencyMs) + '</td>' +
          '<td class="num">' + (w.lastPriceSats === null || w.lastPriceSats === undefined ? '—' : fmt(w.lastPriceSats)) + '</td>' +
          '<td class="mono">' + (w.lastCheckedAt ? esc(w.lastCheckedAt.slice(0, 19).replace('T', ' ')) : 'never') + '</td></tr>'
        ).join('') + '</tbody></table>' +
        (d.pro ? '' : '<div class="muted" style="margin-top:10px">Email + webhook alerts on breakage are Pro — upgrade to get paged.</div>');

    $('proCharts').style.display = d.pro ? 'block' : 'none';
    $('locked').style.display = d.pro ? 'none' : 'block';
    if (!d.pro) return;

    $('chartCalls').innerHTML = svgBars(d.byDay, 'calls', '#6ee7b7');
    $('chartSats').innerHTML = svgBars(d.byDay, 'sats', '#38bdf8');

    const maxCalls = Math.max(1, ...d.byRoute.map((r) => r.calls));
    $('routesPanel').innerHTML = d.byRoute.length === 0
      ? '<span class="muted">No calls yet.</span>'
      : '<table><thead><tr><th>Route</th><th class="num">Calls</th><th class="num">Sats</th><th class="num">Errors</th><th class="num">Avg ms</th><th style="width:140px"></th></tr></thead><tbody>' +
        d.byRoute.map((r) =>
          '<tr><td class="mono">' + esc(r.route) + '</td><td class="num">' + fmt(r.calls) + '</td><td class="num">' + fmt(r.sats) +
          '</td><td class="num">' + fmt(r.errors) + '</td><td class="num">' + fmt(r.avgMs) + '</td>' +
          '<td><div class="bar"><i style="width:' + Math.round((r.calls / maxCalls) * 100) + '%"></i></div></td></tr>'
        ).join('') + '</tbody></table>';

    $('recentPanel').innerHTML = d.recent.length === 0
      ? '<span class="muted">No calls yet.</span>'
      : '<table><thead><tr><th>When (UTC)</th><th>Route</th><th>Payer</th><th class="num">Sats</th><th class="num">Status</th><th class="num">ms</th><th>Tx</th></tr></thead><tbody>' +
        d.recent.map((r) =>
          '<tr><td class="mono">' + esc(r.createdAt.slice(0, 19).replace('T', ' ')) + '</td><td class="mono">' + esc(r.route) +
          '</td><td class="mono">' + esc(r.payer) + '</td><td class="num">' + fmt(r.sats) +
          '</td><td class="num' + (r.status >= 400 ? ' err' : '') + '">' + r.status + '</td><td class="num">' + r.ms + '</td>' +
          '<td>' + (r.txid ? '<a class="mono" target="_blank" rel="noreferrer" href="https://whatsonchain.com/tx/' + esc(r.txid) + '">' + esc(r.txid.slice(0, 10)) + '…</a>' : '—') + '</td></tr>'
        ).join('') + '</tbody></table>';

    // Share panel: owner only (token view is already public).
    if (!token) {
      $('sharePanel').innerHTML = '<h2>Public link</h2><div class="panel row" id="shareBox"><span class="muted">Loading…</span></div>';
      loadShare(d.service.slug);
    } else {
      $('sharePanel').innerHTML = '';
    }
  } catch (e) {
    $('dash').style.display = 'none';
    if (e.status === 401 || e.status === 403) {
      $('auth').style.display = 'block';
      if (showError) { $('error').textContent = 'Admin key missing or wrong for this service.'; $('error').style.display = 'block'; }
    } else if (showError) {
      $('error').textContent = e.message;
      $('error').style.display = 'block';
    }
  }
}

async function loadShare(slug) {
  const box = $('shareBox');
  try {
    const s = await api('/api/services/' + encodeURIComponent(slug) + '/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': keyFor(slug) },
      body: JSON.stringify({ action: 'shared' }),
    });
    if (s.active) {
      box.innerHTML = '<a class="mono" id="shareUrl" href="' + esc(s.url) + '" target="_blank" rel="noreferrer">' + esc(s.url) + '</a>' +
        '<button class="ghost" id="copyShare">Copy</button>' +
        '<button class="ghost" id="rotateShare">Rotate</button>' +
        '<button class="ghost" id="revokeShare">Revoke</button>' +
        '<span class="muted">' + fmt(s.views) + ' views' + (s.lastViewedAt ? ' · last ' + esc(s.lastViewedAt.slice(0, 16).replace('T', ' ')) : '') + '</span>';
      $('copyShare').onclick = () => navigator.clipboard.writeText(s.url);
      $('rotateShare').onclick = () => shareAction(slug, 'share');
      $('revokeShare').onclick = () => shareAction(slug, 'unshare');
    } else {
      box.innerHTML = '<span class="muted">No public link yet.</span><button id="createShare">Create public link</button>';
      $('createShare').onclick = () => shareAction(slug, 'share');
    }
  } catch (e) {
    box.innerHTML = '<span class="muted">Public links are Pro: ' + esc(e.message) + '</span>';
  }
}

async function shareAction(slug, action) {
  try {
    await api('/api/services/' + encodeURIComponent(slug) + '/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': keyFor(slug) },
      body: JSON.stringify({ action }),
    });
    loadShare(slug);
  } catch (e) {
    alert(e.message);
  }
}

async function upgrade(interval) {
  const slug = params.get('service') || $('slug').value.trim();
  try {
    const res = await api('/api/services/' + encodeURIComponent(slug) + '/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': keyFor(slug) },
      body: JSON.stringify({ action: 'checkout', interval }),
    });
    window.location.href = res.url;
  } catch (e) {
    alert('Upgrade error: ' + e.message);
  }
}

$('open').onclick = () => { load(); };
$('refresh').onclick = () => load();
$('days').onchange = () => load();
$('key').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
$('upgradeMonthly').onclick = () => upgrade('month');
$('upgradeAnnual').onclick = () => upgrade('year');

if (params.get('service') || token) load(); else $('auth').style.display = 'block';
</script>
<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"82070152b02a4a06a05d7ac15991ed63"}'></script>
</body></html>`;
}
