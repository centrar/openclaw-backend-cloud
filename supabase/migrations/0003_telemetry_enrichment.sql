-- ─────────────────────────────────────────────────────────────────────────────
-- Telemetry enrichment (Workstream 3 observability upgrade)
--
-- Adds two JSON columns to pm2_telemetry so the auto-dashboard can show:
--   sentinel_stats  — key-health snapshot (healthy/dead/in-use/rpm_limit) from
--                     the sentinel /stats endpoint, captured by pm2_telemetry_push.
--   restart_rates   — per-process 5-minute restart delta, the metric that would
--                     have surfaced the 4235-restart crash-loop in seconds.
--
-- Both are nullable (existing rows default to NULL) so this migration is
-- backward-compatible with the v1.0 pusher — no rewrite of old data needed.
-- Idempotent; safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.pm2_telemetry
    add column if not exists sentinel_stats jsonb,
    add column if not exists restart_rates  jsonb;

-- The dashboard reads the latest row; index captured_at desc for that lookup.
create index if not exists pm2_telemetry_host_captured_idx
    on public.pm2_telemetry (host, captured_at desc);
