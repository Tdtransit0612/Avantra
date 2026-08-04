import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { computeActions, type RolePermissions } from '@/lib/access'

// POST /api/protected/update — staff-gated, service-role UPDATE for RLS-protected
// tables (clients / brokers / loads / invoices / client_statements /
// compliance_items / service_requests).
//
// This is a column-agnostic write surface, so authorization is TABLE + COLUMN +
// ROLE aware. A coarse "any staff role may write any non-protected column" rule
// would let a dispatcher mark a broker invoice paid, void it, or quietly rewrite
// the dispatch fee on a load. The matrix enforced here:
//   • master / admin  → any non-protected column on any allowed table.
//   • back_office     → the financial tables (invoices, client_statements) incl.
//     their money columns, plus the operational tables. Voiding still needs
//     canVoidInvoices; recording a payment still needs canRecordPayment;
//     issuing/sending a statement still needs canIssueStatements.
//   • dispatcher / sales → ONLY operational (non-financial) columns on clients /
//     brokers / loads / compliance_items / service_requests. They can never write
//     invoices or statements, and can't touch a load's FEE columns without
//     canOverrideFee. Any such attempt is rejected 403.

type ProtectedTable =
  | 'clients' | 'brokers' | 'loads' | 'invoices'
  | 'client_statements' | 'compliance_items' | 'service_requests'

const ALLOWED_TABLES = new Set<ProtectedTable>([
  'clients', 'brokers', 'loads', 'invoices',
  'client_statements', 'compliance_items', 'service_requests',
])

// Identity / bookkeeping / trigger-maintained columns callers must never set
// through a generic patch. gross_total and net_to_client are recomputed by
// recalc_load_money() on every write, so accepting them would only mislead.
const PROTECTED_COLUMNS = new Set([
  'id', 'created_at', 'updated_at',
  'load_number', 'invoice_number', 'statement_number', 'client_number', 'request_number',
  'gross_total', 'net_to_client',
])

// The financial tables — writable only by back_office (or admin/master).
const FINANCIAL_TABLES = new Set<ProtectedTable>(['invoices', 'client_statements'])
const FINANCIAL_COLUMNS: Partial<Record<ProtectedTable, Set<string>>> = {
  invoices: new Set([
    'status', 'amount', 'amount_paid', 'issued_date', 'due_date', 'sent_at', 'sent_to',
    'factored_at', 'factoring_company_id', 'factoring_reference', 'funded_at',
    'funded_amount', 'factoring_fee', 'paid_date', 'payment_method',
    'payment_reference', 'voided_at', 'voided_by', 'void_reason',
  ]),
  client_statements: new Set([
    'status', 'total_gross', 'total_fees', 'adjustments', 'amount_due', 'amount_paid',
    'issued_date', 'due_date', 'sent_at', 'paid_date', 'payment_method',
    'payment_reference', 'voided_at', 'voided_by', 'void_reason',
  ]),
}

