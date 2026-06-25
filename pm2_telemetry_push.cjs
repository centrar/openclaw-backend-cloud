'use strict';
/**
 * PM2 TELEMETRY PUSH  v2.0
 * ─────────────────────────────────────────────────────────────────────────
 * Runs every 2 minutes via PM2 cron_restart.
 * Captures:
 *   1. Full `pm2 jlist` JSON status (all process names, statuses, restart counts, CPU/mem)
 *   2. Last 20 lines of error logs for any process with status != 'online'
 *   3. Sentinel key-health snapshot (GET localhost:18790/stats) — the "key health"
 *      metric so dead/exhausted NVIDIA keys are visible without manual probing.
 *   4. Per-process 5-minute restart-rate derived from the prior telemetry rows —
 *      the "agent activity" metric that would have surfaced the 4235-restart
 *      crash-loop in seconds instead of hours.
 * Pushes to Supabase `pm2_telemetry` table (columns sentinel_stats + restart_rates
 * added by migration 0003_telemetry_enrichment.sql).
 * The /dashboard route in hermes_render_api.js reads this for the auto-dashboard.
 * ─────────────────────────────────────────────────────────────────────────
 */

require('../secrets_bootstrap.cjs'); // DPAPI keystore → process.env (sync, before dotenv)
require('dotenv').config({ path: require('../ag_paths.cjs').ENV_FILE });
const { execSync } = require('child_process');
const { readFileSync } = require('fs');
const { Pool } = require('pg');

const paths = require('../ag_paths.cjs');
const { createLogger } = require('../ag_logger.cjs');
const log = createLogger('pm2-telemetry');

const HOST = process.env.SWARM_HOST || 'arvin-main';
const SENTINEL_STATS_URL = process.env.SENTINEL_STATS_URL || 'http://localhost:18790/stats';

const pool = new Pool({
  connectionString: process.env.SUPABASE_DB_URL,
  connectionTimeoutMillis: 15000,
  statement_timeout: 10000,
});

function getPm2Status() {
  try {
    const raw = execSync('pm2 jlist', { timeout: 15000, windowsHide: true }).toString();
    const list = JSON.parse(raw);
    return list.map(p => ({
      id:        p.pm_id,
      name:      p.name,
      status:    p.pm2_env?.status,
      restarts:  p.pm2_env?.restart_time,
      uptime:    p.pm2_env?.pm_uptime,
      pid:       p.pid,
      cpu:       p.monit?.cpu,
      mem:       p.monit?.memory,
      exit_code: p.pm2_env?.exit_code,
    }));
  } catch(e) {
    log.warn('pm2_jlist_failed', { err: e.message });
    return [];
  }
}

function getErrorDigest(processes) {
  const digest = {};
  for (const p of processes) {
    if (p.status === 'online') continue;
    const logPath = paths.pm2ErrorLog(p.name);
    try {
      const content = readFileSync(logPath, 'utf8');
      const lines = content.trim().split('\n');
      digest[p.name] = { status: p.status, restarts: p.restarts, last_error_lines: lines.slice(-20).join('\n') };
    } catch(e) {
      digest[p.name] = { status: p.status, restarts: p.restarts, last_error_lines: `[log not readable: ${e.message}]` };
    }
  }
  return digest;
}

/**
 * Fetch sentinel key-health via /stats. Tries global fetch (Node 18+) first,
 * falls back to http if unavailable. Returns { online: false } if unreachable —
 * the dashboard shows "offline" rather than crashing.
 */
async function getSentinelStats() {
  if (typeof fetch === 'function') {
    try {
      const res = await fetch(SENTINEL_STATS_URL, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { online: false, status: res.status };
      return parseSentinelBody(await res.json());
    } catch (e) { /* fall through to http */ }
  }
  return getSentinelStatsHttp();
}

function parseSentinelBody(j) {
  const keys = Array.isArray(j.keys) ? j.keys : [];
  const inUse = keys.filter(k => k.rpmUsed > 0).length;
  return {
    online: true,
    healthy: j.healthy ?? 0,
    dead: j.dead ?? 0,
    total: j.total ?? keys.length,
    keys_in_use: inUse,
    rpm_limit: keys[0]?.rpmLimit ?? null,
  };
}

function getSentinelStatsHttp() {
  return new Promise((resolve) => {
    const http = require('http');
    const req = http.get(SENTINEL_STATS_URL, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(parseSentinelBody(JSON.parse(body))); }
        catch { resolve({ online: false, status: 'parse_error' }); }
      });
    });
    req.on('error', () => resolve({ online: false }));
    req.on('timeout', () => { req.destroy(); resolve({ online: false, status: 'timeout' }); });
  });
}

/**
 * Compute per-process restart-rate over the last ~5 minutes by diffing the
 * current restart_time against the oldest telemetry row in that window.
 * This is the metric that would have surfaced the 4235-restart crash-loop.
 */
async function getRestartRates(client, processes) {
  try {
    const { rows } = await client.query(
      `SELECT processes FROM pm2_telemetry
       WHERE host = $1 AND captured_at > NOW() - INTERVAL '6 minutes'
       ORDER BY captured_at ASC LIMIT 1`,
      [HOST]
    );
    if (rows.length === 0) return {};
    const priorByName = new Map();
    for (const p of rows[0].processes || []) priorByName.set(p.name, p.restarts || 0);
    const rates = {};
    for (const p of processes) {
      const prev = priorByName.get(p.name) ?? p.restarts ?? 0;
      rates[p.name] = { restarts_now: p.restarts ?? 0, restarts_5min_ago: prev, delta_5min: (p.restarts ?? 0) - prev };
    }
    return rates;
  } catch (e) {
    log.warn('restart_rate_query_failed', { err: e.message });
    return {};
  }
}

async function main() {
  log.info('capturing_snapshot');

  const processes = getPm2Status();
  const errorDigest = getErrorDigest(processes);
  const unhealthy = processes.filter(p => p.status !== 'online' && p.status !== 'stopped');
  if (unhealthy.length > 0) {
    log.warn('unhealthy_processes', { count: unhealthy.length, names: unhealthy.map(p => `${p.name}(${p.status})`) });
  }

  const sentinelStats = await getSentinelStats();
  if (!sentinelStats.online) log.warn('sentinel_offline', { url: SENTINEL_STATS_URL });

  const client = await pool.connect();
  try {
    const restartRates = await getRestartRates(client, processes);

    await client.query(
      `INSERT INTO pm2_telemetry (captured_at, host, processes, error_digest, sentinel_stats, restart_rates)
       VALUES (NOW(), $1, $2, $3, $4, $5)`,
      [HOST, JSON.stringify(processes), JSON.stringify(errorDigest),
       JSON.stringify(sentinelStats), JSON.stringify(restartRates)]
    );
    log.info('pushed_snapshot', {
      processes: processes.length,
      error_digests: Object.keys(errorDigest).length,
      sentinel_online: !!sentinelStats.online,
      sentinel_keys_in_use: sentinelStats.keys_in_use ?? 0,
    });

    // Cleanup: keep only last 100 rows.
    await client.query(`
      DELETE FROM pm2_telemetry
      WHERE id NOT IN (
        SELECT id FROM pm2_telemetry ORDER BY captured_at DESC LIMIT 100
      )
    `);
  } finally {
    client.release();
    await pool.end();
  }
}

module.exports = { getPm2Status, getErrorDigest, parseSentinelBody, getSentinelStatsHttp };

// Only auto-run main() when invoked directly (not when required by tests).
if (require.main === module) {
  main().catch(e => {
    log.error('fatal', { err: e.message });
    process.exit(1);
  });
}
