'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import Header from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Loader2, Search, ClipboardList, Download, RefreshCw,
  ChevronLeft, ChevronRight, Filter, FileText, Truck,
  Users, Package, FileCheck, Building2,
  Wallet, ShieldCheck, Settings, ChevronDown, ChevronUp, Lock, Wrench,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useRole } from '@/lib/role-context'

// ─── Types ────────────────────────────────────────────────────────────────────
type LogEntry = {
  id: string
  created_at: string
  user_id: string | null
  action: string
  table_name: string | null
  record_id: string | null
  old_value: Record<string, unknown> | null
  new_value: Record<string, unknown> | null
  profiles: { full_name: string | null; email: string | null; role: string | null } | null
}

// ─── Category config ──────────────────────────────────────────────────────────
// `prefixes` is an array so one category can absorb several action namespaces —
// e.g. Client covers the client record plus its drivers and equipment, which are
// edited from the same screen and read as one thing to whoever's auditing.
type Category = {
  key: string
  label: string
  prefixes: readonly string[]
  icon: typeof Package
  color: string
}

const CATEGORIES: readonly Category[] = [
  { key: 'load',       label: 'Load',        prefixes: ['load.'],                                  icon: Package,     color: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300' },
  { key: 'client',     label: 'Client',      prefixes: ['client.', 'client_driver', 'client_equipment'], icon: Truck, color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  { key: 'broker',     label: 'Broker',      prefixes: ['broker.'],                                icon: Building2,   color: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
  { key: 'invoice',    label: 'Invoice / AR', prefixes: ['invoice.'],                              icon: FileText,    color: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300' },
  { key: 'statement',  label: 'Fee Statement', prefixes: ['statement.', 'factoring_company.'],     icon: Wallet,      color: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300' },
  { key: 'compliance', label: 'Compliance',  prefixes: ['compliance', 'fmcsa.'],                   icon: ShieldCheck, color: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
  { key: 'service',    label: 'Services',    prefixes: ['service_request'],                        icon: Wrench,      color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300' },
  { key: 'document',   label: 'Document',    prefixes: ['document.'],                              icon: FileCheck,   color: 'bg-slate-100 text-slate-700 dark:bg-slate-900/40 dark:text-slate-300' },
  { key: 'user',       label: 'User & Role', prefixes: ['user.', 'role.', 'account.'],             icon: Users,       color: 'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300' },
  { key: 'settings',   label: 'Settings',    prefixes: ['settings.', 'security.', 'protected.'],   icon: Settings,    color: 'bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-gray-300' },
] as const

function getCategory(action: string): Category | null {
  return CATEGORIES.find(c => c.prefixes.some(p => action.startsWith(p))) ?? null
}

/** OR-filter fragment matching any of a set of category prefixes. */
function catOrFilter(prefixes: string[]): string {
  return prefixes.map(p => `action.ilike.${p}%`).join(',')
}

function actionLabel(action: string) {
  return action.replace(/\./g, ' › ').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// Guard against null/undefined iso
function formatTs(iso: string) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

// ─── Diff renderer ────────────────────────────────────────────────────────────
function Diff({ old: oldV, next: newV }: { old: Record<string, unknown> | null; next: Record<string, unknown> | null }) {
  if (!oldV && !newV) return null
  const allKeys = Array.from(new Set([...Object.keys(oldV ?? {}), ...Object.keys(newV ?? {})]))
  const changed = oldV ? allKeys.filter(k => JSON.stringify((oldV ?? {})[k]) !== JSON.stringify((newV ?? {})[k])) : allKeys
  const display = oldV ? changed : allKeys

  return (
    <div className="mt-2 rounded-lg border dark:border-white/10 overflow-hidden text-xs">
      {oldV && (
        <div className="grid grid-cols-2 divide-x dark:divide-white/10 bg-gray-50 dark:bg-white/5 px-3 py-1 text-gray-400 dark:text-gray-500 text-[10px] font-medium uppercase tracking-wide">
          <span>Before</span><span className="pl-3">After</span>
        </div>
      )}
      <div className="divide-y dark:divide-white/10">
        {display.map(k => {
          const wasVal = String((oldV ?? {})[k] ?? '—')
          const isVal  = String((newV ?? {})[k] ?? '—')
          const diff   = oldV && wasVal !== isVal
          return (
            <div key={k} className={`grid px-3 py-1 gap-1 ${oldV ? 'grid-cols-[1fr_8px_1fr]' : 'grid-cols-[120px_1fr]'}`}>
              {oldV ? (
                <>
                  <span className={diff ? 'text-red-600 dark:text-red-400 line-through opacity-70' : 'text-gray-500 dark:text-gray-400'}>
                    <span className="text-gray-400 dark:text-gray-500 mr-1">{k}:</span>{wasVal}
                  </span>
                  <span className="text-gray-300 dark:text-gray-600 text-center">›</span>
                  <span className={diff ? 'text-green-700 dark:text-green-400 font-medium' : 'text-gray-500 dark:text-gray-400'}>
                    {isVal}
                  </span>
                </>
              ) : (
                <>
                  <span className="text-gray-400 dark:text-gray-500">{k}</span>
                  <span className="text-gray-700 dark:text-gray-300">{isVal}</span>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Row ──────────────────────────────────────────────────────────────────────
function LogRow({ log }: { log: LogEntry }) {
  const [expanded, setExpanded] = useState(false)
  const cat = getCategory(log.action)
  const CatIcon = cat?.icon ?? ClipboardList
  const actor = log.profiles?.full_name ?? log.profiles?.email ?? 'System'
  const hasDetail = log.old_value || log.new_value

  return (
    <>
      <tr
        className={`border-b dark:border-white/10 last:border-0 transition-colors ${expanded ? 'bg-indigo-50/60 dark:bg-indigo-900/10' : 'hover:bg-gray-50 dark:hover:bg-white/5'} ${hasDetail ? 'cursor-pointer' : ''}`}
        onClick={() => hasDetail && setExpanded(e => !e)}
      >
        {/* Timestamp */}
        <td className="px-4 py-2.5 text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap align-top">
          {formatTs(log.created_at)}
        </td>

        {/* User */}
        <td className="px-4 py-2.5 align-top">
          <div className="text-xs font-medium text-gray-900 dark:text-white leading-tight">{actor}</div>
          {log.profiles?.role && (
            <div className="text-[10px] text-gray-400 dark:text-gray-500 capitalize">{log.profiles.role.replace(/_/g, ' ')}</div>
          )}
        </td>

        {/* Category badge */}
        <td className="px-4 py-2.5 align-top">
          {cat ? (
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${cat.color}`}>
              <CatIcon className="h-2.5 w-2.5" />
              {cat.label}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-gray-400">
              Other
            </span>
          )}
        </td>

        {/* Action */}
        <td className="px-4 py-2.5 align-top">
          <span className="text-xs text-gray-700 dark:text-gray-300">{actionLabel(log.action)}</span>
        </td>

        {/* Record */}
        <td className="px-4 py-2.5 text-xs text-gray-400 dark:text-gray-500 align-top">
          {log.table_name && <div>{log.table_name}</div>}
          {log.record_id && <div className="font-mono text-[10px] text-gray-300 dark:text-gray-600">{log.record_id.slice(0, 8)}…</div>}
        </td>

        {/* Expand toggle */}
        <td className="px-4 py-2.5 text-right align-top">
          {hasDetail && (
            <span className="text-gray-300 dark:text-gray-600">
              {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </span>
          )}
        </td>
      </tr>

      {/* Expanded diff */}
      {expanded && hasDetail && (
        <tr className="bg-indigo-50/40 dark:bg-indigo-900/5 border-b dark:border-white/10">
          <td colSpan={6} className="px-6 pb-4 pt-1">
            <Diff old={log.old_value} next={log.new_value} />
          </td>
        </tr>
      )}
    </>
  )
}

// ─── Export field definitions ─────────────────────────────────────────────────
type FieldDef = { key: string; label: string; extract: (log: LogEntry) => string }

const nv = (log: LogEntry, k: string) => String((log.new_value ?? {})[k] ?? '')
const ov = (log: LogEntry, k: string) => String((log.old_value ?? {})[k] ?? '')
const nvOv = (log: LogEntry, k: string) => nv(log, k) || ov(log, k)

const COMMON_FIELDS: FieldDef[] = [
  { key: 'timestamp',   label: 'Timestamp',  extract: l => formatTs(l.created_at) },
  { key: 'user_name',   label: 'User Name',  extract: l => l.profiles?.full_name ?? l.profiles?.email ?? 'System' },
  { key: 'user_role',   label: 'User Role',  extract: l => l.profiles?.role ?? '' },
  { key: 'action',      label: 'Action',     extract: l => l.action },
  { key: 'category',    label: 'Category',   extract: l => getCategory(l.action)?.label ?? 'Other' },
  { key: 'table_name',  label: 'Table',      extract: l => l.table_name ?? '' },
  { key: 'record_id',   label: 'Record ID',  extract: l => l.record_id ?? '' },
]

// Field extractors mirror the Avantra schema (loads/carriers/customers/invoices/
// carrier_settlements). Missing keys degrade to '' — safe for varied event shapes.
const CATEGORY_SPECIFIC_FIELDS: Record<string, FieldDef[]> = {
  load: [
    { key: 'load_number',   label: 'Load #',           extract: l => nvOv(l, 'load_number') },
    { key: 'load_status',   label: 'Status',           extract: l => nv(l, 'status') },
    { key: 'old_status',    label: 'Previous Status',  extract: l => ov(l, 'status') },
    { key: 'customer_name', label: 'Customer',         extract: l => nvOv(l, 'customer_name') },
    { key: 'carrier_name',  label: 'Carrier',          extract: l => nvOv(l, 'carrier_name') },
    { key: 'origin',        label: 'Origin',           extract: l => [nvOv(l, 'pickup_city'), nvOv(l, 'pickup_state')].filter(Boolean).join(', ') },
    { key: 'destination',   label: 'Destination',      extract: l => [nvOv(l, 'delivery_city'), nvOv(l, 'delivery_state')].filter(Boolean).join(', ') },
    { key: 'pickup_date',   label: 'Pickup Date',      extract: l => nvOv(l, 'pickup_date') },
    { key: 'delivery_date', label: 'Delivery Date',    extract: l => nvOv(l, 'delivery_date') },
    { key: 'customer_rate', label: 'Customer Rate ($)', extract: l => nvOv(l, 'customer_rate') },
    { key: 'carrier_rate',  label: 'Carrier Rate ($)', extract: l => nvOv(l, 'carrier_rate') },
    { key: 'margin',        label: 'Margin ($)',       extract: l => nvOv(l, 'margin') },
    { key: 'miles',         label: 'Miles',            extract: l => nvOv(l, 'miles') },
    { key: 'commodity',     label: 'Commodity',        extract: l => nvOv(l, 'commodity') },
    { key: 'temperature',   label: 'Temp',             extract: l => nvOv(l, 'temperature') },
    { key: 'equipment_type', label: 'Equipment',       extract: l => nvOv(l, 'equipment_type') },
    { key: 'weight',        label: 'Weight (lbs)',     extract: l => nvOv(l, 'weight') },
    { key: 'po_number',     label: 'PO #',             extract: l => nvOv(l, 'po_number') },
    { key: 'bol_number',    label: 'BOL #',            extract: l => nvOv(l, 'bol_number') },
    { key: 'ref_number',    label: 'Ref #',            extract: l => nvOv(l, 'ref_number') },
  ],
  carrier: [
    { key: 'carrier_name',      label: 'Carrier Name',      extract: l => nvOv(l, 'name') },
    { key: 'carrier_status',    label: 'Status',            extract: l => nv(l, 'status') },
    { key: 'carrier_mc',        label: 'MC Number',         extract: l => nvOv(l, 'mc_number') },
    { key: 'carrier_dot',       label: 'DOT Number',        extract: l => nvOv(l, 'dot_number') },
    { key: 'authority_status',  label: 'Authority Status',  extract: l => nvOv(l, 'authority_status') },
    { key: 'safety_rating',     label: 'Safety Rating',     extract: l => nvOv(l, 'safety_rating') },
    { key: 'insurance_provider', label: 'Insurance Provider', extract: l => nvOv(l, 'insurance_provider') },
    { key: 'insurance_expiry',  label: 'Insurance Expiry',  extract: l => nvOv(l, 'insurance_expiry') },
    { key: 'carrier_contact',   label: 'Contact',           extract: l => nvOv(l, 'contact_name') },
    { key: 'carrier_phone',     label: 'Phone',             extract: l => nvOv(l, 'phone') },
    { key: 'carrier_email',     label: 'Email',             extract: l => nvOv(l, 'email') },
  ],
  customer: [
    { key: 'customer_name',   label: 'Customer Name',  extract: l => nvOv(l, 'name') },
    { key: 'customer_status', label: 'Status',         extract: l => nv(l, 'status') },
    { key: 'billing_email',   label: 'Billing Email',  extract: l => nvOv(l, 'billing_email') },
    { key: 'payment_terms',   label: 'Payment Terms',  extract: l => nvOv(l, 'payment_terms') },
    { key: 'credit_limit',    label: 'Credit Limit ($)', extract: l => nvOv(l, 'credit_limit') },
    { key: 'customer_mc',     label: 'MC Number',      extract: l => nvOv(l, 'mc_number') },
  ],
  invoice: [
    { key: 'inv_number',     label: 'Invoice #',        extract: l => nvOv(l, 'invoice_number') },
    { key: 'inv_status',     label: 'Status',           extract: l => nv(l, 'status') },
    { key: 'inv_old_status', label: 'Previous Status',  extract: l => ov(l, 'status') },
    { key: 'inv_amount',     label: 'Amount ($)',       extract: l => nvOv(l, 'amount') },
    { key: 'inv_amount_paid', label: 'Amount Paid ($)', extract: l => nvOv(l, 'amount_paid') },
    { key: 'inv_due_date',   label: 'Due Date',         extract: l => nvOv(l, 'due_date') },
    { key: 'inv_paid_date',  label: 'Paid Date',        extract: l => nvOv(l, 'paid_date') },
    { key: 'inv_factoring',  label: 'Factoring Co.',    extract: l => nvOv(l, 'factoring_company') },
    { key: 'inv_load',       label: 'Load ID',          extract: l => nvOv(l, 'load_id') || nvOv(l, 'load_number') },
  ],
  settlement: [
    { key: 'set_number',     label: 'Settlement #',     extract: l => nvOv(l, 'settlement_number') },
    { key: 'set_status',     label: 'Status',           extract: l => nv(l, 'status') },
    { key: 'set_old_status', label: 'Previous Status',  extract: l => ov(l, 'status') },
    { key: 'set_gross',      label: 'Gross ($)',        extract: l => nvOv(l, 'gross') },
    { key: 'set_deductions', label: 'Deductions ($)',   extract: l => nvOv(l, 'deductions') },
    { key: 'set_net',        label: 'Net ($)',          extract: l => nvOv(l, 'net') },
    { key: 'set_quick_pay',  label: 'Quick Pay',        extract: l => nvOv(l, 'quick_pay') },
    { key: 'set_qp_fee',     label: 'Quick Pay Fee ($)', extract: l => nvOv(l, 'quick_pay_fee') },
    { key: 'set_carrier',    label: 'Carrier ID',       extract: l => nvOv(l, 'carrier_id') },
    { key: 'set_paid_date',  label: 'Paid Date',        extract: l => nvOv(l, 'paid_date') },
  ],
  compliance: [
    { key: 'cmp_kind',     label: 'Alert Kind',    extract: l => nvOv(l, 'kind') },
    { key: 'cmp_severity', label: 'Severity',      extract: l => nvOv(l, 'severity') },
    { key: 'cmp_message',  label: 'Message',       extract: l => nvOv(l, 'message') },
    { key: 'cmp_entity',   label: 'Entity ID',     extract: l => nvOv(l, 'entity_id') },
    { key: 'cmp_due',      label: 'Due Date',      extract: l => nvOv(l, 'due_date') },
  ],
  document: [
    { key: 'doc_type',   label: 'Document Type', extract: l => nvOv(l, 'doc_type') || nvOv(l, 'document_type') },
    { key: 'doc_name',   label: 'File Name',     extract: l => nvOv(l, 'file_name') || nvOv(l, 'document_name') },
    { key: 'doc_entity', label: 'Entity Type',   extract: l => nvOv(l, 'entity_type') },
    { key: 'doc_entity_id', label: 'Entity ID',  extract: l => nvOv(l, 'entity_id') },
    { key: 'doc_expiry', label: 'Expiry Date',   extract: l => nvOv(l, 'expiry_date') },
  ],
  user: [
    { key: 'user_email',   label: 'User Email',     extract: l => nvOv(l, 'email') },
    { key: 'user_new_role', label: 'New Role',      extract: l => nv(l, 'role') || nv(l, 'new_role') },
    { key: 'user_old_role', label: 'Previous Role', extract: l => ov(l, 'role') || nvOv(l, 'old_role') },
    { key: 'user_status',  label: 'Account Status', extract: l => nvOv(l, 'status') },
    { key: 'user_app_access', label: 'App Access',  extract: l => nvOv(l, 'app_access') },
    { key: 'user_id_field', label: 'User ID',       extract: l => nvOv(l, 'user_id') },
  ],
  settings: [
    { key: 'set_company',  label: 'Company Name', extract: l => nvOv(l, 'company_name') || nvOv(l, 'name') },
    { key: 'set_mc',       label: 'MC Number',    extract: l => nvOv(l, 'mc_number') },
    { key: 'set_dot',      label: 'DOT Number',   extract: l => nvOv(l, 'dot_number') },
    { key: 'set_phone',    label: 'Phone',        extract: l => nvOv(l, 'phone') },
    { key: 'set_email',    label: 'Email',        extract: l => nvOv(l, 'email') },
  ],
}

/** Returns all fields available for the given set of category keys */
function getAvailableFields(cats: Set<string>): FieldDef[] {
  const specific: FieldDef[] = []
  const seen = new Set<string>()
  for (const key of Array.from(cats)) {
    for (const f of (CATEGORY_SPECIFIC_FIELDS[key] ?? [])) {
      if (!seen.has(f.key)) { seen.add(f.key); specific.push(f) }
    }
  }
  return [...COMMON_FIELDS, ...specific]
}

type ExportFilters = {
  dateFrom: string
  dateTo: string
  search: string
  activeCats: Set<string>
  total: number
}

function ExportModal({ filters }: { filters: ExportFilters }) {
  const [open, setOpen] = useState(false)
  const [selCats, setSelCats] = useState<Set<string>>(
    new Set(filters.activeCats.size > 0 ? filters.activeCats : CATEGORIES.map(c => c.key))
  )
  const [selFields, setSelFields] = useState<Set<string>>(new Set(getAvailableFields(new Set(CATEGORIES.map(c => c.key))).map(f => f.key)))
  const [format, setFormat] = useState<'csv' | 'json'>('csv')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const [fetchedCount, setFetchedCount] = useState<number | null>(null)

  const availableFields = useMemo(() => getAvailableFields(selCats), [selCats])

  // When available fields change, keep existing selections + auto-select new fields
  const prevAvailKeysRef = useRef<Set<string>>(new Set(availableFields.map(f => f.key)))
  useEffect(() => {
    const newAvailKeys = new Set(availableFields.map(f => f.key))
    setSelFields(prev => {
      const next = new Set<string>()
      for (const k of Array.from(prev)) { if (newAvailKeys.has(k)) next.add(k) }
      for (const k of Array.from(newAvailKeys)) { if (!prevAvailKeysRef.current.has(k)) next.add(k) }
      return next
    })
    prevAvailKeysRef.current = newAvailKeys
  }, [availableFields])

  const toggleCat = (k: string) => setSelCats(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const toggleField = (k: string) => setSelFields(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setExporting(false)
      setExportError('')
    }
    setOpen(next)
  }

  // All prefixes across selected categories (null = no category constraint)
  const selectedPrefixes = () =>
    selCats.size > 0 && selCats.size < CATEGORIES.length
      ? CATEGORIES.filter(c => selCats.has(c.key)).flatMap(c => [...c.prefixes])
      : null

  // Estimate record count when modal opens / filters change
  useEffect(() => {
    if (!open) return
    let mounted = true
    const supabase = createClient()
    const prefixes = selectedPrefixes()
    const safeSearch = filters.search.replace(/[(),]/g, '').replace(/%/g, '\\%').replace(/_/g, '\\_')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase.from('audit_log').select('id', { count: 'exact', head: true })
    if (filters.dateFrom) q = q.gte('created_at', filters.dateFrom)
    if (filters.dateTo)   q = q.lte('created_at', filters.dateTo + 'T23:59:59')
    if (safeSearch)       q = q.or(`action.ilike.%${safeSearch}%,table_name.ilike.%${safeSearch}%,record_id.ilike.%${safeSearch}%`)
    if (prefixes)         q = q.or(catOrFilter(prefixes))
    q.then(({ count, error }: { count: number | null; error: unknown }) => {
      if (!mounted) return
      setFetchedCount(error ? null : (count ?? 0))
    })
    return () => { mounted = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selCats, filters])

  const doExport = async () => {
    if (selCats.size === 0 || selFields.size === 0) return
    setExporting(true)
    setExportError('')

    const supabase = createClient()
    const prefixes = selectedPrefixes()
    const safeSearch = filters.search.replace(/[(),]/g, '').replace(/%/g, '\\%').replace(/_/g, '\\_')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase
      .from('audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50000) // safety cap
    if (filters.dateFrom) q = q.gte('created_at', filters.dateFrom)
    if (filters.dateTo)   q = q.lte('created_at', filters.dateTo + 'T23:59:59')
    if (safeSearch)       q = q.or(`action.ilike.%${safeSearch}%,table_name.ilike.%${safeSearch}%,record_id.ilike.%${safeSearch}%`)
    if (prefixes)         q = q.or(catOrFilter(prefixes))

    const { data, error } = await q
    if (error) {
      setExportError(String(error.message ?? error))
      setExporting(false)
      return
    }
    const rawRows = (data ?? []) as Omit<LogEntry, 'profiles'>[]

    // Fetch profiles separately (no FK join dependency)
    const exportUserIds = [...new Set(rawRows.map(r => r.user_id).filter(Boolean))] as string[]
    const exportProfileMap: Record<string, { full_name: string | null; email: string | null; role: string | null }> = {}
    if (exportUserIds.length > 0) {
      const { data: pRows } = await supabase.from('profiles').select('id, full_name, email, role').in('id', exportUserIds)
      for (const p of (pRows ?? [])) {
        exportProfileMap[p.id] = { full_name: p.full_name ?? null, email: p.email ?? null, role: p.role ?? null }
      }
    }
    const rows: LogEntry[] = rawRows.map(r => ({
      ...r,
      profiles: r.user_id ? (exportProfileMap[r.user_id] ?? null) : null,
    }))

    const fname = `avantra-audit-${filters.dateFrom || 'all'}-to-${filters.dateTo || 'today'}`
    const selectedFieldDefs = availableFields.filter(f => selFields.has(f.key))

    if (format === 'json') {
      const out = rows.map(l => {
        const row: Record<string, string> = {}
        for (const f of selectedFieldDefs) row[f.key] = f.extract(l)
        return row
      })
      triggerDownload(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }), `${fname}.json`)
    } else {
      const headers = selectedFieldDefs.map(f => f.label)
      const csvRows = rows.map(l =>
        selectedFieldDefs.map(f => `"${f.extract(l).replace(/"/g, '""')}"`).join(',')
      )
      const csv = [headers.map(h => `"${h.replace(/"/g, '""')}"`).join(','), ...csvRows].join('\n')
      triggerDownload(new Blob([csv], { type: 'text/csv' }), `${fname}.csv`)
    }

    setExporting(false)
    setOpen(false)
  }

  function triggerDownload(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = name; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/5 text-sm font-medium px-3 py-1.5 transition-colors"
      >
        <Download className="h-4 w-4" />Export
      </button>
      {open && <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-4 w-4 text-indigo-500" />
            Export Audit Log
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Active filters summary */}
          {(filters.dateFrom || filters.dateTo || filters.search) && (
            <div className="px-3 py-2 rounded-lg bg-indigo-50 dark:bg-indigo-900/20 text-xs text-indigo-700 dark:text-indigo-300 space-y-0.5">
              <p className="font-medium">Export will apply current page filters:</p>
              {filters.dateFrom && <p>From: {filters.dateFrom}</p>}
              {filters.dateTo   && <p>To: {filters.dateTo}</p>}
              {filters.search   && <p>Search: &quot;{filters.search}&quot;</p>}
            </div>
          )}

          {/* Categories */}
          <div>
            <Label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Categories to include</Label>
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              {CATEGORIES.map(c => {
                const Icon = c.icon
                const on = selCats.has(c.key)
                return (
                  <button
                    key={c.key}
                    onClick={() => toggleCat(c.key)}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-all ${on ? `${c.color} border-transparent` : 'text-gray-400 dark:text-gray-500 border-gray-200 dark:border-white/10 hover:border-gray-300'}`}
                  >
                    <Icon className="h-3 w-3" />{c.label}
                  </button>
                )
              })}
            </div>
            <div className="mt-1.5 flex gap-2">
              <button className="text-[10px] text-indigo-600 hover:text-indigo-700" onClick={() => setSelCats(new Set(CATEGORIES.map(c => c.key)))}>Select all</button>
              <span className="text-[10px] text-gray-300 dark:text-gray-600">·</span>
              <button className="text-[10px] text-indigo-600 hover:text-indigo-700" onClick={() => setSelCats(new Set())}>Clear</button>
            </div>
          </div>

          {/* Fields */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Fields to include</Label>
              <div className="flex gap-2">
                <button className="text-[10px] text-indigo-600 hover:text-indigo-700" onClick={() => setSelFields(new Set(availableFields.map(f => f.key)))}>All</button>
                <span className="text-[10px] text-gray-300 dark:text-gray-600">·</span>
                <button className="text-[10px] text-indigo-600 hover:text-indigo-700" onClick={() => setSelFields(new Set(COMMON_FIELDS.map(f => f.key)))}>Common only</button>
                <span className="text-[10px] text-gray-300 dark:text-gray-600">·</span>
                <button className="text-[10px] text-indigo-600 hover:text-indigo-700" onClick={() => setSelFields(new Set())}>None</button>
              </div>
            </div>
            {/* Common fields */}
            <p className="text-[10px] text-gray-400 dark:text-gray-500 uppercase tracking-wide font-medium mb-1">Common</p>
            <div className="grid grid-cols-2 gap-0.5 mb-3">
              {COMMON_FIELDS.map(f => (
                <label key={f.key} className="flex items-center gap-2 cursor-pointer py-0.5">
                  <input
                    type="checkbox"
                    checked={selFields.has(f.key)}
                    onChange={() => toggleField(f.key)}
                    className="rounded border-gray-300 dark:border-white/20 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-xs text-gray-700 dark:text-gray-300">{f.label}</span>
                </label>
              ))}
            </div>
            {/* Category-specific fields */}
            {availableFields.length > COMMON_FIELDS.length && (
              <>
                <p className="text-[10px] text-gray-400 dark:text-gray-500 uppercase tracking-wide font-medium mb-1">
                  Category-Specific
                  <span className="ml-1 normal-case text-gray-300 dark:text-gray-600">(based on selected categories)</span>
                </p>
                <div className="grid grid-cols-2 gap-0.5 max-h-48 overflow-y-auto pr-1">
                  {availableFields.slice(COMMON_FIELDS.length).map(f => (
                    <label key={f.key} className="flex items-center gap-2 cursor-pointer py-0.5">
                      <input
                        type="checkbox"
                        checked={selFields.has(f.key)}
                        onChange={() => toggleField(f.key)}
                        className="rounded border-gray-300 dark:border-white/20 text-indigo-600 focus:ring-indigo-500"
                      />
                      <span className="text-xs text-gray-700 dark:text-gray-300">{f.label}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Format */}
          <div>
            <Label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Format</Label>
            <div className="mt-2 flex gap-2">
              {(['csv', 'json'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setFormat(f)}
                  className={`flex-1 py-2 rounded-lg border text-xs font-medium transition-all ${format === f ? 'bg-indigo-600 text-white border-indigo-600' : 'text-gray-500 dark:text-gray-400 border-gray-200 dark:border-white/10 hover:border-gray-300'}`}
                >
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Summary + download */}
          <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-gray-50 dark:bg-white/5 text-xs text-gray-500 dark:text-gray-400">
            <span>
              {fetchedCount !== null ? `~${fetchedCount.toLocaleString()} records` : '— records'} · {selFields.size} of {availableFields.length} fields
            </span>
            <Button
              className="bg-indigo-600 hover:bg-indigo-700 h-8 text-xs"
              onClick={doExport}
              disabled={selCats.size === 0 || selFields.size === 0 || exporting}
            >
              {exporting
                ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Fetching…</>
                : <><Download className="h-3.5 w-3.5 mr-1.5" />Download {format.toUpperCase()}</>}
            </Button>
          </div>
          {exportError && (
            <p className="text-xs text-red-600 dark:text-red-400">{exportError}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>}
    </>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
const PAGE_SIZE = 50

export default function AuditPage() {
  const { role, isMasterAdmin, loading: roleLoading } = useRole()

  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState('')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [activeCats, setActiveCats] = useState<Set<string>>(new Set())
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Mirrors the audit_log_select RLS policy: has_role('admin','back_office').
  const allowed = role === 'admin' || role === 'back_office' || isMasterAdmin

  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [])

  const handleSearchChange = (val: string) => {
    setSearch(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(val)
      setPage(1)
    }, 350)
  }

  const fetchLogs = useCallback(async (silent = false) => {
    setFetchError('')
    if (!silent) setLoading(true)
    else setRefreshing(true)

    try {
      const supabase = createClient()

      const prefixes = activeCats.size > 0
        ? CATEGORIES.filter(c => activeCats.has(c.key)).flatMap(c => [...c.prefixes])
        : null

      const safeSearch = debouncedSearch.replace(/[(),]/g, '').replace(/%/g, '\\%').replace(/_/g, '\\_')

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const applyFilters = (q: any) => {
        if (dateFrom) q = q.gte('created_at', dateFrom)
        if (dateTo)   q = q.lte('created_at', dateTo + 'T23:59:59')
        if (safeSearch) {
          q = q.or(`action.ilike.%${safeSearch}%,table_name.ilike.%${safeSearch}%,record_id.ilike.%${safeSearch}%`)
        }
        if (prefixes && prefixes.length > 0) {
          q = q.or(catOrFilter(prefixes))
        }
        return q
      }

      const { count, error: countErr } = await applyFilters(
        supabase.from('audit_log').select('id', { count: 'exact', head: true })
      )
      if (countErr) {
        setFetchError('Failed to load audit log. Please try again.')
        setLoading(false); setRefreshing(false)
        return
      }
      setTotal(count ?? 0)

      const { data, error: dataErr } = await applyFilters(
        supabase
          .from('audit_log')
          .select('*')
          .order('created_at', { ascending: false })
          .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
      )
      if (dataErr) {
        setFetchError('Failed to load audit log. Please try again.')
        setLoading(false); setRefreshing(false)
        return
      }

      const rows = (data ?? []) as Omit<LogEntry, 'profiles'>[]
      const userIds = [...new Set(rows.map(r => r.user_id).filter(Boolean))] as string[]
      const profileMap: Record<string, { full_name: string | null; email: string | null; role: string | null }> = {}
      if (userIds.length > 0) {
        const { data: profileRows } = await supabase
          .from('profiles')
          .select('id, full_name, email, role')
          .in('id', userIds)
        for (const p of (profileRows ?? [])) {
          profileMap[p.id] = { full_name: p.full_name ?? null, email: p.email ?? null, role: p.role ?? null }
        }
      }
      const merged: LogEntry[] = rows.map(r => ({
        ...r,
        profiles: r.user_id ? (profileMap[r.user_id] ?? null) : null,
      }))

      setLogs(merged)
      if (!silent) setLoading(false)
      else setRefreshing(false)
    } catch {
      setFetchError('Failed to load audit log. Please try again.')
      setLoading(false); setRefreshing(false)
    }
  }, [dateFrom, dateTo, page, debouncedSearch, activeCats])

  useEffect(() => { if (allowed) fetchLogs() }, [fetchLogs, allowed])

  // Stable ref for realtime handler
  const fetchLogsRef = useRef(fetchLogs)
  useEffect(() => { fetchLogsRef.current = fetchLogs }, [fetchLogs])

  useEffect(() => {
    if (!allowed) return
    const supabase = createClient()
    const channel = supabase.channel('avantra-audit-realtime')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'audit_log' }, () => {
        fetchLogsRef.current(true)
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [allowed])

  // Per-category counts (server-side, one head query per category)
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number>>({})
  useEffect(() => {
    if (!allowed) return
    let mounted = true
    const supabase = createClient()
    Promise.all(
      CATEGORIES.map(c =>
        supabase.from('audit_log')
          .select('id', { count: 'exact', head: true })
          .or(catOrFilter([...c.prefixes]))
          .then(({ count, error }: { count: number | null; error: unknown }) =>
            (error ? [c.key, 0] : [c.key, count ?? 0]) as [string, number]
          )
      )
    ).then(entries => {
      if (!mounted) return
      setCategoryCounts(Object.fromEntries(entries))
    }).catch(() => {})
    return () => { mounted = false }
  }, [allowed])

  const stats = {
    loads:       categoryCounts['load']       ?? 0,
    carriers:    categoryCounts['carrier']    ?? 0,
    customers:   categoryCounts['customer']   ?? 0,
    invoices:    categoryCounts['invoice']    ?? 0,
    settlements: categoryCounts['settlement'] ?? 0,
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)

  const toggleCat = (key: string) => {
    setPage(1)
    setActiveCats(s => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key); else n.add(key)
      return n
    })
  }

  // Access gate — audit log is Admin + Accounting only. Wait for role to resolve.
  if (!roleLoading && !allowed) {
    return (
      <div>
        <Header
          title="Audit Log"
          subtitle="Tamper-evident record of every action across the brokerage"
        />
        <div className="p-6">
          <Card className="max-w-md mx-auto mt-8">
            <CardContent className="p-8 flex flex-col items-center text-center gap-4">
              <Lock className="h-10 w-10 text-gray-300 dark:text-gray-600" />
              <div>
                <p className="font-semibold text-gray-700 dark:text-gray-300">Access Denied</p>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                  The audit log is restricted to Admin and Accounting roles.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div>
      <Header
        title="Audit Log"
        subtitle="Tamper-evident record of every action across the brokerage — who changed what, and when"
      />
      <div className="p-6 space-y-4">

        {/* Fetch error banner with retry */}
        {fetchError && (
          <div className="rounded-lg bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 p-3 flex items-center justify-between gap-3">
            <p className="text-sm text-red-700 dark:text-red-300">{fetchError}</p>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40"
              onClick={() => fetchLogs()}
            >
              Retry
            </Button>
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
          {[
            { label: 'Total Events',      value: total,             color: 'text-gray-900 dark:text-white' },
            { label: 'Load Events',       value: stats.loads,       color: 'text-indigo-600 dark:text-indigo-400' },
            { label: 'Carrier Events',    value: stats.carriers,    color: 'text-amber-600 dark:text-amber-400' },
            { label: 'Customer Events',   value: stats.customers,   color: 'text-green-600 dark:text-green-400' },
            { label: 'Invoice Events',    value: stats.invoices,    color: 'text-violet-600 dark:text-violet-400' },
            { label: 'Settlement Events', value: stats.settlements, color: 'text-teal-600 dark:text-teal-400' },
          ].map(s => (
            <Card key={s.label} className="border">
              <CardContent className="p-3">
                <p className="text-[10px] text-gray-400 dark:text-gray-500 uppercase tracking-wide">{s.label}</p>
                <p className={`text-2xl font-bold tabular-nums mt-0.5 ${s.color}`}>{s.value.toLocaleString()}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Toolbar */}
        <Card>
          <CardContent className="p-3 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-48">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                <Input
                  placeholder="Search user, action, value…"
                  className="pl-8 h-8 text-xs"
                  value={search}
                  onChange={e => handleSearchChange(e.target.value)}
                />
              </div>

              <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                <Filter className="h-3.5 w-3.5" />
                <Input type="date" className="h-8 text-xs w-32" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1) }} />
                <span>–</span>
                <Input type="date" className="h-8 text-xs w-32" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1) }} />
              </div>

              <ExportModal filters={{ dateFrom, dateTo, search: debouncedSearch, activeCats, total }} />

              <Button
                variant="ghost" size="sm"
                className="h-8 px-2 text-gray-400 hover:text-gray-600"
                onClick={() => fetchLogs(true)}
                disabled={refreshing}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              </Button>
            </div>

            {/* Category filter pills */}
            <div className="flex flex-wrap gap-1">
              <button
                onClick={() => { setActiveCats(new Set()); setPage(1) }}
                className={`px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide transition-all ${activeCats.size === 0 ? 'bg-gray-900 dark:bg-white text-white dark:text-gray-900' : 'text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10'}`}
              >
                All
              </button>
              {CATEGORIES.map(c => {
                const Icon = c.icon
                const on = activeCats.has(c.key)
                const count = categoryCounts[c.key] ?? 0
                if (count === 0) return null
                return (
                  <button
                    key={c.key}
                    onClick={() => toggleCat(c.key)}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide transition-all ${on ? `${c.color} ring-1 ring-inset ring-current` : 'text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10'}`}
                  >
                    <Icon className="h-2.5 w-2.5" />
                    {c.label}
                    <span className="ml-0.5 opacity-60">({count})</span>
                  </button>
                )
              })}
            </div>
          </CardContent>
        </Card>

        {/* Table */}
        <Card>
          <CardHeader className="py-3 px-4 border-b dark:border-white/10">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm text-gray-700 dark:text-gray-300 flex items-center gap-2">
                <ClipboardList className="h-4 w-4 text-indigo-500" />
                {`${logs.length} events`}
              </CardTitle>
              <span className="text-xs text-gray-400 dark:text-gray-500">Click any row to expand full diff</span>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-indigo-500" />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b dark:border-white/10 bg-gray-50 dark:bg-white/5 text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                      <th className="text-left px-4 py-2.5 font-semibold whitespace-nowrap">Timestamp</th>
                      <th className="text-left px-4 py-2.5 font-semibold">User</th>
                      <th className="text-left px-4 py-2.5 font-semibold">Category</th>
                      <th className="text-left px-4 py-2.5 font-semibold">Action</th>
                      <th className="text-left px-4 py-2.5 font-semibold">Record</th>
                      <th className="px-4 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map(log => <LogRow key={log.id} log={log} />)}
                    {logs.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-16 text-center">
                          <ClipboardList className="h-8 w-8 mx-auto mb-2 text-gray-200 dark:text-gray-700" />
                          <p className="text-sm text-gray-400">{total === 0 ? 'No audit events yet.' : 'No events match your filters.'}</p>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t dark:border-white/10">
              <p className="text-xs text-gray-400 dark:text-gray-500">
                Page {page} of {totalPages} · {total.toLocaleString()} total events
              </p>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline" size="sm" className="h-7 px-2"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  const p = Math.max(1, Math.min(totalPages - 4, page - 2)) + i
                  return (
                    <Button
                      key={p}
                      variant={p === page ? 'default' : 'outline'}
                      size="sm"
                      className={`h-7 w-7 p-0 text-xs ${p === page ? 'bg-indigo-600 hover:bg-indigo-700 border-indigo-600' : ''}`}
                      onClick={() => setPage(p)}
                    >
                      {p}
                    </Button>
                  )
                })}
                <Button
                  variant="outline" size="sm" className="h-7 px-2"
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </Card>

      </div>
    </div>
  )
}
