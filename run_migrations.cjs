'use strict';
/**
 * run_migrations.cjs
 * ==================
 * Turnkey Supabase migration runner. Connects via SUPABASE_DB_URL and applies
 * every *.sql file in supabase/migrations/ in filename order. Idempotent
 * (every migration is written to be re-runnable; we also track applied
 * migrations in a `_migrations` table so re-running skips already-applied ones).
 *
 * Run: node run_migrations.cjs
 *   (loads .env via ag_paths; uses SUPABASE_DB_URL)
 *
 * Why this exists: applying migrations via the Supabase dashboard is a manual
 * step that's easy to forget — the telemetry/graph enrichment code degrades
 * silently until run. This script makes it a one-command op.
 */

require('dotenv').config({ path: require('../ag_paths.cjs').ENV_FILE });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, 'supabase', 'migrations');

async function main() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error('SUPABASE_DB_URL not set');

  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 15000 });
  const client = await pool.connect();

  try {
    // Bootstrap the migrations tracking table.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public._migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log('No migration files found.');
      return;
    }

    for (const file of files) {
      const { rows } = await client.query('SELECT 1 FROM public._migrations WHERE filename = $1', [file]);
      if (rows.length > 0) {
        console.log(`SKIP  ${file} (already applied)`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`APPLY ${file} ...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO public._migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`  ✅ applied`);
      } catch (e) {
        await client.query('ROLLBACK');
        console.log(`  ❌ FAILED: ${e.message}`);
        // Continue to next migration rather than aborting everything.
      }
    }
    const { rows: applied } = await client.query('SELECT filename FROM public._migrations ORDER BY filename');
    console.log(`\nDone. ${applied.length} migration(s) recorded as applied.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('Migration runner fatal:', e.message);
  process.exit(1);
});
