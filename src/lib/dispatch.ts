// ─────────────────────────────────────────────────────────────────────────────
// Shared dispatch-domain vocabulary and math.
//
// Everything here is used by three or more pages. The important piece is
// computeFee(): it is a LINE-FOR-LINE mirror of public.recalc_load_money() in
// supabase/migrations/20260803_03_brokers_loads.sql. The database is the source
// of truth — this exists only so a booking form can show the fee before saving.
// If you change one, change the other, or a dispatcher will quote a number the
// database then disagrees with.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  LoadStatus, ClientStatus, InvoiceStatus, StatementStatus,
  ComplianceStatus, ServiceStatus, ServicePriority, FeeType, FeeBasis,
} from '@/types'

// ── Loads ────────────────────────────────────────────────────────────────────
export const LOAD_STATUSES: LoadStatus[] = [
  'sourced', 'offered', 'booked', 'dispatched', 'at_pickup', 'in_transit',
  'at_delivery', 'delivered', 'docs_received', 'invoiced', 'paid', 'cancelled', 'tonu',
]

export const LOAD_STATUS_LABELS: Record<LoadStatus, string> = {
  sourced:       'Sourced',
  offered:       'Offered',
  booked:        'Booked',
  dispatched:    'Dispatched',
  at_pickup:     'At Pickup',
  in_transit:    'In Transit',
  at_delivery:   'At Delivery',
  delivered:     'Delivered',
  docs_received: 'Docs In',
  invoiced:      'Invoiced',
  paid:          'Paid',
  cancelled:     'Cancelled',
  tonu:          'TONU',
}

const GRAY   = 'bg-gray-100 text-gray-700 border-gray-200 dark:bg-white/10 dark:text-gray-300 dark:border-white/10'
const AMBER  = 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800/50'
const INDIGO = 'bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-900/40 dark:text-indigo-300 dark:border-indigo-800/50'
const BLUE   = 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-800/50'
const VIOLET = 'bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-800/50'
const GREEN  = 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-800/50'
const EMERALD= 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-800/50'
const TEAL   = 'bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-900/40 dark:text-teal-300 dark:border-teal-800/50'
const RED    = 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-800/50'
const ORANGE = 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/40 dark:text-orange-300 dark:border-orange-800/50'

export const LOAD_STATUS_COLORS: Record<LoadStatus, string> = {
  sourced:       GRAY,
  offered:       AMBER,
  booked:        INDIGO,
  dispatched:    BLUE,
  at_pickup:     VIOLET,
  in_transit:    BLUE,
  at_delivery:   VIOLET,
  delivered:     GREEN,
  docs_received: TEAL,
  invoiced:      INDIGO,
  paid:          EMERALD,
  cancelled:     RED,
  tonu:          ORANGE,
}

/** Statuses where the load is still live work for a dispatcher. */
export const OPEN_LOAD_STATUSES: LoadStatus[] = [
  'sourced', 'offered', 'booked', 'dispatched', 'at_pickup', 'in_transit', 'at_delivery',
]

/** Statuses where the freight has moved but the money hasn't landed. */
export const UNSETTLED_LOAD_STATUSES: LoadStatus[] = ['delivered', 'docs_received', 'invoiced']

/** The board's swimlanes, in dispatch order. */
export const BOARD_COLUMNS: { key: LoadStatus[]; label: string; hint: string }[] = [
  { key: ['sourced', 'offered'],        label: 'Needs a Yes',  hint: 'Sourced or pitched — waiting on the client' },
  { key: ['booked'],                    label: 'Booked',       hint: 'Client accepted — needs a driver + rate con' },
  { key: ['dispatched', 'at_pickup'],   label: 'Dispatched',   hint: 'Driver assigned, heading to or at pickup' },
  { key: ['in_transit', 'at_delivery'], label: 'Rolling',      hint: 'Loaded and moving' },
  { key: ['delivered', 'docs_received'],label: 'Delivered',    hint: 'Empty — chase the paperwork' },
]

