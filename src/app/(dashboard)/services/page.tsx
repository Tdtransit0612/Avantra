'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import Header from '@/components/layout/Header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet'
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table'
import { SortableTh } from '@/components/ui/SortableTh'
import { DocumentsPanel } from '@/components/DocumentsPanel'
import {
  Plus, Search, Loader2, Wrench, Download, AlertTriangle, Save,
  MessageSquarePlus, CircleDollarSign, CheckCircle2,
} from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { logAudit } from '@/lib/audit'
import { useRole } from '@/lib/role-context'
import { downloadCSV } from '@/lib/csv'
import { useSort, type SortAccessors } from '@/lib/use-sort'
import {
  SERVICE_KINDS, SERVICE_KIND_LABEL, SERVICE_STATUS_LABELS, SERVICE_STATUS_COLORS,
  OPEN_SERVICE_STATUSES, PRIORITY_LABELS, PRIORITY_COLORS,
  money, money2, longDate, dateTime, daysUntil, num,
} from '@/lib/dispatch'
import type {
  ServiceRequest, ServiceRequestUpdate, ServiceStatus, ServicePriority, Client,
} from '@/types'

type SrSortKey = 'request_number' | 'client' | 'kind' | 'priority' | 'due' | 'status' | 'fee'
const SR_SORT: SortAccessors<ServiceRequest, SrSortKey> = {
  request_number: r => r.request_number ?? '',
  client:         r => r.client_id ?? '',
  kind:           r => SERVICE_KIND_LABEL[r.kind] ?? r.kind,
  // Urgent first when descending — encode priority as a rank, not a string.
  priority:       r => ({ urgent: 4, high: 3, normal: 2, low: 1 })[r.priority] ?? 0,
  due:            r => r.due_date ?? '',
  status:         r => r.status,
  fee:            r => r.fee_amount,
}

const BLANK = {
  client_id: '', kind: 'other', title: '', description: '',
  priority: 'normal' as ServicePriority, due_date: '',
  billable: false, fee_amount: '',
}

