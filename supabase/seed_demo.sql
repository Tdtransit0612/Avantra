-- ─────────────────────────────────────────────────────────────────────────────
-- Avantra — OPTIONAL demo data.
--
-- Purpose: let you click through a populated app before real clients exist.
-- This is NOT part of the schema. Do not run it on a database that holds real
-- freight.
--
-- Every row uses a fixed UUID in the reserved 0000…-4000-8000-… range, so the
-- teardown at the bottom removes exactly this data and nothing else. Run the
-- teardown before you go live.
--
-- Depends on migrations 01–06. Re-runnable: every insert is an upsert on the
-- fixed id.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Factoring company ────────────────────────────────────────────────────────
insert into public.factoring_companies (id, name, contact_name, email, phone, submission_email, advance_rate, fee_percent, is_active)
values ('00000000-0000-4000-8000-0000000000f1', 'Demo Freight Factoring', 'Dana Reyes',
        'dana@example.invalid', '555-0100', 'invoices@example.invalid', 95, 3, true)
on conflict (id) do update set name = excluded.name;

-- ── Clients (the carriers we dispatch for) ───────────────────────────────────
insert into public.clients (
  id, client_number, legal_name, dba_name, status, mc_number, dot_number,
  authority_status, contact_name, phone, email, billing_email,
  city, state, home_base_city, home_base_state,
  agreement_signed_at, poa_signed_at, w9_on_file, coi_on_file,
  fee_type, fee_percent, fee_basis, fee_minimum, billing_cycle,
  insurance_provider, liability_amount, cargo_amount, insurance_expiry,
  equipment_types, min_rate_per_mile, onboarded_at
) values
  ('00000000-0000-4000-8000-0000000000c1', 'AC-9001', 'Rivera Trucking LLC', 'Rivera Trucking',
   'active', '888101', '2210101', 'active', 'Miguel Rivera', '555-0111',
   'miguel@example.invalid', 'billing@example.invalid', 'Laredo', 'TX', 'Laredo', 'TX',
   current_date - 120, current_date - 120, true, true,
   'percent', 10, 'gross', 50, 'weekly',
   'Great West', 1000000, 100000, current_date + 45,
   '{"Dry Van","Reefer"}', 2.10, current_date - 118),

  ('00000000-0000-4000-8000-0000000000c2', 'AC-9002', 'Northbound Carriers Inc', null,
   'active', '888202', '2210202', 'active', 'Sam Okafor', '555-0122',
   'sam@example.invalid', 'ap@example.invalid', 'Columbus', 'OH', 'Columbus', 'OH',
   current_date - 60, current_date - 60, true, true,
   'percent', 8, 'linehaul', 0, 'weekly',
   'Progressive', 1000000, 250000, current_date + 12,
   '{"Flatbed","Step Deck"}', 2.40, current_date - 58),

  ('00000000-0000-4000-8000-0000000000c3', 'AC-9003', 'Kestrel Logistics LLC', 'Kestrel',
   'onboarding', '888303', '2210303', 'pending', 'Ava Chen', '555-0133',
   'ava@example.invalid', null, 'Fresno', 'CA', 'Fresno', 'CA',
   null, null, true, false,
   'flat', 0, 'gross', 0, 'weekly',
   null, null, null, current_date - 5,
   '{"Reefer"}', 2.60, null)
on conflict (id) do update set legal_name = excluded.legal_name, status = excluded.status;

-- Kestrel is flat-fee; set it explicitly (the columns above default fee_flat 0).
update public.clients set fee_flat = 250, factoring_company_id = '00000000-0000-4000-8000-0000000000f1', factors_invoices = true
 where id = '00000000-0000-4000-8000-0000000000c3';
update public.clients set factoring_company_id = '00000000-0000-4000-8000-0000000000f1', factors_invoices = true
 where id = '00000000-0000-4000-8000-0000000000c1';

