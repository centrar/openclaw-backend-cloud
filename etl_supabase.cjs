require('dotenv').config({ path: 'C:/Users/arvin/.openclaw/.env' });
const { DatabaseSync } = require('node:sqlite');
const { Client } = require('pg');

async function etl() {
  const sqliteDb = new DatabaseSync('C:/Users/arvin/.openclaw/swarm_blackboard.db');
  
  const client = new Client({
    connectionString: process.env.SUPABASE_DB_URL,
  });

  try {
    await client.connect();
    console.log('Connected to Postgres.');

    const tickets = sqliteDb.prepare('SELECT * FROM tickets').all();
    console.log(`Extracting ${tickets.length} tickets from local SQLite...`);

    let count = 0;
    for (const t of tickets) {
      await client.query(
        `INSERT INTO tickets (id, type, priority, target_agent, status, data, created_at, updated_at, claimed_by, claimed_at, lease_expires_at, ttl_minutes, correlation_id, source_system, source_issue_key, idempotency_key, agent_origin_tag, retry_count, max_retries, error_log)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
         ON CONFLICT (id) DO NOTHING`,
        [
          t.id, t.type, t.priority, t.target_agent, t.status, t.data, t.created_at, t.updated_at,
          t.claimed_by, t.claimed_at, t.lease_expires_at, t.ttl_minutes, t.correlation_id, t.source_system,
          t.source_issue_key, t.idempotency_key, t.agent_origin_tag, t.retry_count, t.max_retries, t.error_log
        ]
      );
      count++;
    }
    console.log(`Successfully migrated ${count} tickets to Supabase!`);
    
  } catch (err) {
    console.error('ETL failed:', err);
  } finally {
    await client.end();
  }
}

etl();
