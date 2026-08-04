// ─────────────────────────────────────────────────────────────────────────────
// Avantra Carrier Services — core domain types (dispatch SERVICE agency).
//
// Avantra owns no trucks and holds no broker authority. Our CLIENTS are motor
// carriers (owner-operators / small fleets). We source freight for them from
// BROKERS, dispatch it on their equipment, invoice the broker in their name, and
// bill the client a DISPATCH FEE. Two money flows, never conflated:
//
//   broker  → client (or their factor)   `invoices`           — not our money
//   client  → Avantra                    `client_statements`  — our revenue
//
// These types are the hand-maintained TS view of the schema. The schema of record
// is the CREATE TABLE migrations in supabase/migrations/ — keep this in sync.
// ─────────────────────────────────────────────────────────────────────────────

// Staff roles run the agency; `client` is the external carrier portal;
// pending/terminated are lifecycle states with no data access.
export type UserRole =
  | 'admin'
  | 'dispatcher'    // sources, books, and dispatches loads; runs the board
  | 'back_office'   // invoicing, factoring, invoice tracing/AR, statements
  | 'sales'         // prospecting + client onboarding
  | 'client'        // external: a carrier client viewing their own data
  | 'pending'
  | 'terminated'

export interface Profile {
  id: string
  email: string | null
  full_name: string | null
  phone: string | null
  role: UserRole
  is_master_admin: boolean
  mfa_enrolled: boolean
  client_id: string | null      // set only for portal users
  created_at: string
}

// ── Clients: the carriers we dispatch FOR ────────────────────────────────────
export type ClientStatus = 'prospect' | 'onboarding' | 'active' | 'paused' | 'terminated'
export type AuthorityStatus = 'active' | 'pending' | 'inactive' | 'not_authorized' | 'unknown'
export type FeeType = 'percent' | 'flat'
export type FeeBasis = 'gross' | 'linehaul'
export type BillingCycle = 'weekly' | 'biweekly' | 'monthly' | 'per_load'

export interface Client {
  id: string
  client_number: string
  legal_name: string
  dba_name: string | null
  status: ClientStatus
  // Authority / identity
  mc_number: string | null
  dot_number: string | null
  ein: string | null
  authority_status: AuthorityStatus
  authority_date: string | null
  safety_rating: string | null
  fmcsa_last_checked: string | null
  // Contact
  contact_name: string | null
  phone: string | null
  email: string | null
  billing_email: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  // Service agreement — the legal spine of the agent relationship
  agreement_signed_at: string | null
  poa_signed_at: string | null
  agreement_doc_path: string | null
  w9_on_file: boolean
  coi_on_file: boolean
  noa_on_file: boolean
  // Dispatch fee terms (snapshotted onto each load at booking)
  fee_type: FeeType
  fee_percent: number
  fee_flat: number
  fee_basis: FeeBasis
  fee_minimum: number
  billing_cycle: BillingCycle
  // Factoring
  factoring_company_id: string | null
  factors_invoices: boolean
  // Insurance quick-glance (full history lives in compliance_items)
  insurance_provider: string | null
  liability_amount: number | null
  cargo_amount: number | null
  insurance_expiry: string | null
  // Dispatch preferences
  equipment_types: string[]
  preferred_states: string[]
  avoid_states: string[]
  home_base_city: string | null
  home_base_state: string | null
  min_rate_per_mile: number | null
  max_weekly_miles: number | null
  hazmat: boolean
  team: boolean
  notes: string | null
  assigned_dispatcher: string | null
  onboarded_at: string | null
  terminated_at: string | null
  termination_reason: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string | null
}

export interface ClientDriver {
  id: string
  client_id: string
  full_name: string
  phone: string | null
  email: string | null
  cdl_number: string | null
  cdl_state: string | null
  cdl_expiry: string | null
  medical_expiry: string | null
  hazmat_endorsed: boolean
  is_owner: boolean
  status: 'active' | 'inactive' | 'terminated'
  notes: string | null
  created_at: string
  updated_at: string | null
}

export interface ClientEquipment {
  id: string
  client_id: string
  kind: 'truck' | 'trailer'
  unit_number: string | null
  equipment_type: string | null
  year: number | null
  make: string | null
  model: string | null
  vin: string | null
  plate: string | null
  plate_state: string | null
  length_ft: number | null
  status: 'active' | 'inactive' | 'out_of_service'
  notes: string | null
  created_at: string
  updated_at: string | null
}

export interface OnboardingStep {
  id: string
  client_id: string
  step_key: string
  label: string
  sort_order: number
  is_required: boolean
  completed_at: string | null
  completed_by: string | null
  doc_path: string | null
  notes: string | null
  created_at: string
}

export interface ClientNote {
  id: string
  client_id: string
  body: string
  kind: 'note' | 'call' | 'email' | 'meeting' | 'issue'
  created_by: string | null
  created_at: string
}