-- ── Drivers ──────────────────────────────────────────────────────────────────
insert into public.client_drivers (id, client_id, full_name, phone, cdl_number, cdl_state, cdl_expiry, medical_expiry, is_owner, status)
values
  ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000c1', 'Miguel Rivera', '555-0111', 'TX4482910', 'TX', current_date + 300, current_date + 20, true, 'active'),
  ('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000c1', 'Tomas Vega',   '555-0112', 'TX4482911', 'TX', current_date + 18,  current_date + 200, false, 'active'),
  ('00000000-0000-4000-8000-0000000000d3', '00000000-0000-4000-8000-0000000000c2', 'Sam Okafor',   '555-0122', 'OH9911223', 'OH', current_date + 400, current_date + 150, true, 'active')
on conflict (id) do update set full_name = excluded.full_name;

-- ── Equipment ────────────────────────────────────────────────────────────────
insert into public.client_equipment (id, client_id, kind, unit_number, equipment_type, year, make, model, plate, plate_state, status)
values
  ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000c1', 'truck',   '101', null,      2021, 'Freightliner', 'Cascadia', 'TX11AAA', 'TX', 'active'),
  ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000c1', 'trailer', 'R-55', 'Reefer',  2020, 'Utility', '3000R',        'TX22BBB', 'TX', 'active'),
  ('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-0000000000c2', 'truck',   '7',    null,      2019, 'Peterbilt', '579',         'OH33CCC', 'OH', 'active'),
  ('00000000-0000-4000-8000-0000000000e4', '00000000-0000-4000-8000-0000000000c2', 'trailer', 'F-12', 'Flatbed', 2018, 'Great Dane', 'Freedom LT', 'OH44DDD', 'OH', 'active')
on conflict (id) do update set unit_number = excluded.unit_number;

-- ── Brokers ──────────────────────────────────────────────────────────────────
insert into public.brokers (id, name, mc_number, contact_name, phone, email, billing_email, city, state, payment_terms, days_to_pay, credit_rating, packet_status, packet_completed_at, do_not_use, do_not_use_reason)
values
  ('00000000-0000-4000-8000-0000000000b1', 'Meridian Logistics', '551001', 'Pat Nolan', '555-0201', 'pat@example.invalid', 'ap@example.invalid', 'Chicago', 'IL', 'Net 30', 28, '96', 'complete', current_date - 90, false, null),
  ('00000000-0000-4000-8000-0000000000b2', 'Cardinal Freight Group', '551002', 'Jo Vance', '555-0202', 'jo@example.invalid', 'billing@example.invalid', 'Dallas', 'TX', 'Net 30', 41, '88', 'complete', current_date - 40, false, null),
  ('00000000-0000-4000-8000-0000000000b3', 'Sunbelt Transport Brokers', '551003', 'Rey Duarte', '555-0203', 'rey@example.invalid', null, 'Phoenix', 'AZ', 'Net 45', null, '72', 'pending', null, false, null),
  ('00000000-0000-4000-8000-0000000000b4', 'Lowball Freight Co', '551004', null, '555-0204', null, null, 'Newark', 'NJ', 'Net 60', 74, '51', 'none', null, true, 'Chronic slow pay; two chargebacks in Q1.')
on conflict (id) do update set name = excluded.name, do_not_use = excluded.do_not_use;

