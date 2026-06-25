'use strict';
/**
 * GOOSE MAINTENANCE BRIDGE  v1.0
 * ─────────────────────────────────────────────────────────────────────────
 * Lives locally on Windows, runs under PM2 (autorestart: true).
 * Polls Supabase `maintenance_tickets` every 30 seconds.
 * Picks up OPEN tickets, executes repair actions, posts results back.
 *
 * Actions supported:
 *   pm2_restart   { process_name }
 *   pm2_status    {}
 *   read_log      { log_path, lines }
 *   patch_file    { file_path, search, replace }
 *   run_command   { command }   (allowlisted)
 *
 * ─────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config({ path: 'C:/Users/arvin/.openclaw/.env' });
const { execSync, execFileSync } = require('child_process');
const { readFileSync, writeFileSync } = require('fs');
const { Pool } = require('pg');

const HOST       = 'arvin-main';
const AGENT_ID   = 'goose_maintenance_bridge_v1';
const POLL_MS    = 30_000;
const LOG_PREFIX = '[MaintenanceBridge]';

// ── Safe command allowlist ──────────────────────────────────────────────
const ALLOWED_COMMANDS = [
  /^pm2 (restart|reload|stop|start|list|jlist|flush)/,
  /^node .+\.cjs$/,
  /^node .+\.js$/,
  /^python .+\.py$/,
  /^git .+/
];

function isAllowed(cmd) {
  return ALLOWED_COMMANDS.some(r => r.test(cmd.trim()));
}

// ── query_local_db write allowlist ──────────────────────────────────────
// Maps an SQL verb + table to a canonical "verb:table" key. SELECTs run on any
// table; writes (INSERT/UPDATE/DELETE) only run if the key is in WRITE_ALLOWLIST.
// DDL and PRAGMA/ATTACH are always rejected.
const WRITE_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE']);
const DDL_VERBS = new Set([
  'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'ATTACH', 'DETACH', 'REINDEX', 'VACUUM',
]);
const WRITE_ALLOWLIST = new Set([
  // The watchdog/bridge legitimately append lifecycle + proof rows:
  'INSERT:ticket_events',
  'INSERT:proof_events',
  'INSERT:hive_forwarded',
  'INSERT:ticket_action_dedupe',
  // Ticket lifecycle transitions (status flips, claim/release):
  'UPDATE:tickets',
  // task lifecycle for dispatched background jobs:
  'INSERT:tasks',
  'UPDATE:tasks',
]);

// Parses the LEADING statement of an SQL string into { verb, table, key }.
// Conservative on purpose: if it can't confidently identify a single verb and a
// single table token, it returns verb='UNKNOWN' so the allowlist check fails
// closed. We do NOT support multi-statement input (node:sqlite prepare only
// compiles the first statement anyway), and stacked/semicolon-terminated tails
// are flagged as ambiguous and rejected.
function parseSqlStatement(sql) {
  const stripped = sql.trim().replace(/;+\s*$/, '');
  if (stripped.includes(';')) {
    // Refuse anything that looks like stacked statements.
    return { verb: 'UNKNOWN', table: null, key: 'UNKNOWN:null' };
  }
  const tokens = stripped.split(/\s+/);
  const verb = (tokens[0] || '').toUpperCase();

  if (DDL_VERBS.has(verb) || verb === 'PRAGMA') {
    return { verb: 'DDL', table: null, key: 'DDL:null' };
  }
  if (verb === 'SELECT') {
    return { verb: 'SELECT', table: null, key: 'SELECT:null' };
  }
  if (WRITE_VERBS.has(verb)) {
    // "INSERT INTO t ...", "UPDATE t ...", "DELETE FROM t ..."
    let tableIdx = 1;
    const secondWord = (tokens[1] || '').toUpperCase();
    if ((verb === 'INSERT' && secondWord === 'INTO') || (verb === 'DELETE' && secondWord === 'FROM')) {
      tableIdx = 2;
    }
    const tableRaw = (tokens[tableIdx] || '').replace(/[`"\[\]]/g, '');
    if (!tableRaw) return { verb, table: null, key: `${verb}:null` };
    return { verb, table: tableRaw, key: `${verb}:${tableRaw}` };
  }
  return { verb: 'UNKNOWN', table: null, key: 'UNKNOWN:null' };
}

const pool = new Pool({
  connectionString: process.env.SUPABASE_DB_URL,
  connectionTimeoutMillis: 15000,
  statement_timeout: 15000,
});

function log(msg)  { console.log(`${LOG_PREFIX} ${new Date().toISOString()} ${msg}`); }
function warn(msg) { console.warn(`${LOG_PREFIX} ⚠️  ${msg}`); }

// ── Repair action handlers ──────────────────────────────────────────────
const handlers = {

  pm2_restart({ process_name }) {
    if (!process_name) throw new Error('process_name is required');
    const out = execSync(`pm2 restart ${process_name}`, { timeout: 30000, windowsHide: true }).toString();
    return `✅ Restarted ${process_name}\n${out.trim()}`;
  },

  pm2_status() {
    const raw = execSync('pm2 jlist', { timeout: 15000, windowsHide: true }).toString();
    const list = JSON.parse(raw);
    const summary = list.map(p =>
      `${p.name}: ${p.pm2_env?.status} | restarts=${p.pm2_env?.restart_time}`
    ).join('\n');
    return summary;
  },

  read_log({ log_path, lines = 50 }) {
    if (!log_path) throw new Error('log_path is required');
    const content = readFileSync(log_path, 'utf8');
    const allLines = content.trim().split('\n');
    const last = allLines.slice(-Number(lines));
    return last.join('\n');
  },

  patch_file({ file_path, search, replace }) {
    if (!file_path || search === undefined || replace === undefined) {
      throw new Error('file_path, search, and replace are required');
    }
    const original = readFileSync(file_path, 'utf8');
    if (!original.includes(search)) {
      return `⚠️ Search string not found in ${file_path}. No changes made.`;
    }
    const patched = original.split(search).join(replace);
    writeFileSync(file_path, patched, 'utf8');
    const changeCount = original.split(search).length - 1;
    return `✅ Patched ${changeCount} occurrence(s) in ${file_path}`;
  },

  run_command({ command }) {
    if (!isAllowed(command)) {
      throw new Error(`Command not in allowlist: ${command}`);
    }
    const out = execSync(command, { timeout: 30000, windowsHide: true }).toString();
    return out.trim() || '(no output)';
  },

  // query_local_db — local blackboard access for the watchdog.
  //
  // Security model:
  //   This handler used to run ANY sql the caller supplied (arbitrary DDL/DML),
  //   gated only by the same DB-write precondition as the kill switch. It now
  //   enforces two layers:
  //     1. READ-only by default: any SELECT (any table) runs fine — inspection
  //        is the common, low-risk case.
  //     2. WRITES only via a curated allowlist of (verb, table) pairs the
  //        watchdog legitimately performs. Anything else is rejected. DDL
  //        (CREATE/DROP/ALTER/ATTACH/PRAGMA) is always rejected.
  //   The allowlist covers the tables that actually exist in swarm_blackboard.db
  //   (tickets, ticket_events, proof_events, tasks, hive_forwarded,
  //    ticket_action_dedupe). The tickets_fts* shadow tables and
  //    sqlite_sequence are intentionally NOT writable through this handler.
  query_local_db({ sql_query, params = [] }) {
    if (!sql_query) throw new Error('sql_query is required');
    const raw = String(sql_query);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('C:/Users/arvin/.openclaw/swarm_blackboard.db');

    try {
      const parsed = parseSqlStatement(raw);
      if (parsed.verb === 'SELECT') {
        const stmt = db.prepare(raw);
        return JSON.stringify(stmt.all(...params), null, 2);
      }
      if (WRITE_ALLOWLIST.has(parsed.key)) {
        const stmt = db.prepare(raw);
        const info = stmt.run(...params);
        return JSON.stringify(info, null, 2);
      }
      throw new Error(
        `query_local_db write not allowed: ${parsed.verb} on ${parsed.table} is not in the allowlist`,
      );
    } finally {
      db.close();
    }
  },

  async diagnose_and_heal({ process_name, error_log_path, instruction }) {
    return `⚠️ diagnose_and_heal has been disabled due to arbitrary file write risks.`;
  },

  forward_ticket({ ticket_type, data }) {
    if (!ticket_type || !data) throw new Error('ticket_type and data are required');
    const tmpId = Date.now();
    const tmpScriptFile = `C:/AG-Custom-Swarm/hive_mind/tmp_forward_${tmpId}.py`;
    const tmpDataFile = `C:/AG-Custom-Swarm/hive_mind/tmp_data_${tmpId}.json`;
    
    require('fs').writeFileSync(tmpDataFile, JSON.stringify(data), 'utf8');
    
    const script = `
import sys
import json
sys.path.append(r"C:\\AG-Custom-Swarm\\hive_mind")
from telemetry_logger import hive_forward
try:
    with open(r"${tmpDataFile}", "r", encoding="utf-8") as f:
        payload = json.load(f)
    tid = hive_forward("goose_maintenance_bridge", "${ticket_type}", payload)
    print("SUCCESS: " + str(tid))
except Exception as e:
    print(f"Error: {e}")
    sys.exit(1)
`;
    require('fs').writeFileSync(tmpScriptFile, script, 'utf8');
    const out = require('child_process').execSync(`"C:\\2. PYTHON A\\python.exe" "${tmpScriptFile}"`, { timeout: 15000, windowsHide: true }).toString();
    require('fs').unlinkSync(tmpScriptFile);
    require('fs').unlinkSync(tmpDataFile);
    return `✅ Forwarded ticket: ${out.trim()}`;
  },
};

// ── Claim + execute ticket ───────────────────────────────────────────────
async function processTicket(client, ticket) {
  const { id, action, payload } = ticket;
  log(`Claiming ticket ${id} [action=${action}]`);

  // Claim
  await client.query(
    `UPDATE maintenance_tickets
     SET status='CLAIMED', claimed_by=$1, claimed_at=NOW(), updated_at=NOW()
     WHERE id=$2`,
    [AGENT_ID, id]
  );

  let result;
  try {
    const handler = handlers[action];
    if (!handler) throw new Error(`Unknown action: ${action}`);
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    result = await handler(parsed);
    log(`✅ Ticket ${id} completed: ${String(result).substring(0, 100)}`);

    await client.query(
      `UPDATE maintenance_tickets
       SET status='DONE', result=$1, updated_at=NOW()
       WHERE id=$2`,
      [String(result).substring(0, 2000), id]
    );
  } catch(e) {
    warn(`Ticket ${id} FAILED: ${e.message}`);
    await client.query(
      `UPDATE maintenance_tickets
       SET status='FAILED', result=$1, updated_at=NOW()
       WHERE id=$2`,
      [`❌ ${e.message}`, id]
    );
  }
}

// ── Poll loop ───────────────────────────────────────────────────────────
async function poll() {
  let client;
  try {
    client = await pool.connect();
    const { rows } = await client.query(
      `SELECT id, action, payload FROM maintenance_tickets
       WHERE status='OPEN' AND (host=$1 OR host IS NULL)
       ORDER BY created_at ASC
       LIMIT 5`,
      [HOST]
    );

    if (rows.length > 0) {
      log(`Found ${rows.length} OPEN maintenance ticket(s).`);
      for (const ticket of rows) {
        await processTicket(client, ticket);
      }
    }
  } catch(e) {
    warn(`Poll error: ${e.message}`);
  } finally {
    if (client) client.release();
  }
}

async function main() {
  log('Goose Maintenance Bridge started.');
  log(`  Host:     ${HOST}`);
  log(`  Agent ID: ${AGENT_ID}`);
  log(`  Poll:     every ${POLL_MS / 1000}s`);
  log(`  Actions:  ${Object.keys(handlers).join(', ')}`);

  // Test connection
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    log('✅ Supabase connection verified.');
  } catch(e) {
    console.error(`${LOG_PREFIX} ❌ Cannot connect to Supabase:`, e.message);
    process.exit(1);
  }

  // Run immediately, then on interval
  await poll();
  setInterval(poll, POLL_MS);

  process.on('SIGINT',  () => { log('Shutting down.'); pool.end(); process.exit(0); });
  process.on('SIGTERM', () => { log('Shutting down.'); pool.end(); process.exit(0); });
}

main().catch(e => {
  console.error(`${LOG_PREFIX} ❌ Fatal:`, e.message);
  process.exit(1);
});