// Columns that change what Avantra earns on a load — only canOverrideFee may set
// them. Note the raw charge columns (line_haul, detention …) are NOT here: a
// dispatcher adding detention legitimately moves the fee with it.
const LOAD_FEE_COLUMNS = new Set([
  'fee_type', 'fee_percent', 'fee_flat', 'fee_basis', 'fee_minimum',
  'fee_manual', 'fee_waived', 'fee_waived_reason', 'dispatch_fee',
])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: NextRequest) {
  try {
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    if (!serviceKey || !supabaseUrl) {
      return NextResponse.json({ error: 'Server not configured (missing Supabase service key).' }, { status: 500 })
    }

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const admin = createServiceClient(supabaseUrl, serviceKey)
    const { data: caller } = await admin
      .from('profiles').select('role, is_master_admin').eq('id', user.id).single()
    const role = (caller?.role as string | null) ?? null
    const isMaster = caller?.is_master_admin === true
    const isAdminish = isMaster || role === 'admin'
    const isBackOffice = isAdminish || role === 'back_office'

    const body = await req.json() as { table?: ProtectedTable; id?: string; patch?: Record<string, unknown> }
    const table = body.table
    const id = String(body.id ?? '')
    const patch = body.patch
    if (!table || !ALLOWED_TABLES.has(table) || !id) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
    }
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'invalid_request: id is not a valid uuid' }, { status: 400 })
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return NextResponse.json({ error: 'invalid_request: patch must be an object' }, { status: 400 })
    }

    // Strip identity/bookkeeping/generated keys; reject an empty patch.
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(patch)) {
      if (!PROTECTED_COLUMNS.has(k)) clean[k] = v
    }
    const cleanKeys = Object.keys(clean)
    if (cleanKeys.length === 0) {
      return NextResponse.json({ error: 'invalid_request: nothing to update' }, { status: 400 })
    }

    // ── Authorize by TABLE + COLUMN + ROLE ────────────────────────────────────
    // master / admin bypass the fine-grained matrix (full editors on all tables).
    if (!isAdminish) {
      const deny = () =>
        NextResponse.json({ error: 'You don’t have permission to make this change.' }, { status: 403 })

      // Granular action flags resolved from the admin-editable role_permissions
      // (same source of truth as the client), falling back to role defaults.
      let stored: RolePermissions | null = null
      try {
        const { data: cs } = await admin
          .from('company_settings').select('role_permissions').limit(1).maybeSingle()
        stored = (cs?.role_permissions as RolePermissions) ?? null
      } catch {
        stored = null
      }
      const actions = computeActions(role, isMaster, stored)

      if (FINANCIAL_TABLES.has(table)) {
        if (!isBackOffice) return deny()

        if (table === 'invoices') {
          const voiding = clean.status === 'void'
            || 'voided_at' in clean || 'voided_by' in clean || 'void_reason' in clean
          if (voiding && !actions.canVoidInvoices) return deny()

          const settling = clean.status === 'paid' || clean.status === 'partial'
            || 'amount_paid' in clean || 'paid_date' in clean
            || 'payment_reference' in clean || 'funded_at' in clean || 'funded_amount' in clean
          if (settling && !actions.canRecordPayment) return deny()
        }
        if (table === 'client_statements') {
          const voiding = clean.status === 'void'
            || 'voided_at' in clean || 'voided_by' in clean || 'void_reason' in clean
          if (voiding && !actions.canVoidInvoices) return deny()

          const issuing = clean.status === 'sent' || 'sent_at' in clean || 'issued_date' in clean
          if (issuing && !actions.canIssueStatements) return deny()

          const settling = clean.status === 'paid' || clean.status === 'partial'
            || 'amount_paid' in clean || 'paid_date' in clean || 'payment_reference' in clean
          if (settling && !actions.canRecordPayment) return deny()
        }
      } else {
        // Operational tables. back_office / dispatcher / sales may write
        // non-financial columns here.
        if (!(isBackOffice || role === 'dispatcher' || role === 'sales')) return deny()

        // A patch must never smuggle a financial/privileged column into an
        // operational table.
        const financialCols = FINANCIAL_COLUMNS[table]
        if (financialCols && cleanKeys.some(k => financialCols.has(k))) return deny()

        // Rewriting what Avantra earns on a load requires canOverrideFee.
        if (table === 'loads'
            && cleanKeys.some(k => LOAD_FEE_COLUMNS.has(k))
            && !actions.canOverrideFee) {
          return deny()
        }
        // Same for the client's standing fee plan.
        if (table === 'clients'
            && cleanKeys.some(k => LOAD_FEE_COLUMNS.has(k))
            && !actions.canOverrideFee) {
          return deny()
        }
        if (table === 'compliance_items' && !actions.canManageCompliance) return deny()
      }
    }

    const { data, error } = await admin.from(table).update(clean).eq('id', id).select('id')
    if (error) return NextResponse.json({ error: error.message, code: error.code }, { status: 500 })
    if (!data || data.length === 0) {
      return NextResponse.json({ error: `No ${table} row matched — it may have been deleted.` }, { status: 404 })
    }

    // Server-side audit trail (client-side logAudit calls are best-effort and
    // bypassable). Log the column names, not values.
    await admin.from('audit_log').insert({
      user_id: user.id,
      action: 'protected.update',
      table_name: table,
      record_id: id,
      new_value: { columns: cleanKeys },
    }).then(() => {}, () => {})

    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