-- ── Loads ────────────────────────────────────────────────────────────────────
-- Fee columns are snapshotted the way the app does it. gross_total / dispatch_fee
-- / net_to_client are left to recalc_load_money() — never set them by hand.
insert into public.loads (
  id, load_number, status, client_id, client_name, broker_id, broker_name, broker_load_number, source,
  driver_id, driver_name, truck_id, trailer_id,
  shipper_name, pickup_city, pickup_state, pickup_date,
  consignee_name, delivery_city, delivery_state, delivery_date,
  commodity, weight, equipment_type, miles,
  line_haul, fuel_surcharge, accessorials, detention,
  fee_type, fee_percent, fee_basis, fee_minimum,
  booked_at, dispatched_at, delivered_at
) values
  -- Delivered + invoiced + paid
  ('00000000-0000-4000-8000-00000000001a', 'AV-99001', 'paid',
   '00000000-0000-4000-8000-0000000000c1', 'Rivera Trucking',
   '00000000-0000-4000-8000-0000000000b1', 'Meridian Logistics', 'MER-88120', 'broker_direct',
   '00000000-0000-4000-8000-0000000000d1', 'Miguel Rivera',
   '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000e2',
   'Rio Grande Produce', 'Laredo', 'TX', current_date - 24,
   'Midwest Grocery DC', 'Chicago', 'IL', current_date - 21,
   'Fresh produce', 42000, 'Reefer', 1350,
   3400, 250, 0, 0, 'percent', 10, 'gross', 50,
   now() - interval '26 days', now() - interval '25 days', now() - interval '21 days'),

  -- Delivered, awaiting invoice
  ('00000000-0000-4000-8000-00000000002a', 'AV-99002', 'docs_received',
   '00000000-0000-4000-8000-0000000000c1', 'Rivera Trucking',
   '00000000-0000-4000-8000-0000000000b2', 'Cardinal Freight Group', 'CFG-4471', 'dat',
   '00000000-0000-4000-8000-0000000000d2', 'Tomas Vega',
   '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000e2',
   'Gulf Cold Storage', 'Houston', 'TX', current_date - 8,
   'Southeast Foods', 'Atlanta', 'GA', current_date - 6,
   'Frozen poultry', 40000, 'Reefer', 790,
   2150, 180, 0, 150, 'percent', 10, 'gross', 50,
   now() - interval '10 days', now() - interval '9 days', now() - interval '6 days'),

  -- Invoiced, now overdue (the AR chaser has something to find)
  ('00000000-0000-4000-8000-00000000003a', 'AV-99003', 'invoiced',
   '00000000-0000-4000-8000-0000000000c2', 'Northbound Carriers Inc',
   '00000000-0000-4000-8000-0000000000b2', 'Cardinal Freight Group', 'CFG-4402', 'broker_direct',
   '00000000-0000-4000-8000-0000000000d3', 'Sam Okafor',
   '00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-0000000000e4',
   'Ohio Steel Supply', 'Columbus', 'OH', current_date - 62,
   'Keystone Fabrication', 'Pittsburgh', 'PA', current_date - 61,
   'Steel coil', 46000, 'Flatbed', 190,
   950, 60, 0, 0, 'percent', 8, 'linehaul', 0,
   now() - interval '64 days', now() - interval '63 days', now() - interval '61 days'),

  -- Rolling
  ('00000000-0000-4000-8000-00000000004a', 'AV-99004', 'in_transit',
   '00000000-0000-4000-8000-0000000000c2', 'Northbound Carriers Inc',
   '00000000-0000-4000-8000-0000000000b1', 'Meridian Logistics', 'MER-88455', 'relationship',
   '00000000-0000-4000-8000-0000000000d3', 'Sam Okafor',
   '00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-0000000000e4',
   'Great Lakes Lumber', 'Cleveland', 'OH', current_date - 1,
   'Carolina Builders', 'Charlotte', 'NC', current_date + 1,
   'Lumber', 44000, 'Flatbed', 520,
   1750, 140, 0, 0, 'percent', 8, 'linehaul', 0,
   now() - interval '3 days', now() - interval '2 days', null),

  -- Booked, no driver yet — the board should flag this
  ('00000000-0000-4000-8000-00000000005a', 'AV-99005', 'booked',
   '00000000-0000-4000-8000-0000000000c1', 'Rivera Trucking',
   '00000000-0000-4000-8000-0000000000b3', 'Sunbelt Transport Brokers', 'SUN-2210', 'truckstop',
   null, null, null, null,
   'Desert Fresh Packing', 'Phoenix', 'AZ', current_date + 2,
   'Rocky Mountain Produce', 'Denver', 'CO', current_date + 3,
   'Melons', 38000, 'Reefer', 860,
   2400, 190, 0, 0, 'percent', 10, 'gross', 50,
   now() - interval '1 day', null, null),

  -- Sourced, still being pitched
  ('00000000-0000-4000-8000-00000000006a', 'AV-99006', 'sourced',
   '00000000-0000-4000-8000-0000000000c3', 'Kestrel',
   '00000000-0000-4000-8000-0000000000b3', 'Sunbelt Transport Brokers', null, 'dat',
   null, null, null, null,
   'Central Valley Cold', 'Fresno', 'CA', current_date + 4,
   'Pacific Northwest Foods', 'Portland', 'OR', current_date + 6,
   'Table grapes', 41000, 'Reefer', 730,
   2050, 160, 0, 0, 'flat', 0, 'gross', 0,
   null, null, null)
