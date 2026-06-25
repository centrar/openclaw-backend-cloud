const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { signKillOrder } = require('./kill_order.cjs');
require('dotenv').config();

const app = express();
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL || "https://aws-1-us-west-2.pooler.supabase.com";
const SUPABASE_KEY = process.env.RENDER_API_KEY; // Using RENDER_API_KEY as a placeholder/secret
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Security Middleware
app.use((req, res, next) => {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🛡️ Hermes Cloud API running on port ${PORT}`);
});
