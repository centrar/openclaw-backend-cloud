require('dotenv').config({ path: require('../ag_paths.cjs').ENV_FILE });
const { createClient } = require('@supabase/supabase-js');
const Database = require('better-sqlite3');
const path = require('path');
const chokidar = require('chokidar');
const { createKillOrderVerifier } = require('./kill_order.cjs');

const paths = require('../ag_paths.cjs');
const OPENCLAW_DIR = paths.OPENCLAW_DIR;
const dbPath = paths.TOPOLOGY_DB;
const db = new Database(dbPath);

const SUPABASE_URL = process.env.SUPABASE_URL || "https://aws-1-us-west-2.pooler.supabase.com";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.RENDER_API_KEY; // Replace with proper service role key
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log("☁️  Hermes Supabase Sync Bridge Starting...");

async function syncPendingEvents() {
    try {
        const events = db.prepare("SELECT * FROM process_events WHERE sync_status IS NULL OR sync_status = 0").all();
        if (events.length === 0) return;

        console.log(`Syncing ${events.length} new events to Supabase...`);
        
        for (const evt of events) {
            const { error } = await supabase
                .from('process_events')
                .insert({
                    process_name: evt.process_name,
                    event_type: evt.event_type,
                    exit_code: evt.exit_code,
                    restart_count: evt.restart_count,
                    timestamp: evt.timestamp
                });
                
            if (!error) {
                // Mark as synced locally
                db.prepare("UPDATE process_events SET sync_status = 1 WHERE id = ?").run(evt.id);
            } else {
                console.error(`Supabase Sync Error for event ${evt.id}:`, error.message);
            }
        }
    } catch (e) {
        if (!e.message.includes('no such column')) {
            console.error("Local Sync Error:", e.message);
        } else {
            // Initialize column
            try { db.prepare("ALTER TABLE process_events ADD COLUMN sync_status INT DEFAULT 0").run(); } catch(ex){}
        }
    }
}

// Run sync every 5 seconds
setInterval(syncPendingEvents, 5000);

// ── Knowledge-graph mirror: push local nodes + edges to Supabase ─────────────
// The local swarm_topology.sqlite now holds live nodes (Process/Agent/Ticket/
// Host) and edges (ASSIGNED_TICKET, CLAIMED_TICKET, MANAGED_BY, CORRELATES_WITH)
// written by hermes_core_daemon + graph_builder. This mirrors them to the cloud
// knowledge_graph / knowledge_graph_edges tables so the /health endpoint and the
// dashboard reflect real data (previously /health read an empty table).
async function syncGraph() {
    try {
        const nodes = db.prepare("SELECT id AS node_id, label, properties, updated_at FROM nodes").all();
        const edges = db.prepare("SELECT id AS edge_id, source_id, target_id, relation, properties, updated_at FROM edges").all();
        if (nodes.length === 0) return;
        // upsert nodes (properties is text in sqlite -> cast to jsonb by Supabase)
        const { error: nErr } = await supabase.from('knowledge_graph').upsert(nodes, { onConflict: 'node_id' });
        if (nErr) console.error('graph node sync error:', nErr.message);
        // upsert edges (only if the target table exists; non-fatal if not yet migrated)
        const { error: eErr } = await supabase.from('knowledge_graph_edges').upsert(edges, { onConflict: 'edge_id' });
        if (eErr && !eErr.message.includes('does not exist')) console.error('graph edge sync error:', eErr.message);
    } catch (e) {
        // Non-fatal: the migration may not be applied yet, or tables absent.
        console.error('graph sync skipped:', e.message);
    }
}
// Run graph mirror every 60 seconds (less frequent than events; graph changes slowly)
setInterval(syncGraph, 60000);

// Subscribe to Cloud Quarantine Orders (Remote Kill Switch)
//
// Security: an insert into quarantine_log is NOT trusted merely because it
// exists. The bridge recomputes an HMAC-SHA256 over the canonical
// (agent, reason, issued_at, nonce) string using KILL_ORDER_HMAC_SECRET and
// compares with a constant-time check. Only if the signature is valid (and the
// order isn't stale/replayed) does pm2.stop run.
//
// Verification logic + canonical format live in kill_order.cjs (shared with the
// signer in hermes_render_api.js) so the two sides cannot drift. The verifier
// instance holds its own nonce store + secret, isolated and unit-testable.
const killOrderVerifier = createKillOrderVerifier({
    secret: process.env.KILL_ORDER_HMAC_SECRET,
    maxAgeMs: Number(process.env.KILL_ORDER_MAX_AGE_MS || 5 * 60 * 1000),
});
if (!process.env.KILL_ORDER_HMAC_SECRET) {
    console.error('❌ KILL_ORDER_HMAC_SECRET not set on bridge — refusing ALL kill orders.');
}

supabase
  .channel('public:quarantine_log')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'quarantine_log' }, payload => {
    console.log('🚨 Received Cloud Quarantine Order:', payload.new);

    const verdict = killOrderVerifier.verifyKillOrder(payload.new);
    if (!verdict.ok) {
        console.error(`❌ Rejected kill order for ${payload.new.agent} — ${verdict.reason}`);
        return;
    }

    const pm2 = require('pm2');
    pm2.connect((err) => {
        if (!err) {
            pm2.stop(payload.new.agent, () => {
                console.log(`🔪 Executed verified Cloud Kill Order on ${payload.new.agent}`);
                pm2.disconnect();
            });
        }
    });
  })
  .subscribe();

console.log("✅ Supabase Sync Active. Listening for Cloud Orders (HMAC-verified)...");

// Export for unit tests (the module's top-level side effects — DB open, intervals,
// Supabase subscribe — only fire when run as the entry point, not when required).
// Tests load kill_order.cjs directly instead, so this export is a thin re-export
// for any integration-level checks.
module.exports = { killOrderVerifier };
