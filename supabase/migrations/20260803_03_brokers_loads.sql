-- ─────────────────────────────────────────────────────────────────────────────
-- Avantra — 03 Brokers + Loads: the counterparties we book with, the central
-- load fact table, multi-stop support, and the check-call log.
--
-- Money on a load runs the OPPOSITE direction from a brokerage. The broker pays
-- the GROSS to our client (or their factor). We take a DISPATCH FEE off that
-- gross; net_to_client is what the carrier keeps. There is no margin — our
-- revenue is dispatch_fee, full stop. Depends on 01–02. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

-- ── brokers (who pays the freight bill) ──────────────────────────────────────
create table if not exists public.brokers (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  mc_number         text,
  dot_number        text,
  -- Contact
  contact_name      text,
  phone             text,
  after_hours_phone text,
  email             text,
  billing_email     text,
  address           text,
  city              text,
  state             text,
  zip               text,
  -- Credit / payment behaviour — what makes a broker safe to haul for
  payment_terms     text,                       -- "Net 30", "Quick Pay 2%" …
  days_to_pay       integer,                    -- observed average, updated from paid invoices
  credit_rating     text,                       -- free-text (Ansonia / broker credit score)
  credit_limit      numeric,
  -- Setup packet: are we able to invoice them on a client's behalf yet?
  packet_status     text not null default 'none'
                    check (packet_status in ('none','sent','pending','complete')),
  packet_completed_at date,
  -- Blocklist
  do_not_use        boolean not null default false,
  do_not_use_reason text,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz
);
create index if not exists idx_brokers_name on public.brokers(lower(name));
create index if not exists idx_brokers_mc on public.brokers(mc_number);
create index if not exists idx_brokers_dnu on public.brokers(do_not_use) where do_not_use = true;
drop trigger if exists trg_brokers_updated_at on public.brokers;
create trigger trg_brokers_updated_at before update on public.brokers
  for each row execute function public.set_updated_at();

alter table public.brokers enable row level security;
select public._reset_policies('brokers');
create policy brokers_staff_all on public.brokers for all
  using (public.is_staff()) with check (public.is_staff());

-- ── loads ────────────────────────────────────────────────────────────────────
-- Single-pickup/single-drop details live denormalized on the load itself (the
-- common case, and it keeps the board query to one table). Extra stops go in
-- load_stops; the denormalized columns always mirror the FIRST pickup and LAST
-- delivery so lists and the public tracking page never need the join.
create sequence if not exists public.load_number_seq start with 10001;

