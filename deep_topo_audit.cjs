const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');

const db_path = 'C:/Users/arvin/.openclaw/swarm_blackboard.db';
const config_path = 'C:/Users/arvin/.openclaw/agents.json';

console.log("=== SQLITE SCHEMA ===");
const db = new DatabaseSync(db_path);
const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table'").all();
for (const t of tables) {
    console.log(`-- Table: ${t.name}`);
    console.log(t.sql);
    console.log("");
}

console.log("=== NODE TOPOLOGY MAP ===");
const config = JSON.parse(fs.readFileSync(config_path, 'utf8'));

for (const agent of config.list || []) {
    const agent_id = agent.id;
    const runtime = agent.params?.agentOsCapability?.runtime || 'unknown';
    const ticket_types = agent.params?.ticketTypes || [];
    console.log(`Node: ${agent_id}`);
    console.log(`  Runtime: ${runtime}`);
    console.log(`  Listens for: ${ticket_types.join(', ')}`);
}
