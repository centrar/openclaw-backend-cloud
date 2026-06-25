import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import pg from "pg";
import { readFileSync } from "fs";
import { createRequire } from "module";
import { z } from "zod";
import dotenv from "dotenv";

// server.js is ESM; dashboard_renderer.cjs is CommonJS. createRequire bridges.
const require = createRequire(import.meta.url);
const { renderDashboard } = require("./dashboard_renderer.cjs");

dotenv.config({ path: "C:/Users/arvin/.openclaw/.env" });

const AGENTS_PATH = "C:/Users/arvin/.openclaw/agents.json";
const PORT = process.env.PORT || 19005;
const HOST = "arvin-main";

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

pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
});

// ─────────────────────────────────────────────
// MCP SERVER
// ─────────────────────────────────────────────
const server = new McpServer({
  name: "OpenClawSwarm",
  version: "3.0.0",
  description:
    "Bidirectional bridge between Goose and your 28-agent OpenClaw swarm — includes self-healing watchdog",
});

// ─────────────────────────────────────────────
// LAYER 1: Core Ticket Tools
// ─────────────────────────────────────────────

server.tool("swarm_status", "Returns real-time ticket counts by status across the entire swarm.", {}, async () => {
  const byStatus = await pool.query(
    "SELECT status, count(*) as count FROM tickets GROUP BY status ORDER BY count DESC"
  );
  const recent = await pool.query(
    "SELECT id, type, target_agent, status, created_at FROM tickets ORDER BY created_at DESC LIMIT 5"
  );
  return {
    content: [
      {
        type: "text",
        text: `📊 SWARM STATUS\n\n${JSON.stringify(byStatus.rows, null, 2)}\n\n🕐 Last 5 tickets:\n${JSON.stringify(recent.rows, null, 2)}`,
      },
    ],
  };
});

server.tool(
  "swarm_dispatch",
  "Creates a new ticket in the OpenClaw Swarm Blackboard for a background agent to execute.",
  {
    type: z.string(),
    target_agent: z.string(),
    payload: z.string(),
    priority: z.number().int().min(1).max(10).optional(),
  },
  async ({ type, target_agent, payload, priority }) => {
    const id = `goose_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO tickets (id, type, target_agent, data, status, created_at, updated_at, priority, source_system)
       VALUES ($1, $2, $3, $4, 'OPEN', $5, $6, $7, 'goose-mcp')`,
      [id, type, target_agent, payload, now, now, priority ?? 5]
    );
    return {
      content: [
        {
          type: "text",
          text: `✅ Dispatched ticket ${id} → ${target_agent} [type: ${type}, priority: ${priority ?? 5}]\nPoll with: ticket_proof("${id}")`,
        },
      ],
    };
  }
);

server.tool("swarm_cancel", "Cancels an OPEN or CLAIMED ticket by ID.", { ticket_id: z.string() }, async ({ ticket_id }) => {
  const { rows } = await pool.query("SELECT status FROM tickets WHERE id = $1", [ticket_id]);
  if (rows.length === 0) return { content: [{ type: "text", text: `Ticket ${ticket_id} not found.` }] };
  const tkt = rows[0];
  if (!["OPEN", "CLAIMED"].includes(tkt.status))
    return { content: [{ type: "text", text: `Cannot cancel — ticket is in status: ${tkt.status}` }] };
  await pool.query("UPDATE tickets SET status='ARCHIVED', updated_at=$1 WHERE id=$2", [new Date().toISOString(), ticket_id]);
  return { content: [{ type: "text", text: `🗑️ Ticket ${ticket_id} cancelled.` }] };
});

// ─────────────────────────────────────────────
// LAYER 2: Agent Registry
// ─────────────────────────────────────────────

