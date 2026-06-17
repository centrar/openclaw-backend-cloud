'use strict';
require('dotenv').config({ path: 'C:/Users/arvin/.openclaw/.env' });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.SUPABASE_DB_URL,
  connectionTimeoutMillis: 15000,
});

const DDL = [
  {
    name: 'pm2_telemetry',
    sql: [
      `CREATE TABLE IF NOT EXISTS pm2_telemetry (
        id           SERIAL PRIMARY KEY,
        captured_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        host         TEXT NOT NULL DEFAULT 'arvin-main',
        processes    JSONB NOT NULL,
        error_digest JSONB
      )`,
    ]
  },
  {
    name: 'maintenance_tickets',
    sql: [
      `CREATE TABLE IF NOT EXISTS maintenance_tickets (
        id           TEXT PRIMARY KEY,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status       TEXT NOT NULL DEFAULT 'OPEN',
        action       TEXT NOT NULL,
        payload      JSONB NOT NULL,
        result       TEXT,
        claimed_at   TIMESTAMPTZ,
        claimed_by   TEXT,
        host         TEXT DEFAULT 'arvin-main'
      )`,
      `CREATE INDEX IF NOT EXISTS idx_maint_status ON maintenance_tickets(status, created_at)`,
    ]
  }
];

async function main() {
  const client = await pool.connect();
  try {
    for (const table of DDL) {
      for (const stmt of table.sql) {
        await client.query(stmt);
      }
      console.log('OK:', table.name);
    }
    console.log('All tables ready.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
