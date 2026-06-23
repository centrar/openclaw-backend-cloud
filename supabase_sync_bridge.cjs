require('dotenv').config({ path: 'C:/Users/arvin/.openclaw/.env' });
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const Database = require('better-sqlite3');
const path = require('path');
const chokidar = require('chokidar');

const OPENCLAW_DIR = 'C:/Users/arvin/.openclaw';
const dbPath = path.join(OPENCLAW_DIR, 'swarm_topology.sqlite');
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

// Subscribe to Cloud Quarantine Orders (Remote Kill Switch)
//
// Security: an insert into quarantine_log is NOT trusted merely because it
// exists. The bridge recomputes an HMAC-SHA256 over the canonical
// (agent, reason, issued_at, nonce) string using KILL_ORDER_HMAC_SECRET and
// compares with a constant-time check. Only if the signature is valid (and the
// order isn't stale/replayed) does pm2.stop run.
const KILL_ORDER_HMAC_SECRET = process.env.KILL_ORDER_HMAC_SECRET;
const KILL_ORDER_MAX_AGE_MS = Number(process.env.KILL_ORDER_MAX_AGE_MS || 5 * 60 * 1000); // 5 min
const seenNonces = new Set(); // simple replay guard (bounded by max-age)

function verifyKillOrder(row) {
    if (!KILL_ORDER_HMAC_SECRET) {
        console.error('❌ KILL_ORDER_HMAC_SECRET not set on bridge — refusing ALL kill orders.');
        return { ok: false, reason: 'bridge misconfigured (no secret)' };
    }
    const { agent, reason, issued_at, nonce, signature } = row;
    if (!agent || reason === undefined || issued_at === undefined || !nonce || !signature) {
        return { ok: false, reason: 'missing signature fields' };
    }
    // Replay guard: reject orders we've already honored.
    if (seenNonces.has(nonce)) {
        return { ok: false, reason: `replayed nonce ${nonce}` };
    }
    // Freshness: reject orders older than the window (defends against capture/replay).
    const age = Date.now() - Number(issued_at);
    if (!Number.isFinite(age) || age < 0 || age > KILL_ORDER_MAX_AGE_MS) {
        return { ok: false, reason: `stale/future order (age=${age}ms)` };
    }
    // Constant-time signature comparison.
    const canonical = [agent, reason, String(issued_at), nonce].join('\n');
    const expected = crypto.createHmac('sha256', KILL_ORDER_HMAC_SECRET).update(canonical, 'utf8').digest('hex');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        return { ok: false, reason: 'bad signature' };
    }
    seenNonces.add(nonce);
    // Keep the nonce set bounded (drop entries older than the max-age window).
    if (seenNonces.size > 1024) seenNonces.clear();
    return { ok: true };
}

supabase
  .channel('public:quarantine_log')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'quarantine_log' }, payload => {
    console.log('🚨 Received Cloud Quarantine Order:', payload.new);

    const verdict = verifyKillOrder(payload.new);
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
