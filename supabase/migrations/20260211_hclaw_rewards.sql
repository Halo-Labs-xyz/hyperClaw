-- HCLAW rewards/points/treasury schema

create table if not exists public.hc_hclaw_locks (
  lock_id text primary key,
  user_address text not null,
  amount text not null,
  start_ts bigint not null,
  end_ts bigint not null,
  multiplier_bps integer not null,
  status text not null check (status in ('active', 'unlocked', 'expired'))
);

create index if not exists hc_hclaw_locks_user_idx
  on public.hc_hclaw_locks(user_address);

create index if not exists hc_hclaw_locks_end_ts_idx
  on public.hc_hclaw_locks(end_ts desc);

create table if not exists public.hc_hclaw_points_epochs (
  epoch_id text primary key,
  start_ts bigint not null,
  end_ts bigint not null,
  status text not null check (status in ('open', 'closing', 'closed')),
  root_hash text,
  settled_ts bigint
);

create table if not exists public.hc_hclaw_points_balances (
  epoch_id text not null references public.hc_hclaw_points_epochs(epoch_id) on delete cascade,
  user_address text not null,
  lock_points double precision not null default 0,
  lp_points double precision not null default 0,
  ref_points double precision not null default 0,
  quest_points double precision not null default 0,
  total_points double precision not null default 0,
  primary key (epoch_id, user_address)
);

create table if not exists public.hc_hclaw_referrals (
  referrer text not null,
  referee text not null,
  qualified_volume_usd double precision not null default 0,
  epoch_id text not null references public.hc_hclaw_points_epochs(epoch_id) on delete cascade,
  primary key (referrer, referee, epoch_id)
);

create table if not exists public.hc_hclaw_rewards (
  user_address text not null,
  epoch_id text not null references public.hc_hclaw_points_epochs(epoch_id) on delete cascade,
  rebate_usd double precision not null default 0,
  incentive_hclaw double precision not null default 0,
  claimed boolean not null default false,
  primary key (user_address, epoch_id)
);

create table if not exists public.hc_hclaw_treasury_flows (
  id bigserial primary key,
  ts bigint not null,
  source text not null,
  amount_usd double precision not null,
  buyback_usd double precision not null,
  incentive_usd double precision not null,
  reserve_usd double precision not null,
  tx_hash text
);

create index if not exists hc_hclaw_points_balances_user_epoch_idx
  on public.hc_hclaw_points_balances(user_address, epoch_id);

create index if not exists hc_hclaw_rewards_user_epoch_idx
  on public.hc_hclaw_rewards(user_address, epoch_id);

create index if not exists hc_hclaw_points_balances_epoch_idx
  on public.hc_hclaw_points_balances(epoch_id);

create index if not exists hc_hclaw_rewards_epoch_idx
  on public.hc_hclaw_rewards(epoch_id);

create index if not exists hc_hclaw_referrals_epoch_idx
  on public.hc_hclaw_referrals(epoch_id);

create index if not exists hc_hclaw_points_epochs_epoch_idx
  on public.hc_hclaw_points_epochs(epoch_id);

create index if not exists hc_hclaw_treasury_flows_ts_idx
  on public.hc_hclaw_treasury_flows(ts desc);
