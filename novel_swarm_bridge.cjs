const fs = require('fs');
const Database = require('better-sqlite3');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('../ag_paths.cjs');

const NOVEL_FACTORY_DIR = paths.NOVEL_FACTORY_CLI_DIR;
const STATUS_FILE = path.join(NOVEL_FACTORY_DIR, 'NOVEL_FACTORY_STATUS.md');
const DB_PATH = paths.BLACKBOARD_DB;
const NOVEL_FACTORY_SCRIPT = path.join(NOVEL_FACTORY_DIR, 'novel-factory-orchestrator.js');

// Logger
const log = (msg) => console.log(`[${new Date().toISOString()}] [SWARM-BRIDGE] ${msg}`);

let isProcessingTicket = false;

function parseStatusFile() {
  if (!fs.existsSync(STATUS_FILE)) return null;
  const content = fs.readFileSync(STATUS_FILE, 'utf8');

  const status = {
    novel: (content.match(/Current Novel:\s*(.*)/i) || [])[1]?.replace(/\*/g, '').trim() || 'Unknown',
    status: (content.match(/Status\*?\*?:\s*(.*)/i) || [])[1]?.replace(/\*/g, '').trim() || 'IDLE',
    phase: (content.match(/Phase\*?\*?:\s*(.*)/i) || [])[1]?.replace(/\*/g, '').trim() || 'NONE',
    wordCount: parseInt((content.match(/Current Word Count\*?\*?:\s*(\d+)/i) || [])[1] || '0')
  };
  return status;
}

function processOpenTickets(db) {
  if (isProcessingTicket) return;

  const openTicket = db.prepare(`
    SELECT id, status FROM tickets 
    WHERE target_agent = 'novel_factory_cli' 
    AND status = 'OPEN'
    ORDER BY priority DESC, created_at ASC LIMIT 1
  `).get();

  if (openTicket) {
    log(`Found OPEN ticket ${openTicket.id}. Dispatching to Novel Factory...`);
    isProcessingTicket = true;

    const child = spawn('node', [NOVEL_FACTORY_SCRIPT, 'process-ticket', openTicket.id], {
      cwd: NOVEL_FACTORY_DIR,
      stdio: 'inherit'
    });

    child.on('error', (err) => {
      log(`Failed to spawn Novel Factory: ${err.message}`);
      isProcessingTicket = false;
    });

    child.on('close', (code) => {
      log(`Novel Factory finished ticket ${openTicket.id} with code ${code}`);
      isProcessingTicket = false;
    });
  }
}

function syncToSwarm() {
  let db;
  try {
    const status = parseStatusFile();
    db = new Database(DB_PATH);

    // Auto-recovery: If status is STALLED or old, and we aren't actively processing a ticket
    if (status && (status.status === 'STALLED' || status.status === 'IN_PROGRESS' || status.status === 'WORKING' || status.status === 'Generation') && !isProcessingTicket) {
      const stats = fs.statSync(STATUS_FILE);
      const hoursSinceUpdate = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60);
      
      // If it's been stuck for over 2 hours or is explicitly STALLED, auto-recover
      if (hoursSinceUpdate > 2 || status.status === 'STALLED') {
        log(`Detected stuck/stalled pipeline (Age: ${hoursSinceUpdate.toFixed(1)}h). Auto-recovering factory to IDLE.`);
        
        // Mark the active ticket as DONE so it doesn't block
        const activeTicket = db.prepare(`SELECT id FROM tickets WHERE target_agent = 'novel_factory_cli' AND status IN ('OPEN', 'CLAIMED', 'IN_PROGRESS', 'BLOCKED', 'STALLED') ORDER BY updated_at DESC LIMIT 1`).get();
        if (activeTicket) {
          db.prepare(`UPDATE tickets SET status = 'DONE', updated_at = datetime('now') WHERE id = ?`).run(activeTicket.id);
          log(`Auto-closed stuck ticket ${activeTicket.id}`);
        }
        
        // Overwrite the status file to clear the stall
        fs.writeFileSync(STATUS_FILE, `# Novel Factory Status\n\n- **Status:** IDLE\n- **Phase:** NONE\n- Auto-recovered by Swarm Bridge.\n`);
        status.status = 'IDLE';
      }
    }
    
    // First, process any open tickets if we are idle
    if (status && (status.status === 'IDLE' || status.status === 'COMPLETE' || status.status === 'FAILED' || status.status === 'DONE')) {
      processOpenTickets(db);
    } else if (!status) {
      processOpenTickets(db); // Process if no status file at all (fresh start)
    }
    
    if (!status) {
      db.close();
      return;
    }
    
    // Check for an active ticket for novel_factory_cli
    const activeTicket = db.prepare(`
      SELECT id, status, data FROM tickets 
      WHERE target_agent = 'novel_factory_cli' 
      AND status IN ('OPEN', 'CLAIMED', 'IN_PROGRESS', 'BLOCKED', 'STALLED')
      ORDER BY updated_at DESC LIMIT 1
    `).get();

    let ticketId;

    if (!activeTicket) {
      // No active ticket found. If the factory is actively working, we create a recovery ticket.
      if (status.status !== 'IDLE' && status.status !== 'COMPLETE' && status.status !== 'DONE') {
        ticketId = `T-nvr-${Math.random().toString(36).substring(2, 10)}`;
        log(`No active ticket found but pipeline is ${status.status}. Generating tracking ticket: ${ticketId}`);
        
        const dataJson = JSON.stringify({
          instruction: `Auto-generated recovery ticket to track standalone daemon pipeline for ${status.novel}`,
          phase: status.phase,
          wordCount: status.wordCount,
          internal_status: status.status
        });

        db.prepare(`
          INSERT INTO tickets (id, type, priority, target_agent, status, data, created_at, updated_at)
          VALUES (?, 'novel_pipeline', 10, 'novel_factory_cli', 'IN_PROGRESS', ?, datetime('now'), datetime('now'))
        `).run(ticketId, dataJson);
      }
    } else {
      ticketId = activeTicket.id;
      // Update the existing ticket with the latest progress
      let data = {};
      try { data = JSON.parse(activeTicket.data || '{}'); } catch(e){}
      
      let newStatus = activeTicket.status;
      if (status.status === 'STALLED') newStatus = 'STALLED';
      else if (status.status === 'COMPLETE' || status.status === 'DONE') newStatus = 'DONE';
      else if (activeTicket.status === 'CLAIMED' || activeTicket.status === 'OPEN') newStatus = 'IN_PROGRESS';
      
      // Only update if something changed
      if (data.phase !== status.phase || data.wordCount !== status.wordCount || activeTicket.status !== newStatus) {
        data.phase = status.phase;
        data.wordCount = status.wordCount;
        data.internal_status = status.status;
        data.novel = status.novel;

        db.prepare(`
          UPDATE tickets 
          SET status = ?, data = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(newStatus, JSON.stringify(data), ticketId);
        
        log(`Updated ticket ${ticketId} | Novel: ${status.novel} | Phase: ${status.phase} | Words: ${status.wordCount}`);
      }
    }
    
    db.close();
  } catch (error) {
    if(db) db.close();
    log(`Error syncing to swarm: ${error.message}`);
  }
}

log('Starting Hybrid Swarm Bridge for Novel Factory...');
syncToSwarm(); // Run immediately
setInterval(syncToSwarm, 10000); // Check every 10 seconds
