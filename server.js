import express from "express";
import cors from "cors";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import pg from "pg";
import { readFileSync, statSync } from "fs";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config({ path: "C:/Users/arvin/.openclaw/.env" });

const AGENTS_PATH = "C:/Users/arvin/.openclaw/agents.json";
const PORT = process.env.PORT || 19005;

const app = express();
app.use(cors());
app.use(express.json());

// Setup Postgres Connection Pool
const pool = new pg.Pool({
  connectionString: process.env.SUPABASE_DB_URL || process.env.OPENCLAW_DB_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

// ─────────────────────────────────────────────
// MCP SERVER
// ─────────────────────────────────────────────
const server = new McpServer({
  name: "OpenClawSwarm",
  version: "2.0.0",
  description: "Bidirectional bridge between Goose and your 28-agent OpenClaw swarm factory"
});

// ─────────────────────────────────────────────
// LAYER 1: Core Ticket Tools
// ─────────────────────────────────────────────

server.tool(
  "swarm_status",
  "Returns real-time ticket counts by status across the entire swarm.",
  {},
  async () => {
    const byStatus = await pool.query("SELECT status, count(*) as count FROM tickets GROUP BY status ORDER BY count DESC");
    const recent = await pool.query("SELECT id, type, target_agent, status, created_at FROM tickets ORDER BY created_at DESC LIMIT 5");
    return {
      content: [{
        type: "text",
        text: `📊 SWARM STATUS\n\n${JSON.stringify(byStatus.rows, null, 2)}\n\n🕐 Last 5 tickets:\n${JSON.stringify(recent.rows, null, 2)}`
      }]
    };
  }
);

server.tool(
  "swarm_dispatch",
  "Creates a new ticket in the OpenClaw Swarm Blackboard for a background agent to execute.",
  {
    type:         z.string(),
    target_agent: z.string(),
    payload:      z.string(),
    priority:     z.number().int().min(1).max(10).optional()
  },
  async ({ type, target_agent, payload, priority }) => {
    const id  = `goose_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const now = new Date().toISOString();
    await pool.query(`
      INSERT INTO tickets (id, type, target_agent, data, status, created_at, updated_at, priority, source_system)
      VALUES ($1, $2, $3, $4, 'OPEN', $5, $6, $7, 'goose-mcp')
    `, [id, type, target_agent, payload, now, now, priority ?? 5]);
    
    return {
      content: [{
        type: "text",
        text: `✅ Dispatched ticket ${id} → ${target_agent} [type: ${type}, priority: ${priority ?? 5}]\nPoll with: ticket_proof("${id}")`
      }]
    };
  }
);

server.tool(
  "swarm_cancel",
  "Cancels an OPEN or CLAIMED ticket by ID.",
  { ticket_id: z.string() },
  async ({ ticket_id }) => {
    const { rows } = await pool.query("SELECT status FROM tickets WHERE id = $1", [ticket_id]);
    if (rows.length === 0) return { content: [{ type: "text", text: `Ticket ${ticket_id} not found.` }] };
    
    const tkt = rows[0];
    if (!["OPEN", "CLAIMED"].includes(tkt.status))
      return { content: [{ type: "text", text: `Cannot cancel — ticket is in status: ${tkt.status}` }] };
      
    await pool.query("UPDATE tickets SET status='ARCHIVED', updated_at=$1 WHERE id=$2", [new Date().toISOString(), ticket_id]);
    return { content: [{ type: "text", text: `🗑️ Ticket ${ticket_id} cancelled.` }] };
  }
);

// ─────────────────────────────────────────────
// LAYER 2: Agent Registry
// ─────────────────────────────────────────────

server.tool(
  "agents_list",
  "Lists all 28 registered OpenClaw agents.",
  {},
  async () => {
    try {
      const config = JSON.parse(readFileSync(AGENTS_PATH, "utf8"));
      const agents = config.list.map(a => ({
        id:          a.id,
        name:        a.name,
        ticketTypes: a.params?.ticketTypes ?? [],
      }));
      return { content: [{ type: "text", text: JSON.stringify(agents, null, 2) }] };
    } catch(e) {
      return { content: [{ type: "text", text: "Cannot read agents.json in cloud mode." }] };
    }
  }
);

// ─────────────────────────────────────────────
// LAYER 3: Search
// ─────────────────────────────────────────────

server.tool(
  "swarm_search",
  "Search across all historical tickets by keyword.",
  { query: z.string() },
  async ({ query }) => {
    const searchTerms = `%${query}%`;
    const { rows } = await pool.query(`
      SELECT id, type, target_agent, status, substring(data from 1 for 100) as data_snippet, created_at
      FROM tickets 
      WHERE data ILIKE $1 OR target_agent ILIKE $1 OR id ILIKE $1
      ORDER BY created_at DESC
      LIMIT 8
    `, [searchTerms]);
    
    if (!rows.length) return { content: [{ type: "text", text: "No matching historical tickets found." }] };
    return { content: [{ type: "text", text: `🔍 Found ${rows.length} past tickets:\n\n${JSON.stringify(rows, null, 2)}` }] };
  }
);

// ─────────────────────────────────────────────
// LAYER 4: Proof Verification
// ─────────────────────────────────────────────

server.tool(
  "ticket_proof",
  "Fetches the full proof event trail for a ticket.",
  { ticket_id: z.string() },
  async ({ ticket_id }) => {
    const tktRes = await pool.query("SELECT * FROM tickets WHERE id=$1", [ticket_id]);
    if (tktRes.rows.length === 0) return { content: [{ type: "text", text: `Ticket ${ticket_id} not found.` }] };
    
    const eventsRes = await pool.query("SELECT * FROM proof_events WHERE ticket_id=$1 ORDER BY created_at ASC", [ticket_id]);
    const tkt = tktRes.rows[0];
    
    return {
      content: [{
        type: "text",
        text: `📋 Ticket: ${ticket_id}\nStatus: ${tkt.status}\nAgent: ${tkt.claimed_by ?? tkt.target_agent}\n\nProof Events (${eventsRes.rows.length}):\n${JSON.stringify(eventsRes.rows, null, 2)}`
      }]
    };
  }
);

// ─────────────────────────────────────────────
// SSE Transport — Multi-session aware
// ─────────────────────────────────────────────
const transports = new Map(); // sessionId → SSEServerTransport

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/message", res);
  transports.set(transport.sessionId, transport);
  console.log(`[+] Goose connected  session=${transport.sessionId}  total=${transports.size}`);

  res.on("close", () => {
    transports.delete(transport.sessionId);
    console.log(`[-] Goose disconnected session=${transport.sessionId}  total=${transports.size}`);
  });

  await server.connect(transport);
});

app.post("/message", async (req, res) => {
  const sessionId  = req.query.sessionId;
  const transport  = transports.get(sessionId);
  if (!transport) return res.status(404).send("Session not found");
  await transport.handlePostMessage(req, res);
});

// Health check endpoint
app.get("/health", async (req, res) => {
  try {
    const stats = await pool.query("SELECT count(*) as total FROM tickets");
    res.json({ status: "ok", sessions: transports.size, total_tickets: parseInt(stats.rows[0].total), port: PORT });
  } catch (e) {
    res.status(500).json({ status: "error", error: e.message });
  }
});

// ─────────────────────────────────────────────
// LAYER 5: Bidirectional Escalation Watcher
// ─────────────────────────────────────────────
const seenEscalations = new Set();

setInterval(async () => {
  if (transports.size === 0) return;

  try {
    const escalations = await pool.query(`
      SELECT id, type, target_agent, data, status, reason_code
      FROM tickets
      WHERE status IN ('BLOCKED', 'FAILED')
      AND source_system = 'goose-mcp'
    `);

    for (const tkt of escalations.rows) {
      if (seenEscalations.has(tkt.id)) continue;
      seenEscalations.add(tkt.id);

      const msg = `⚠️ SWARM ESCALATION\nAgent: ${tkt.target_agent}\nTicket: ${tkt.id}\nStatus: ${tkt.status}\nReason: ${tkt.reason_code ?? "unknown"}\nContext: ${tkt.data?.substring(0, 200)}`;
      console.log(`[ESCALATION] ${tkt.id}`);

      for (const [, transport] of transports) {
        transport.send({
          jsonrpc: "2.0",
          method: "notifications/message",
          params: { level: "warning", logger: "swarm-watcher", data: msg }
        }).catch(e => console.error("SSE push failed:", e.message));
      }
    }
  } catch (e) {
    console.error("Watcher polling error:", e.message);
  }
}, 5000);

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🦞 OpenClaw MCP Bridge v2.0 (Postgres Edition)`);
  console.log(`   SSE endpoint : http://0.0.0.0:${PORT}/sse`);
  console.log(`   POST endpoint: http://0.0.0.0:${PORT}/message?sessionId=<id>`);
  console.log(`   Health check : http://0.0.0.0:${PORT}/health\n`);
});
