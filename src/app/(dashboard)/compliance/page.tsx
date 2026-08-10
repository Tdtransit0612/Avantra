'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Header from '@/components/layout/Header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table'
import { SortableTh } from '@/components/ui/SortableTh'
import {
  Search, Loader2, ShieldCheck, ShieldAlert, Download, AlertTriangle, Clock, IdCard,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { downloadCSV } from '@/lib/csv'
import { useSort, type SortAccessors } from '@/lib/use-sort'
import {
  COMPLIANCE_KINDS, COMPLIANCE_KIND_LABEL, COMPLIANCE_STATUS_LABELS, COMPLIANCE_STATUS_COLORS,
  longDate, daysUntil,
} from '@/lib/dispatch'
import type { ComplianceItem, Client, ClientDriver } from '@/types'

// One row per tracked obligation, flattened across every client so the whole
// book can be swept in one view. Driver CDL/medical dates live on client_drivers
// rather than compliance_items, so they're folded in here as synthetic rows —
// otherwise the two halves of "is this carrier legal" would live on two screens.
interface Row {
  id: string
  clientId: string
  clientName: string
  kind: string
  label: string
  subject: string          // whose item it is (the client, or a driver's name)
  status: string
  provider: string | null
  reference: string | null
  expiry: string | null
  synthetic: boolean
}

type RowSortKey = 'client' | 'item' | 'subject' | 'expiry' | 'status'
const ROW_SORT: SortAccessors<Row, RowSortKey> = {
  client:  r => r.clientName,
  item:    r => r.label,
  subject: r => r.subject,
  expiry:  r => r.expiry ?? '',
  status:  r => r.status,
}

// Mirrors derive_compliance_status() for the synthetic driver rows.
function statusFromExpiry(expiry: string | null): string {
  if (!expiry) return 'missing'
  const d = daysUntil(expiry)
  if (d == null) return 'missing'
  if (d < 0) return 'expired'
  if (d <= 30) return 'expiring'
  return 'ok'
}

export default function CompliancePage() {
  const router = useRouter()
  const [items, setItems] = useState<ComplianceItem[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [drivers, setDrivers] = useState<ClientDriver[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('attention')
  const [kindFilter, setKindFilter] = useState('all')
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const [{ data: ci }, { data: c }, { data: d }] = await Promise.all([
      supabase.from('compliance_items').select('*').order('expiry_date', { nullsFirst: false }).limit(2000),
      supabase.from('clients').select('*').is('deleted_at', null),
      supabase.from('client_drivers').select('*').eq('status', 'active'),
    ])
    setItems((ci ?? []) as ComplianceItem[])
    setClients((c ?? []) as Client[])
    setDrivers((d ?? []) as ClientDriver[])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const clientName = useCallback((id: string) => {
    const c = clients.find(x => x.id === id)
    return c ? (c.dba_name || c.legal_name) : 'Unknown client'
  }, [clients])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = items.map(i => ({
      id: i.id,
      clientId: i.client_id,
      clientName: clientName(i.client_id),
      kind: i.kind,
      label: i.label || COMPLIANCE_KIND_LABEL[i.kind] || i.kind,
      subject: clientName(i.client_id),
      status: i.status,
      provider: i.provider,
      reference: i.reference,
      expiry: i.expiry_date,
      synthetic: false,
    }))

    for (const d of drivers) {
      if (d.cdl_expiry !== null) {
        out.push({
          id: `${d.id}-cdl`, clientId: d.client_id, clientName: clientName(d.client_id),
          kind: 'cdl', label: 'CDL', subject: d.full_name,
          status: statusFromExpiry(d.cdl_expiry), provider: d.cdl_state, reference: d.cdl_number,
          expiry: d.cdl_expiry, synthetic: true,
        })
      }
      if (d.medical_expiry !== null) {
        out.push({
          id: `${d.id}-med`, clientId: d.client_id, clientName: clientName(d.client_id),
          kind: 'medical_card', label: 'Medical card', subject: d.full_name,
          status: statusFromExpiry(d.medical_expiry), provider: null, reference: null,
          expiry: d.medical_expiry, synthetic: true,
        })
      }
    }
    return out
  }, [items, drivers, clientName])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter(r => {
      if (statusFilter === 'attention') {
        if (!['expired', 'expiring', 'missing'].includes(r.status)) return false
      } else if (statusFilter !== 'all' && r.status !== statusFilter) return false
      if (kindFilter !== 'all' && r.kind !== kindFilter) return false
      if (!q) return true
      return [r.clientName, r.label, r.subject, r.provider, r.reference]
        .filter(Boolean).join(' ').toLowerCase().includes(q)
    })
  }, [rows, statusFilter, kindFilter, search])

  const { sorted, sort, toggle } = useSort<Row, RowSortKey>(filtered, ROW_SORT, { key: 'expiry', dir: 'asc' })

  const stats = useMemo(() => ({
    expired: rows.filter(r => r.status === 'expired').length,
    expiring: rows.filter(r => r.status === 'expiring').length,
    missing: rows.filter(r => r.status === 'missing').length,
    ok: rows.filter(r => r.status === 'ok').length,
  }), [rows])

  const exportCsv = () => downloadCSV(
    `compliance-${new Date().toISOString().slice(0, 10)}.csv`,
    ['Client', 'Item', 'Subject', 'Provider', 'Reference', 'Expires', 'Days', 'Status'],
    sorted.map(r => [
      r.clientName, r.label, r.subject, r.provider ?? '', r.reference ?? '',
      r.expiry ?? '', daysUntil(r.expiry) ?? '', COMPLIANCE_STATUS_LABELS[r.status as keyof typeof COMPLIANCE_STATUS_LABELS] ?? r.status,
    ]),
  )

  const tile = (key: string, value: number, label: string, icon: React.ReactNode, ring: string, bg: string) => (
    <Card
      role="button" tabIndex={0}
      onClick={() => setStatusFilter(f => f === key ? 'all' : key)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setStatusFilter(f => f === key ? 'all' : key) } }}
      className={`cursor-pointer transition-shadow hover:shadow-md ${statusFilter === key ? `ring-2 ${ring}` : ''}`}
    >
      <CardContent className="flex items-center gap-3 py-4">
        <div className={`p-2 rounded-lg ${bg}`}>{icon}</div>
        <div>
          <div className="text-2xl font-bold text-gray-900 dark:text-white">{value}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
        </div>
      </CardContent>
    </Card>
  )

  return (
    <>
      <Header title="Compliance" subtitle="Every expiring obligation across the client book" />
      <div className="p-6 space-y-6">

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {tile('expired', stats.expired, 'Expired',
            <ShieldAlert className="h-5 w-5" />, 'ring-red-500', 'bg-red-100 dark:bg-red-950 text-red-600')}
          {tile('expiring', stats.expiring, 'Expiring in 30 days',
            <Clock className="h-5 w-5" />, 'ring-amber-500', 'bg-amber-100 dark:bg-amber-950 text-amber-600')}
          {tile('missing', stats.missing, 'Missing',
            <AlertTriangle className="h-5 w-5" />, 'ring-orange-500', 'bg-orange-100 dark:bg-orange-950 text-orange-600')}
          {tile('ok', stats.ok, 'Current',
            <ShieldCheck className="h-5 w-5" />, 'ring-emerald-500', 'bg-emerald-100 dark:bg-emerald-950 text-emerald-600')}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input placeholder="Search client, item, driver…" className="pl-9 h-9" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <Select value={statusFilter} onValueChange={v => setStatusFilter(v ?? 'attention')}>
            <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="attention">Needs attention</SelectItem>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
              <SelectItem value="expiring">Expiring</SelectItem>
              <SelectItem value="missing">Missing</SelectItem>
              <SelectItem value="ok">Current</SelectItem>
            </SelectContent>
          </Select>
          <Select value={kindFilter} onValueChange={v => setKindFilter(v ?? 'all')}>
            <SelectTrigger className="h-9 w-52"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All item types</SelectItem>
              {COMPLIANCE_KINDS.map(k => <SelectItem key={k.kind} value={k.kind}>{k.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" className="ml-auto gap-2 h-9" onClick={exportCsv} disabled={filtered.length === 0}>
            <Download className="h-4 w-4" />Export
          </Button>
        </div>

        <Card>
          <CardContent className="p-0">
            {loading ? (
              <div className="flex items-center justify-center py-20 text-gray-400">
                <Loader2 className="h-6 w-6 animate-spin mr-2" />Loading compliance…
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
                <div className="p-3 rounded-full bg-emerald-50 dark:bg-emerald-950 text-emerald-500"><ShieldCheck className="h-7 w-7" /></div>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
                  {rows.length === 0 ? 'Nothing tracked yet' : 'Nothing needs attention'}
                </p>
                <p className="text-xs text-gray-400 max-w-sm">
                  {rows.length === 0
                    ? 'Open a client and add their authority, COIs, IFTA, UCR, and driver credentials to start tracking.'
                    : 'Everything in this filter is current.'}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortableTh label="Client"  k="client"  sort={sort} toggle={toggle} />
                      <SortableTh label="Item"    k="item"    sort={sort} toggle={toggle} />
                      <SortableTh label="Subject" k="subject" sort={sort} toggle={toggle} />
                      <TableHead>Reference</TableHead>
                      <SortableTh label="Expires" k="expiry"  sort={sort} toggle={toggle} />
                      <TableHead className="text-right">Days</TableHead>
                      <SortableTh label="Status"  k="status"  sort={sort} toggle={toggle} />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sorted.map(r => {
                      const d = daysUntil(r.expiry)
                      return (
                        <TableRow key={r.id} className="cursor-pointer" onClick={() => router.push(`/clients/${r.clientId}`)}>
                          <TableCell className="max-w-[200px] truncate font-medium">{r.clientName}</TableCell>
                          <TableCell className="text-sm">
                            <span className="inline-flex items-center gap-1.5">
                              {r.synthetic && <IdCard className="h-3.5 w-3.5 text-gray-400" />}
                              {r.label}
                            </span>
                          </TableCell>
                          <TableCell className="max-w-[180px] truncate text-sm text-gray-600 dark:text-gray-300">
                            {r.subject}
                          </TableCell>
                          <TableCell className="text-sm text-gray-600 dark:text-gray-300">
                            {[r.provider, r.reference].filter(Boolean).join(' · ') || '—'}
                          </TableCell>
                          <TableCell className="text-sm text-gray-600 dark:text-gray-300 whitespace-nowrap">
                            {r.expiry ? longDate(r.expiry) : '—'}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-sm">
                            {d == null ? <span className="text-gray-400">—</span>
                              : <span className={d < 0 ? 'text-red-600 dark:text-red-400 font-semibold' : d <= 30 ? 'text-amber-600 dark:text-amber-400 font-medium' : 'text-gray-600 dark:text-gray-300'}>
                                  {d < 0 ? `${-d} late` : d}
                                </span>}
                          </TableCell>
                          <TableCell>
                            <Badge className={`border ${COMPLIANCE_STATUS_COLORS[r.status as keyof typeof COMPLIANCE_STATUS_COLORS] ?? ''}`}>
                              {COMPLIANCE_STATUS_LABELS[r.status as keyof typeof COMPLIANCE_STATUS_LABELS] ?? r.status}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {!loading && filtered.length > 0 && (
          <p className="text-xs text-gray-400">
            {filtered.length} of {rows.length} tracked item{rows.length !== 1 ? 's' : ''} · click a row to open the client
          </p>
        )}
      </div>
    </>
  )
}