export const EQUIPMENT_TYPES = [
  'Dry Van', 'Reefer', 'Flatbed', 'Step Deck', 'Power Only', 'Hotshot', 'Box Truck', 'Conestoga',
]

/**
 * The happy-path next step for a load. Terminal states (paid/cancelled/tonu)
 * map to nothing. Anything off this path is still reachable from the status
 * dropdown on the load — this only drives the one-click "advance" affordance.
 */
export const NEXT_STATUS: Partial<Record<LoadStatus, LoadStatus>> = {
  sourced:       'offered',
  offered:       'booked',
  booked:        'dispatched',
  dispatched:    'at_pickup',
  at_pickup:     'in_transit',
  in_transit:    'at_delivery',
  at_delivery:   'delivered',
  delivered:     'docs_received',
  docs_received: 'invoiced',
  invoiced:      'paid',
}

/** Verb for the button that moves a load to NEXT_STATUS[status]. */
export const ADVANCE_LABELS: Partial<Record<LoadStatus, string>> = {
  sourced:       'Offer to client',
  offered:       'Client accepted',
  booked:        'Dispatch',
  dispatched:    'Arrived at pickup',
  at_pickup:     'Loaded / rolling',
  in_transit:    'Arrived at delivery',
  at_delivery:   'Delivered',
  delivered:     'Docs received',
  docs_received: 'Invoice',
  invoiced:      'Mark paid',
}

/**
 * Lifecycle timestamps to stamp when a load ENTERS a status. Keyed by the status
 * being entered. Kept here so the board, the detail page, and any future
 * automation all stamp the same columns.
 */
export const STATUS_TIMESTAMP: Partial<Record<LoadStatus, string>> = {
  offered:     'offered_at',
  booked:      'booked_at',
  dispatched:  'dispatched_at',
  at_pickup:   'picked_up_at',
  delivered:   'delivered_at',
  cancelled:   'cancelled_at',
}

/** Patch to apply when moving a load into `to`. Includes the lifecycle stamp. */
export function statusPatch(to: LoadStatus): Record<string, unknown> {
  const patch: Record<string, unknown> = { status: to }
  const stamp = STATUS_TIMESTAMP[to]
  if (stamp) patch[stamp] = new Date().toISOString()
  return patch
}

export const LOAD_SOURCE_LABELS: Record<string, string> = {
  dat:           'DAT',
  truckstop:     'Truckstop',
  broker_direct: 'Broker direct',
  client:        'Client brought it',
  relationship:  'Relationship',
  other:         'Other',
}

// ── Clients ──────────────────────────────────────────────────────────────────
export const CLIENT_STATUSES: ClientStatus[] = ['prospect', 'onboarding', 'active', 'paused', 'terminated']

export const CLIENT_STATUS_LABELS: Record<ClientStatus, string> = {
  prospect:   'Prospect',
  onboarding: 'Onboarding',
  active:     'Active',
  paused:     'Paused',
  terminated: 'Terminated',
}

export const CLIENT_STATUS_COLORS: Record<ClientStatus, string> = {
  prospect:   GRAY,
  onboarding: AMBER,
  active:     EMERALD,
  paused:     ORANGE,
  terminated: RED,
}

/** Seeded onto every new client. Keys match client_onboarding_steps.step_key. */
export const ONBOARDING_TEMPLATE: { step_key: string; label: string; is_required: boolean }[] = [
  { step_key: 'agreement',   label: 'Dispatch service agreement signed', is_required: true },
  { step_key: 'poa',         label: 'Limited power of attorney signed',  is_required: true },
  { step_key: 'w9',          label: 'W-9 on file',                       is_required: true },
  { step_key: 'authority',   label: 'Operating authority verified (FMCSA)', is_required: true },
  { step_key: 'coi',         label: 'Certificate of insurance on file',  is_required: true },
  { step_key: 'coi_named',   label: 'Avantra named as certificate holder', is_required: false },
  { step_key: 'noa',         label: 'Factoring notice of assignment',    is_required: false },
  { step_key: 'equipment',   label: 'Trucks + trailers entered',         is_required: true },
  { step_key: 'drivers',     label: 'Drivers + CDLs entered',            is_required: true },
  { step_key: 'preferences', label: 'Lane + equipment preferences set',  is_required: false },
  { step_key: 'fee_plan',    label: 'Fee plan agreed and recorded',      is_required: true },
  { step_key: 'kickoff',     label: 'Kickoff call completed',            is_required: false },
]