on conflict (id) do update set status = excluded.status;

-- Kestrel's load is a flat-fee plan.
update public.loads set fee_flat = 250 where id = '00000000-0000-4000-8000-00000000006a';

-- ── Check calls on the rolling load ──────────────────────────────────────────
insert into public.load_check_calls (id, load_id, occurred_at, city, state, location, status_note, is_public)
values
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-00000000004a', now() - interval '20 hours', 'Cleveland', 'OH', 'Cleveland, OH', 'Loaded and rolling', true),
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-00000000004a', now() - interval '6 hours',  'Columbus',  'OH', 'Columbus, OH',  'Fuel stop, on schedule', true)
on conflict (id) do nothing;

-- ── Invoices ─────────────────────────────────────────────────────────────────
insert into public.invoices (id, invoice_number, load_id, client_id, broker_id, status, amount, amount_paid, issued_date, due_date, terms, sent_at, paid_date, payment_method)
values
  ('00000000-0000-4000-8000-0000000000i1', 'INV-9001',
   '00000000-0000-4000-8000-00000000001a', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000b1',
   'paid', 3650, 3650, current_date - 21, current_date + 9, 'Net 30', now() - interval '21 days', current_date - 3, 'ach'),

  ('00000000-0000-4000-8000-0000000000i2', 'INV-9002',
   '00000000-0000-4000-8000-00000000003a', '00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000b2',
   'overdue', 1010, 0, current_date - 61, current_date - 31, 'Net 30', now() - interval '61 days', null, null)
on conflict (id) do update set status = excluded.status;

-- A couple of collection attempts on the overdue one.
insert into public.invoice_traces (id, invoice_id, traced_at, method, outcome, contact_name, notes)
values
  ('00000000-0000-4000-8000-0000000000t1', '00000000-0000-4000-8000-0000000000i2', now() - interval '20 days', 'call',  'left_message',     'AP desk', 'Left voicemail, no callback.'),
  ('00000000-0000-4000-8000-0000000000t2', '00000000-0000-4000-8000-0000000000i2', now() - interval '9 days',  'email', 'promised_payment', 'Jo Vance', 'Said it would go out in the next check run.')
on conflict (id) do nothing;

-- ── Compliance items ─────────────────────────────────────────────────────────
-- status is derived by the trigger from expiry_date — never set it here.
insert into public.compliance_items (id, client_id, entity_type, kind, provider, reference, amount, effective_date, expiry_date)
values
  ('00000000-0000-4000-8000-0000000000m1', '00000000-0000-4000-8000-0000000000c1', 'client', 'liability_insurance', 'Great West', 'GW-771201', 1000000, current_date - 320, current_date + 45),
  ('00000000-0000-4000-8000-0000000000m2', '00000000-0000-4000-8000-0000000000c1', 'client', 'ifta', 'TX Comptroller', 'IFTA-TX-8891', null, current_date - 300, current_date + 65),
  ('00000000-0000-4000-8000-0000000000m3', '00000000-0000-4000-8000-0000000000c2', 'client', 'liability_insurance', 'Progressive', 'PG-330219', 1000000, current_date - 353, current_date + 12),
  ('00000000-0000-4000-8000-0000000000m4', '00000000-0000-4000-8000-0000000000c2', 'client', 'ucr', 'FMCSA', 'UCR-2210202', null, current_date - 200, current_date - 6),
  ('00000000-0000-4000-8000-0000000000m5', '00000000-0000-4000-8000-0000000000c3', 'client', 'authority', 'FMCSA', 'MC-888303', null, null, null)