server.tool("agents_list", "Lists all registered OpenClaw agents.", {}, async () => {
  try {
    const config = JSON.parse(readFileSync(AGENTS_PATH, "utf8"));
    const agents = config.list.map((a) => ({
      id: a.id,
      name: a.name,
      ticketTypes: a.params?.ticketTypes ?? [],
    }));
    return { content: [{ type: "text", text: JSON.stringify(agents, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: "Cannot read agents.json in cloud mode." }] };
  }
});

// ─────────────────────────────────────────────
// LAYER 3: Search
// ─────────────────────────────────────────────

server.tool("swarm_search", "Search across all historical tickets by keyword.", { query: z.string() }, async ({ query }) => {
  const { rows } = await pool.query(
    `SELECT id, type, target_agent, status, substring(data from 1 for 100) as data_snippet, created_at
     FROM tickets
     WHERE data ILIKE $1 OR target_agent ILIKE $1 OR id ILIKE $1
     ORDER BY created_at DESC LIMIT 8`,
    [`%${query}%`]
  );
  if (!rows.length) return { content: [{ type: "text", text: "No matching historical tickets found." }] };
  return { content: [{ type: "text", text: `🔍 Found ${rows.length} past tickets:\n\n${JSON.stringify(rows, null, 2)}` }] };
});

// ─────────────────────────────────────────────
// LAYER 4: Proof Verification
// ─────────────────────────────────────────────

server.tool("ticket_proof", "Fetches the full proof event trail for a ticket.", { ticket_id: z.string() }, async ({ ticket_id }) => {
  const tktRes = await pool.query("SELECT * FROM tickets WHERE id=$1", [ticket_id]);
  if (tktRes.rows.length === 0) return { content: [{ type: "text", text: `Ticket ${ticket_id} not found.` }] };
  const eventsRes = await pool.query(
    "SELECT * FROM proof_events WHERE ticket_id=$1 ORDER BY created_at ASC",
    [ticket_id]
  );
  const tkt = tktRes.rows[0];
  return {
    content: [
      {
        type: "text",
        text: `📋 Ticket: ${ticket_id}\nStatus: ${tkt.status}\nAgent: ${tkt.claimed_by ?? tkt.target_agent}\n\nProof Events (${eventsRes.rows.length}):\n${JSON.stringify(eventsRes.rows, null, 2)}`,
      },
    ],
  };
});

// ─────────────────────────────────────────────
// LAYER 5: Watchdog MCP Tools
// ─────────────────────────────────────────────

server.tool("stack_health", "Returns the latest PM2 process snapshot from the local machine via telemetry.", {}, async () => {
  try {
    const { rows } = await pool.query(
      "SELECT captured_at, processes, error_digest FROM pm2_telemetry ORDER BY captured_at DESC LIMIT 1"
    );
    if (!rows.length) return { content: [{ type: "text", text: "⚠️ No telemetry data yet. pm2_telemetry_push may not be running." }] };
    const snap = rows[0];
    const procs = snap.processes || [];
    const unhealthy = procs.filter((p) => p.status !== "online" && p.status !== "stopped");
    const lines = procs.map(
      (p) => `  ${p.status === "online" ? "✅" : "❌"} ${p.name.padEnd(35)} ${p.status} | restarts=${p.restarts}`
    );
    return {
      content: [
        {
          type: "text",
          text: `🖥️ STACK HEALTH SNAPSHOT\nCaptured: ${snap.captured_at}\nUnhealthy: ${unhealthy.length}\n\n${lines.join("\n")}\n\nError Digest:\n${JSON.stringify(snap.error_digest, null, 2)}`,
        },
      ],
    };
  } catch (e) {
    return { content: [{ type: "text", text: `Error reading telemetry: ${e.message}` }] };
  }
});

server.tool("watchdog_status", "Returns the Goose Watchdog status: last scan time, issues found, repairs dispatched.", {}, async () => {
  const { rows: pending } = await pool.query(
    "SELECT id, action, payload, status, created_at FROM maintenance_tickets ORDER BY created_at DESC LIMIT 10"
  );
  return {
    content: [
      {
        type: "text",
        text: `🛡️ GOOSE WATCHDOG STATUS\nScan interval: every 5 minutes\nLast scan: ${watchdog.lastScanAt || "never"}\nIssues detected (all time): ${watchdog.issuesFound}\nRepairs dispatched (all time): ${watchdog.repairsDispatched}\n\nRecent maintenance tickets:\n${JSON.stringify(pending, null, 2)}`,
      },
    ],
  };
});

server.tool(
  "dispatch_fix",
  "Manually dispatch a maintenance action to the local machine. Actions: pm2_restart, read_log, patch_file, run_command, pm2_status",
  {
    action: z.enum(["pm2_restart", "read_log", "patch_file", "run_command", "pm2_status"]),
    payload: z.string().describe("JSON string of action parameters"),
    reason: z.string().optional(),
  },
  async ({ action, payload, reason }) => {
    const id = `maint_manual_${Date.now()}`;
    let parsedPayload;
    try {
      parsedPayload = JSON.parse(payload);
    } catch (e) {
      return { content: [{ type: "text", text: `❌ Invalid payload JSON: ${e.message}` }] };
    }
    await pool.query(
      `INSERT INTO maintenance_tickets (id, action, payload, status, host, created_at, updated_at)
       VALUES ($1, $2, $3, 'OPEN', $4, NOW(), NOW())`,
      [id, action, JSON.stringify(parsedPayload), HOST]
    );
    return {
      content: [
        {
          type: "text",
          text: `🔧 Manual fix dispatched!\nTicket: ${id}\nAction: ${action}\nPayload: ${JSON.stringify(parsedPayload)}\nReason: ${reason || "manual"}\n\nThe local maintenance bridge will pick this up within 30 seconds.`,
        },
      ],
    };
  }
);

// ─────────────────────────────────────────────
// LAYER 6: SSE Transport — Multi-session aware
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
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);
  if (!transport) return res.status(404).send("Session not found");
  await transport.handlePostMessage(req, res);
});

