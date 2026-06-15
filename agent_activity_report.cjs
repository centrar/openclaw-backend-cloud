const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/arvin/.openclaw/swarm_blackboard.db');

const rows = db.prepare(`
  SELECT target_agent, type, status, updated_at 
  FROM tickets 
  WHERE target_agent IN ('novel_factory_cli', 'developer_agency', 'campaign_manager', 'image_analyzer', 'security_bouncer_agent', 'browser_ops_agent', 'uba_god_mode')
  ORDER BY updated_at DESC
`).all();

console.log(JSON.stringify(rows, null, 2));
