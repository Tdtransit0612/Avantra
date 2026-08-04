-- ─────────────────────────────────────────────────────────────────────────────
-- Avantra — 02 Clients: the carriers we dispatch FOR, plus their drivers,
-- equipment, factoring relationship, and onboarding checklist.
--
-- `clients` is the heart of the model. In Cryolane a carrier is a VENDOR you pay;
-- here a client carrier is the CUSTOMER you serve — you invoice brokers in their
-- name and bill them a dispatch fee. Depends on 01. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

-- ── factoring_companies ──────────────────────────────────────────────────────
-- Most owner-operators factor their receivables. We submit invoices to the
-- client's factor and track funding, so the factor is a first-class entity.
create table if not exists public.factoring_companies (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  contact_name    text,
  email           text,
  phone           text,
  submission_email text,               -- where invoice packets get sent
  portal_url      text,
  advance_rate    numeric,             -- e.g. 95.00 (%)
  fee_percent     numeric,             -- e.g. 3.00 (%)
  notes           text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz
);
create unique index if not exists idx_factoring_companies_name on public.factoring_companies(lower(name));
drop trigger if exists trg_factoring_companies_updated_at on public.factoring_companies;
create trigger trg_factoring_companies_updated_at before update on public.factoring_companies
  for each row execute function public.set_updated_at();

alter table public.factoring_companies enable row level security;
select public._reset_policies('factoring_companies');
create policy factoring_companies_all on public.factoring_companies for all
  using (public.is_staff()) with check (public.is_staff());

-- ── clients (carrier clients we provide dispatch + back-office services to) ───
create sequence if not exists public.client_number_seq start with 1001;

create table if not exists public.clients (
  id                  uuid primary key default gen_random_uuid(),
  client_number       text unique,
  legal_name          text not null,
  dba_name            text,
  status              text not null default 'prospect'
                      check (status in ('prospect','onboarding','active','paused','terminated')),
  -- Authority / identity
  mc_number           text,
  dot_number          text,
  ein                 text,
  authority_status    text not null default 'unknown'
                      check (authority_status in ('active','pending','inactive','not_authorized','unknown')),
  authority_date      date,
  safety_rating       text,
  fmcsa_last_checked  timestamptz,
  -- Contact
  contact_name        text,
  phone               text,
  email               text,
  billing_email       text,
  address             text,
  city                text,
  state               text,
  zip                 text,
  -- Service agreement — the legal spine of the agent relationship
  agreement_signed_at date,
  poa_signed_at       date,            -- limited power of attorney (bill in their name)
  agreement_doc_path  text,            -- private `documents` bucket object path
  w9_on_file          boolean not null default false,
  coi_on_file         boolean not null default false,
  noa_on_file         boolean not null default false,   -- notice of assignment (factoring)
  -- Dispatch fee terms (snapshotted onto each load at booking)
  fee_type            text not null default 'percent' check (fee_type in ('percent','flat')),
  fee_percent         numeric not null default 10,
  fee_flat            numeric not null default 0,
  fee_basis           text not null default 'gross' check (fee_basis in ('gross','linehaul')),
  fee_minimum         numeric not null default 0,
  billing_cycle       text not null default 'weekly' check (billing_cycle in ('weekly','biweekly','monthly','per_load')),
  -- Factoring
  factoring_company_id uuid references public.factoring_companies(id) on delete set null,
  factors_invoices    boolean not null default false,
  -- Insurance (COI tracking lives in compliance_items; these are the quick-glance fields)
  insurance_provider  text,
  liability_amount    numeric,
  cargo_amount        numeric,
  insurance_expiry    date,
  -- Dispatch preferences — what the dispatcher needs to know before booking
  equipment_types     text[] not null default '{}',      -- Reefer / Dry Van / Flatbed …
  preferred_states    text[] not null default '{}',
  avoid_states        text[] not null default '{}',
  home_base_city      text,
  home_base_state     text,
  min_rate_per_mile   numeric,
  max_weekly_miles    numeric,
  hazmat              boolean not null default false,
  team                boolean not null default false,
  notes               text,
  -- Ownership
  assigned_dispatcher uuid references auth.users(id) on delete set null,
  onboarded_at        date,
  terminated_at       date,
  termination_reason  text,
  deleted_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz
);
create index if not exists idx_clients_status on public.clients(status) where deleted_at is null;
create index if not exists idx_clients_dispatcher on public.clients(assigned_dispatcher);
create index if not exists idx_clients_mc on public.clients(mc_number);
create index if not exists idx_clients_name on public.clients(lower(legal_name));

create or replace function public.set_client_number()
returns trigger language plpgsql as $$
begin
  if new.client_number is null or new.client_number = '' then
    new.client_number := 'AC-' || nextval('public.client_number_seq');
  end if;
  return new;
end;
$$;
drop trigger if exists trg_clients_set_number on public.clients;
create trigger trg_clients_set_number before insert on public.clients
  for each row execute function public.set_client_number();