// Health check endpoint
app.get("/health", async (req, res) => {
  try {
    const stats = await pool.query("SELECT count(*) as total FROM tickets");
    res.json({
      status: "ok",
      sessions: transports.size,
      total_tickets: parseInt(stats.rows[0].total),
      watchdog: {
        lastScanAt: watchdog.lastScanAt,
        issuesFound: watchdog.issuesFound,
        repairsDispatched: watchdog.repairsDispatched,
      },
      port: PORT,
    });
  } catch (e) {
    res.status(500).json({ status: "error", error: e.message });
  }
});

// ─────────────────────────────────────────────
// Observability Dashboard (public, read-only)
//
// Serves a self-contained HTML page reading the latest pm2_telemetry row.
// Auto-refreshes every 15s. Public (no auth) so it's viewable in any browser —
// it only reads telemetry, no write surface. The same renderer + table used by
// hermes_render_api.js; added here too because Render runs THIS file (server.js)
// as the entry point.
app.get("/dashboard", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT captured_at, host, processes, error_digest, sentinel_stats, restart_rates FROM pm2_telemetry ORDER BY captured_at DESC LIMIT 1"
    );
    res.type("html").send(renderDashboard(rows[0] || null));
  } catch (e) {
    res
      .status(500)
      .type("html")
      .send(`<html><body><h1>Dashboard error</h1><pre>${e.message}</pre><p>The pm2_telemetry table may not exist yet — run migration 0003_telemetry_enrichment.sql via <code>node run_migrations.cjs</code>.</p></body></html>`);
  }
});

// ─────────────────────────────────────────────
// LAYER 7: Bidirectional Escalation Watcher
// ─────────────────────────────────────────────
const seenEscalations = new Set();

setInterval(async () => {
  if (transports.size === 0) return;
  try {
    const escalations = await pool.query(
      `SELECT id, type, target_agent, data, status, reason_code FROM tickets
       WHERE status IN ('BLOCKED', 'FAILED') AND source_system = 'goose-mcp'`
    );
    for (const tkt of escalations.rows) {
      if (seenEscalations.has(tkt.id)) continue;
      seenEscalations.add(tkt.id);
      const msg = `⚠️ SWARM ESCALATION\nAgent: ${tkt.target_agent}\nTicket: ${tkt.id}\nStatus: ${tkt.status}\nReason: ${tkt.reason_code ?? "unknown"}\nContext: ${String(tkt.data).substring(0, 200)}`;
      console.log(`[ESCALATION] ${tkt.id}`);
      for (const [, transport] of transports) {
        transport
          .send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "warning", logger: "swarm-watcher", data: msg } })
          .catch((e) => console.error("SSE push failed:", e.message));
      }
    }
  } catch (e) {
    console.error("Watcher polling error:", e.message);
  }
}, 5000);

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 8: GOOSE WATCHDOG DAEMON — Self-Healing Brain (Phases 2 + 4)
//
// Runs every 5 minutes on Render. Reads pm2_telemetry from Supabase,
// applies the failure-pattern rulebook, and dispatches maintenance_tickets
// for the local goose_maintenance_bridge to execute.
// ─────────────────────────────────────────────────────────────────────────────

