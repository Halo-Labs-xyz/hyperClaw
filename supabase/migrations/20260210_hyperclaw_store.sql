-- HyperClaw hybrid storage schema
-- Apply in Supabase SQL Editor before enabling SUPABASE_* env vars.
-- This schema intentionally keeps only core relational state in Supabase.
-- High-volume trade logs are archived to S3 via TRADE_ARCHIVE_PREFIX.

create table if not exists public.hc_agents (
  id text primary key,
  name text not null,
  description text not null,
  status text not null check (status in ('active', 'paused', 'stopped')),
  created_at bigint not null,
  markets jsonb not null default '[]'::jsonb,
  max_leverage integer not null,
  risk_level text not null check (risk_level in ('conservative', 'moderate', 'aggressive')),
  stop_loss_percent double precision not null,
  autonomy jsonb not null,
  indicator jsonb,
  telegram jsonb,
  vault_social jsonb,
  hl_address text not null,
  hl_vault_address text,
  total_pnl double precision not null default 0,
  total_pnl_percent double precision not null default 0,
  total_trades integer not null default 0,
  win_rate double precision not null default 0,
  vault_tvl_usd double precision not null default 0,
  depositor_count integer not null default 0,
  pending_approval jsonb
);

create index if not exists hc_agents_status_idx on public.hc_agents(status);
create index if not exists hc_agents_total_pnl_idx on public.hc_agents(total_pnl desc);

create table if not exists public.hc_deposits (
  tx_hash text primary key,
  block_number text not null,
  agent_id text not null,
  user_address text not null,
  token_address text not null,
  amount text not null,
  shares text not null,
  usd_value double precision not null,
  mon_rate double precision not null,
  relay_fee double precision not null,
  timestamp bigint not null,
  relayed boolean not null default true,
  hl_wallet_address text,
  hl_funded boolean,
  hl_funded_amount double precision
);

create index if not exists hc_deposits_agent_ts_idx on public.hc_deposits(agent_id, timestamp desc);
create index if not exists hc_deposits_user_ts_idx on public.hc_deposits(user_address, timestamp desc);
