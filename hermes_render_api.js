const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');
const { signKillOrder } = require('./kill_order.cjs');
const { renderDashboard } = require('./dashboard_renderer.cjs');
require('dotenv').config();

const app = express();
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL || "https://aws-1-us-west-2.pooler.supabase.com";
const SUPABASE_KEY = process.env.RENDER_API_KEY; // Using RENDER_API_KEY as a placeholder/secret
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Postgres pool for direct table reads (pm2_telemetry) the Supabase JS client
// doesn't expose well. Same connection string the MCP bridge uses.
const pgPool = new Pool({
    connectionString: process.env.SUPABASE_DB_URL,
    connectionTimeoutMillis: 10000,
    statement_timeout: 8000,
});

// Security Middleware — protects every route EXCEPT the public dashboard,
// which is read-only observability and must be viewable in a browser without
// a bearer token.
app.use((req, res, next) => {
    if (req.path === '/dashboard') return next();
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.RENDER_API_KEY}`) {
        return res.status(403).json({ error: 'Unauthorized. Iron Hermes Protocol.' });
    }
    next();
});

// 1. Full Swarm Health Status
app.get('/health', async (req, res) => {
    const { data: nodes, error } = await supabase
        .from('knowledge_graph')
        .select('*')
        .like('node_id', 'process:%');
    
    if (error) return res.status(500).json({ error: error.message });
    res.json({
        status: 'IRON_HERMES_ACTIVE',
        processes_tracked: nodes.length,
        nodes
    });
});

// 2. Quarantine List
app.get('/quarantine', async (req, res) => {
    const { data, error } = await supabase
        .from('quarantine_log')
        .select('*')
        .order('timestamp', { ascending: false });
        
    if (error) return res.status(500).json({ error: error.message });
    res.json({ quarantined_agents: data });
});

// 3. Remote Kill Switch
//
// Security model:
//   The kill order is signed with HMAC-SHA256 over a canonical string built
//   from the (agent, reason, issued_at) tuple, using KILL_ORDER_HMAC_SECRET.
//   The local sync bridge independently recomputes and verifies the signature
//   before executing pm2.stop, so merely inserting a row into quarantine_log
//   (with or without a known ordered_by value) is NOT enough to kill a process.
app.post('/kill/:agent', async (req, res) => {
    const agentName = req.params.agent;
    const reason = req.body.reason || "Remote Cloud Order";

    const secret = process.env.KILL_ORDER_HMAC_SECRET;
    if (!secret) {
        return res.status(500).json({ error: 'Server misconfigured: KILL_ORDER_HMAC_SECRET not set.' });
    }

    // Sign the kill order. The canonical string + HMAC live in kill_order.cjs
    // (single source of truth, shared with the verifier). The local sync bridge
    // recomputes the signature before executing pm2.stop, so merely inserting a
    // row into quarantine_log is NOT enough to kill a process.
    const order = signKillOrder({ agent: agentName, reason, secret });

    // Insert into quarantine log. The local sync bridge will detect this
    // via Supabase Realtime, verify the HMAC signature, and only then execute
    // the kill command via PM2 locally.
    const { data, error } = await supabase
        .from('quarantine_log')
        .insert({
            agent: order.agent,
            reason: order.reason,
            ordered_by: order.ordered_by,
            issued_at: order.issuedAt,
            nonce: order.nonce,
            signature: order.signature,
        });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ status: 'KILL_ORDER_DISPATCHED', target: agentName });
});

// 4. Observability Dashboard (public, read-only)
//
// Serves a self-contained HTML page that reads the latest pm2_telemetry row and
// renders per-agent status + sentinel key-health + a restart-loop alert banner.
// Auto-refreshes every 15s. This is the "zero manual intervention" observability
// layer: surfacing the 4235-restart crash-loop in seconds instead of hours.
// No bearer auth (see middleware above) so it's viewable in any browser.
app.get('/dashboard', async (req, res) => {
    try {
        const { rows } = await pgPool.query(
            'SELECT captured_at, host, processes, error_digest, sentinel_stats, restart_rates FROM pm2_telemetry ORDER BY captured_at DESC LIMIT 1'
        );
        const snapshot = rows[0] || null;
        res.type('html').send(renderDashboard(snapshot));
    } catch (e) {
        res.status(500).type('html').send(`<html><body><h1>Dashboard error</h1><pre>${e.message}</pre><p>The pm2_telemetry table may not exist yet — run migration 0003_telemetry_enrichment.sql.</p></body></html>`);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🛡️ Hermes Cloud API running on port ${PORT}`);
});
