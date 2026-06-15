const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/arvin/.openclaw/swarm_blackboard.db');

const tickets = db.prepare("SELECT * FROM tickets WHERE target_agent LIKE '%novel%' OR claimed_by LIKE '%novel%'").all();
console.log('--- TICKETS ---');
console.log(JSON.stringify(tickets, null, 2));

for (const t of tickets) {
  const events = db.prepare("SELECT * FROM proof_events WHERE ticket_id = ?").all(t.id);
  console.log(`\n--- PROOF EVENTS FOR ${t.id} ---`);
  console.log(JSON.stringify(events, null, 2));
}
