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
import {
  Plus, Search, Loader2, Building2, AlertTriangle, Download, ShieldCheck,
  Ban, Clock, PencilLine,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { logAudit } from '@/lib/audit'
import { useRole } from '@/lib/role-context'
import { downloadCSV } from '@/lib/csv'
import { useSort, type SortAccessors } from '@/lib/use-sort'
import { num, money } from '@/lib/dispatch'
import type { Broker, PacketStatus } from '@/types'

const PACKET_STATUSES: PacketStatus[] = ['none', 'sent', 'pending', 'complete']
const PACKET_LABELS: Record<PacketStatus, string> = {
  none: 'Not started', sent: 'Sent', pending: 'Pending', complete: 'Complete',
}
const PACKET_COLORS: Record<PacketStatus, string> = {
  none:     'bg-gray-100 text-gray-700 border-gray-200 dark:bg-white/10 dark:text-gray-300 dark:border-white/10',
  sent:     'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-800/50',
  pending:  'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800/50',
  complete: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-800/50',
}

type BrokerSortKey = 'name' | 'mc' | 'terms' | 'days' | 'packet' | 'credit'
const BROKER_SORT: SortAccessors<Broker, BrokerSortKey> = {
  name:   b => b.name ?? '',
  mc:     b => b.mc_number ?? '',
  terms:  b => b.payment_terms ?? '',
  days:   b => b.days_to_pay,
  packet: b => b.packet_status,
  credit: b => b.credit_limit,
}

const BLANK = {
  name: '', mc_number: '', dot_number: '',
  contact_name: '', phone: '', after_hours_phone: '', email: '', billing_email: '',
  address: '', city: '', state: '', zip: '',
  payment_terms: 'Net 30', days_to_pay: '', credit_rating: '', credit_limit: '',
  packet_status: 'none' as PacketStatus,
  do_not_use: false, do_not_use_reason: '',
  notes: '',
}

interface FmcsaResult {
  configured?: boolean
  legalName?: string | null
  dbaName?: string | null
  dotNumber?: string | null
  mcNumber?: string | null
  phyStreet?: string | null
  phyCity?: string | null
  phyState?: string | null
  phyZip?: string | null
  error?: string
}

function BrokerSheet({
  existing, onSaved, trigger,
}: {
  existing?: Broker
  onSaved: () => void
  trigger: (open: () => void) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [looking, setLooking] = useState(false)
  const [lookupNote, setLookupNote] = useState('')
  const [form, setForm] = useState({ ...BLANK })

  // Hydrate from the row being edited each time the sheet opens, so a cancelled
  // edit never leaks into the next one.
  useEffect(() => {
    if (!open) return
    setError(''); setLookupNote('')
    setForm(existing ? {
      name: existing.name ?? '',
      mc_number: existing.mc_number ?? '',
      dot_number: existing.dot_number ?? '',
      contact_name: existing.contact_name ?? '',
      phone: existing.phone ?? '',
      after_hours_phone: existing.after_hours_phone ?? '',
      email: existing.email ?? '',
      billing_email: existing.billing_email ?? '',
      address: existing.address ?? '',
      city: existing.city ?? '',
      state: existing.state ?? '',
      zip: existing.zip ?? '',
      payment_terms: existing.payment_terms ?? '',
      days_to_pay: existing.days_to_pay?.toString() ?? '',
      credit_rating: existing.credit_rating ?? '',
      credit_limit: existing.credit_limit?.toString() ?? '',
      packet_status: existing.packet_status,
      do_not_use: existing.do_not_use,
      do_not_use_reason: existing.do_not_use_reason ?? '',
      notes: existing.notes ?? '',
    } : { ...BLANK })
  }, [open, existing])

  const set = <K extends keyof typeof BLANK>(k: K, v: (typeof BLANK)[K]) =>
    setForm(f => ({ ...f, [k]: v }))

  const runFmcsa = async () => {
    const mc = form.mc_number.replace(/\D/g, '')
    const dot = form.dot_number.replace(/\D/g, '')
    if (!mc && !dot) { setLookupNote('Enter an MC or DOT number first.'); return }
    setLooking(true); setLookupNote('')
    try {
      const res = await fetch('/api/fmcsa', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mc, dot }),
      })
      const data = (await res.json()) as FmcsaResult
      if (data.configured === false) {
        setLookupNote('FMCSA lookup isn’t configured yet (FMCSA_WEBKEY). Enter details manually.')
        return
      }
      if (data.error) { setLookupNote(data.error); return }
      setForm(f => ({
        ...f,
        name: data.dbaName || data.legalName || f.name,
        dot_number: data.dotNumber || f.dot_number,
        mc_number: data.mcNumber || f.mc_number,
        address: data.phyStreet || f.address,
        city: data.phyCity || f.city,
        state: data.phyState || f.state,
        zip: data.phyZip || f.zip,
      }))
      setLookupNote('Found — fields prefilled.')
    } catch {
      setLookupNote('Lookup failed. Enter details manually.')
    } finally {
      setLooking(false)
    }
  }

  const handleSubmit = async () => {
    if (!form.name.trim()) { setError('Broker name is required.'); return }
    if (form.do_not_use && !form.do_not_use_reason.trim()) {
      setError('Give a reason when flagging a broker do-not-use — the next dispatcher needs to know why.')
      return
    }
    setSaving(true); setError('')
    const supabase = createClient()

    const payload = {
      name: form.name.trim(),
      mc_number: form.mc_number.trim() || null,
      dot_number: form.dot_number.trim() || null,
      contact_name: form.contact_name.trim() || null,
      phone: form.phone.trim() || null,
      after_hours_phone: form.after_hours_phone.trim() || null,
      email: form.email.trim() || null,
      billing_email: form.billing_email.trim() || null,
      address: form.address.trim() || null,
      city: form.city.trim() || null,
      state: form.state.toUpperCase().slice(0, 2) || null,
      zip: form.zip.trim() || null,
      payment_terms: form.payment_terms.trim() || null,
      days_to_pay: form.days_to_pay ? Math.round(num(form.days_to_pay)) : null,
      credit_rating: form.credit_rating.trim() || null,
      credit_limit: form.credit_limit ? num(form.credit_limit) : null,
      packet_status: form.packet_status,
      packet_completed_at: form.packet_status === 'complete'
        ? (existing?.packet_completed_at ?? new Date().toISOString().slice(0, 10))
        : null,
      do_not_use: form.do_not_use,
      do_not_use_reason: form.do_not_use ? form.do_not_use_reason.trim() : null,
      notes: form.notes.trim() || null,
    }

    const res = existing
      ? await supabase.from('brokers').update(payload).eq('id', existing.id).select('id').single()
      : await supabase.from('brokers').insert(payload).select('id').single()

    setSaving(false)
    if (res.error) { setError(res.error.message); return }

    void logAudit(existing ? 'broker.update' : 'broker.create', {
      table_name: 'brokers',
      record_id: res.data?.id,
      new_value: {
        name: payload.name, mc_number: payload.mc_number,
        packet_status: payload.packet_status, do_not_use: payload.do_not_use,
      },
    })

    setOpen(false)
    onSaved()
  }

  return (
    <>
      {trigger(() => setOpen(true))}

      <Sheet open={open} onOpenChange={setOpen}>
        {open && (
          <SheetContent side="right" className="!w-[75vw] !max-w-[900px] flex flex-col gap-0 p-0">
            <SheetHeader className="px-6 py-4 border-b dark:border-gray-800">
              <SheetTitle className="text-lg font-semibold">
                {existing ? 'Edit Broker' : 'Add a Broker'}
              </SheetTitle>
              <SheetDescription>
                A broker or shipper we book freight with. They pay the freight bill — to our client.
              </SheetDescription>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
              <section className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Identity</p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="md:col-span-1">
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Broker name *</Label>
                    <Input className="mt-1 h-9" value={form.name} onChange={e => set('name', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">MC #</Label>
                    <Input className="mt-1 h-9" value={form.mc_number} onChange={e => set('mc_number', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">DOT #</Label>
                    <Input className="mt-1 h-9" value={form.dot_number} onChange={e => set('dot_number', e.target.value)} />
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Button type="button" variant="outline" className="gap-2 h-9" onClick={runFmcsa} disabled={looking}>
                    {looking ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                    Look up FMCSA
                  </Button>
                  {lookupNote && <p className="text-xs text-gray-500 dark:text-gray-400">{lookupNote}</p>}
                </div>
              </section>

              <section className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Contact</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Contact name</Label>
                    <Input className="mt-1 h-9" value={form.contact_name} onChange={e => set('contact_name', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Phone</Label>
                    <Input className="mt-1 h-9" value={form.phone} onChange={e => set('phone', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">After-hours phone</Label>
                    <Input className="mt-1 h-9" value={form.after_hours_phone} onChange={e => set('after_hours_phone', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Email</Label>
                    <Input className="mt-1 h-9" type="email" value={form.email} onChange={e => set('email', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Billing / AP email</Label>
                    <Input className="mt-1 h-9" type="email" value={form.billing_email} onChange={e => set('billing_email', e.target.value)} placeholder="Where invoices go" />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Address</Label>
                    <Input className="mt-1 h-9" value={form.address} onChange={e => set('address', e.target.value)} />
                  </div>
                  <div className="grid grid-cols-3 gap-2 md:col-span-2">
                    <div>
                      <Label className="text-xs text-gray-500 dark:text-gray-400">City</Label>
                      <Input className="mt-1 h-9" value={form.city} onChange={e => set('city', e.target.value)} />
                    </div>
                    <div>
                      <Label className="text-xs text-gray-500 dark:text-gray-400">State</Label>
                      <Input className="mt-1 h-9" maxLength={2} value={form.state} onChange={e => set('state', e.target.value.toUpperCase())} />
                    </div>
                    <div>
                      <Label className="text-xs text-gray-500 dark:text-gray-400">ZIP</Label>
                      <Input className="mt-1 h-9" value={form.zip} onChange={e => set('zip', e.target.value)} />
                    </div>
                  </div>
                </div>
              </section>

              <section className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Credit &amp; setup
                </p>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Payment terms</Label>
                    <Input className="mt-1 h-9" value={form.payment_terms} onChange={e => set('payment_terms', e.target.value)} placeholder="Net 30" />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Avg days to pay</Label>
                    <Input className="mt-1 h-9" type="number" value={form.days_to_pay} onChange={e => set('days_to_pay', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Credit rating</Label>
                    <Input className="mt-1 h-9" value={form.credit_rating} onChange={e => set('credit_rating', e.target.value)} placeholder="e.g. 95" />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Credit limit ($)</Label>
                    <Input className="mt-1 h-9" type="number" value={form.credit_limit} onChange={e => set('credit_limit', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Setup packet</Label>
                    <Select value={form.packet_status} onValueChange={v => set('packet_status', (v ?? 'none') as PacketStatus)}>
                      <SelectTrigger className="mt-1 h-9 w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {PACKET_STATUSES.map(s => <SelectItem key={s} value={s}>{PACKET_LABELS[s]}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <p className="text-[11px] text-gray-400">
                  The setup packet is what lets us invoice this broker in a client&apos;s name. Booking against
                  an incomplete packet means the invoice may bounce.
                </p>
              </section>

              <section className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Blocklist &amp; notes
                </p>
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200 cursor-pointer">
                  <input type="checkbox" checked={form.do_not_use} onChange={e => set('do_not_use', e.target.checked)} />
                  <Ban className="h-4 w-4 text-red-500" />
                  Do not use this broker
                </label>
                {form.do_not_use && (
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Reason *</Label>
                    <Input className="mt-1 h-9" value={form.do_not_use_reason} onChange={e => set('do_not_use_reason', e.target.value)} placeholder="Slow pay, chargebacks, double-brokering…" />
                  </div>
                )}
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Notes</Label>
                  <Textarea className="mt-1" rows={3} value={form.notes} onChange={e => set('notes', e.target.value)} />
                </div>
              </section>

              {error && (
                <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 rounded-lg px-4 py-2.5">
                  <AlertTriangle className="h-4 w-4 shrink-0" />{error}
                </div>
              )}
            </div>

            <div className="border-t dark:border-gray-800 px-6 py-4 flex items-center justify-end gap-3">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white" disabled={saving} onClick={handleSubmit}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {saving ? 'Saving…' : existing ? 'Save Broker' : 'Create Broker'}
              </Button>
            </div>
          </SheetContent>
        )}
      </Sheet>
    </>
  )
}

export default function BrokersPage() {
  const { canModify } = useRole()
  const [brokers, setBrokers] = useState<Broker[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<string>('all')
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const { data } = await supabase.from('brokers').select('*').order('name').limit(1000)
    setBrokers((data ?? []) as Broker[])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return brokers.filter(b => {
      if (filter === 'do_not_use' && !b.do_not_use) return false
      if (filter === 'needs_packet' && (b.packet_status === 'complete' || b.do_not_use)) return false
      if (filter === 'ready' && (b.packet_status !== 'complete' || b.do_not_use)) return false
      if (!q) return true
      const hay = [b.name, b.mc_number, b.dot_number, b.contact_name, b.email, b.city, b.state]
        .filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [brokers, filter, search])

  const { sorted, sort, toggle } = useSort<Broker, BrokerSortKey>(filtered, BROKER_SORT)

  const exportCsv = () => downloadCSV(
    `brokers-${new Date().toISOString().slice(0, 10)}.csv`,
    ['Name', 'MC', 'DOT', 'Contact', 'Phone', 'Billing Email', 'City', 'State',
     'Terms', 'Days to Pay', 'Credit Rating', 'Credit Limit', 'Packet', 'Do Not Use', 'Reason'],
    sorted.map(b => [
      b.name, b.mc_number ?? '', b.dot_number ?? '', b.contact_name ?? '', b.phone ?? '',
      b.billing_email ?? '', b.city ?? '', b.state ?? '', b.payment_terms ?? '',
      b.days_to_pay ?? '', b.credit_rating ?? '', b.credit_limit ?? '',
      PACKET_LABELS[b.packet_status], b.do_not_use ? 'Yes' : 'No', b.do_not_use_reason ?? '',
    ]),
  )

  const stats = useMemo(() => ({
    ready: brokers.filter(b => b.packet_status === 'complete' && !b.do_not_use).length,
    needsPacket: brokers.filter(b => b.packet_status !== 'complete' && !b.do_not_use).length,
    blocked: brokers.filter(b => b.do_not_use).length,
  }), [brokers])

  return (
    <>
      <Header title="Brokers" subtitle="Counterparties we book freight with" />
      <div className="p-6 space-y-6">

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card
            role="button" tabIndex={0}
            onClick={() => setFilter(f => f === 'ready' ? 'all' : 'ready')}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFilter(f => f === 'ready' ? 'all' : 'ready') } }}
            className={`cursor-pointer transition-shadow hover:shadow-md ${filter === 'ready' ? 'ring-2 ring-emerald-500' : ''}`}
          >
            <CardContent className="flex items-center gap-3 py-4">
              <div className="p-2 rounded-lg bg-emerald-100 dark:bg-emerald-950 text-emerald-600"><ShieldCheck className="h-5 w-5" /></div>
              <div>
                <div className="text-2xl font-bold text-gray-900 dark:text-white">{stats.ready}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">Ready to book</div>
              </div>
            </CardContent>
          </Card>
          <Card
            role="button" tabIndex={0}
            onClick={() => setFilter(f => f === 'needs_packet' ? 'all' : 'needs_packet')}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFilter(f => f === 'needs_packet' ? 'all' : 'needs_packet') } }}
            className={`cursor-pointer transition-shadow hover:shadow-md ${filter === 'needs_packet' ? 'ring-2 ring-amber-500' : ''}`}
          >
            <CardContent className="flex items-center gap-3 py-4">
              <div className="p-2 rounded-lg bg-amber-100 dark:bg-amber-950 text-amber-600"><Clock className="h-5 w-5" /></div>
              <div>
                <div className="text-2xl font-bold text-gray-900 dark:text-white">{stats.needsPacket}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">Setup packet open</div>
              </div>
            </CardContent>
          </Card>
          <Card
            role="button" tabIndex={0}
            onClick={() => setFilter(f => f === 'do_not_use' ? 'all' : 'do_not_use')}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFilter(f => f === 'do_not_use' ? 'all' : 'do_not_use') } }}
            className={`cursor-pointer transition-shadow hover:shadow-md ${filter === 'do_not_use' ? 'ring-2 ring-red-500' : ''}`}
          >
            <CardContent className="flex items-center gap-3 py-4">
              <div className="p-2 rounded-lg bg-red-100 dark:bg-red-950 text-red-600"><Ban className="h-5 w-5" /></div>
              <div>
                <div className="text-2xl font-bold text-gray-900 dark:text-white">{stats.blocked}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">Do not use</div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input placeholder="Search broker, MC, contact…" className="pl-9 h-9" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <Select value={filter} onValueChange={v => setFilter(v ?? 'all')}>
            <SelectTrigger className="h-9 w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All brokers</SelectItem>
              <SelectItem value="ready">Ready to book</SelectItem>
              <SelectItem value="needs_packet">Setup packet open</SelectItem>
              <SelectItem value="do_not_use">Do not use</SelectItem>
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" className="gap-2 h-9" onClick={exportCsv} disabled={filtered.length === 0}>
              <Download className="h-4 w-4" />Export
            </Button>
            {canModify && (
              <BrokerSheet
                onSaved={load}
                trigger={open => (
                  <Button className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white" onClick={open}>
                    <Plus className="h-4 w-4" />New Broker
                  </Button>
                )}
              />
            )}
          </div>
        </div>

        <Card>
          <CardContent className="p-0">
            {loading ? (
              <div className="flex items-center justify-center py-20 text-gray-400">
                <Loader2 className="h-6 w-6 animate-spin mr-2" />Loading brokers…
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
                <div className="p-3 rounded-full bg-indigo-50 dark:bg-indigo-950 text-indigo-500"><Building2 className="h-7 w-7" /></div>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
                  {brokers.length === 0 ? 'No brokers yet' : 'No brokers match your filters'}
                </p>
                <p className="text-xs text-gray-400 max-w-xs">
                  {brokers.length === 0
                    ? 'Add the brokers you book with so loads can reference a real counterparty.'
                    : 'Try clearing the search or filter.'}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortableTh label="Broker"  k="name"   sort={sort} toggle={toggle} />
                      <SortableTh label="MC / DOT" k="mc"    sort={sort} toggle={toggle} />
                      <TableHead>Contact</TableHead>
                      <SortableTh label="Terms"   k="terms"  sort={sort} toggle={toggle} />
                      <SortableTh label="Days"    k="days"   sort={sort} toggle={toggle} align="right" />
                      <SortableTh label="Credit"  k="credit" sort={sort} toggle={toggle} align="right" />
                      <SortableTh label="Packet"  k="packet" sort={sort} toggle={toggle} />
                      <TableHead className="w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sorted.map(b => (
                      <TableRow key={b.id} className={b.do_not_use ? 'bg-red-50/50 dark:bg-red-950/10' : undefined}>
                        <TableCell className="max-w-[240px]">
                          <div className="flex items-center gap-2">
                            {b.do_not_use && <Ban className="h-3.5 w-3.5 text-red-500 shrink-0" />}
                            <span className="truncate font-medium text-gray-900 dark:text-white">{b.name}</span>
                          </div>
                          {b.do_not_use && b.do_not_use_reason && (
                            <div className="truncate text-xs text-red-600 dark:text-red-400">{b.do_not_use_reason}</div>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm text-gray-600 dark:text-gray-300">
                          {b.mc_number ? `MC ${b.mc_number}` : '—'}
                          {b.dot_number && <span className="text-gray-400"> · {b.dot_number}</span>}
                        </TableCell>
                        <TableCell className="max-w-[180px] truncate text-sm text-gray-600 dark:text-gray-300">
                          {b.contact_name || b.billing_email || b.email || '—'}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm text-gray-600 dark:text-gray-300">
                          {b.payment_terms || '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-sm text-gray-600 dark:text-gray-300">
                          {b.days_to_pay ?? '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-sm text-gray-600 dark:text-gray-300">
                          {b.credit_limit != null ? money(b.credit_limit) : '—'}
                        </TableCell>
                        <TableCell>
                          <Badge className={`border ${PACKET_COLORS[b.packet_status]}`}>{PACKET_LABELS[b.packet_status]}</Badge>
                        </TableCell>
                        <TableCell>
                          {canModify && (
                            <BrokerSheet
                              existing={b}
                              onSaved={load}
                              trigger={open => (
                                <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={open} title="Edit broker">
                                  <PencilLine className="h-4 w-4" />
                                </Button>
                              )}
                            />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {!loading && filtered.length > 0 && (
          <p className="text-xs text-gray-400">{filtered.length} of {brokers.length} broker{brokers.length !== 1 ? 's' : ''}</p>
        )}
      </div>
    </>
  )
}