const watchdog = {
  lastScanAt: null,
  issuesFound: 0,
  repairsDispatched: 0,
  seenRepairs: new Set(), // deduplicate repairs: key = `${processName}:${ruleId}`
};

// ── RULEBOOK (Phase 4) ─────────────────────────────────────────────────
// Each rule: { id, description, match(proc, errorLines) → bool, buildTickets(proc) → [{action, payload}] }
const RULES = [
  {
    id: "novel_factory_model_gone_404",
    description: "Novel Factory crash-loop: MODEL_GONE 404 wrong API path",
    match: (proc, errorLines) =>
      proc.name === "novel_factory_orchestrator" &&
      proc.unstable_restarts > 3 &&
      errorLines.some((l) => l.includes("MODEL_GONE") && l.includes("404")),
    buildTickets: () => [
      {
        action: "patch_file",
        payload: {
          file_path: "C:/video gen test folder nvdia/novel_factory/api.js",
          search: "parsedUrl.pathname.endsWith('/') ? 'chat/completions' : '/chat/completions'",
          replace: "'/v1/chat/completions'",
        },
      },
      { action: "pm2_restart", payload: { process_name: "novel_factory_orchestrator" } },
    ],
  },
  {
    id: "novel_factory_syntax_error_authtoken",
    description: "Novel Factory crash: duplicate const authToken SyntaxError",
    match: (proc, errorLines) =>
      proc.name === "novel_factory_orchestrator" &&
      errorLines.some((l) => l.includes("SyntaxError") && l.includes("already been declared")),
    buildTickets: () => [
      { action: "read_log", payload: { log_path: "C:/Users/arvin/.pm2/logs/novel-factory-orchestrator-error.log", lines: 80 } },
      { action: "pm2_restart", payload: { process_name: "novel_factory_orchestrator" } },
    ],
  },
  {
    id: "process_errored",
    description: "Any critical process has status=errored",
    // Only apply to processes that should never stop
    CRITICAL: ["novel_factory_orchestrator", "novel_factory_sentinel", "mcp_bridge_server", "mcp_cloud_sync", "goose_maintenance_bridge"],
    match(proc) {
      return this.CRITICAL.includes(proc.name) && proc.status === "errored";
    },
    buildTickets: (proc) => [
      { action: "pm2_restart", payload: { process_name: proc.name } },
    ],
  },
  {
    id: "crash_loop",
    description: "Process restart count exceeds 30 (crash-loop detected)",
    CRITICAL: ["novel_factory_orchestrator", "novel_factory_sentinel", "mcp_bridge_server", "mcp_cloud_sync"],
    match(proc) {
      return this.CRITICAL.includes(proc.name) && proc.unstable_restarts > 5;
    },
    buildTickets: (proc) => [
      {
        action: "read_log",
        payload: {
          log_path: `C:/Users/arvin/.pm2/logs/${proc.name.replace(/_/g, "-")}-error.log`,
          lines: 50,
        },
      },
      { action: "pm2_restart", payload: { process_name: proc.name } },
    ],
  },
  {
    id: "sentinel_not_online",
    description: "Novel Factory Sentinel gateway is not online",
    match: (proc) => proc.name === "novel_factory_sentinel" && proc.status !== "online",
    buildTickets: () => [
      { action: "pm2_restart", payload: { process_name: "novel_factory_sentinel" } },
    ],
  },
];