// ── Invoices (broker-facing) ─────────────────────────────────────────────────
export const INVOICE_STATUSES: InvoiceStatus[] = [
  'draft', 'sent', 'factored', 'partial', 'paid', 'overdue', 'disputed', 'written_off', 'void',
]

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft:       'Draft',
  sent:        'Sent',
  factored:    'Factored',
  partial:     'Partial',
  paid:        'Paid',
  overdue:     'Overdue',
  disputed:    'Disputed',
  written_off: 'Written Off',
  void:        'Void',
}

export const INVOICE_STATUS_COLORS: Record<InvoiceStatus, string> = {
  draft:       GRAY,
  sent:        BLUE,
  factored:    VIOLET,
  partial:     AMBER,
  paid:        EMERALD,
  overdue:     RED,
  disputed:    ORANGE,
  written_off: GRAY,
  void:        GRAY,
}

/** Invoices still owed to the client — what the tracing queue works. */
export const OPEN_INVOICE_STATUSES: InvoiceStatus[] = ['sent', 'factored', 'partial', 'overdue', 'disputed']

export const TRACE_OUTCOME_LABELS: Record<string, string> = {
  no_answer:        'No answer',
  left_message:     'Left message',
  promised_payment: 'Promised payment',
  in_process:       'In payment process',
  disputed:         'Disputed',
  short_paid:       'Short paid',
  paid:             'Paid',
  escalated:        'Escalated',
  other:            'Other',
}

// ── Statements (our own revenue) ─────────────────────────────────────────────
export const STATEMENT_STATUSES: StatementStatus[] = ['draft', 'sent', 'partial', 'paid', 'overdue', 'void']

export const STATEMENT_STATUS_LABELS: Record<StatementStatus, string> = {
  draft: 'Draft', sent: 'Sent', partial: 'Partial', paid: 'Paid', overdue: 'Overdue', void: 'Void',
}

export const STATEMENT_STATUS_COLORS: Record<StatementStatus, string> = {
  draft: GRAY, sent: BLUE, partial: AMBER, paid: EMERALD, overdue: RED, void: GRAY,
}

// ── Compliance ───────────────────────────────────────────────────────────────
export const COMPLIANCE_STATUS_LABELS: Record<ComplianceStatus, string> = {
  ok:             'Current',
  expiring:       'Expiring',
  expired:        'Expired',
  missing:        'Missing',
  pending:        'Pending',
  not_applicable: 'N/A',
}

export const COMPLIANCE_STATUS_COLORS: Record<ComplianceStatus, string> = {
  ok:             EMERALD,
  expiring:       AMBER,
  expired:        RED,
  missing:        ORANGE,
  pending:        GRAY,
  not_applicable: GRAY,
}

/** Items tracked per client. `entity` says what the item hangs off. */
export const COMPLIANCE_KINDS: { kind: string; label: string; entity: 'client' | 'driver' | 'equipment' }[] = [
  { kind: 'authority',            label: 'Operating authority',   entity: 'client' },
  { kind: 'liability_insurance',  label: 'Auto liability',        entity: 'client' },
  { kind: 'cargo_insurance',      label: 'Cargo insurance',       entity: 'client' },
  { kind: 'ifta',                 label: 'IFTA license',          entity: 'client' },
  { kind: 'ucr',                  label: 'UCR registration',      entity: 'client' },
  { kind: 'mcs150',               label: 'MCS-150 biennial',      entity: 'client' },
  { kind: 'boc3',                 label: 'BOC-3 filing',          entity: 'client' },
  { kind: 'drug_consortium',      label: 'Drug/alcohol consortium', entity: 'client' },
  { kind: 'form_2290',            label: 'Form 2290 (HVUT)',      entity: 'client' },
  { kind: 'cdl',                  label: 'CDL',                   entity: 'driver' },
  { kind: 'medical_card',         label: 'Medical card',          entity: 'driver' },
  { kind: 'annual_inspection',    label: 'Annual inspection',     entity: 'equipment' },
]

