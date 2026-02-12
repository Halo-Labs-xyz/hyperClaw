-- Persist Monad on-chain agent attestation metadata.

alter table public.hc_agents
  add column if not exists aip_attestation jsonb;
