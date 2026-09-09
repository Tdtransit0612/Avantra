-- ─────────────────────────────────────────────────────────────────────────────
-- Avantra — 09 Money correctness.
--
-- Two audit findings, both about money, both confirmed against the code.
--
--  1. Voiding a fee statement permanently stranded its loads. The uniqueness
--     guard idx_statement_lines_one_fee_per_load has no status predicate, so a
--     fee line reserved its load forever. The invoice side got this right —
--     idx_invoices_one_per_load carries `where ... status <> 'void'`, with the
--     comment "A voided invoice frees the load to be re-invoiced" — but a
--     statement line's status lives on the PARENT row, and a partial index
--     cannot reference another table. Hence the denormalized flag below.
--
--     The consequence was not cosmetic: void a statement cut for the wrong
--     period and those loads can never be billed again through the UI, because
--     the generator's scan excludes any load with a fee line regardless of
--     whether that line's statement still counts. That is Avantra's own revenue
--     silently becoming unbillable.
--
--  2. Recording a second payment OVERWROTE the first. `amount_paid: amt` is a
--     replacement, and "is it paid in full" compared a single remittance
--     against the whole total rather than the outstanding balance. $400 then
--     $600 against a $1,000 statement left amount_paid = 600, status stuck at
--     'partial', $400 of phantom AR on the books, and a client still being
--     chased for money they had already sent. Both sides had it: client
--     statements and broker invoices.
--
--     Accumulating in app code would swap that bug for a lost-update race
--     between two people posting cheques at once, so the read-modify-write
--     happens here, in one statement, under the row lock the UPDATE takes.
--
-- Depends on 03 and 04. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Let a voided statement release its loads.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.statement_lines
  add column if not exists voided boolean not null default false;

-- Anything already sitting under a voided header is released by this backfill.
update public.statement_lines sl
   set voided = true
  from public.client_statements cs
 where sl.statement_id = cs.id
   and cs.status = 'void'
   and sl.voided = false;

-- Swap the guard for one that ignores released lines. Same protection against
-- double-billing a live load; no longer a life sentence.
drop index if exists public.idx_statement_lines_one_fee_per_load;
create unique index if not exists idx_statement_lines_one_fee_per_load
  on public.statement_lines(load_id)
  where load_id is not null and kind = 'fee' and not voided;

-- Keep the flag true to the parent's status, so nobody has to remember to set
-- it and a future void path cannot forget.
create or replace function public.sync_statement_line_void()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    update public.statement_lines
       set voided = (new.status = 'void')
     where statement_id = new.id
       and voided is distinct from (new.status = 'void');
  end if;
  return new;
end;
$$;
drop trigger if exists trg_statement_void_lines on public.client_statements;
create trigger trg_statement_void_lines after update on public.client_statements
  for each row execute function public.sync_statement_line_void();

-- A line added to an already-void statement inherits its state rather than
-- re-reserving the load.
create or replace function public.inherit_statement_line_void()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.voided := coalesce(
    (select status = 'void' from public.client_statements where id = new.statement_id),
    false);
  return new;
end;
$$;
drop trigger if exists trg_statement_line_inherit_void on public.statement_lines;
create trigger trg_statement_line_inherit_void before insert on public.statement_lines
  for each row execute function public.inherit_statement_line_void();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Payments accumulate, atomically.
--
-- Both functions are SECURITY INVOKER on purpose: the caller's RLS still
-- decides whether they may touch the row. These exist to make the arithmetic
-- correct and race-free, not to widen access.
-- ─────────────────────────────────────────────────────────────────────────────

-- Client → Avantra. This is our revenue.
create or replace function public.record_statement_payment(
  p_statement_id uuid,
  p_amount       numeric,
  p_paid_date    date    default null,
  p_method       text    default null,
  p_reference    text    default null
) returns public.client_statements
language plpgsql security invoker set search_path = public as $$
declare rec public.client_statements;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment amount must be greater than zero';
  end if;

  update public.client_statements s
     set amount_paid       = coalesce(s.amount_paid, 0) + p_amount,
         status            = case
                               when coalesce(s.amount_paid, 0) + p_amount >= s.amount_due
                                 then 'paid'
                               else 'partial'
                             end,
         paid_date         = coalesce(p_paid_date, current_date),
         payment_method    = coalesce(p_method, s.payment_method),
         payment_reference = coalesce(p_reference, s.payment_reference)
   where s.id = p_statement_id
     and s.status <> 'void'
  returning s.* into rec;

  if rec.id is null then
    raise exception 'Statement not found, already voided, or not yours to edit';
  end if;
  return rec;
end;
$$;

-- Broker → the client carrier. NOT our money; we only bill and chase it.
create or replace function public.record_invoice_payment(
  p_invoice_id uuid,
  p_amount     numeric,
  p_paid_date  date    default null,
  p_method     text    default null,
  p_reference  text    default null
) returns public.invoices
language plpgsql security invoker set search_path = public as $$
declare rec public.invoices;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment amount must be greater than zero';
  end if;

  update public.invoices i
     set amount_paid       = coalesce(i.amount_paid, 0) + p_amount,
         status            = case
                               when coalesce(i.amount_paid, 0) + p_amount >= i.amount
                                 then 'paid'
                               else 'partial'
                             end,
         paid_date         = coalesce(p_paid_date, current_date),
         payment_method    = coalesce(p_method, i.payment_method),
         payment_reference = coalesce(p_reference, i.payment_reference)
   where i.id = p_invoice_id
     and i.status <> 'void'
  returning i.* into rec;

  if rec.id is null then
    raise exception 'Invoice not found, already voided, or not yours to edit';
  end if;

  -- Settling the load follows the invoice, and only once it is fully paid.
  -- In the function so it cannot drift out of step with the status above.
  if rec.status = 'paid' and rec.load_id is not null then
    update public.loads set status = 'paid' where id = rec.load_id;
  end if;

  return rec;
end;
$$;
