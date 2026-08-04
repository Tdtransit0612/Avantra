-- ─────────────────────────────────────────────────────────────────────────────
-- Avantra Carrier Services — 01 Foundation: extensions, RLS helper spine,
-- profiles, company_settings, audit_log.
--
-- Run in the Supabase SQL editor in filename order. Every statement is
-- idempotent (safe to re-run). These migrations are the SCHEMA OF RECORD.
--
-- Business model reminder for anyone reading the schema cold: Avantra is a
-- dispatch-service AGENT, not a broker and not an asset carrier. Our CLIENTS are
-- motor carriers (owner-operators / small fleets). We source freight for them
-- from BROKERS, dispatch it on their trucks, invoice the broker on their behalf,
-- and bill the client a DISPATCH FEE. Money flows:
--     broker → client carrier (or their factor)        [the load pays them]
--     client → Avantra                                  [the dispatch fee pays us]
-- ─────────────────────────────────────────────────────────────────────────────

-- Allow the helper functions below to reference tables (profiles) created later
-- in this script — bodies are validated lazily, like pg_dump does. Session-only.
set check_function_bodies = off;

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ── Generic updated_at trigger ───────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

-- ── RLS helper spine (all SECURITY DEFINER so they bypass RLS internally) ─────
create or replace function public.app_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.is_master()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_master_admin from public.profiles where id = auth.uid()), false)
$$;

-- The workhorse: is the caller Avantra staff (as opposed to a client-portal user)?
create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select is_master_admin
       or role in ('admin','dispatcher','back_office','sales')
     from public.profiles where id = auth.uid()),
    false)
$$;

create or replace function public.has_role(variadic roles text[])
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select is_master_admin or role = any(roles)
     from public.profiles where id = auth.uid()),
    false)
$$;

-- Drop EVERY existing policy on a table before recreating the intended set, so a
-- stale permissive policy can't survive a re-run.
create or replace function public._reset_policies(tbl text)
returns void language plpgsql as $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = tbl
  loop
    execute format('drop policy if exists %I on public.%I', p.policyname, tbl);
  end loop;
end;
$$;

-- ── profiles ─────────────────────────────────────────────────────────────────
-- PK = auth.users.id. Auto-provisioned at signup (default 'pending'); role +
-- master flag are pinned against self-escalation by the trigger below.
--
-- Roles:
--   admin       — everything
--   dispatcher  — sources + books + dispatches loads, runs the board
--   back_office — invoicing, factoring, invoice tracing/AR, statements, paperwork
--   sales       — prospecting + client onboarding
--   client      — EXTERNAL: a carrier client logging into their own portal
--   pending / terminated — lifecycle states with no data access
create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  email           text,
  full_name       text,
  phone           text,
  role            text not null default 'pending'
                  check (role in ('admin','dispatcher','back_office','sales','client','pending','terminated')),
  is_master_admin boolean not null default false,
  mfa_enrolled    boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz
);
drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- Auto-create a profile row when an auth user is created.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'pending')
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Pin role / is_master_admin unless the writer is the service role. RLS is
-- row-level, not column-level, so without this a user could PATCH their own row
-- to admin.
create or replace function public.prevent_profile_privilege_escalation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.role() = 'service_role' then
    return new;  -- service role (server, role-checked) may change anything
  end if;
  new.role := old.role;
  new.is_master_admin := old.is_master_admin;
  return new;
end;
$$;
drop trigger if exists trg_profiles_priv_esc on public.profiles;
create trigger trg_profiles_priv_esc before update on public.profiles
  for each row execute function public.prevent_profile_privilege_escalation();

alter table public.profiles enable row level security;
select public._reset_policies('profiles');
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or public.is_staff());
create policy profiles_update on public.profiles for update
  using (id = auth.uid() or public.has_role('admin'))
  with check (id = auth.uid() or public.has_role('admin'));
create policy profiles_insert on public.profiles for insert
  with check (public.has_role('admin'));

-- ── company_settings (singleton) ─────────────────────────────────────────────
create table if not exists public.company_settings (
  id                 integer primary key default 1 check (id = 1),
  company_name       text not null default 'Avantra Carrier Services',
  company_identity   jsonb not null default '{}'::jsonb,  -- name/address/logo for PDFs
  role_permissions   jsonb not null default '{}'::jsonb,  -- consumed by @/lib/access
  billing_settings   jsonb not null default '{}'::jsonb,  -- remit-to / ACH for fee statements
  dispatch_defaults  jsonb not null default '{}'::jsonb,  -- default fee %, basis, minimum
  require_2fa        boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz
);
insert into public.company_settings (id) values (1) on conflict (id) do nothing;
drop trigger if exists trg_company_settings_updated_at on public.company_settings;
create trigger trg_company_settings_updated_at before update on public.company_settings
  for each row execute function public.set_updated_at();

alter table public.company_settings enable row level security;
select public._reset_policies('company_settings');
-- Reads open to any authenticated user (role_permissions is needed everywhere);
-- writes admin/master only.
create policy company_settings_select on public.company_settings for select
  using (auth.uid() is not null);
create policy company_settings_write on public.company_settings for all
  using (public.has_role('admin')) with check (public.has_role('admin'));

-- ── audit_log (append-only, tamper-evident) ─────────────────────────────────
create table if not exists public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete set null,
  action      text not null,
  table_name  text,
  record_id   text,
  old_value   jsonb,
  new_value   jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_audit_log_created_at on public.audit_log(created_at desc);
create index if not exists idx_audit_log_action on public.audit_log(action);
create index if not exists idx_audit_log_record on public.audit_log(table_name, record_id);

alter table public.audit_log enable row level security;
select public._reset_policies('audit_log');
-- INSERT allowed for any authenticated user, attributed to themselves. No UPDATE
-- or DELETE policy exists → the log is append-only. Reads: admin/back_office.
create policy audit_log_insert on public.audit_log for insert
  with check (user_id = auth.uid());
create policy audit_log_select on public.audit_log for select
  using (public.has_role('admin','back_office'));
