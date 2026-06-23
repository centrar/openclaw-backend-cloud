-- ─────────────────────────────────────────────────────────────────────────────
-- Kill-order RLS hardening (defense-in-depth for the remote kill switch)
--
-- Threat model:
--   supabase_sync_bridge.cjs subscribes to quarantine_log inserts and runs
--   pm2.stop(agent) on the local machine. Anyone who can INSERT a row into
--   quarantine_log can therefore shut down arbitrary PM2 processes.
--
-- Primary control:  HMAC signature verified by the bridge (see commit 0375242).
--   This migration is the SECONDARY control — it prevents the table from being
--   written by anything other than the authenticated service role in the first
--   place, so an attacker holding only the anon/published key (or none, if RLS
--   was previously absent) cannot even stage a kill order.
--
-- Run this in the Supabase SQL editor (or via `supabase db push`). It is
-- idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Ensure the columns the HMAC signature path expects exist.
alter table public.quarantine_log
    add column if not exists ordered_by text,
    add column if not exists issued_at  bigint,
    add column if not exists nonce     text,
    add column if not exists signature text;

-- Index for the bridge's replay/freshness lookups and for audit queries.
create index if not exists quarantine_log_nonce_idx
    on public.quarantine_log (nonce);
create index if not exists quarantine_log_issued_at_idx
    on public.quarantine_log (issued_at desc);

-- 2. Enable + lock down Row Level Security.
--    DEFAULT: deny all. Every policy below is an explicit grant.
alter table public.quarantine_log enable row level security;

-- 2a. Writes: ONLY the service role may insert. The service role bypasses RLS,
--     so this policy exists for the non-bypass case (anon/authenticated) and
--     documents intent. The hard guarantee is: anon/any client role cannot
--     insert. If you need the Render app to insert with a non-service role,
--     create a dedicated role and grant it here instead — never grant anon.
drop policy if exists quarantine_log_service_insert on public.quarantine_log;
create policy quarantine_log_service_insert
    on public.quarantine_log
    for insert
    to service_role
    with check (true);

-- 2b. Reads: the bridge needs to read rows to verify them. Restrict to the
--     service role (the bridge connects as the service/pooler role). Dashboard
--     access uses the service role too; tighten further with a dedicated
--     read-only role if you expose reads to other clients.
drop policy if exists quarantine_log_service_select on public.quarantine_log;
create policy quarantine_log_service_select
    on public.quarantine_log
    for select
    to service_role
    using (true);

-- 2c. No UPDATE / DELETE policy => those operations are denied under RLS for
--     non-bypass roles. Kill orders are append-only by design (audit trail).

-- 3. Revoke direct table privileges from anon/authenticated as belt-and-suspenders.
--    RLS is the control; this just removes the footgun if RLS is ever toggled off.
revoke insert, update, delete on public.quarantine_log from anon, authenticated;
revoke select on public.quarantine_log from anon;
-- (authenticated may retain SELECT if you want dashboard visibility without
--  write; remove the next line to grant it.)
revoke select on public.quarantine_log from authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- NOTE on the application-layer HMAC (commit 0375242):
--   Even with the above RLS in place, this migration does NOT make the bridge
--   trust the table blindly. The bridge recomputes the HMAC over
--   (agent, reason, issued_at, nonce) and rejects any row whose signature
--   fails, is stale (>KILL_ORDER_MAX_AGE_MS), or whose nonce was already seen.
--   Two independent controls = if one is misconfigured, the other still holds.
-- ─────────────────────────────────────────────────────────────────────────────
