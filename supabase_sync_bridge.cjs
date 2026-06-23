require('dotenv').config({ path: 'C:/Users/arvin/.openclaw/.env' });
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
supabase
  .channel('public:quarantine_log')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'quarantine_log' }, payload => {
    console.log('🚨 Received Cloud Quarantine Order:', payload.new);
    const pm2 = require('pm2');
    pm2.connect((err) => {
        if (!err) {
            pm2.stop(payload.new.agent, () => {
                console.log(`🔪 Executed Cloud Kill Order on ${payload.new.agent}`);
                pm2.disconnect();
            });
        }
    });
  })
  .subscribe();

console.log("✅ Supabase Sync Active. Listening for Cloud Orders...");
