const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');

const db = new DatabaseSync('C:/Users/arvin/.openclaw/swarm_blackboard.db');
const agentsConfig = JSON.parse(fs.readFileSync('C:/Users/arvin/.openclaw/agents.json', 'utf8'));

console.log("=== AGENT CONFIGURATION & CAPABILITIES ===");
const ticketToAgents = {};
for (const agent of agentsConfig.list) {
  const types = agent.params?.ticketTypes || [];
  for (const t of types) {
    if (!ticketToAgents[t]) ticketToAgents[t] = [];
    ticketToAgents[t].push(agent.id);
  }
}

const collisions = Object.entries(ticketToAgents).filter(([_, agents]) => agents.length > 1);
console.log("\n[!] TICKET COLLISIONS (Multiple agents accept these):");
for (const [type, agents] of collisions) {
  console.log(`  - ${type}: ${agents.join(', ')}`);
}

console.log("\n=== REAL USE (DATABASE ACTIVITY) ===");
const stats = db.prepare(`
  SELECT 
    target_agent,
    claimed_by,
    type,
    status,
    COUNT(*) as count 
  FROM tickets 
  GROUP BY target_agent, claimed_by, type, status
  ORDER BY count DESC
`).all();

const summary = {};
let totalTickets = 0;

for (const row of stats) {
  totalTickets += row.count;
  const owner = row.claimed_by || row.target_agent || 'UNCLAIMED';
  if (!summary[owner]) summary[owner] = { types: {}, status: {}, total: 0 };
  
  summary[owner].total += row.count;
  summary[owner].types[row.type] = (summary[owner].types[row.type] || 0) + row.count;
  summary[owner].status[row.status] = (summary[owner].status[row.status] || 0) + row.count;
}

console.log(`\nTotal Tickets Processed/In-Queue: ${totalTickets}\n`);

for (const [owner, data] of Object.entries(summary)) {
  console.log(`Agent: ${owner} (Total: ${data.total})`);
  console.log(`  Status: ${JSON.stringify(data.status)}`);
  console.log(`  Types : ${JSON.stringify(data.types)}`);
  console.log('');
}
