-- Agent AI API key for unlimited decisions (encrypted)
alter table public.hc_agents
  add column if not exists ai_api_key_provider text,
  add column if not exists ai_api_key_encrypted text;
