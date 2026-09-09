-- ─────────────────────────────────────────────────────────────────────────────
-- Avantra — 10 Money-write authorization, enforced by the database.
--
-- The audit's last critical: every money-write check was client-side only.
--
-- /api/protected/update was built with exactly the right TABLE + COLUMN + ROLE
-- matrix, and its own comment names the risk — a coarse rule "would let a
-- dispatcher mark a broker invoice paid, void it, or quietly rewrite the
-- dispatch fee on a load". But nothing ever called it. Its client helper still
-- declared tables named carriers / customers / carrier_settlements, three
-- relations that have never existed in this schema, which is the tell that it
-- was ported from the brokerage skeleton and never wired in.
--
-- Meanwhile RLS on these tables is uniformly `for all using (is_staff())`, and
-- is_staff() is true for admin, dispatcher, back_office AND sales. So
-- canOverrideFee, canRecordPayment, canVoidInvoices and canIssueStatements were
-- disabled buttons and nothing more: any staff session could open devtools and
-- write any column on any of these tables directly.
--
-- Routing the app through the endpoint (this commit) fixes the app. It does not
-- fix the hole, because the browser can always skip the app. RLS cannot help —
-- it is row-level, and this is a column-level and role-level problem. Column
-- privileges are the right tool, so the grants below are what actually close it.
-- The service role is unaffected: it has its own grants, which is precisely how
-- the endpoint still works.
--
-- Depends on 03, 04, 09. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. A load's fee terms become unwritable from the browser.
--
-- Only the fee columns. The raw charge columns (line_haul, detention, lumper …)
-- stay writable on purpose: a dispatcher adding detention SHOULD move the fee
-- with it, and recalc_load_money() recomputes it from the pinned terms. Load
-- status, driver and equipment are likewise untouched, so the board and the
-- load detail page keep working exactly as before.
-- ─────────────────────────────────────────────────────────────────────────────
revoke update (
  fee_type, fee_percent, fee_flat, fee_basis, fee_minimum,
  fee_manual, fee_waived, fee_waived_reason, dispatch_fee
) on public.loads from authenticated;

-- Booking is an INSERT, and column privileges on UPDATE say nothing about it —
-- so without this a dispatcher could simply book the load at fee_percent 0.
--
-- Rather than block booking, pin the terms to the client's own plan, which is
-- what "fee terms are snapshotted onto each load at booking" was always meant
-- to mean. Anyone who may legitimately override a fee still can.
--
-- Named to sort before trg_loads_money: same-timing triggers fire in alphabetic
-- order, and recalc_load_money() must see the pinned values, not the submitted
-- ones.
create or replace function public.pin_load_fee_terms()
returns trigger language plpgsql security definer set search_path = public as $$
declare c record;
begin
  if auth.role() = 'service_role' then return new; end if;
  if public.has_role('admin', 'back_office') then return new; end if;

  select fee_type, fee_percent, fee_flat, fee_basis, fee_minimum
    into c
    from public.clients
   where id = new.client_id;

  if found then
    new.fee_type    := c.fee_type;
    new.fee_percent := c.fee_percent;
    new.fee_flat    := c.fee_flat;
    new.fee_basis   := c.fee_basis;
    new.fee_minimum := c.fee_minimum;
  end if;

  -- Waiving a fee or hand-entering one is an override, never a booking action.
  new.fee_waived := false;
  new.fee_manual := false;
  return new;
end;
$$;
drop trigger if exists trg_loads_fee_terms on public.loads;
create trigger trg_loads_fee_terms before insert on public.loads
  for each row execute function public.pin_load_fee_terms();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The financial tables become unwritable from the browser entirely.
--
-- Sending, voiding, disputing and settling are back_office actions. Every one of
-- them now goes through /api/protected/update, which checks the role before
-- using the service key. INSERT and DELETE are deliberately left alone: creating
-- an invoice or a statement is already gated by RLS, and the generator's
-- rollback delete must keep working.
-- ─────────────────────────────────────────────────────────────────────────────
revoke update on public.invoices          from authenticated;
revoke update on public.client_statements from authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The payment functions were SECURITY INVOKER, so the revokes above would
--    have broken them. They become SECURITY DEFINER — which means they can no
--    longer lean on the caller's RLS and must check the role themselves.
--
-- Same rule the endpoint applies: recording a payment is back_office (or
-- admin/master). A dispatcher, a sales user, and a client-portal user are all
-- refused here rather than merely having the button hidden.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.record_statement_payment(
  p_statement_id uuid,
  p_amount       numeric,
  p_paid_date    date    default null,
  p_method       text    default null,
  p_reference    text    default null
) returns public.client_statements
language plpgsql security definer set search_path = public as $$
declare rec public.client_statements;
begin
  if not (auth.role() = 'service_role' or public.has_role('admin', 'back_office')) then
    raise exception 'You do not have permission to record payments'
      using errcode = '42501';
  end if;
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
    raise exception 'Statement not found or already voided';
  end if;
  return rec;
end;
$$;

create or replace function public.record_invoice_payment(
  p_invoice_id uuid,
  p_amount     numeric,
  p_paid_date  date    default null,
  p_method     text    default null,
  p_reference  text    default null
) returns public.invoices
language plpgsql security definer set search_path = public as $$
declare rec public.invoices;
begin
  if not (auth.role() = 'service_role' or public.has_role('admin', 'back_office')) then
    raise exception 'You do not have permission to record payments'
      using errcode = '42501';
  end if;
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
    raise exception 'Invoice not found or already voided';
  end if;

  if rec.status = 'paid' and rec.load_id is not null then
    update public.loads set status = 'paid' where id = rec.load_id;
  end if;

  return rec;
end;
$$;

revoke all on function public.record_statement_payment(uuid, numeric, date, text, text) from public;
revoke all on function public.record_invoice_payment(uuid, numeric, date, text, text)   from public;
grant execute on function public.record_statement_payment(uuid, numeric, date, text, text) to authenticated;
grant execute on function public.record_invoice_payment(uuid, numeric, date, text, text)   to authenticated;
