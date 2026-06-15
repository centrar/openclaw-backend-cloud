# OpenClaw Swarm MCP Bridge

> **Connecting Goose (cloud-dispatched via GitHub Actions) → OpenClaw 28-agent local factory**

---

## Architecture

```
GitHub Actions
  └─ Goose workflow (centrar/openclaw-agentos-private)
       └─ Runner: openclaw-hive-node (this machine)
            └─ GOOSE_MCP_SERVERS=http://localhost:19005/sse
                 └─ ← THIS SERVER → swarm_blackboard.db (885+ tickets)
                      └─ 28 background OpenClaw agents
```

---

## MCP Tools Exposed to Goose

| Tool | Purpose |
|---|---|
| `swarm_status` | Real-time ticket counts by status |
| `swarm_dispatch` | Create a new ticket for any agent |
| `swarm_cancel` | Cancel an OPEN/CLAIMED ticket |
| `agents_list` | All 28 agents, IDs, and accepted ticket types |
| `agents_status` | Live DONE count + last activity per agent |
| `swarm_search` | FTS5 full-text search over 885 historical tickets |
| `ticket_proof` | Full proof event trail for any ticket |

## MCP Resources

| URI | Content |
|---|---|
| `swarm://agents` | All 28 agent definitions |
| `swarm://tickets/open` | All currently open tickets |
| `swarm://tickets/{id}` | Ticket + proof bundle by ID |

---

## Running the Server

```powershell
# One-shot
node C:\AG-Custom-Swarm\goose-openclaw-mcp\server.js

# Auto-restart daemon (recommended)
powershell -File C:\AG-Custom-Swarm\goose-openclaw-mcp\run-daemon.ps1

# Health check
curl http://localhost:19005/health
```

---

## Connecting Goose via GitHub Actions

Add this to your workflow YAML in `centrar/openclaw-agentos-private`
(in the step that runs the Goose agent):

```yaml
- name: Run Goose with OpenClaw Swarm
  env:
    GOOSE_MCP_SERVERS: "openclaw-swarm:http://localhost:19005/sse"
    # Goose will automatically discover all tools and resources
  run: |
    goose run --profile your-profile "Your task here"
```

> **Why `localhost` works:** The GitHub workflow runs on the `openclaw-hive-node` 
> self-hosted runner (this machine), so `localhost:19005` resolves directly to 
> the MCP bridge running in the background.

---

## Bidirectional Escalation (Layer 5)

When any ticket dispatched by Goose transitions to `BLOCKED` or `FAILED`,
the server **automatically pushes a notification** to all connected Goose 
sessions over SSE within 5 seconds.

Goose will see:
```
⚠️ SWARM ESCALATION
Agent: developer_agency
Ticket: goose_1750000000_abc123
Status: BLOCKED
Reason: needs_clarification
Context: Fix the login bug in...
```

---

## Files

```
C:\AG-Custom-Swarm\goose-openclaw-mcp\
├── server.js        ← Main MCP HTTP/SSE server (all 7 layers)
├── run-daemon.ps1   ← Auto-restart daemon
├── package.json     ← Dependencies
└── README.md        ← This file
```
