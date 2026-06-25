-- ─────────────────────────────────────────────────────────────────────────────
-- Knowledge graph tables (Workstream 4 — live graph)
--
-- Creates the cloud-side tables the /health endpoint and dashboard read. Until
-- now hermes_render_api.js queried a `knowledge_graph` table that nothing in the
-- codebase ever wrote — it returned empty. This migration creates a proper
-- node + edge schema mirroring the local swarm_topology.sqlite, and the
-- supabase_sync_bridge now pushes nodes/edges up here.
--
-- RLS: service-role-only writes (the bridge connects as the service role);
-- anon may SELECT (so the public dashboard can render without a token).
-- ─────────────────────────────────────────────────────────────────────────────

-- Nodes (agents, tickets, processes, hosts, skills, etc.)
create table if not exists public.knowledge_graph (
    node_id     text primary key,
    label       text not null,
    properties  jsonb not null default '{}'::jsonb,
    updated_at  timestamptz not null default now()
);
create index if not exists knowledge_graph_label_idx on public.knowledge_graph (label);

-- Edges (ASSIGNED_TICKET, CLAIMED_TICKET, MANAGED_BY, CORRELATES_WITH, ...)
create table if not exists public.knowledge_graph_edges (
    edge_id     text primary key,
    source_id   text not null references public.knowledge_graph(node_id) on delete cascade,
    target_id   text not null references public.knowledge_graph(node_id) on delete cascade,
    relation    text not null,
    properties  jsonb not null default '{}'::jsonb,
    updated_at  timestamptz not null default now()
);
create index if not exists knowledge_graph_edges_source_idx on public.knowledge_graph_edges (source_id);
create index if not exists knowledge_graph_edges_target_idx on public.knowledge_graph_edges (target_id);
create index if not exists knowledge_graph_edges_relation_idx on public.knowledge_graph_edges (relation);

-- RLS: service role writes, anon reads (dashboard).
alter table public.knowledge_graph enable row level security;
alter table public.knowledge_graph_edges enable row level security;

drop policy if exists knowledge_graph_service_write on public.knowledge_graph;
create policy knowledge_graph_service_write
    on public.knowledge_graph for insert to service_role with check (true);
drop policy if exists knowledge_graph_service_update on public.knowledge_graph;
create policy knowledge_graph_service_update
    on public.knowledge_graph for update to service_role using (true) with check (true);
drop policy if exists knowledge_graph_anon_read on public.knowledge_graph;
create policy knowledge_graph_anon_read
    on public.knowledge_graph for select to anon, authenticated using (true);

drop policy if exists knowledge_graph_edges_service_write on public.knowledge_graph_edges;
create policy knowledge_graph_edges_service_write
    on public.knowledge_graph_edges for insert to service_role with check (true);
drop policy if exists knowledge_graph_edges_anon_read on public.knowledge_graph_edges;
create policy knowledge_graph_edges_anon_read
    on public.knowledge_graph_edges for select to anon, authenticated using (true);

-- Revoke direct write privileges from anon as belt-and-suspenders.
revoke insert, update, delete on public.knowledge_graph from anon;
revoke insert, update, delete on public.knowledge_graph_edges from anon;
