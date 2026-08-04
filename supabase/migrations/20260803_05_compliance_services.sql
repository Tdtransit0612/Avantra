-- ─────────────────────────────────────────────────────────────────────────────
-- Avantra — 05 Compliance + Service Requests.
--
-- compliance_items is a single generic expiry ledger covering everything Avantra
-- watches on a client's behalf: operating authority, liability/cargo COIs, IFTA,
-- UCR, MCS-150, BOC-3, drug consortium, 2290, CDLs, medical cards, annual
-- inspections. One table (not one per kind) so the watchdog is a single query and
-- adding a new kind never needs a migration.
--
-- service_requests is the back-office work queue that makes "A-to-Z services"
-- real: every non-load thing a client asks us to do, tracked, assigned, and
-- optionally billable onto their statement. Depends on 01–04. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

-- ── compliance_items ─────────────────────────────────────────────────────────
create table if not exists public.compliance_items (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients(id) on delete cascade,
  -- What the item hangs off. client_id is ALWAYS set (even for a driver's CDL) so
  -- the compliance board can filter by client without extra joins.
  entity_type   text not null default 'client'
                check (entity_type in ('client','driver','equipment')),
  entity_id     uuid,
  kind          text not null,        -- authority | liability_insurance | cargo_insurance |
                                      -- ifta | ucr | mcs150 | boc3 | drug_consortium |
                                      -- form_2290 | cdl | medical_card | annual_inspection | other
  label         text,                 -- human override, else the app renders the kind
  status        text not null default 'pending'
                check (status in ('ok','expiring','expired','missing','pending','not_applicable')),
  provider      text,                 -- insurer / consortium / filing agent
  reference     text,                 -- policy #, filing #, confirmation #
  amount        numeric,              -- coverage limit where relevant
  effective_date date,
  expiry_date   date,
  doc_path      text,                 -- private `documents` object path
  last_checked_at timestamptz,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz
);
create index if not exists idx_compliance_client on public.compliance_items(client_id, kind);
create index if not exists idx_compliance_expiry on public.compliance_items(expiry_date)
  where expiry_date is not null;
create index if not exists idx_compliance_status on public.compliance_items(status);
create unique index if not exists idx_compliance_unique
  on public.compliance_items(client_id, entity_type, coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid), kind);

drop trigger if exists trg_compliance_updated_at on public.compliance_items;
create trigger trg_compliance_updated_at before update on public.compliance_items
  for each row execute function public.set_updated_at();

-- Derive status from the expiry date on every write, so the board is never stale
-- because someone forgot to also flip the status field.
create or replace function public.derive_compliance_status()
returns trigger language plpgsql as $$
begin
  if new.status = 'not_applicable' then
    return new;                                    -- explicit opt-out wins
  end if;
  if new.expiry_date is null then
    if new.effective_date is null and new.reference is null and new.doc_path is null then
      new.status := 'missing';
    else
      new.status := 'ok';
    end if;
  elsif new.expiry_date < current_date then
    new.status := 'expired';
  elsif new.expiry_date <= current_date + interval '30 days' then
    new.status := 'expiring';
  else
    new.status := 'ok';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_compliance_status on public.compliance_items;
create trigger trg_compliance_status before insert or update on public.compliance_items
  for each row execute function public.derive_compliance_status();

alter table public.compliance_items enable row level security;
select public._reset_policies('compliance_items');
create policy compliance_staff_all on public.compliance_items for all
  using (public.is_staff()) with check (public.is_staff());
create policy compliance_portal_select on public.compliance_items for select
  using (client_id = public.app_client_id());

-- ── service_requests ─────────────────────────────────────────────────────────
create sequence if not exists public.service_request_seq start with 101;

create table if not exists public.service_requests (
  id            uuid primary key default gen_random_uuid(),
  request_number text unique,
  client_id     uuid references public.clients(id) on delete cascade,
  kind          text not null default 'other',
                -- new_authority | authority_reinstatement | ifta_registration | ifta_filing |
                -- ucr | mcs150_update | boc3 | drug_consortium | form_2290 | insurance_quote |
                -- factoring_setup | broker_setup | permit | dispute | notary | other
  title         text not null,
  description   text,
  status        text not null default 'open'
                check (status in ('open','in_progress','waiting_client','waiting_third_party',
                                  'blocked','done','cancelled')),
  priority      text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  assigned_to   uuid references auth.users(id) on delete set null,
  requested_by  uuid references auth.users(id) on delete set null,
  due_date      date,
  started_at    timestamptz,
  completed_at  timestamptz,
  -- Billable services flow onto the client's next statement as a 'service' line.
  billable      boolean not null default false,
  fee_amount    numeric not null default 0,
  billed_at     timestamptz,
  statement_id  uuid references public.client_statements(id) on delete set null,
  outcome       text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz
);
create index if not exists idx_service_requests_client on public.service_requests(client_id);
create index if not exists idx_service_requests_status on public.service_requests(status, priority);
create index if not exists idx_service_requests_assignee on public.service_requests(assigned_to)
  where status not in ('done','cancelled');
create index if not exists idx_service_requests_billable on public.service_requests(billable)
  where billable = true and billed_at is null;

create or replace function public.set_service_request_number()
returns trigger language plpgsql as $$
begin
  if new.request_number is null or new.request_number = '' then
    new.request_number := 'SR-' || nextval('public.service_request_seq');
  end if;
  return new;
end;
$$;
drop trigger if exists trg_service_requests_set_number on public.service_requests;
create trigger trg_service_requests_set_number before insert on public.service_requests
  for each row execute function public.set_service_request_number();
drop trigger if exists trg_service_requests_updated_at on public.service_requests;
create trigger trg_service_requests_updated_at before update on public.service_requests
  for each row execute function public.set_updated_at();

alter table public.service_requests enable row level security;
select public._reset_policies('service_requests');
create policy service_requests_staff_all on public.service_requests for all
  using (public.is_staff()) with check (public.is_staff());
create policy service_requests_portal_select on public.service_requests for select
  using (client_id = public.app_client_id());

-- ── service_request_updates (per-request timeline) ───────────────────────────
create table if not exists public.service_request_updates (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.service_requests(id) on delete cascade,
  body        text not null,
  status_from text,
  status_to   text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_sr_updates_request on public.service_request_updates(request_id, created_at desc);

alter table public.service_request_updates enable row level security;
select public._reset_policies('service_request_updates');
create policy sr_updates_staff_all on public.service_request_updates for all
  using (public.is_staff()) with check (public.is_staff());
create policy sr_updates_portal_select on public.service_request_updates for select
  using (exists (select 1 from public.service_requests r
                 where r.id = request_id and r.client_id = public.app_client_id()));