export interface FactoringCompany {
  id: string
  name: string
  contact_name: string | null
  email: string | null
  phone: string | null
  submission_email: string | null
  portal_url: string | null
  advance_rate: number | null
  fee_percent: number | null
  notes: string | null
  is_active: boolean
  created_at: string
  updated_at: string | null
}

// ── Brokers: who pays the freight bill ───────────────────────────────────────
export type PacketStatus = 'none' | 'sent' | 'pending' | 'complete'

export interface Broker {
  id: string
  name: string
  mc_number: string | null
  dot_number: string | null
  contact_name: string | null
  phone: string | null
  after_hours_phone: string | null
  email: string | null
  billing_email: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  payment_terms: string | null
  days_to_pay: number | null
  credit_rating: string | null
  credit_limit: number | null
  packet_status: PacketStatus
  packet_completed_at: string | null
  do_not_use: boolean
  do_not_use_reason: string | null
  notes: string | null
  created_at: string
  updated_at: string | null
}

// ── Loads: the central fact table ────────────────────────────────────────────
export type LoadStatus =
  | 'sourced'        // found on a board / offered by a broker, not yet pitched
  | 'offered'        // pitched to the client, awaiting their yes
  | 'booked'         // client accepted; rate con requested
  | 'dispatched'     // rate con in hand, driver dispatched
  | 'at_pickup'
  | 'in_transit'
  | 'at_delivery'
  | 'delivered'
  | 'docs_received'  // BOL/POD collected — ready to invoice
  | 'invoiced'
  | 'paid'
  | 'cancelled'
  | 'tonu'           // truck ordered, not used

export type LoadSource = 'dat' | 'truckstop' | 'broker_direct' | 'client' | 'relationship' | 'other'

export interface Load {
  id: string
  load_number: string
  status: LoadStatus
  // Who it's for / who pays
  client_id: string | null
  client_name: string | null
  broker_id: string | null
  broker_name: string | null
  broker_load_number: string | null
  source: LoadSource
  // Assignment (the client's own driver + equipment)
  driver_id: string | null
  driver_name: string | null
  truck_id: string | null
  trailer_id: string | null
  // Pickup (first stop)
  shipper_name: string | null
  shipper_address: string | null
  pickup_city: string | null
  pickup_state: string | null
  pickup_zip: string | null
  pickup_date: string | null
  pickup_time: string | null
  pickup_appt: string | null
  // Delivery (last stop)
  consignee_name: string | null
  consignee_address: string | null
  delivery_city: string | null
  delivery_state: string | null
  delivery_zip: string | null
  delivery_date: string | null
  delivery_time: string | null
  delivery_appt: string | null
  // Freight
  commodity: string | null
  weight: number | null
  temperature: string | null
  equipment_type: string | null
  miles: number | null
  stop_count: number
  // Money the broker pays (belongs to the client, not to us)
  line_haul: number
  fuel_surcharge: number
  accessorials: number
  detention: number
  lumper: number
  other_charges: number
  gross_total: number          // maintained by recalc_load_money()
  // Fee terms, snapshotted from the client at booking
  fee_type: FeeType
  fee_percent: number
  fee_flat: number
  fee_basis: FeeBasis
  fee_minimum: number
  fee_manual: boolean
  fee_waived: boolean
  fee_waived_reason: string | null
  dispatch_fee: number         // OUR revenue
  net_to_client: number        // gross_total − dispatch_fee
  // References / paperwork
  ref_number: string | null
  po_number: string | null
  bol_number: string | null
  seal_number: string | null
  rate_con_path: string | null
  rate_con_received_at: string | null
  pod_path: string | null
  pod_received_at: string | null
  // Lifecycle
  offered_at: string | null
  booked_at: string | null
  dispatched_at: string | null
  picked_up_at: string | null
  delivered_at: string | null
  cancelled_at: string | null
  cancel_reason: string | null
  // Public tracking
  tracking_token: string
  tracking_active: boolean
  notes: string | null
  dispatcher_id: string | null
  deleted_at: string | null
  deleted_by: string | null
  created_at: string
  updated_at: string | null
}

export interface LoadStop {
  id: string
  load_id: string
  seq: number
  stop_type: 'pickup' | 'delivery'
  facility_name: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  stop_date: string | null
  stop_time: string | null
  appt_number: string | null
  reference: string | null
  instructions: string | null
  arrived_at: string | null
  departed_at: string | null
  created_at: string
}

export interface CheckCall {
  id: string
  load_id: string
  occurred_at: string
  location: string | null
  city: string | null
  state: string | null
  status_note: string | null
  eta: string | null
  temperature: string | null
  miles_out: number | null
  notes: string | null          // internal — never shown on the public track page
  is_public: boolean
  created_by: string | null
  created_at: string
}

// ── Invoices: we bill the BROKER in our client's name ────────────────────────
export type InvoiceStatus =
  | 'draft' | 'sent' | 'factored' | 'partial' | 'paid'
  | 'overdue' | 'disputed' | 'written_off' | 'void'

