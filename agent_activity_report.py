import sqlite3
import json

conn = sqlite3.connect('C:/Users/arvin/.openclaw/swarm_blackboard.db')
c = conn.cursor()

c.execute("""
  SELECT target_agent, type, status, updated_at 
  FROM tickets 
  WHERE target_agent IN ('novel_factory_cli', 'developer_agency', 'campaign_manager', 'image_analyzer', 'security_bouncer_agent', 'browser_ops_agent', 'uba_god_mode')
  ORDER BY updated_at DESC
""")

rows = c.fetchall()
result = []
for row in rows:
    result.append({
        "agent": row[0],
        "type": row[1],
        "status": row[2],
        "last_active": row[3]
    })

print(json.dumps(result, indent=2))