async function dispatchMaintenanceTicket(action, payload, ruleId, processName) {
  const dedupKey = `${processName}:${ruleId}:${action}`;
  if (watchdog.seenRepairs.has(dedupKey)) return false; // already dispatched recently

  const id = `maint_wd_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  try {
    await pool.query(
      `INSERT INTO maintenance_tickets (id, action, payload, status, host, created_at, updated_at)
       VALUES ($1, $2, $3, 'OPEN', $4, NOW(), NOW())`,
      [id, action, JSON.stringify(payload), HOST]
    );
    watchdog.seenRepairs.add(dedupKey);
    // Auto-clear dedup after 10 minutes so it can re-fire if problem persists
    setTimeout(() => watchdog.seenRepairs.delete(dedupKey), 10 * 60 * 1000);
    watchdog.repairsDispatched++;
    return id;
  } catch (e) {
    console.error(`[Watchdog] Failed to insert maintenance ticket: ${e.message}`);
    return false;
  }
}

function pushSseAlert(msg) {
  for (const [, transport] of transports) {
    transport
      .send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "error", logger: "watchdog", data: msg } })
      .catch(() => {});
  }
}

async function runWatchdogScan() {
  watchdog.lastScanAt = new Date().toISOString();
  console.log(`[Watchdog] 🔍 Scanning at ${watchdog.lastScanAt}...`);

  let snap;
  try {
    const { rows } = await pool.query(
      "SELECT captured_at, processes, error_digest FROM pm2_telemetry ORDER BY captured_at DESC LIMIT 1"
    );
    if (!rows.length) {
      console.log("[Watchdog] No telemetry data yet — skipping scan.");
      return;
    }
    snap = rows[0];

    // Stale telemetry check: if data is > 10 minutes old, pm2_telemetry_push may be broken
    const age = (Date.now() - new Date(snap.captured_at).getTime()) / 1000 / 60;
    if (age > 10) {
      console.warn(`[Watchdog] ⚠️ Telemetry is ${age.toFixed(1)} minutes stale! pm2_telemetry_push may be down.`);
      pushSseAlert(`⚠️ WATCHDOG ALERT: PM2 telemetry is ${age.toFixed(1)} minutes stale. Local telemetry push may have crashed.`);
    }
  } catch (e) {
    console.error("[Watchdog] Cannot read telemetry:", e.message);
    return;
  }

  const processes = snap.processes || [];
  const errorDigest = snap.error_digest || {};

  for (const proc of processes) {
    const errorLines = errorDigest[proc.name]?.last_error_lines?.split("\n") || [];

    for (const rule of RULES) {
      try {
        if (!rule.match(proc, errorLines)) continue;

        watchdog.issuesFound++;
        const tickets = rule.buildTickets(proc, errorLines);

        console.log(`[Watchdog] 🚨 Rule fired: ${rule.id} → ${proc.name} (restarts=${proc.restarts}, status=${proc.status})`);
        pushSseAlert(
          `🚨 WATCHDOG DETECTED: ${rule.description}\nProcess: ${proc.name} | Status: ${proc.status} | Restarts: ${proc.restarts}\nDispatching ${tickets.length} repair ticket(s)...`
        );

        for (const t of tickets) {
          const ticketId = await dispatchMaintenanceTicket(t.action, t.payload, rule.id, proc.name);
          if (ticketId) {
            console.log(`[Watchdog] ✅ Dispatched ${t.action} → ticket ${ticketId}`);
          }
        }

        break; // one rule per process per scan to avoid flood
      } catch (ruleErr) {
        console.error(`[Watchdog] Rule ${rule.id} threw:`, ruleErr.message);
      }
    }
  }

  console.log(`[Watchdog] Scan complete. Issues: ${watchdog.issuesFound}, Repairs: ${watchdog.repairsDispatched}`);
}

// Run immediately on startup, then every 5 minutes
setTimeout(runWatchdogScan, 15000); // 15s delay to let pool settle
setInterval(runWatchdogScan, 5 * 60 * 1000);

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🦞 OpenClaw MCP Bridge v3.0 (Watchdog Edition)`);
  console.log(`   SSE endpoint : http://0.0.0.0:${PORT}/sse`);
  console.log(`   POST endpoint: http://0.0.0.0:${PORT}/message?sessionId=<id>`);
  console.log(`   Health check : http://0.0.0.0:${PORT}/health`);
  console.log(`   🛡️  Watchdog  : scanning every 5 minutes\n`);
});