export const COMPLIANCE_KIND_LABEL: Record<string, string> =
  Object.fromEntries(COMPLIANCE_KINDS.map(k => [k.kind, k.label]))

// ── Service requests ─────────────────────────────────────────────────────────
export const SERVICE_KINDS: { kind: string; label: string }[] = [
  { kind: 'new_authority',            label: 'New operating authority' },
  { kind: 'authority_reinstatement',  label: 'Authority reinstatement' },
  { kind: 'ifta_registration',        label: 'IFTA registration' },
  { kind: 'ifta_filing',              label: 'IFTA quarterly filing' },
  { kind: 'ucr',                      label: 'UCR registration' },
  { kind: 'mcs150_update',            label: 'MCS-150 update' },
  { kind: 'boc3',                     label: 'BOC-3 filing' },
  { kind: 'drug_consortium',          label: 'Drug consortium enrollment' },
  { kind: 'form_2290',                label: 'Form 2290 (HVUT) filing' },
  { kind: 'insurance_quote',          label: 'Insurance quote' },
  { kind: 'factoring_setup',          label: 'Factoring setup' },
  { kind: 'broker_setup',             label: 'Broker setup packet' },
  { kind: 'permit',                   label: 'Permit / oversize' },
  { kind: 'dispute',                  label: 'Claim or dispute' },
  { kind: 'notary',                   label: 'Notary / document prep' },
  { kind: 'other',                    label: 'Other' },
]

export const SERVICE_KIND_LABEL: Record<string, string> =
  Object.fromEntries(SERVICE_KINDS.map(k => [k.kind, k.label]))

export const SERVICE_STATUS_LABELS: Record<ServiceStatus, string> = {
  open:               'Open',
  in_progress:        'In progress',
  waiting_client:     'Waiting on client',
  waiting_third_party:'Waiting on 3rd party',
  blocked:            'Blocked',
  done:               'Done',
  cancelled:          'Cancelled',
}

export const SERVICE_STATUS_COLORS: Record<ServiceStatus, string> = {
  open:                GRAY,
  in_progress:         BLUE,
  waiting_client:      AMBER,
  waiting_third_party: VIOLET,
  blocked:             RED,
  done:                EMERALD,
  cancelled:           GRAY,
}

export const OPEN_SERVICE_STATUSES: ServiceStatus[] = [
  'open', 'in_progress', 'waiting_client', 'waiting_third_party', 'blocked',
]

export const PRIORITY_LABELS: Record<ServicePriority, string> = {
  low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent',
}

export const PRIORITY_COLORS: Record<ServicePriority, string> = {
  low: GRAY, normal: BLUE, high: AMBER, urgent: RED,
}

// ── Money + formatting ───────────────────────────────────────────────────────
export const num = (s: string | number | null | undefined): number => {
  const n = typeof s === 'number' ? s : parseFloat(String(s ?? ''))
  return Number.isFinite(n) ? n : 0
}

export const money = (n: number | null | undefined): string =>
  `$${(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`

