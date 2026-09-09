-- ─────────────────────────────────────────────────────────────────────────────
-- Avantra — 07 Leads: enquiries from the marketing site (avantracs.com).
--
-- The marketing site is a SEPARATE deploy but writes into this same project, so
-- a lead lands in the dispatch queue rather than an inbox somebody has to
-- remember to check.
--
-- Security posture: the website has NO browser-side Supabase client and no anon
-- key. Its /api/lead route writes with the service role, server-side only. So
-- there is deliberately NO anon INSERT policy here — the table has no public
-- write surface at all, and spam control lives in the route (honeypot + rate
-- limit) rather than in RLS.
--
-- Depends on 01 (helpers) and 02 (clients). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

create table if not exists public.leads (
  id            uuid primary key default gen_random_uuid(),
  -- Who got in touch
  name          text not null,
  company       text,
  email         text not null,
  phone         text,
  mc_number     text,
  equipment     text,
  truck_count   integer,
  message       text,
  -- Where from
  source        text not null default 'website'
                check (source in ('website','referral','phone','load_board','other')),
  submitted_ip  text,                 -- abuse triage only; never displayed
  -- Working the lead
  status        text not null default 'new'
                check (status in ('new','contacted','quoted','won','lost','spam')),
  assigned_to   uuid references auth.users(id) on delete set null,
  notes         text,
  contacted_at  timestamptz,
  -- Set when the lead becomes a real client, so the link survives conversion.
  converted_client_id uuid references public.clients(id) on delete set null,
  converted_at  timestamptz,
  lost_reason   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz
);

create index if not exists idx_leads_status on public.leads(status, created_at desc);
create index if not exists idx_leads_created on public.leads(created_at desc);
create index if not exists idx_leads_email on public.leads(lower(email));

drop trigger if exists trg_leads_updated_at on public.leads;
create trigger trg_leads_updated_at before update on public.leads
  for each row execute function public.set_updated_at();

-- Stamp contacted_at the first time a lead leaves 'new', so nobody has to
-- remember to set it and response-time reporting stays honest.
create or replace function public.stamp_lead_contacted()
returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status
     and old.status = 'new'
     and new.status <> 'new'
     and new.contacted_at is null then
    new.contacted_at := now();
  end if;
  if new.converted_client_id is not null and new.converted_at is null then
    new.converted_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists trg_leads_contacted on public.leads;
create trigger trg_leads_contacted before update on public.leads
  for each row execute function public.stamp_lead_contacted();

alter table public.leads enable row level security;
select public._reset_policies('leads');

-- Staff only. No anon policy by design: the website never touches this table
-- from a browser, so granting public INSERT would create an abuse surface that
-- buys nothing.
create policy leads_staff_all on public.leads for all
  using (public.is_staff()) with check (public.is_staff());