function RequestSheet({ existing, clients, onSaved, trigger }: {
  existing?: ServiceRequest
  clients: Client[]
  onSaved: () => void
  trigger: (open: () => void) => React.ReactNode
}) {
  const { canModify } = useRole()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [f, setF] = useState({ ...BLANK })
  const [updates, setUpdates] = useState<ServiceRequestUpdate[]>([])
  const [note, setNote] = useState('')

  const fetchUpdates = useCallback(async () => {
    if (!existing) return
    const supabase = createClient()
    const { data } = await supabase.from('service_request_updates').select('*')
      .eq('request_id', existing.id).order('created_at', { ascending: false })
    setUpdates((data ?? []) as ServiceRequestUpdate[])
  }, [existing])

  useEffect(() => {
    if (!open) return
    setError(''); setNote('')
    setF(existing ? {
      client_id: existing.client_id ?? '',
      kind: existing.kind,
      title: existing.title,
      description: existing.description ?? '',
      priority: existing.priority,
      due_date: existing.due_date ?? '',
      billable: existing.billable,
      fee_amount: String(existing.fee_amount ?? 0),
    } : { ...BLANK })
    fetchUpdates()
  }, [open, existing, fetchUpdates])

  const save = async () => {
    if (!f.title.trim()) { setError('Give the request a title.'); return }
    setSaving(true); setError('')
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const payload = {
      client_id: f.client_id || null,
      kind: f.kind,
      title: f.title.trim(),
      description: f.description.trim() || null,
      priority: f.priority,
      due_date: f.due_date || null,
      billable: f.billable,
      fee_amount: f.billable ? num(f.fee_amount) : 0,
      ...(existing ? {} : { requested_by: user?.id ?? null }),
    }
    const res = existing
      ? await supabase.from('service_requests').update(payload).eq('id', existing.id).select('id, request_number').single()
      : await supabase.from('service_requests').insert(payload).select('id, request_number').single()
    setSaving(false)
    if (res.error) { setError(res.error.message); return }
    void logAudit(existing ? 'service_request.update' : 'service_request.create', {
      table_name: 'service_requests', record_id: res.data?.id,
      new_value: { request_number: res.data?.request_number, kind: payload.kind, title: payload.title },
    })
    setOpen(false); onSaved()
  }

  const changeStatus = async (to: ServiceStatus) => {
    if (!existing) return
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const patch: Record<string, unknown> = { status: to }
    if (to === 'in_progress' && !existing.started_at) patch.started_at = new Date().toISOString()
    if (to === 'done') patch.completed_at = new Date().toISOString()
    const { error } = await supabase.from('service_requests').update(patch).eq('id', existing.id)
    if (error) { toast.error(error.message); return }
    await supabase.from('service_request_updates').insert({
      request_id: existing.id,
      body: `Status changed to ${SERVICE_STATUS_LABELS[to]}`,
      status_from: existing.status, status_to: to,
      created_by: user?.id ?? null,
    })
    void logAudit('service_request.status_change', {
      table_name: 'service_requests', record_id: existing.id,
      old_value: { status: existing.status }, new_value: { status: to },
    })
    toast.success(`Status → ${SERVICE_STATUS_LABELS[to]}`)
    fetchUpdates(); onSaved()
  }

  const addUpdate = async () => {
    if (!existing || !note.trim()) return
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('service_request_updates').insert({
      request_id: existing.id, body: note.trim(), created_by: user?.id ?? null,
    })
    if (error) { toast.error(error.message); return }
    setNote('')
    fetchUpdates()
  }

  return (
    <>
      {trigger(() => setOpen(true))}
      <Sheet open={open} onOpenChange={setOpen}>
        {open && (
          <SheetContent side="right" className="!w-[75vw] !max-w-[900px] flex flex-col gap-0 p-0">
            <SheetHeader className="px-6 py-4 border-b dark:border-gray-800">
              <SheetTitle className="text-lg font-semibold flex items-center gap-3">
                {existing ? existing.request_number : 'New Service Request'}
                {existing && (
                  <Badge className={`border ${SERVICE_STATUS_COLORS[existing.status]}`}>
                    {SERVICE_STATUS_LABELS[existing.status]}
                  </Badge>
                )}
              </SheetTitle>
              <SheetDescription>
                Anything a client asks us to do that isn&apos;t a load — authority, filings, permits,
                disputes. Billable work lands on their next fee statement.
              </SheetDescription>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
              {existing && (
                <div className="flex flex-wrap gap-2">
                  {(['in_progress', 'waiting_client', 'waiting_third_party', 'blocked', 'done', 'cancelled'] as ServiceStatus[])
                    .filter(s => s !== existing.status)
                    .map(s => (
                      <Button key={s} size="sm" variant="outline" className="h-7 text-xs" onClick={() => changeStatus(s)}>
                        {SERVICE_STATUS_LABELS[s]}
                      </Button>
                    ))}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Client</Label>
                  <Select value={f.client_id || null} onValueChange={v => setF(s => ({ ...s, client_id: (v && v !== '__none') ? v : '' }))}>
                    <SelectTrigger className="mt-1 h-9 w-full"><SelectValue placeholder="Internal / no client" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">Internal / no client</SelectItem>
                      {clients.map(c => <SelectItem key={c.id} value={c.id}>{c.dba_name || c.legal_name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Service</Label>
                  <Select value={f.kind} onValueChange={v => setF(s => ({ ...s, kind: v ?? 'other' }))}>
                    <SelectTrigger className="mt-1 h-9 w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SERVICE_KINDS.map(k => <SelectItem key={k.kind} value={k.kind}>{k.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label className="text-xs text-gray-500 dark:text-gray-400">Title *</Label>
                <Input className="mt-1 h-9" value={f.title} onChange={e => setF(s => ({ ...s, title: e.target.value }))}
                  placeholder="e.g. File Q3 IFTA for ABC Trucking" />
              </div>

              <div>
                <Label className="text-xs text-gray-500 dark:text-gray-400">Details</Label>
                <Textarea className="mt-1" rows={3} value={f.description} onChange={e => setF(s => ({ ...s, description: e.target.value }))} />
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Priority</Label>
                  <Select value={f.priority} onValueChange={v => setF(s => ({ ...s, priority: (v ?? 'normal') as ServicePriority }))}>
                    <SelectTrigger className="mt-1 h-9 w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(PRIORITY_LABELS) as ServicePriority[]).map(p => (
                        <SelectItem key={p} value={p}>{PRIORITY_LABELS[p]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Due date</Label>
                  <Input className="mt-1 h-9" type="date" value={f.due_date} onChange={e => setF(s => ({ ...s, due_date: e.target.value }))} />
                </div>
                <div className="flex items-end pb-1.5">
                  <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200 cursor-pointer">
                    <input type="checkbox" checked={f.billable} onChange={e => setF(s => ({ ...s, billable: e.target.checked }))} />
                    Billable
                  </label>
                </div>
                {f.billable && (
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Fee ($)</Label>
                    <Input className="mt-1 h-9" type="number" value={f.fee_amount} onChange={e => setF(s => ({ ...s, fee_amount: e.target.value }))} />
                  </div>
                )}
              </div>

              {f.billable && (
                <p className="text-[11px] text-gray-400 flex items-start gap-1.5">
                  <CircleDollarSign className="h-3 w-3 mt-0.5 shrink-0" />
                  Once this is marked Done, the fee is picked up by the next fee statement generated for
                  this client.
                </p>
              )}

              {existing && (
                <>
                  <section className="space-y-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Activity</p>
                    {canModify && (
                      <div className="flex items-start gap-2">
                        <Textarea rows={2} placeholder="Add an update…" value={note} onChange={e => setNote(e.target.value)} />
                        <Button className="gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white shrink-0" onClick={addUpdate} disabled={!note.trim()}>
                          <MessageSquarePlus className="h-4 w-4" />Add
                        </Button>
                      </div>
                    )}
                    {updates.length === 0 ? (
                      <p className="text-xs text-gray-400 py-4 text-center border border-dashed dark:border-gray-800 rounded-lg">
                        No activity yet.
                      </p>
                    ) : (
                      <ul className="space-y-2">
                        {updates.map(u => (
                          <li key={u.id} className="rounded-lg border dark:border-gray-800 px-3 py-2">
                            <p className="text-sm text-gray-800 dark:text-gray-100">{u.body}</p>
                            <p className="mt-0.5 text-[11px] text-gray-400">{dateTime(u.created_at)}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <DocumentsPanel
                    entityType="service_request" entityId={existing.id} clientId={existing.client_id}
                    canModify={canModify} title="Attachments"
                  />
                </>
              )}

              {error && (
                <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 rounded-lg px-4 py-2.5">
                  <AlertTriangle className="h-4 w-4 shrink-0" />{error}
                </div>
              )}
            </div>

            <div className="border-t dark:border-gray-800 px-6 py-4 flex items-center justify-end gap-3">
              <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
              {canModify && (
                <Button className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white" disabled={saving} onClick={save}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {existing ? 'Save changes' : 'Create request'}
                </Button>
              )}
            </div>
          </SheetContent>
        )}
      </Sheet>
    </>
  )
}

export default function ServicesPage() {
  const { canModify } = useRole()
  const [requests, setRequests] = useState<ServiceRequest[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('open')
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const [{ data: r }, { data: c }] = await Promise.all([
      supabase.from('service_requests').select('*').order('created_at', { ascending: false }).limit(1000),
      supabase.from('clients').select('*').is('deleted_at', null).order('legal_name'),
    ])
    setRequests((r ?? []) as ServiceRequest[])
    setClients((c ?? []) as Client[])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const clientName = useCallback((id: string | null) => {
    if (!id) return 'Internal'
    const c = clients.find(x => x.id === id)
    return c ? (c.dba_name || c.legal_name) : '—'
  }, [clients])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return requests.filter(r => {
      if (filter === 'open') {
        if (!OPEN_SERVICE_STATUSES.includes(r.status)) return false
      } else if (filter === 'overdue') {
        const d = daysUntil(r.due_date)
        if (!OPEN_SERVICE_STATUSES.includes(r.status) || d == null || d >= 0) return false
      } else if (filter === 'unbilled') {
        if (!(r.billable && r.status === 'done' && !r.billed_at)) return false
      } else if (filter !== 'all' && r.status !== filter) return false
      if (!q) return true
      return [r.request_number, r.title, r.description, clientName(r.client_id), SERVICE_KIND_LABEL[r.kind]]
        .filter(Boolean).join(' ').toLowerCase().includes(q)
    })
  }, [requests, filter, search, clientName])

  const { sorted, sort, toggle } = useSort<ServiceRequest, SrSortKey>(filtered, SR_SORT)

  const stats = useMemo(() => ({
    open: requests.filter(r => OPEN_SERVICE_STATUSES.includes(r.status)).length,
    overdue: requests.filter(r => {
      const d = daysUntil(r.due_date)
      return OPEN_SERVICE_STATUSES.includes(r.status) && d != null && d < 0
    }).length,
    unbilled: requests.filter(r => r.billable && r.status === 'done' && !r.billed_at).length,
    unbilledValue: requests.filter(r => r.billable && r.status === 'done' && !r.billed_at)
      .reduce((s, r) => s + (r.fee_amount ?? 0), 0),
  }), [requests])

  const exportCsv = () => downloadCSV(
    `service-requests-${new Date().toISOString().slice(0, 10)}.csv`,
    ['Request #', 'Client', 'Service', 'Title', 'Status', 'Priority', 'Due',
     'Billable', 'Fee', 'Billed', 'Completed'],
    sorted.map(r => [
      r.request_number, clientName(r.client_id), SERVICE_KIND_LABEL[r.kind] ?? r.kind, r.title,
      SERVICE_STATUS_LABELS[r.status], PRIORITY_LABELS[r.priority], r.due_date ?? '',
      r.billable ? 'Yes' : 'No', r.fee_amount, r.billed_at ?? '', r.completed_at ?? '',
    ]),
  )

  const tile = (key: string, value: string | number, label: string, sub: string | null, ring: string, bg: string, icon: React.ReactNode) => (
    <Card
      role="button" tabIndex={0}
      onClick={() => setFilter(f => f === key ? 'all' : key)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFilter(f => f === key ? 'all' : key) } }}
      className={`cursor-pointer transition-shadow hover:shadow-md ${filter === key ? `ring-2 ${ring}` : ''}`}
    >
      <CardContent className="flex items-center gap-3 py-4">
        <div className={`p-2 rounded-lg ${bg}`}>{icon}</div>
        <div>
          <div className="text-2xl font-bold text-gray-900 dark:text-white">{value}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
          {sub && <div className="text-[11px] text-gray-400">{sub}</div>}
        </div>
      </CardContent>
    </Card>
  )

  return (
    <>
      <Header title="Services" subtitle="The A-to-Z back-office queue — everything that isn't a load" />
      <div className="p-6 space-y-6">

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {tile('open', stats.open, 'Open requests', null, 'ring-indigo-500',
            'bg-indigo-100 dark:bg-indigo-950 text-indigo-600', <Wrench className="h-5 w-5" />)}
          {tile('overdue', stats.overdue, 'Past due', null, 'ring-red-500',
            'bg-red-100 dark:bg-red-950 text-red-600', <AlertTriangle className="h-5 w-5" />)}
          {tile('unbilled', stats.unbilled, 'Done, not billed', money(stats.unbilledValue), 'ring-emerald-500',
            'bg-emerald-100 dark:bg-emerald-950 text-emerald-600', <CircleDollarSign className="h-5 w-5" />)}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input placeholder="Search request, client, service…" className="pl-9 h-9" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <Select value={filter} onValueChange={v => setFilter(v ?? 'open')}>
            <SelectTrigger className="h-9 w-52"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="overdue">Past due</SelectItem>
              <SelectItem value="unbilled">Done, not billed</SelectItem>
              <SelectItem value="all">All requests</SelectItem>
              {(Object.keys(SERVICE_STATUS_LABELS) as ServiceStatus[]).map(s => (
                <SelectItem key={s} value={s}>{SERVICE_STATUS_LABELS[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" className="gap-2 h-9" onClick={exportCsv} disabled={filtered.length === 0}>
              <Download className="h-4 w-4" />Export
            </Button>
            {canModify && (
              <RequestSheet clients={clients} onSaved={load} trigger={open => (
                <Button className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white" onClick={open}>
                  <Plus className="h-4 w-4" />New Request
                </Button>
              )} />
            )}
          </div>
        </div>

        <Card>
          <CardContent className="p-0">
            {loading ? (
              <div className="flex items-center justify-center py-20 text-gray-400">
                <Loader2 className="h-6 w-6 animate-spin mr-2" />Loading requests…
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
                <div className="p-3 rounded-full bg-indigo-50 dark:bg-indigo-950 text-indigo-500"><Wrench className="h-7 w-7" /></div>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
                  {requests.length === 0 ? 'No service requests yet' : 'Nothing matches these filters'}
                </p>
                <p className="text-xs text-gray-400 max-w-sm">
                  {requests.length === 0
                    ? 'Log authority filings, IFTA, permits, insurance quotes, and disputes here so nothing gets lost in a text thread.'
                    : 'Try “All requests”.'}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortableTh label="Request #" k="request_number" sort={sort} toggle={toggle} />
                      <SortableTh label="Client"    k="client"         sort={sort} toggle={toggle} />
                      <SortableTh label="Service"   k="kind"           sort={sort} toggle={toggle} />
                      <TableHead>Title</TableHead>
                      <SortableTh label="Priority"  k="priority"       sort={sort} toggle={toggle} />
                      <SortableTh label="Due"       k="due"            sort={sort} toggle={toggle} />
                      <SortableTh label="Status"    k="status"         sort={sort} toggle={toggle} />
                      <SortableTh label="Fee"       k="fee"            sort={sort} toggle={toggle} align="right" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sorted.map(r => {
                      const d = daysUntil(r.due_date)
                      const late = OPEN_SERVICE_STATUSES.includes(r.status) && d != null && d < 0
                      return (
                        <TableRow key={r.id}>
                          <TableCell className="whitespace-nowrap">
                            <RequestSheet existing={r} clients={clients} onSaved={load} trigger={open => (
                              <button onClick={open} className="font-medium text-indigo-700 dark:text-indigo-400 hover:underline">
                                {r.request_number}
                              </button>
                            )} />
                          </TableCell>
                          <TableCell className="max-w-[170px] truncate text-sm">{clientName(r.client_id)}</TableCell>
                          <TableCell className="text-sm text-gray-600 dark:text-gray-300 whitespace-nowrap">
                            {SERVICE_KIND_LABEL[r.kind] ?? r.kind}
                          </TableCell>
                          <TableCell className="max-w-[240px] truncate text-sm">{r.title}</TableCell>
                          <TableCell>
                            <Badge className={`border ${PRIORITY_COLORS[r.priority]}`}>{PRIORITY_LABELS[r.priority]}</Badge>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-sm">
                            {r.due_date
                              ? <span className={late ? 'text-red-600 dark:text-red-400 font-medium' : 'text-gray-600 dark:text-gray-300'}>
                                  {longDate(r.due_date)}{late && ` (${-d!}d)`}
                                </span>
                              : <span className="text-gray-400">—</span>}
                          </TableCell>
                          <TableCell>
                            <Badge className={`border ${SERVICE_STATUS_COLORS[r.status]}`}>{SERVICE_STATUS_LABELS[r.status]}</Badge>
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-sm">
                            {r.billable
                              ? <span className="inline-flex items-center gap-1">
                                  {money2(r.fee_amount)}
                                  {r.billed_at && <CheckCircle2 className="h-3 w-3 text-emerald-500" />}
                                </span>
                              : <span className="text-gray-400">—</span>}
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
      </div>
    </>
  )
}
