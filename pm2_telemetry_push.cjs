'use strict';
/**
 * PM2 TELEMETRY PUSH  v1.0
 * ─────────────────────────────────────────────────────────────────────────
 * Runs every 2 minutes via PM2 cron_restart.
 * Captures:
 *   1. Full `pm2 jlist` JSON status (all process names, statuses, restart counts, CPU/mem)
 *   2. Last 20 lines of error logs for any process with status != 'online'
 * Pushes to Supabase `pm2_telemetry` table.
 * Goose on Render reads this to monitor local machine health.
 * ─────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config({ path: 'C:/Users/arvin/.openclaw/.env' });
const { execSync } = require('child_process');
const { readFileSync } = require('fs');
const { Pool } = require('pg');

const HOST = 'arvin-main';
const LOG_PREFIX = '[PM2Telemetry]';
const PM2_LOG_BASE = 'C:/Users/arvin/.pm2/logs';

const pool = new Pool({
  connectionString: process.env.SUPABASE_DB_URL,
  connectionTimeoutMillis: 15000,
  statement_timeout: 10000,
});

function log(msg)  { console.log(`${LOG_PREFIX} ${new Date().toISOString()} ${msg}`); }
function warn(msg) { console.warn(`${LOG_PREFIX} ⚠️  ${msg}`); }

function getPm2Status() {
  try {
    const raw = execSync('pm2 jlist', { timeout: 15000 }).toString();
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
    warn(`pm2 jlist failed: ${e.message}`);
    return [];
  }
}

function getErrorDigest(processes) {
  const digest = {};
  for (const p of processes) {
    if (p.status === 'online') continue;
    // Try reading last 20 lines of error log
    const logName = p.name.replace(/_/g, '-');
    const logPath = `${PM2_LOG_BASE}/${logName}-error.log`;
    try {
      const content = readFileSync(logPath, 'utf8');
      const lines = content.trim().split('\n');
      const last20 = lines.slice(-20).join('\n');
      digest[p.name] = {
        status: p.status,
        restarts: p.restarts,
        last_error_lines: last20
      };
    } catch(e) {
      digest[p.name] = {
        status: p.status,
        restarts: p.restarts,
        last_error_lines: `[log not readable: ${e.message}]`
      };
    }
  }
  return digest;
}

async function main() {
  log('Capturing PM2 telemetry snapshot...');

  const processes = getPm2Status();
  log(`Found ${processes.length} PM2 processes.`);

  // Also capture error digest for unhealthy processes
  const errorDigest = getErrorDigest(processes);
  const unhealthy = processes.filter(p => p.status !== 'online' && p.status !== 'stopped');
  if (unhealthy.length > 0) {
    warn(`Unhealthy processes: ${unhealthy.map(p => `${p.name}(${p.status})`).join(', ')}`);
  }

  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO pm2_telemetry (captured_at, host, processes, error_digest)
       VALUES (NOW(), $1, $2, $3)`,
      [HOST, JSON.stringify(processes), JSON.stringify(errorDigest)]
    );
    log(`✅ Pushed telemetry snapshot (${processes.length} processes, ${Object.keys(errorDigest).length} error digests) to Supabase.`);

    // Cleanup: keep only last 100 rows to avoid unbounded growth
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

main().catch(e => {
  console.error(`${LOG_PREFIX} ❌ Fatal:`, e.message);
  process.exit(1);
});
