const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/arvin/.openclaw/swarm_blackboard.db');

const collision = db.prepare("SELECT type, count(*) as c, GROUP_CONCAT(DISTINCT claimed_by) as agents FROM tickets WHERE type IN ('browser_task','web_automation','ui_qa') GROUP BY type").all();
console.log('=== COLLISION TYPES ===');
console.log(JSON.stringify(collision, null, 2));

const open = db.prepare("SELECT id, type, status, claimed_by, target_agent FROM tickets WHERE type IN ('browser_task','web_automation','ui_qa','browser_ops','browser_grounding') ORDER BY created_at DESC LIMIT 10").all();
console.log('=== RECENT TICKETS ===');
console.log(JSON.stringify(open, null, 2));
