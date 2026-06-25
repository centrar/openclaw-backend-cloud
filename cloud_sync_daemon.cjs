/**
 * CLOUD SYNC DAEMON  v1.1
 * ─────────────────────────────────────────────────────────────────────
 * Bridges Cloud Supabase Postgres ↔ Local SQLite (swarm_blackboard.db)
 *
 * Direction 1 — PULL (Cloud → Local):
 *   First run: fetches ALL tickets from Supabase (historical + open).
 *   Subsequent runs: only fetches tickets with created_at > last pull
 *   watermark — avoids re-scanning 885 rows every 5 seconds.
 *
 * Direction 2 — PUSH (Local → Cloud):
 *   Every POLL_INTERVAL ms, find locally-updated tickets (updated_at
 *   newer than last push watermark) and mirror status back to Supabase.
 *
 * Scope: ALL ticket types, ALL agents.
 * ─────────────────────────────────────────────────────────────────────
 */

'use strict';

require('../secrets_bootstrap.cjs'); // DPAPI keystore → process.env (sync, before dotenv)
require('dotenv').config({ path: 'C:/Users/arvin/.openclaw/.env' });
const Database = require('better-sqlite3');
const { Pool }  = require('pg');

// ── Config ────────────────────────────────────────────────────────────
const SQLITE_PATH   = 'C:/Users/arvin/.openclaw/swarm_blackboard.db';
const POLL_INTERVAL = 5_000;   // ms between sync cycles
const QUERY_TIMEOUT = 10_000;  // ms — pg query timeout
const LOG_PREFIX    = '[CloudSync]';

// Columns shared between SQLite and Supabase
const SHARED_COLS = [
  'id', 'type', 'priority', 'target_agent', 'status', 'data',
  'created_at', 'updated_at', 'claimed_by', 'claimed_at',
  'lease_expires_at', 'ttl_minutes', 'correlation_id',
  'source_system', 'source_issue_key', 'idempotency_key',
  'agent_origin_tag', 'retry_count', 'max_retries'
];

// ── Clients ───────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.SUPABASE_DB_URL,
  statement_timeout: QUERY_TIMEOUT,
  connectionTimeoutMillis: QUERY_TIMEOUT,
});
let db;  // opened after sanity check

// ── Logging ───────────────────────────────────────────────────────────
function log(msg)  { console.log(`${LOG_PREFIX} ${new Date().toISOString()}  ${msg}`); }
function warn(msg) { console.warn(`${LOG_PREFIX} ⚠️  ${msg}`); }
function err(msg, e) { console.error(`${LOG_PREFIX} ❌  ${msg}`, e?.message || ''); }

// ── State ─────────────────────────────────────────────────────────────
// Pull watermark: only fetch cloud tickets created AFTER this time
// Set to epoch on first run (fetches all), then advanced after each pull
let lastPullAt  = new Date(0).toISOString();
let lastPushAt  = new Date(0).toISOString();
let firstRun    = true;
let stats = { pulled: 0, pushed: 0, errors: 0, cycles: 0 };

// ── Prepared statements (set up after DB opens) ───────────────────────
let stmtInsertTicket;
let stmtLocalUpdatedSince;
let stmtMaxUpdatedAt;

function prepareStatements() {
  const placeholders = SHARED_COLS.map(c => `@${c}`).join(', ');
  const cols         = SHARED_COLS.join(', ');

  // Insert cloud ticket into local — ignore if already exists (idempotent)
  stmtInsertTicket = db.prepare(
    `INSERT OR IGNORE INTO tickets (${cols}) VALUES (${placeholders})`
  );

  // Get locally-updated tickets since last push watermark
  stmtLocalUpdatedSince = db.prepare(`
    SELECT id, status, claimed_by, claimed_at, updated_at,
           lease_expires_at, retry_count
    FROM tickets
    WHERE updated_at > ?
    ORDER BY updated_at ASC
  `);

  // Get the most recent updated_at in local DB (used to set push watermark at startup)
  stmtMaxUpdatedAt = db.prepare('SELECT MAX(updated_at) as m FROM tickets');
}

