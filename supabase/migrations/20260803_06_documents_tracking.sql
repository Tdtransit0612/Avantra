-- ─────────────────────────────────────────────────────────────────────────────
-- Avantra — 06 Documents + public tracking.
--
-- The `documents` storage bucket is PRIVATE. Nothing in the app ever calls
-- getPublicUrl(); files are read exclusively through short-lived signed URLs
-- minted server-side by /api/doc-url. The table below is metadata only — the
-- bytes live in storage.
--
-- The /track/<token> page is anonymous, so it reads through SECURITY DEFINER
-- RPCs that whitelist safe columns. Rates, fees, and net-to-client are NEVER
-- exposed — a broker holding a tracking link must not be able to see what our
-- client is netting, or what we charge. Depends on 01–05. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

set check_function_bodies = off;

-- ── documents (metadata for objects in the private `documents` bucket) ───────
create table if not exists public.documents (
  id            uuid primary key default gen_random_uuid(),
  entity_type   text not null
                check (entity_type in ('client','driver','equipment','load','broker',
                                       'invoice','statement','service_request','company')),
  entity_id     uuid,
  -- Denormalized so portal RLS is a single column compare rather than a
  -- polymorphic join per entity_type.
  client_id     uuid references public.clients(id) on delete cascade,
  doc_type      text not null default 'other',
                -- rate_con | bol | pod | invoice | w9 | coi | authority | agreement |
                -- poa | noa | cdl | medical | inspection | lumper_receipt | scale | other
  file_path     text not null,        -- bare object path in the private bucket
  file_name     text,
  mime_type     text,
  size_bytes    bigint,
  expiry_date   date,                 -- for COIs and other expiring paperwork
  is_client_visible boolean not null default true,
  notes         text,
  uploaded_by   uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists idx_documents_entity on public.documents(entity_type, entity_id);
create index if not exists idx_documents_client on public.documents(client_id);
create index if not exists idx_documents_type on public.documents(doc_type);
create index if not exists idx_documents_expiry on public.documents(expiry_date)
  where expiry_date is not null;

alter table public.documents enable row level security;
select public._reset_policies('documents');
create policy documents_staff_all on public.documents for all
  using (public.is_staff()) with check (public.is_staff());
create policy documents_portal_select on public.documents for select
  using (client_id = public.app_client_id() and is_client_visible = true);

-- ── The private bucket ───────────────────────────────────────────────────────
-- public = false. Signed URLs are minted by the service role in /api/doc-url,
-- which is why no broad storage.objects policy is granted to end users.
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do update set public = false;

-- Staff may upload / read / delete objects in the bucket via their own session
-- (the client-side uploader); everyone else goes through the signed-URL route.
drop policy if exists documents_bucket_staff_all on storage.objects;
create policy documents_bucket_staff_all on storage.objects for all
  to authenticated
  using (bucket_id = 'documents' and public.is_staff())
  with check (bucket_id = 'documents' and public.is_staff());

-- ── Public tracking RPCs ─────────────────────────────────────────────────────
-- Whitelisted columns only. Deliberately omits line_haul, gross_total,
-- dispatch_fee, net_to_client, broker identity, and internal notes.
create or replace function public.get_load_tracking(p_token uuid)
returns table (
  load_number     text,
  status          text,
  equipment_type  text,
  client_name     text,
  pickup_city     text,
  pickup_state    text,
  pickup_date     date,
  delivery_city   text,
  delivery_state  text,
  delivery_date   date,
  commodity       text,
  temperature     text,
  stop_count      integer,
  tracking_active boolean
)
language sql stable security definer set search_path = public as $$
  select load_number, status, equipment_type, client_name,
         pickup_city, pickup_state, pickup_date,
         delivery_city, delivery_state, delivery_date,
         commodity, temperature, stop_count, tracking_active
  from public.loads
  where tracking_token = p_token
    and tracking_active = true
    and deleted_at is null
$$;
revoke all on function public.get_load_tracking(uuid) from public;
grant execute on function public.get_load_tracking(uuid) to anon, authenticated;

-- Check-in feed for the tracking page: only is_public rows, and never the
-- internal `notes` column.
create or replace function public.get_load_tracking_events(p_token uuid)
returns table (occurred_at timestamptz, location text, city text, state text,
               status_note text, temperature text, eta timestamptz)
language sql stable security definer set search_path = public as $$
  select cc.occurred_at, cc.location, cc.city, cc.state,
         cc.status_note, cc.temperature, cc.eta
  from public.load_check_calls cc
  join public.loads l on l.id = cc.load_id
  where l.tracking_token = p_token
    and l.tracking_active = true
    and l.deleted_at is null
    and cc.is_public = true
  order by cc.occurred_at desc
  limit 50
$$;
revoke all on function public.get_load_tracking_events(uuid) from public;
grant execute on function public.get_load_tracking_events(uuid) to anon, authenticated;