export interface Invoice {
  id: string
  invoice_number: string
  load_id: string | null
  client_id: string | null
  broker_id: string | null
  status: InvoiceStatus
  amount: number
  amount_paid: number
  issued_date: string | null
  due_date: string | null
  terms: string | null
  sent_at: string | null
  sent_to: string | null
  // Factoring
  factored_at: string | null
  factoring_company_id: string | null
  factoring_reference: string | null
  funded_at: string | null
  funded_amount: number | null
  factoring_fee: number | null
  // Settlement
  paid_date: string | null
  payment_method: 'ach' | 'check' | 'wire' | 'factor' | 'other' | null
  payment_reference: string | null
  // Collections / tracing
  last_traced_at: string | null
  trace_count: number
  next_follow_up: string | null
  dispute_reason: string | null
  invoice_pdf_path: string | null
  packet_path: string | null
  voided_at: string | null
  voided_by: string | null
  void_reason: string | null
  notes: string | null
  created_at: string
  updated_at: string | null
}

export type TraceMethod = 'call' | 'email' | 'portal' | 'letter' | 'other'
export type TraceOutcome =
  | 'no_answer' | 'left_message' | 'promised_payment' | 'in_process'
  | 'disputed' | 'short_paid' | 'paid' | 'escalated' | 'other'

export interface InvoiceTrace {
  id: string
  invoice_id: string
  traced_at: string
  method: TraceMethod
  contact_name: string | null
  contact_info: string | null
  outcome: TraceOutcome
  promised_date: string | null
  notes: string | null
  created_by: string | null
  created_at: string
}

// ── Client statements: Avantra's own revenue ─────────────────────────────────
export type StatementStatus = 'draft' | 'sent' | 'partial' | 'paid' | 'overdue' | 'void'

export interface ClientStatement {
  id: string
  statement_number: string
  client_id: string
  period_start: string
  period_end: string
  status: StatementStatus
  load_count: number
  total_gross: number
  total_fees: number
  adjustments: number
  amount_due: number
  amount_paid: number
  issued_date: string | null
  due_date: string | null
  sent_at: string | null
  paid_date: string | null
  payment_method: 'ach' | 'check' | 'wire' | 'card' | 'other' | null
  payment_reference: string | null
  pdf_path: string | null
  voided_at: string | null
  voided_by: string | null
  void_reason: string | null
  notes: string | null
  created_at: string
  updated_at: string | null
}

export interface StatementLine {
  id: string
  statement_id: string
  load_id: string | null
  kind: 'fee' | 'adjustment' | 'credit' | 'service'
  description: string
  load_gross: number
  amount: number
  sort_order: number
  created_at: string
}

// ── Compliance ───────────────────────────────────────────────────────────────
export type ComplianceStatus = 'ok' | 'expiring' | 'expired' | 'missing' | 'pending' | 'not_applicable'

export interface ComplianceItem {
  id: string
  client_id: string
  entity_type: 'client' | 'driver' | 'equipment'
  entity_id: string | null
  kind: string
  label: string | null
  status: ComplianceStatus
  provider: string | null
  reference: string | null
  amount: number | null
  effective_date: string | null
  expiry_date: string | null
  doc_path: string | null
  last_checked_at: string | null
  notes: string | null
  created_at: string
  updated_at: string | null
}

// ── Service requests: the A-to-Z back-office work queue ──────────────────────
export type ServiceStatus =
  | 'open' | 'in_progress' | 'waiting_client' | 'waiting_third_party'
  | 'blocked' | 'done' | 'cancelled'
export type ServicePriority = 'low' | 'normal' | 'high' | 'urgent'

export interface ServiceRequest {
  id: string
  request_number: string
  client_id: string | null
  kind: string
  title: string
  description: string | null
  status: ServiceStatus
  priority: ServicePriority
  assigned_to: string | null
  requested_by: string | null
  due_date: string | null
  started_at: string | null
  completed_at: string | null
  billable: boolean
  fee_amount: number
  billed_at: string | null
  statement_id: string | null
  outcome: string | null
  created_at: string
  updated_at: string | null
}

export interface ServiceRequestUpdate {
  id: string
  request_id: string
  body: string
  status_from: string | null
  status_to: string | null
  created_by: string | null
  created_at: string
}

// ── Documents (metadata; bytes live in the private `documents` bucket) ───────
export type DocEntityType =
  | 'client' | 'driver' | 'equipment' | 'load' | 'broker'
  | 'invoice' | 'statement' | 'service_request' | 'company'

export interface DocumentRecord {
  id: string
  entity_type: DocEntityType
  entity_id: string | null
  client_id: string | null
  doc_type: string
  file_path: string
  file_name: string | null
  mime_type: string | null
  size_bytes: number | null
  expiry_date: string | null
  is_client_visible: boolean
  notes: string | null
  uploaded_by: string | null
  created_at: string
}
