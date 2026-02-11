-- HyperClaw core store completion migration
-- Ensures all tables referenced by lib/supabase-store.ts exist.

create table if not exists public.hc_cursors (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.hc_trades (
  id text primary key,
  agent_id text not null,
  timestamp bigint not null,
  decision jsonb not null,
  executed boolean not null,
  execution_result jsonb
);

create index if not exists hc_trades_agent_ts_idx
  on public.hc_trades(agent_id, timestamp desc);

create table if not exists public.hc_vault_messages (
  id text primary key,
  agent_id text not null,
  timestamp bigint not null,
  sender text not null check (sender in ('agent', 'investor', 'system')),
  sender_name text not null,
  sender_id text,
  type text not null check (
    type in (
      'trade_proposal',
      'trade_executed',
      'discussion',
      'question',
      'ai_response',
      'pnl_update'
    )
  ),
  content text not null,
  trade_decision jsonb,
  telegram_message_id bigint
);

create index if not exists hc_vault_messages_agent_ts_idx
  on public.hc_vault_messages(agent_id, timestamp desc);