// ── PULL: Cloud → Local ───────────────────────────────────────────────
async function pullFromCloud() {
  try {
    // On first run: fetch ALL historical tickets (no watermark filter)
    // On subsequent runs: only fetch tickets created after the last pull watermark
    const query = firstRun
      ? `SELECT ${SHARED_COLS.join(', ')} FROM tickets ORDER BY created_at ASC`
      : `SELECT ${SHARED_COLS.join(', ')} FROM tickets WHERE created_at > $1 ORDER BY created_at ASC`;

    const params = firstRun ? [] : [lastPullAt];
    log(`PULL  checking cloud (since ${firstRun ? 'epoch/all' : lastPullAt})...`);

    const { rows: cloudTickets } = await pool.query(query, params);

    if (cloudTickets.length === 0) {
      if (firstRun) log('PULL  ↓  No new tickets to pull (already fully synced locally)');
      firstRun = false;
      return;
    }

    // Bulk insert in a single transaction (INSERT OR IGNORE = idempotent)
    const insertMany = db.transaction((tickets) => {
      for (const t of tickets) {
        if (t.data && typeof t.data === 'object') t.data = JSON.stringify(t.data);
        for (const tsCol of ['created_at', 'updated_at', 'claimed_at', 'lease_expires_at']) {
          if (t[tsCol] instanceof Date) t[tsCol] = t[tsCol].toISOString();
          else if (t[tsCol] == null) t[tsCol] = null;
        }
        for (const col of SHARED_COLS) { if (t[col] === undefined) t[col] = null; }
        stmtInsertTicket.run(t);
      }
    });

    insertMany(cloudTickets);

    // Advance watermark to newest ticket fetched
    const newest = cloudTickets[cloudTickets.length - 1].created_at;
    if (newest instanceof Date) lastPullAt = newest.toISOString();
    else if (typeof newest === 'string') lastPullAt = newest;

    stats.pulled += cloudTickets.length;
    firstRun = false;

    log(`PULL  ↓  ${cloudTickets.length} ticket(s) → local SQLite  (total pulled: ${stats.pulled})`);
    if (cloudTickets.length <= 10) {
      cloudTickets.forEach(t => log(`       id=${t.id}  type=${t.type}  status=${t.status}`));
    }

  } catch(e) {
    err('PULL failed', e);
    stats.errors++;
  }
}

// ── PUSH: Local → Cloud ───────────────────────────────────────────────
async function pushToCloud() {
  try {
    const updatedLocally = stmtLocalUpdatedSince.all(lastPushAt);
    if (updatedLocally.length === 0) return;

    let pushed = 0;
    for (const row of updatedLocally) {
      try {
        await pool.query(`
          UPDATE tickets SET
            status          = $1,
            claimed_by      = $2,
            claimed_at      = $3,
            updated_at      = $4,
            lease_expires_at= $5,
            retry_count     = $6
          WHERE id = $7
        `, [
          row.status,
          row.claimed_by,
          row.claimed_at,
          row.updated_at,
          row.lease_expires_at,
          row.retry_count,
          row.id
        ]);
        pushed++;
        // Advance watermark to this ticket's updated_at
        if (row.updated_at > lastPushAt) lastPushAt = row.updated_at;
      } catch(e) {
        err(`PUSH failed for ticket ${row.id}`, e);
        stats.errors++;
      }
    }

    if (pushed > 0) {
      stats.pushed += pushed;
      log(`PUSH  ↑  ${pushed} ticket update(s) → Supabase  (total pushed: ${stats.pushed})`);
    }
  } catch(e) {
    err('PUSH cycle failed', e);
    stats.errors++;
  }
}

// ── Status report every 5 minutes ─────────────────────────────────────
function printStatus() {
  log(`─── STATUS  cycles=${stats.cycles}  pulled=${stats.pulled}  pushed=${stats.pushed}  errors=${stats.errors} ───`);
}

// ── Main loop ─────────────────────────────────────────────────────────
async function syncCycle() {
  stats.cycles++;
  await pullFromCloud();
  await pushToCloud();
}

async function main() {
  log('Starting Cloud↔Local Sync Daemon');
  log(`  SQLite : ${SQLITE_PATH}`);
  log(`  Cloud  : ${process.env.SUPABASE_DB_URL?.split('@')[1] || '(set)'}`);
  log(`  Poll   : every ${POLL_INTERVAL / 1000}s`);
  log(`  Scope  : ALL ticket types, ALL agents`);

  // Open SQLite in WAL mode for concurrent access with OpenClaw
  db = new Database(SQLITE_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  prepareStatements();

  // Test cloud connection
  try {
    const r = await pool.query('SELECT COUNT(*) as c FROM tickets');
    log(`Cloud connected — ${r.rows[0].c} tickets in Supabase`);
  } catch(e) {
    err('Cannot connect to Supabase — aborting', e);
    process.exit(1);
  }

  // Set push watermark to current local max updated_at so we don't push all 885 existing rows
  const maxRow = stmtMaxUpdatedAt.get();
  if (maxRow?.m) {
    lastPushAt = maxRow.m;
    log(`Push watermark initialised to local max updated_at: ${lastPushAt}`);
  }

  log('Running first sync cycle (fetches ALL historical + new tickets from Supabase)...');
  await syncCycle();
  log(`Initial sync complete — pulled=${stats.pulled} pushed=${stats.pushed}. Entering poll loop...\n`);

  // Regular poll loop
  setInterval(syncCycle, POLL_INTERVAL);

  // Status every 5 minutes
  setInterval(printStatus, 5 * 60 * 1000);

  // Graceful shutdown
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function shutdown(signal) {
  log(`Received ${signal}. Shutting down...`);
  printStatus();
  if (db) db.close();
  await pool.end();
  process.exit(0);
}

main().catch(e => { err('Fatal startup error', e); process.exit(1); });