on conflict (id) do update set expiry_date = excluded.expiry_date;

-- ── Service requests ─────────────────────────────────────────────────────────
insert into public.service_requests (id, request_number, client_id, kind, title, description, status, priority, due_date, billable, fee_amount, completed_at)
values
  ('00000000-0000-4000-8000-0000000000s1', 'SR-9001', '00000000-0000-4000-8000-0000000000c3',
   'new_authority', 'Activate MC authority for Kestrel',
   'BOC-3 filed; waiting on the 21-day protest period to close.', 'waiting_third_party', 'high',
   current_date + 7, true, 350, null),

  ('00000000-0000-4000-8000-0000000000s2', 'SR-9002', '00000000-0000-4000-8000-0000000000c2',
   'ucr', 'UCR renewal — Northbound',
   'UCR lapsed. Renew before the next interstate run.', 'open', 'urgent',
   current_date - 2, true, 90, null),

  ('00000000-0000-4000-8000-0000000000s3', 'SR-9003', '00000000-0000-4000-8000-0000000000c1',
   'ifta_filing', 'Q1 IFTA filing — Rivera', null, 'done', 'normal',
   current_date - 15, true, 125, now() - interval '14 days')
on conflict (id) do update set status = excluded.status;

-- ── Onboarding checklists ────────────────────────────────────────────────────
-- Seeds the same template the app uses, so the client detail page shows progress.
insert into public.client_onboarding_steps (client_id, step_key, label, sort_order, is_required, completed_at)
select c.id, s.step_key, s.label, s.sort_order, s.is_required,
       case when c.status = 'active' and s.sort_order < 8 then now() else null end
from (values
  ('00000000-0000-4000-8000-0000000000c1'::uuid),
  ('00000000-0000-4000-8000-0000000000c2'::uuid),
  ('00000000-0000-4000-8000-0000000000c3'::uuid)
) as ids(id)
join public.clients c on c.id = ids.id
cross join (values
  ('agreement',   'Dispatch service agreement signed',    0,  true),
  ('poa',         'Limited power of attorney signed',     1,  true),
  ('w9',          'W-9 on file',                          2,  true),
  ('authority',   'Operating authority verified (FMCSA)', 3,  true),
  ('coi',         'Certificate of insurance on file',     4,  true),
  ('coi_named',   'Avantra named as certificate holder',  5,  false),
  ('noa',         'Factoring notice of assignment',       6,  false),
  ('equipment',   'Trucks + trailers entered',            7,  true),
  ('drivers',     'Drivers + CDLs entered',               8,  true),
  ('preferences', 'Lane + equipment preferences set',     9,  false),
  ('fee_plan',    'Fee plan agreed and recorded',        10,  true),
  ('kickoff',     'Kickoff call completed',              11,  false)
) as s(step_key, label, sort_order, is_required)
on conflict (client_id, step_key) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- TEARDOWN — run this before go-live to remove every demo row.
-- Cascades handle drivers, equipment, stops, check calls, traces, steps.
-- ─────────────────────────────────────────────────────────────────────────────
-- delete from public.invoice_traces where id::text like '00000000-0000-4000-8000-%';
-- delete from public.invoices        where id::text like '00000000-0000-4000-8000-%';
-- delete from public.load_check_calls where id::text like '00000000-0000-4000-8000-%';
-- delete from public.loads           where id::text like '00000000-0000-4000-8000-%';
-- delete from public.service_requests where id::text like '00000000-0000-4000-8000-%';
-- delete from public.compliance_items where id::text like '00000000-0000-4000-8000-%';
-- delete from public.client_equipment where id::text like '00000000-0000-4000-8000-%';
-- delete from public.client_drivers   where id::text like '00000000-0000-4000-8000-%';
-- delete from public.clients          where id::text like '00000000-0000-4000-8000-%';
-- delete from public.brokers          where id::text like '00000000-0000-4000-8000-%';
-- delete from public.factoring_companies where id::text like '00000000-0000-4000-8000-%';
