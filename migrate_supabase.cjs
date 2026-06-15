require('dotenv').config({ path: 'C:/Users/arvin/.openclaw/.env' });
const { Client } = require('pg');

async function migrate() {
  const client = new Client({
    connectionString: process.env.SUPABASE_DB_URL,
  });

  try {
    await client.connect();
    console.log('Connected to Supabase Postgres!');

    const ddl = `
      CREATE TABLE IF NOT EXISTS tickets (
          id               TEXT PRIMARY KEY,
          type             TEXT NOT NULL,
          priority         INTEGER DEFAULT 0,
          target_agent     TEXT,
          status           TEXT DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLAIMED','IN_PROGRESS','WAITING_APPROVAL','BLOCKED','DONE','FAILED','ARCHIVED')),
          data             TEXT,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL,
          claimed_by       TEXT,
          claimed_at       TEXT,
          lease_expires_at TEXT,
          ttl_minutes      INTEGER,
          correlation_id   TEXT,
          source_system    TEXT,
          source_issue_key TEXT,
          idempotency_key  TEXT,
          agent_origin_tag TEXT,
          retry_count      INTEGER DEFAULT 0,
          max_retries      INTEGER DEFAULT 0,
          error_log        TEXT
      );

      CREATE TABLE IF NOT EXISTS proof_events (
          id           TEXT PRIMARY KEY,
          ticket_id    TEXT NOT NULL,
          event_type   TEXT NOT NULL,
          agent_id     TEXT NOT NULL,
          payload      TEXT,
          created_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ticket_events (
          id         SERIAL PRIMARY KEY,
          ticket_id  TEXT NOT NULL,
          event_type TEXT NOT NULL,
          agent_id   TEXT,
          old_value  TEXT,
          new_value  TEXT,
          timestamp  TEXT NOT NULL
      );
    `;

    console.log('Running DDL migrations...');
    await client.query(ddl);
    console.log('Tables created successfully!');
    
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await client.end();
  }
}

migrate();
