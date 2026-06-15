import sqlite3
import json
import os

db_path = 'C:/Users/arvin/.openclaw/swarm_blackboard.db'
config_path = 'C:/Users/arvin/.openclaw/agents.json'

print("=== SQLITE SCHEMA ===")
conn = sqlite3.connect(db_path)
c = conn.cursor()
c.execute("SELECT name, sql FROM sqlite_master WHERE type='table'")
tables = c.fetchall()
for t in tables:
    print(f"-- Table: {t[0]}")
    print(t[1])
    print("")

print("=== NODE TOPOLOGY MAP ===")
with open(config_path, 'r', encoding='utf-8') as f:
    config = json.load(f)

for agent in config.get('list', []):
    agent_id = agent.get('id')
    runtime = agent.get('params', {}).get('agentOsCapability', {}).get('runtime', 'unknown')
    ticket_types = agent.get('params', {}).get('ticketTypes', [])
    print(f"Node: {agent_id}")
    print(f"  Runtime: {runtime}")
    print(f"  Listens for: {', '.join(ticket_types)}")