export const money2 = (n: number | null | undefined): string =>
  (n ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

// Date columns store YYYY-MM-DD; anchor to local midnight so the day never shifts.
export const shortDate = (d?: string | null): string =>
  d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' }) : '—'

export const longDate = (d?: string | null): string =>
  d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

export const dateTime = (d?: string | null): string =>
  d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'

export const todayISO = (): string => new Date().toISOString().slice(0, 10)

/** Whole days between today and an ISO date. Negative = in the past. */
export function daysUntil(d?: string | null): number | null {
  if (!d) return null
  const then = new Date(`${d.slice(0, 10)}T00:00:00`).getTime()
  const now = new Date(new Date().toDateString()).getTime()
  return Math.round((then - now) / 86_400_000)
}

/** Days an invoice is past due. 0 or negative = not yet due. */
export const daysPastDue = (dueDate?: string | null): number => {
  const d = daysUntil(dueDate)
  return d == null ? 0 : -d
}

/** Standard AR aging bucket for an invoice due date. */
export function agingBucket(dueDate?: string | null): 'current' | '1-30' | '31-60' | '61-90' | '90+' {
  const pd = daysPastDue(dueDate)
  if (pd <= 0) return 'current'
  if (pd <= 30) return '1-30'
  if (pd <= 60) return '31-60'
  if (pd <= 90) return '61-90'
  return '90+'
}

export const lane = (l: { pickup_city?: string | null; pickup_state?: string | null; delivery_city?: string | null; delivery_state?: string | null }) => ({
  from: [l.pickup_city, l.pickup_state].filter(Boolean).join(', ') || '—',
  to:   [l.delivery_city, l.delivery_state].filter(Boolean).join(', ') || '—',
})

// ── The fee engine (mirror of recalc_load_money) ─────────────────────────────
export interface FeeInput {
  line_haul?: number | string
  fuel_surcharge?: number | string
  accessorials?: number | string
  detention?: number | string
  lumper?: number | string
  other_charges?: number | string
  fee_type?: FeeType
  fee_percent?: number | string
  fee_flat?: number | string
  fee_basis?: FeeBasis
  fee_minimum?: number | string
  fee_manual?: boolean
  fee_waived?: boolean
  /** Only consulted when fee_manual is true. */
  dispatch_fee?: number | string
  status?: LoadStatus
}

export interface FeeResult {
  gross: number
  fee: number
  net: number
  /** Fee as a % of gross — what a client actually feels. 0 when gross is 0. */
  effectivePct: number
}

/**
 * Preview the money on a load exactly as the database will store it.
 * MIRRORS public.recalc_load_money(). Keep the two in lockstep.
 */
export function computeFee(input: FeeInput): FeeResult {
  const gross =
    num(input.line_haul) + num(input.fuel_surcharge) + num(input.accessorials) +
    num(input.detention) + num(input.lumper) + num(input.other_charges)

  let fee: number
  if (input.fee_waived || input.status === 'cancelled') {
    fee = 0
  } else if (input.fee_manual) {
    fee = num(input.dispatch_fee)
  } else {
    const base = input.fee_basis === 'linehaul' ? num(input.line_haul) : gross
    fee = input.fee_type === 'flat'
      ? num(input.fee_flat)
      : round2(base * num(input.fee_percent) / 100)
    const min = num(input.fee_minimum)
    if (min > 0 && base > 0) fee = Math.max(fee, min)
  }

  const g = round2(gross)
  const f = round2(fee)
  return { gross: g, fee: f, net: round2(gross - fee), effectivePct: g > 0 ? (f / g) * 100 : 0 }
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** One-line human summary of a fee plan, e.g. "10% of gross (min $50)". */
export function describeFeePlan(p: {
  fee_type?: FeeType; fee_percent?: number; fee_flat?: number
  fee_basis?: FeeBasis; fee_minimum?: number
}): string {
  const base = p.fee_basis === 'linehaul' ? 'linehaul' : 'gross'
  const core = p.fee_type === 'flat'
    ? `${money2(p.fee_flat ?? 0)} per load`
    : `${p.fee_percent ?? 0}% of ${base}`
  const min = (p.fee_minimum ?? 0) > 0 ? ` (min ${money2(p.fee_minimum ?? 0)})` : ''
  return core + min
}

export const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
]
