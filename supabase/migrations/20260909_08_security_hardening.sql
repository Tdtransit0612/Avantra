-- ─────────────────────────────────────────────────────────────────────────────
-- Avantra — 08 Security hardening.
--
-- Three findings from the pre-launch audit, all confirmed against the live
-- database. Every one of them is a case of code and schema drifting apart.
--
--  1. prevent_profile_privilege_escalation() pinned role and is_master_admin,
--     but migration 02 later added profiles.client_id and made it the tenancy
--     key for the whole client portal. The trigger was never updated, so any
--     authenticated user could PATCH their own client_id and read another
--     carrier's entire book.
--
--  2. company_settings was readable by every authenticated user. The same row
--     carries billing_settings, which holds Avantra's ACH routing and account
--     numbers. Signup is open, so the audience for those was "anyone with an
--     email address".
--
--  3. login_attempts is read and written by /api/auth/login-track but exists in
--     no migration. The lockout has never worked.
--
-- Depends on 01 and 02. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Pin every column a user must not be able to grant themselves.
--
-- RLS is ROW-level, not column-level: profiles_update lets a user write their
-- own row, and nothing stopped them choosing which columns. role and
-- is_master_admin were pinned; client_id and mfa_enrolled were not.
--
--   client_id    is the tenancy key. app_client_id() reads it, and roughly a
--                dozen portal policies funnel through that — clients,
--                client_drivers, client_equipment, client_onboarding_steps,
--                loads, load_stops, load_check_calls, invoices,
--                client_statements, statement_lines, compliance_items,
--                service_requests, documents. Setting it to another carrier's
--                uuid hands over their loads, rates, invoices, statements,
--                driver CDL numbers and documents.
--
--   mfa_enrolled is what the middleware trusts when deciding whether to force
--                /setup-2fa. Self-attested, it let the account switch off the
--                control that protects it.
--
-- Admin paths are unaffected: /api/users uses the service role, which returns
-- early above.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.prevent_profile_privilege_escalation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.role() = 'service_role' then
    return new;  -- service role (server, role-checked) may change anything
  end if;
  new.role            := old.role;
  new.is_master_admin := old.is_master_admin;
  new.client_id       := old.client_id;
  new.mfa_enrolled    := old.mfa_enrolled;
  return new;
end;
$$;

drop trigger if exists trg_profiles_priv_esc on public.profiles;
create trigger trg_profiles_priv_esc before update on public.profiles
  for each row execute function public.prevent_profile_privilege_escalation();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Close company_settings, and hand out only the two fields that genuinely
--    need to be readable by everyone.
--
-- The old policy was `using (auth.uid() is not null)`, justified by
-- role_permissions being "needed everywhere". That is true, but RLS cannot hand
-- out one column and withhold another — so it also handed out billing_settings.
--
-- SELECT is now admin/back_office only: the settings page is admin, and billing
-- generation is back_office. Everything else reads get_app_config() below.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.company_settings enable row level security;
select public._reset_policies('company_settings');

create policy company_settings_select on public.company_settings for select
  using (public.has_role('admin', 'back_office'));
create policy company_settings_write on public.company_settings for all
  using (public.has_role('admin')) with check (public.has_role('admin'));

-- The narrow read. Returns ONLY the two non-sensitive fields the app needs on
-- every request — never company_identity and never billing_settings. Being
-- SECURITY DEFINER it bypasses the policy above, which is the entire point:
-- a client-portal or pending user can resolve their permissions and the 2FA
-- requirement without being able to see Avantra's bank details.
create or replace function public.get_app_config()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object(
              'role_permissions', coalesce(role_permissions, '{}'::jsonb),
              'require_2fa',      coalesce(require_2fa, true))
       from public.company_settings
      order by id
      limit 1),
    jsonb_build_object('role_permissions', '{}'::jsonb, 'require_2fa', true))
$$;

revoke all on function public.get_app_config() from public;
grant execute on function public.get_app_config() to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The account-lockout store.
--
-- Columns match exactly what /api/auth/login-track upserts. Only the service
-- role touches this table, so RLS is enabled with NO policies at all: the
-- service role bypasses RLS, and every other caller is denied by default. That
-- also keeps the failed-login history of every user account away from the
-- browser, which is the right posture for it.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.login_attempts (
  email           text primary key,
  failed_count    integer not null default 0,
  locked_until    timestamptz,
  last_attempt_at timestamptz not null default now()
);

-- Lets a cleanup job find stale rows without a sequential scan.
create index if not exists idx_login_attempts_last on public.login_attempts(last_attempt_at desc);

alter table public.login_attempts enable row level security;
select public._reset_policies('login_attempts');
-- Intentionally no policies. See above.
