-- ─────────────────────────────────────────────────────────────────────────────
-- Avantra — post-migration verification.
--
-- Run in the Supabase SQL editor AFTER setup.sql. Every row must say PASS.
--
-- Deliberately reads ONLY the system catalogs, never the tables themselves — so
-- it still returns a full report if the migration only half-applied, instead of
-- erroring with "relation does not exist" and telling you nothing.
-- ─────────────────────────────────────────────────────────────────────────────

with expected_tables(tbl) as (values
  ('profiles'),('company_settings'),('audit_log'),
  ('factoring_companies'),('clients'),('client_drivers'),('client_equipment'),
  ('client_onboarding_steps'),('client_notes'),
  ('brokers'),('loads'),('load_stops'),('load_check_calls'),
  ('invoices'),('invoice_traces'),('client_statements'),('statement_lines'),
  ('compliance_items'),('service_requests'),('service_request_updates'),
  ('documents')
),
expected_functions(fn) as (values
  ('set_updated_at'),('app_role'),('is_master'),('is_staff'),('has_role'),
  ('_reset_policies'),('handle_new_user'),('prevent_profile_privilege_escalation'),
  ('set_client_number'),('app_client_id'),('set_load_number'),('recalc_load_money'),
  ('set_invoice_number'),('bump_invoice_trace_counters'),('set_statement_number'),
  ('recalc_statement_totals'),('derive_compliance_status'),('set_service_request_number'),
  ('get_load_tracking'),('get_load_tracking_events')
),
expected_sequences(sq) as (values
  ('client_number_seq'),('load_number_seq'),('invoice_number_seq'),
  ('statement_number_seq'),('service_request_seq')
),
results(sort_order, check_name, expected, actual) as (

  select 1, 'Tables created', 21,
    (select count(*)::int from pg_tables t
      join expected_tables e on e.tbl = t.tablename
     where t.schemaname = 'public')

  union all
  select 2, 'RLS enabled on every table', 21,
    (select count(*)::int from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join expected_tables e on e.tbl = c.relname
     where n.nspname = 'public' and c.relrowsecurity)

  union all
  -- RLS on with zero policies denies everything, so presence matters as much as
  -- the flag above.
  select 3, 'Tables with >=1 RLS policy', 21,
    (select count(distinct p.tablename)::int from pg_policies p
      join expected_tables e on e.tbl = p.tablename
     where p.schemaname = 'public')

  union all
  select 4, 'Helper + trigger functions', 20,
    (select count(distinct p.proname)::int from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join expected_functions e on e.fn = p.proname
     where n.nspname = 'public')

  union all
  select 5, 'Number sequences', 5,
    (select count(*)::int from pg_sequences s
      join expected_sequences e on e.sq = s.sequencename
     where s.schemaname = 'public')

  union all
  -- The money engine: set_number + recalc_money + updated_at. Without recalc,
  -- gross_total / dispatch_fee / net_to_client stay 0 on every load.
  select 6, 'Triggers on loads', 3,
    (select count(*)::int from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'loads' and not t.tgisinternal)

  union all
  -- Derives compliance status from expiry_date on write.
  select 7, 'Triggers on compliance_items', 2,
    (select count(*)::int from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'compliance_items' and not t.tgisinternal)

  union all
  -- Blocks a user PATCHing their own row to admin.
  select 8, 'Privilege-escalation guard on profiles', 1,
    (select count(*)::int from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'profiles'
       and t.tgname = 'trg_profiles_priv_esc')

  union all
  select 9, 'documents bucket exists and is PRIVATE', 1,
    (select count(*)::int from storage.buckets where id = 'documents' and public = false)

  union all
  -- Anonymous /track/<token> must be able to call the whitelisting RPCs.
  select 10, 'Tracking RPCs executable by anon', 2,
    (select count(distinct p.proname)::int from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('get_load_tracking','get_load_tracking_events')
       and has_function_privilege('anon', p.oid, 'EXECUTE'))
)
select
  check_name,
  expected,
  actual,
  case when actual = expected then 'PASS' else 'FAIL' end as status
from results
order by sort_order;
