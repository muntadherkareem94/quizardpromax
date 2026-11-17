-- Gemini 3.8 Flash has its own visible free-model limits in the user's
-- Google AI Studio account. Track this model separately from Flash-Lite.
-- Both use the same genuine Google account/key; this is not quota evasion.
-- Only explicit Railway opt-in and caps enable the backup model.

alter table public.ai_import_provider_daily
  drop constraint if exists ai_import_provider_daily_provider_check;
alter table public.ai_import_provider_daily
  add constraint ai_import_provider_daily_provider_check
  check(provider in ('gemini','gemini_flash','groq','mistral','openrouter','cloudflare'));

alter table public.ai_import_provider_state
  drop constraint if exists ai_import_provider_state_provider_check;
alter table public.ai_import_provider_state
  add constraint ai_import_provider_state_provider_check
  check(provider in ('gemini','gemini_flash','groq','mistral','openrouter','cloudflare'));

create or replace function public.ai_reserve_free_provider_request(
  p_provider text,p_max_calls integer)
returns boolean language plpgsql security invoker set search_path=public as $$
declare n integer;
begin
  if p_provider not in ('gemini','gemini_flash','groq','mistral','openrouter','cloudflare')
     or p_max_calls < 1 or p_max_calls > 100000 then
     raise exception 'Invalid free provider model budget';
  end if;
  insert into public.ai_import_provider_daily(provider,quota_date,request_count)
    values(p_provider,(now() at time zone 'utc')::date,1)
  on conflict (provider,quota_date) do update
    set request_count=public.ai_import_provider_daily.request_count+1,
        updated_at=now()
    where public.ai_import_provider_daily.request_count < p_max_calls
  returning request_count into n;
  return n is not null;
end $$;
revoke all on function public.ai_reserve_free_provider_request(text,integer)
  from public,anon,authenticated;
grant execute on function public.ai_reserve_free_provider_request(text,integer)
  to service_role;