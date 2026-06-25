/**
 * dashboard_renderer.cjs
 * ======================
 * Pure HTML renderer for the swarm observability dashboard.
 *
 * Extracted from the Express route so it's unit-testable: pass a telemetry
 * snapshot (the latest pm2_telemetry row), get back a self-contained HTML
 * string. No I/O, no Express dependency.
 *
 * The dashboard shows three panels:
 *   1. Per-agent status grid (name, status, restarts, uptime, 5-min restart delta)
 *   2. Sentinel key-health (online, healthy/dead, keys in use, rpm limit)
 *   3. Error digest summary for unhealthy agents
 *
 * It auto-refreshes every 15s via a meta tag — zero manual intervention.
 */

'use strict';

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusColor(status) {
  if (status === 'online') return '#16a34a';
  if (status === 'stopped') return '#6b7280';
  if (status === 'errored' || status === 'stopping') return '#dc2626';
  return '#d97706'; // waiting restart / unknown
}

function fmtUptime(ms) {
  if (!ms) return '—';
  const s = Math.floor((Date.now() - new Date(ms).getTime()) / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

/**
 * @param {object} snapshot  latest pm2_telemetry row:
 *   { captured_at, host, processes:[], error_digest:{}, sentinel_stats:{}, restart_rates:{} }
 * @returns {string} HTML document
 */
function renderDashboard(snapshot) {
  const snap = snapshot || {};
  const processes = Array.isArray(snap.processes) ? snap.processes : [];
  const sentinel = (snap.sentinel_stats && typeof snap.sentinel_stats === 'object') ? snap.sentinel_stats : { online: false };
  const rates = (snap.restart_rates && typeof snap.restart_rates === 'object') ? snap.restart_rates : {};
  const errorDigest = (snap.error_digest && typeof snap.error_digest === 'object') ? snap.error_digest : {};

  const onlineCount = processes.filter(p => p.status === 'online').length;
  const loopedAgents = Object.entries(rates).filter(([, r]) => r.delta_5min > 0);

  // Sentinel panel
  const sentinelPanel = sentinel.online
    ? `<div class="metric"><span class="label">Sentinel</span><span class="value ok">ONLINE</span></div>
       <div class="metric"><span class="label">Keys healthy</span><span class="value">${sentinel.healthy} / ${sentinel.total}</span></div>
       <div class="metric"><span class="label">Keys dead</span><span class="value ${sentinel.dead > 0 ? 'bad' : ''}">${sentinel.dead}</span></div>
       <div class="metric"><span class="label">Keys in use</span><span class="value">${sentinel.keys_in_use ?? 0}</span></div>
       <div class="metric"><span class="label">RPM limit/key</span><span class="value">${sentinel.rpm_limit ?? '—'}</span></div>`
    : `<div class="metric"><span class="label">Sentinel</span><span class="value bad">OFFLINE</span></div>`;

  // Restart-loop alert banner (the "4235 restarts unnoticed" gap)
  const loopBanner = loopedAgents.length > 0
    ? `<div class="alert">⚠️ ${loopedAgents.length} agent(s) restarted in the last 5 min: ${loopedAgents.map(([n, r]) => `${escapeHtml(n)} (+${r.delta_5min})`).join(', ')}</div>`
    : '';

  // Per-agent rows
  const rows = processes.map(p => {
    const r = rates[p.name] || {};
    const delta = r.delta_5min;
    const color = statusColor(p.status);
    return `<tr>
      <td class="mono">${escapeHtml(p.name)}</td>
      <td><span class="badge" style="background:${color}">${escapeHtml(p.status)}</span></td>
      <td>${p.restarts ?? 0}</td>
      <td>${delta != null ? `<span class="${delta > 0 ? 'bad' : ''}">+${delta}</span>` : '—'}</td>
      <td>${fmtUptime(p.uptime)}</td>
      <td>${p.cpu ?? '—'}%</td>
      <td>${p.mem ? Math.round(p.mem / 1048576) + 'MB' : '—'}</td>
    </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="15">
<title>OpenClaw Swarm Dashboard</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background:#0f172a; color:#e2e8f0; margin:0; padding:20px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:#94a3b8; font-size:13px; margin-bottom:16px; }
  .panels { display:flex; gap:16px; margin-bottom:16px; flex-wrap:wrap; }
  .panel { background:#1e293b; border-radius:8px; padding:14px 16px; min-width:220px; }
  .metric { display:flex; justify-content:space-between; padding:4px 0; font-size:14px; }
  .metric .label { color:#94a3b8; }
  .metric .value { font-weight:600; }
  .value.ok { color:#16a34a; } .value.bad { color:#dc2626; }
  .alert { background:#7f1d1d; border-radius:6px; padding:10px 14px; margin-bottom:16px; font-size:14px; }
  table { width:100%; border-collapse:collapse; background:#1e293b; border-radius:8px; overflow:hidden; }
  th, td { padding:8px 12px; text-align:left; font-size:13px; border-bottom:1px solid #334155; }
  th { color:#94a3b8; font-weight:600; text-transform:uppercase; font-size:11px; }
  .mono { font-family:ui-monospace,monospace; }
  .badge { color:#fff; padding:2px 8px; border-radius:4px; font-size:11px; }
  .summary { color:#94a3b8; font-size:13px; margin-top:8px; }
</style>
</head>
<body>
<h1>🦞 OpenClaw Swarm Dashboard</h1>
<div class="sub">${escapeHtml(snap.host || 'unknown')} · captured ${escapeHtml(snap.captured_at || '—')} · ${onlineCount}/${processes.length} online · auto-refresh 15s</div>
${loopBanner}
<div class="panels">
  <div class="panel">${sentinelPanel}</div>
  <div class="panel">
    <div class="metric"><span class="label">Agents total</span><span class="value">${processes.length}</span></div>
    <div class="metric"><span class="label">Online</span><span class="value ok">${onlineCount}</span></div>
    <div class="metric"><span class="label">Not online</span><span class="value">${processes.length - onlineCount}</span></div>
    <div class="metric"><span class="label">Error digests</span><span class="value">${Object.keys(errorDigest).length}</span></div>
  </div>
</div>
<table>
  <thead><tr><th>Agent</th><th>Status</th><th>Restarts</th><th>Δ 5min</th><th>Uptime</th><th>CPU</th><th>Mem</th></tr></thead>
  <tbody>
  ${rows || '<tr><td colspan="7" style="text-align:center;color:#94a3b8">No telemetry yet</td></tr>'}
  </tbody>
</table>
<div class="summary">Sentinel offline = local NVIDIA gateway down. Δ 5min > 0 = agent in a restart loop (the crash-loop signal).</div>
</body>
</html>`;
}

module.exports = { renderDashboard, escapeHtml, statusColor, fmtUptime };
