-- ─────────────────────────────────────────────────────────────────────────────
-- Avantra — 11 Make the load fee-column lock actually take effect.
--
-- Migration 10 wrote:
--
--   revoke update (fee_type, fee_percent, …) on public.loads from authenticated;
--
-- which does nothing here. Supabase grants ALL ON ALL TABLES IN SCHEMA public to
-- `authenticated`, and that is a TABLE-level grant. PostgreSQL will not let you
-- carve a column out of a table-level privilege: the revoke finds no
-- column-level grant to remove, warns, and the role keeps UPDATE on every
-- column. The table-level revokes on invoices and client_statements in the same
-- migration were fine — only the per-column one was ineffective.
--
-- The working pattern is to drop the table-level privilege and grant back
-- exactly the columns that should stay writable.
--
-- Derived from the catalog rather than hand-listed, so that re-running this
-- after adding a column re-grants it instead of silently leaving the new column
-- unwritable. That does mean: ADD A COLUMN TO loads → RE-RUN THIS.
--
-- Depends on 10. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare cols text;
begin
  -- Columns that must NOT be writable from a browser session:
  --   fee_*        change what Avantra earns; only canOverrideFee may set them,
  --                and that check lives in /api/protected/update
  --   dispatch_fee trigger-owned unless fee_manual
  --   gross_total  trigger-owned, always
  --   net_to_client trigger-owned, always
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'loads'
     and column_name not in (
       'fee_type', 'fee_percent', 'fee_flat', 'fee_basis', 'fee_minimum',
       'fee_manual', 'fee_waived', 'fee_waived_reason', 'dispatch_fee',
       'gross_total', 'net_to_client'
     );

  if cols is null then
    raise exception 'public.loads has no grantable columns — refusing to lock the table out';
  end if;

  revoke update on public.loads from authenticated;
  execute format('grant update (%s) on public.loads to authenticated', cols);
end $$;

-- The board, the load detail page and dispatch all keep working: status,
-- driver, equipment, dates, stops and the raw charge columns (line_haul,
-- detention, lumper …) are all still writable, and recalc_load_money() moves the
-- fee along with them from the pinned terms.