create table if not exists public.loads (
  id                 uuid primary key default gen_random_uuid(),
  load_number        text unique,
  status             text not null default 'sourced'
                     check (status in ('sourced','offered','booked','dispatched','at_pickup',
                                       'in_transit','at_delivery','delivered','docs_received',
                                       'invoiced','paid','cancelled','tonu')),
  -- Who it's for / who pays
  client_id          uuid references public.clients(id) on delete set null,
  client_name        text,
  broker_id          uuid references public.brokers(id) on delete set null,
  broker_name        text,
  broker_load_number text,
  source             text not null default 'broker_direct'
                     check (source in ('dat','truckstop','broker_direct','client','relationship','other')),
  -- Assignment (the client's own driver + equipment)
  driver_id          uuid references public.client_drivers(id) on delete set null,
  driver_name        text,
  truck_id           uuid references public.client_equipment(id) on delete set null,
  trailer_id         uuid references public.client_equipment(id) on delete set null,
  -- Pickup (first stop)
  shipper_name       text,
  shipper_address    text,
  pickup_city        text,
  pickup_state       text,
  pickup_zip         text,
  pickup_date        date,
  pickup_time        text,
  pickup_appt        text,
  -- Delivery (last stop)
  consignee_name     text,
  consignee_address  text,
  delivery_city      text,
  delivery_state     text,
  delivery_zip       text,
  delivery_date      date,
  delivery_time      text,
  delivery_appt      text,
  -- Freight
  commodity          text,
  weight             numeric,
  temperature        text,
  equipment_type     text,
  miles              numeric,
  stop_count         integer not null default 2,
  -- Money the BROKER pays (all revenue belongs to the client, not to us)
  line_haul          numeric not null default 0,
  fuel_surcharge     numeric not null default 0,
  accessorials       numeric not null default 0,
  detention          numeric not null default 0,
  lumper             numeric not null default 0,
  other_charges      numeric not null default 0,
  gross_total        numeric not null default 0,   -- maintained by recalc_load_money()
  -- Dispatch fee terms, SNAPSHOTTED from the client at booking so changing the
  -- client's plan later never rewrites history.
  fee_type           text not null default 'percent' check (fee_type in ('percent','flat')),
  fee_percent        numeric not null default 10,
  fee_flat           numeric not null default 0,
  fee_basis          text not null default 'gross' check (fee_basis in ('gross','linehaul')),
  fee_minimum        numeric not null default 0,
  fee_manual         boolean not null default false,  -- true = dispatch_fee entered by hand
  fee_waived         boolean not null default false,
  fee_waived_reason  text,
  dispatch_fee       numeric not null default 0,   -- OUR revenue. maintained by trigger
  net_to_client      numeric not null default 0,   -- gross_total − dispatch_fee
  -- References / paperwork
  ref_number         text,
  po_number          text,
  bol_number         text,
  seal_number        text,
  rate_con_path      text,                          -- private `documents` object path
  rate_con_received_at timestamptz,
  pod_path           text,
  pod_received_at    timestamptz,
  -- Lifecycle timestamps
  offered_at         timestamptz,
  booked_at          timestamptz,
  dispatched_at      timestamptz,
  picked_up_at       timestamptz,
  delivered_at       timestamptz,
  cancelled_at       timestamptz,
  cancel_reason      text,
  -- Public tracking
  tracking_token     uuid not null default gen_random_uuid(),
  tracking_active    boolean not null default true,
  notes              text,
  dispatcher_id      uuid references auth.users(id) on delete set null,
  deleted_at         timestamptz,
  deleted_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz
);
create unique index if not exists idx_loads_tracking_token on public.loads(tracking_token);
create index if not exists idx_loads_status on public.loads(status) where deleted_at is null;
create index if not exists idx_loads_client on public.loads(client_id) where deleted_at is null;
create index if not exists idx_loads_broker on public.loads(broker_id) where deleted_at is null;
create index if not exists idx_loads_driver on public.loads(driver_id) where deleted_at is null;
create index if not exists idx_loads_pickup_date on public.loads(pickup_date desc);
create index if not exists idx_loads_lane on public.loads(pickup_state, delivery_state);

-- Auto load number.
create or replace function public.set_load_number()
returns trigger language plpgsql as $$
begin
  if new.load_number is null or new.load_number = '' then
    new.load_number := 'AV-' || nextval('public.load_number_seq');
  end if;
  return new;
end;
$$;

-- ── The money engine ─────────────────────────────────────────────────────────
-- A trigger rather than generated columns: the fee needs a minimum, a manual
-- override, and a waive path, none of which a generated column can express
-- (and Postgres forbids a generated column referencing another one anyway).
create or replace function public.recalc_load_money()
returns trigger language plpgsql as $$
declare
  v_gross numeric;
  v_base  numeric;
  v_fee   numeric;
begin
  v_gross := coalesce(new.line_haul,0) + coalesce(new.fuel_surcharge,0)
           + coalesce(new.accessorials,0) + coalesce(new.detention,0)
           + coalesce(new.lumper,0) + coalesce(new.other_charges,0);

  if new.fee_waived or new.status = 'cancelled' then
    v_fee := 0;
  elsif new.fee_manual then
    v_fee := coalesce(new.dispatch_fee, 0);          -- respect the hand-entered value
  else
    v_base := case when new.fee_basis = 'linehaul'
                   then coalesce(new.line_haul, 0)
                   else v_gross end;
    v_fee  := case when new.fee_type = 'flat'
                   then coalesce(new.fee_flat, 0)
                   else round(v_base * coalesce(new.fee_percent, 0) / 100.0, 2) end;
    -- A minimum only applies once there's actually money on the load, so a blank
    -- draft doesn't show a fee owed.
    if coalesce(new.fee_minimum, 0) > 0 and v_base > 0 then
      v_fee := greatest(v_fee, new.fee_minimum);
    end if;
  end if;

  new.gross_total   := round(v_gross, 2);
  new.dispatch_fee  := round(v_fee, 2);
  new.net_to_client := round(v_gross - v_fee, 2);
  return new;
end;
$$;

drop trigger if exists trg_loads_set_number on public.loads;
create trigger trg_loads_set_number before insert on public.loads
  for each row execute function public.set_load_number();
drop trigger if exists trg_loads_money on public.loads;
create trigger trg_loads_money before insert or update on public.loads
  for each row execute function public.recalc_load_money();
drop trigger if exists trg_loads_updated_at on public.loads;
create trigger trg_loads_updated_at before update on public.loads
  for each row execute function public.set_updated_at();

alter table public.loads enable row level security;
select public._reset_policies('loads');
create policy loads_staff_all on public.loads for all
  using (public.is_staff()) with check (public.is_staff());
-- Portal: a client sees only their own loads, read-only.
create policy loads_portal_select on public.loads for select
  using (client_id = public.app_client_id() and deleted_at is null);

-- ── load_stops (stops 2..n on a multi-stop load) ─────────────────────────────
create table if not exists public.load_stops (
  id            uuid primary key default gen_random_uuid(),
  load_id       uuid not null references public.loads(id) on delete cascade,
  seq           integer not null default 1,
  stop_type     text not null default 'pickup' check (stop_type in ('pickup','delivery')),
  facility_name text,
  address       text,
  city          text,
  state         text,
  zip           text,
  stop_date     date,
  stop_time     text,
  appt_number   text,
  reference     text,
  instructions  text,
  arrived_at    timestamptz,
  departed_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists idx_load_stops_load on public.load_stops(load_id, seq);

alter table public.load_stops enable row level security;
select public._reset_policies('load_stops');
create policy load_stops_staff_all on public.load_stops for all
  using (public.is_staff()) with check (public.is_staff());
create policy load_stops_portal_select on public.load_stops for select
  using (exists (select 1 from public.loads l
                 where l.id = load_id and l.client_id = public.app_client_id()));

-- ── load_check_calls ─────────────────────────────────────────────────────────
-- Dispatcher check-ins. Rows flagged is_public surface on the anonymous
-- /track/<token> page through a whitelisting RPC (see migration 06).
create table if not exists public.load_check_calls (
  id           uuid primary key default gen_random_uuid(),
  load_id      uuid not null references public.loads(id) on delete cascade,
  occurred_at  timestamptz not null default now(),
  location     text,
  city         text,
  state        text,
  status_note  text,                 -- "loaded, rolling", "at receiver door 12" …
  eta          timestamptz,
  temperature  text,                 -- reefer set-point confirmation
  miles_out    numeric,
  notes        text,                 -- INTERNAL — never exposed publicly
  is_public    boolean not null default true,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists idx_check_calls_load on public.load_check_calls(load_id, occurred_at desc);

alter table public.load_check_calls enable row level security;
select public._reset_policies('load_check_calls');
create policy check_calls_staff_all on public.load_check_calls for all
  using (public.is_staff()) with check (public.is_staff());
create policy check_calls_portal_select on public.load_check_calls for select
  using (exists (select 1 from public.loads l
                 where l.id = load_id and l.client_id = public.app_client_id()));