drop trigger if exists trg_clients_updated_at on public.clients;
create trigger trg_clients_updated_at before update on public.clients
  for each row execute function public.set_updated_at();

alter table public.clients enable row level security;
select public._reset_policies('clients');
create policy clients_staff_all on public.clients for all
  using (public.is_staff()) with check (public.is_staff());

-- ── Client-portal identity ───────────────────────────────────────────────────
-- A 'client' role profile is bound to exactly one client row. Every portal RLS
-- policy funnels through app_client_id() so a client can only ever see their own
-- data. Added here (not in 01) because it needs clients to exist for the FK.
alter table public.profiles
  add column if not exists client_id uuid references public.clients(id) on delete set null;

create or replace function public.app_client_id()
returns uuid language sql stable security definer set search_path = public as $$
  select client_id from public.profiles where id = auth.uid()
$$;

-- Clients may read their own record (never write it).
create policy clients_portal_select on public.clients for select
  using (id = public.app_client_id());

-- ── client_drivers ───────────────────────────────────────────────────────────
create table if not exists public.client_drivers (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients(id) on delete cascade,
  full_name       text not null,
  phone           text,
  email           text,
  cdl_number      text,
  cdl_state       text,
  cdl_expiry      date,
  medical_expiry  date,
  hazmat_endorsed boolean not null default false,
  is_owner        boolean not null default false,   -- the O-O themself drives
  status          text not null default 'active' check (status in ('active','inactive','terminated')),
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz
);
create index if not exists idx_client_drivers_client on public.client_drivers(client_id);
create index if not exists idx_client_drivers_cdl_expiry on public.client_drivers(cdl_expiry) where cdl_expiry is not null;
drop trigger if exists trg_client_drivers_updated_at on public.client_drivers;
create trigger trg_client_drivers_updated_at before update on public.client_drivers
  for each row execute function public.set_updated_at();

alter table public.client_drivers enable row level security;
select public._reset_policies('client_drivers');
create policy client_drivers_staff_all on public.client_drivers for all
  using (public.is_staff()) with check (public.is_staff());
create policy client_drivers_portal_select on public.client_drivers for select
  using (client_id = public.app_client_id());

-- ── client_equipment (their trucks + trailers) ───────────────────────────────
create table if not exists public.client_equipment (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients(id) on delete cascade,
  kind            text not null default 'truck' check (kind in ('truck','trailer')),
  unit_number     text,
  equipment_type  text,               -- Reefer / Dry Van / Flatbed / Step Deck …
  year            integer,
  make            text,
  model           text,
  vin             text,
  plate           text,
  plate_state     text,
  length_ft       integer,
  status          text not null default 'active' check (status in ('active','inactive','out_of_service')),
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz
);
create index if not exists idx_client_equipment_client on public.client_equipment(client_id, kind);
drop trigger if exists trg_client_equipment_updated_at on public.client_equipment;
create trigger trg_client_equipment_updated_at before update on public.client_equipment
  for each row execute function public.set_updated_at();

alter table public.client_equipment enable row level security;
select public._reset_policies('client_equipment');
create policy client_equipment_staff_all on public.client_equipment for all
  using (public.is_staff()) with check (public.is_staff());
create policy client_equipment_portal_select on public.client_equipment for select
  using (client_id = public.app_client_id());

-- ── client_onboarding_steps ──────────────────────────────────────────────────
-- The A-to-Z onboarding checklist. Seeded per client from a default template by
-- the app; each row is independently completable and auditable.
create table if not exists public.client_onboarding_steps (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients(id) on delete cascade,
  step_key     text not null,          -- agreement | poa | w9 | coi | noa | authority | setup_packet …
  label        text not null,
  sort_order   integer not null default 0,
  is_required  boolean not null default true,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  doc_path     text,
  notes        text,
  created_at   timestamptz not null default now()
);
create unique index if not exists idx_onboarding_client_step on public.client_onboarding_steps(client_id, step_key);
create index if not exists idx_onboarding_client on public.client_onboarding_steps(client_id, sort_order);

alter table public.client_onboarding_steps enable row level security;
select public._reset_policies('client_onboarding_steps');
create policy client_onboarding_staff_all on public.client_onboarding_steps for all
  using (public.is_staff()) with check (public.is_staff());
create policy client_onboarding_portal_select on public.client_onboarding_steps for select
  using (client_id = public.app_client_id());

-- ── client_notes (CRM timeline) ──────────────────────────────────────────────
create table if not exists public.client_notes (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients(id) on delete cascade,
  body       text not null,
  kind       text not null default 'note' check (kind in ('note','call','email','meeting','issue')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_client_notes_client on public.client_notes(client_id, created_at desc);

alter table public.client_notes enable row level security;
select public._reset_policies('client_notes');
create policy client_notes_staff_all on public.client_notes for all
  using (public.is_staff()) with check (public.is_staff());
