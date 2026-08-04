-- ─────────────────────────────────────────────────────────────────────────────
-- Avantra — 04 Billing. Two distinct money flows, deliberately separate tables:
--
--   invoices           → we bill the BROKER, in our CLIENT's name, for the load.
--                        The money lands with the client (or their factor), not
--                        with us. We track it because chasing it IS the service.
--   client_statements  → we bill our CLIENT for the dispatch fees they owe us.
--                        This is Avantra's actual revenue.
--
-- invoice_traces is the collections/"invoice tracing" activity log — the audit
-- trail that proves the chasing happened. Depends on 01–03. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

-- ── invoices (broker-facing, issued on the client's behalf) ──────────────────
create sequence if not exists public.invoice_number_seq start with 5001;

create table if not exists public.invoices (
  id                 uuid primary key default gen_random_uuid(),
  invoice_number     text unique,
  load_id            uuid references public.loads(id) on delete set null,
  client_id          uuid references public.clients(id) on delete set null,
  broker_id          uuid references public.brokers(id) on delete set null,
  status             text not null default 'draft'
                     check (status in ('draft','sent','factored','partial','paid',
                                       'overdue','disputed','written_off','void')),
  amount             numeric not null default 0,
  amount_paid        numeric not null default 0,
  -- Dates / terms
  issued_date        date,
  due_date           date,
  terms              text,                       -- "Net 30"
  sent_at            timestamptz,
  sent_to            text,
  -- Factoring: submitted to the client's factor, who advances against it
  factored_at        timestamptz,
  factoring_company_id uuid references public.factoring_companies(id) on delete set null,
  factoring_reference text,
  funded_at          timestamptz,
  funded_amount      numeric,
  factoring_fee      numeric,
  -- Settlement
  paid_date          date,
  payment_method     text check (payment_method in ('ach','check','wire','factor','other')),
  payment_reference  text,
  -- Collections / invoice tracing
  last_traced_at     timestamptz,
  trace_count        integer not null default 0,
  next_follow_up     date,
  dispute_reason     text,
  -- Paperwork
  invoice_pdf_path   text,                       -- private `documents` object path
  packet_path        text,                       -- invoice + BOL + POD combined packet
  -- Void audit trio
  voided_at          timestamptz,
  voided_by          uuid references auth.users(id) on delete set null,
  void_reason        text,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz
);
-- One live invoice per load. A voided invoice frees the load to be re-invoiced.
create unique index if not exists idx_invoices_one_per_load
  on public.invoices(load_id) where load_id is not null and status <> 'void';
create index if not exists idx_invoices_status on public.invoices(status);
create index if not exists idx_invoices_client on public.invoices(client_id);
create index if not exists idx_invoices_broker on public.invoices(broker_id);
create index if not exists idx_invoices_due on public.invoices(due_date)
  where status in ('sent','factored','partial','overdue');

create or replace function public.set_invoice_number()
returns trigger language plpgsql as $$
begin
  if new.invoice_number is null or new.invoice_number = '' then
    new.invoice_number := 'INV-' || nextval('public.invoice_number_seq');
  end if;
  return new;
end;
$$;
drop trigger if exists trg_invoices_set_number on public.invoices;
create trigger trg_invoices_set_number before insert on public.invoices
  for each row execute function public.set_invoice_number();
drop trigger if exists trg_invoices_updated_at on public.invoices;
create trigger trg_invoices_updated_at before update on public.invoices
  for each row execute function public.set_updated_at();

alter table public.invoices enable row level security;
select public._reset_policies('invoices');
create policy invoices_staff_all on public.invoices for all
  using (public.is_staff()) with check (public.is_staff());
create policy invoices_portal_select on public.invoices for select
  using (client_id = public.app_client_id());

-- ── invoice_traces (the collections activity log) ────────────────────────────
-- Every chase attempt against a broker invoice. Keeping this append-only-ish and
-- attributed is what lets us show a client exactly what we did to get them paid.
create table if not exists public.invoice_traces (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references public.invoices(id) on delete cascade,
  traced_at     timestamptz not null default now(),
  method        text not null default 'call' check (method in ('call','email','portal','letter','other')),
  contact_name  text,
  contact_info  text,
  outcome       text not null default 'no_answer'
                check (outcome in ('no_answer','left_message','promised_payment','in_process',
                                   'disputed','short_paid','paid','escalated','other')),
  promised_date date,
  notes         text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists idx_invoice_traces_invoice on public.invoice_traces(invoice_id, traced_at desc);

-- Keep the invoice's rollup counters honest without the app having to remember.
create or replace function public.bump_invoice_trace_counters()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.invoices
     set trace_count    = (select count(*) from public.invoice_traces where invoice_id = new.invoice_id),
         last_traced_at = (select max(traced_at) from public.invoice_traces where invoice_id = new.invoice_id),
         next_follow_up = coalesce(new.promised_date, next_follow_up)
   where id = new.invoice_id;
  return new;
end;
$$;
drop trigger if exists trg_invoice_traces_bump on public.invoice_traces;
create trigger trg_invoice_traces_bump after insert on public.invoice_traces
  for each row execute function public.bump_invoice_trace_counters();

alter table public.invoice_traces enable row level security;
select public._reset_policies('invoice_traces');
create policy invoice_traces_staff_all on public.invoice_traces for all
  using (public.is_staff()) with check (public.is_staff());
create policy invoice_traces_portal_select on public.invoice_traces for select
  using (exists (select 1 from public.invoices i
                 where i.id = invoice_id and i.client_id = public.app_client_id()));

-- ── client_statements (Avantra's revenue: the dispatch-fee bill) ─────────────
create sequence if not exists public.statement_number_seq start with 2001;

create table if not exists public.client_statements (
  id                uuid primary key default gen_random_uuid(),
  statement_number  text unique,
  client_id         uuid not null references public.clients(id) on delete cascade,
  period_start      date not null,
  period_end        date not null,
  status            text not null default 'draft'
                    check (status in ('draft','sent','partial','paid','overdue','void')),
  load_count        integer not null default 0,
  total_gross       numeric not null default 0,   -- gross the client billed on these loads
  total_fees        numeric not null default 0,   -- our fees on those loads
  adjustments       numeric not null default 0,   -- credits/discounts (negative) or add-ons
  amount_due        numeric not null default 0,   -- total_fees + adjustments
  amount_paid       numeric not null default 0,
  issued_date       date,
  due_date          date,
  sent_at           timestamptz,
  paid_date         date,
  payment_method    text check (payment_method in ('ach','check','wire','card','other')),
  payment_reference text,
  pdf_path          text,
  voided_at         timestamptz,
  voided_by         uuid references auth.users(id) on delete set null,
  void_reason       text,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz
);
create index if not exists idx_statements_client on public.client_statements(client_id, period_end desc);
create index if not exists idx_statements_status on public.client_statements(status);

create or replace function public.set_statement_number()
returns trigger language plpgsql as $$
begin
  if new.statement_number is null or new.statement_number = '' then
    new.statement_number := 'ST-' || nextval('public.statement_number_seq');
  end if;
  return new;
end;
$$;
drop trigger if exists trg_statements_set_number on public.client_statements;
create trigger trg_statements_set_number before insert on public.client_statements
  for each row execute function public.set_statement_number();
drop trigger if exists trg_statements_updated_at on public.client_statements;
create trigger trg_statements_updated_at before update on public.client_statements
  for each row execute function public.set_updated_at();

alter table public.client_statements enable row level security;
select public._reset_policies('client_statements');
create policy client_statements_staff_all on public.client_statements for all
  using (public.is_staff()) with check (public.is_staff());
create policy client_statements_portal_select on public.client_statements for select
  using (client_id = public.app_client_id());

-- ── statement_lines ──────────────────────────────────────────────────────────
create table if not exists public.statement_lines (
  id           uuid primary key default gen_random_uuid(),
  statement_id uuid not null references public.client_statements(id) on delete cascade,
  load_id      uuid references public.loads(id) on delete set null,
  kind         text not null default 'fee' check (kind in ('fee','adjustment','credit','service')),
  description  text not null,
  load_gross   numeric not null default 0,
  amount       numeric not null default 0,   -- what the client owes for this line
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists idx_statement_lines_statement on public.statement_lines(statement_id, sort_order);
-- A load's fee can only land on one statement, so a re-run can't double-bill.
create unique index if not exists idx_statement_lines_one_fee_per_load
  on public.statement_lines(load_id) where load_id is not null and kind = 'fee';

-- Recompute the statement header whenever its lines change.
create or replace function public.recalc_statement_totals()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_stmt uuid;
begin
  v_stmt := coalesce(new.statement_id, old.statement_id);
  update public.client_statements s
     set load_count  = (select count(*) from public.statement_lines
                        where statement_id = v_stmt and kind = 'fee'),
         total_gross = (select coalesce(sum(load_gross),0) from public.statement_lines
                        where statement_id = v_stmt and kind = 'fee'),
         total_fees  = (select coalesce(sum(amount),0) from public.statement_lines
                        where statement_id = v_stmt and kind = 'fee'),
         adjustments = (select coalesce(sum(amount),0) from public.statement_lines
                        where statement_id = v_stmt and kind <> 'fee'),
         amount_due  = (select coalesce(sum(amount),0) from public.statement_lines
                        where statement_id = v_stmt)
   where s.id = v_stmt;
  return null;
end;
$$;
drop trigger if exists trg_statement_lines_recalc on public.statement_lines;
create trigger trg_statement_lines_recalc
  after insert or update or delete on public.statement_lines
  for each row execute function public.recalc_statement_totals();

alter table public.statement_lines enable row level security;
select public._reset_policies('statement_lines');
create policy statement_lines_staff_all on public.statement_lines for all
  using (public.is_staff()) with check (public.is_staff());
create policy statement_lines_portal_select on public.statement_lines for select
  using (exists (select 1 from public.client_statements s
                 where s.id = statement_id and s.client_id = public.app_client_id()));
