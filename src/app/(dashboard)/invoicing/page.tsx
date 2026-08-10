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
  Plus, Search, Loader2, FileText, AlertTriangle, Download, Phone,
  Banknote, Clock, Save, CheckCircle2, Ban, PackageCheck,
} from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { logAudit } from '@/lib/audit'
import { useRole } from '@/lib/role-context'
import { downloadCSV } from '@/lib/csv'
import { useSort, type SortAccessors } from '@/lib/use-sort'
import {
  INVOICE_STATUSES, INVOICE_STATUS_LABELS, INVOICE_STATUS_COLORS, OPEN_INVOICE_STATUSES,
  TRACE_OUTCOME_LABELS, money, money2, longDate, dateTime, todayISO,
  daysPastDue, agingBucket, num,
} from '@/lib/dispatch'
import type {
  Invoice, InvoiceStatus, InvoiceTrace, Load, Client, Broker, FactoringCompany,
} from '@/types'

type InvoiceSortKey =
  | 'invoice_number' | 'client' | 'broker' | 'issued' | 'due' | 'amount' | 'status' | 'aging'

const INVOICE_SORT: SortAccessors<Invoice, InvoiceSortKey> = {
  invoice_number: i => i.invoice_number ?? '',
  client:         i => i.client_id ?? '',
  broker:         i => i.broker_id ?? '',
  issued:         i => i.issued_date ?? '',
  due:            i => i.due_date ?? '',
  amount:         i => i.amount,
  status:         i => i.status,
  aging:          i => daysPastDue(i.due_date),
}

const AGING_LABELS: Record<string, string> = {
  current: 'Current', '1-30': '1–30', '31-60': '31–60', '61-90': '61–90', '90+': '90+',
}

// Net-terms string → days. Anything unparseable falls back to 30.
function termsToDays(terms: string | null | undefined): number {
  const m = /(\d+)/.exec(terms ?? '')
  return m ? parseInt(m[1], 10) : 30
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

// ── Create invoice from a delivered load ─────────────────────────────────────
function NewInvoiceSheet({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [loads, setLoads] = useState<Load[]>([])
  const [brokers, setBrokers] = useState<Broker[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [loadId, setLoadId] = useState('')
  const [issued, setIssued] = useState(todayISO())
  const [terms, setTerms] = useState('Net 30')
  const [notes, setNotes] = useState('')

  useEffect(() => {
    if (!open) return
    setError(''); setLoadId(''); setIssued(todayISO()); setNotes('')
    const supabase = createClient()
    ;(async () => {
      // Only loads that have moved and aren't already invoiced. The unique index
      // on invoices(load_id) is the real guard; this just keeps the list honest.
      const [{ data: l }, { data: b }, { data: c }, { data: inv }] = await Promise.all([
        supabase.from('loads').select('*').is('deleted_at', null)
          .in('status', ['delivered', 'docs_received']).order('delivery_date', { ascending: true }),
        supabase.from('brokers').select('*').order('name'),
        supabase.from('clients').select('*').is('deleted_at', null).order('legal_name'),
        supabase.from('invoices').select('load_id').neq('status', 'void'),
      ])
      const invoiced = new Set((inv ?? []).map(r => r.load_id).filter(Boolean))
      setLoads(((l ?? []) as Load[]).filter(x => !invoiced.has(x.id)))
      setBrokers((b ?? []) as Broker[])
      setClients((c ?? []) as Client[])
    })()
  }, [open])

  const load = useMemo(() => loads.find(l => l.id === loadId) ?? null, [loads, loadId])
  const broker = useMemo(() => brokers.find(b => b.id === load?.broker_id) ?? null, [brokers, load])
  const client = useMemo(() => clients.find(c => c.id === load?.client_id) ?? null, [clients, load])

  // Default the terms off the broker's own terms once a load is picked.
  useEffect(() => { if (broker?.payment_terms) setTerms(broker.payment_terms) }, [broker])

  const dueDate = useMemo(() => addDays(issued || todayISO(), termsToDays(terms)), [issued, terms])

  const submit = async () => {
    if (!load) { setError('Pick a delivered load to invoice.'); return }
    if (!load.broker_id) { setError('That load has no broker, so there is nobody to invoice.'); return }
    setSaving(true); setError('')
    const supabase = createClient()

    // Factored receivables are assigned at creation so the remit block can never
    // point at the carrier by accident.
    const factored = !!client?.factors_invoices && !!client?.factoring_company_id

    const { data: created, error: err } = await supabase.from('invoices').insert({
      load_id: load.id,
      client_id: load.client_id,
      broker_id: load.broker_id,
      status: 'draft' as InvoiceStatus,
      amount: load.gross_total,
      issued_date: issued || todayISO(),
      due_date: dueDate,
      terms,
      factoring_company_id: factored ? client!.factoring_company_id : null,
      notes: notes.trim() || null,
    }).select('id, invoice_number').single()

    setSaving(false)
    if (err) {
      setError(err.code === '23505'
        ? 'That load already has a live invoice. Void the existing one first.'
        : err.message)
      return
    }

    // Move the load along so it leaves the "ready to invoice" queue.
    await supabase.from('loads').update({ status: 'invoiced' }).eq('id', load.id)

    void logAudit('invoice.create', {
      table_name: 'invoices', record_id: created?.id,
      new_value: {
        invoice_number: created?.invoice_number, load_number: load.load_number,
        amount: load.gross_total, broker: load.broker_name, factored,
      },
    })
    toast.success(`${created?.invoice_number} created`)
    setOpen(false)
    onCreated()
  }

  return (
    <>
      <Button className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />New Invoice
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        {open && (
          <SheetContent side="right" className="!w-[75vw] !max-w-[900px] flex flex-col gap-0 p-0">
            <SheetHeader className="px-6 py-4 border-b dark:border-gray-800">
              <SheetTitle className="text-lg font-semibold">Invoice a Broker</SheetTitle>
              <SheetDescription>
                Issued in the client carrier&apos;s name, under their authority. The money goes to them
                (or their factor) — not to Avantra.
              </SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
              <div>
                <Label className="text-xs text-gray-500 dark:text-gray-400">Delivered load *</Label>
                <Select value={loadId || null} onValueChange={v => setLoadId(v ?? '')}>
                  <SelectTrigger className="mt-1 h-9 w-full">
                    <SelectValue placeholder={loads.length ? 'Pick a load to invoice' : 'No uninvoiced delivered loads'} />
                  </SelectTrigger>
                  <SelectContent>
                    {loads.map(l => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.load_number} — {l.client_name} · {money(l.gross_total)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {loads.length === 0 && (
                  <p className="mt-1 text-[11px] text-gray-400">
                    A load shows up here once it&apos;s marked Delivered or Docs In and has no live invoice.
                  </p>
                )}
              </div>

              {load && (
                <div className="rounded-lg border dark:border-gray-800 p-4 space-y-2 text-sm">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Bill from</div>
                      <div className="text-gray-900 dark:text-white">{load.client_name || '—'}</div>
                      <div className="text-[11px] text-gray-400">{client?.mc_number ? `MC ${client.mc_number}` : 'No MC on file'}</div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Bill to</div>
                      <div className="text-gray-900 dark:text-white">{load.broker_name || '—'}</div>
                      <div className="text-[11px] text-gray-400">{broker?.billing_email || 'No AP email'}</div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Lane</div>
                      <div className="text-gray-900 dark:text-white">
                        {[load.pickup_city, load.pickup_state].filter(Boolean).join(', ')} → {[load.delivery_city, load.delivery_state].filter(Boolean).join(', ')}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Amount</div>
                      <div className="text-lg font-bold text-gray-900 dark:text-white">{money2(load.gross_total)}</div>
                    </div>
                  </div>

                  {client?.factors_invoices && (
                    <div className="flex items-start gap-2 rounded-md bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-900/50 px-3 py-2 text-xs text-violet-800 dark:text-violet-300">
                      <Banknote className="h-4 w-4 shrink-0 mt-0.5" />
                      <span>
                        This client factors. The receivable is assigned — remit instructions must point at
                        the factor, never at the carrier.
                      </span>
                    </div>
                  )}
                  {broker && broker.packet_status !== 'complete' && (
                    <div className="flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                      <span>Setup packet with {broker.name} is not complete — this invoice may be rejected.</span>
                    </div>
                  )}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Issue date</Label>
                  <Input className="mt-1 h-9" type="date" value={issued} onChange={e => setIssued(e.target.value)} />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Terms</Label>
                  <Input className="mt-1 h-9" value={terms} onChange={e => setTerms(e.target.value)} placeholder="Net 30" />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Due date</Label>
                  <Input className="mt-1 h-9" value={longDate(dueDate)} readOnly disabled />
                </div>
              </div>

              <div>
                <Label className="text-xs text-gray-500 dark:text-gray-400">Notes</Label>
                <Textarea className="mt-1" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
              </div>

              {error && (
                <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 rounded-lg px-4 py-2.5">
                  <AlertTriangle className="h-4 w-4 shrink-0" />{error}
                </div>
              )}
            </div>
            <div className="border-t dark:border-gray-800 px-6 py-4 flex items-center justify-end gap-3">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white" disabled={saving || !load} onClick={submit}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}Create invoice
              </Button>
            </div>
          </SheetContent>
        )}
      </Sheet>
    </>
  )
}

// ── Invoice detail + tracing ─────────────────────────────────────────────────
function InvoiceSheet({
  invoice, clientName, brokerName, factorName, onSaved, onClose,
}: {
  invoice: Invoice
  clientName: string
  brokerName: string
  factorName: string | null
  onSaved: () => void
  onClose: () => void
}) {
  const { canRecordPayment, canVoidInvoices, canModify } = useRole()
  const [traces, setTraces] = useState<InvoiceTrace[]>([])
  const [loadingTraces, setLoadingTraces] = useState(true)
  const [busy, setBusy] = useState(false)

  const [trace, setTrace] = useState({
    method: 'call', outcome: 'no_answer', contact_name: '', promised_date: '', notes: '',
  })
  const [pay, setPay] = useState({ amount_paid: '', paid_date: todayISO(), payment_method: 'ach', payment_reference: '' })

  const fetchTraces = useCallback(async () => {
    setLoadingTraces(true)
    const supabase = createClient()
    const { data } = await supabase.from('invoice_traces').select('*')
      .eq('invoice_id', invoice.id).order('traced_at', { ascending: false })
    setTraces((data ?? []) as InvoiceTrace[])
    setLoadingTraces(false)
  }, [invoice.id])

  useEffect(() => { fetchTraces() }, [fetchTraces])
  useEffect(() => { setPay(p => ({ ...p, amount_paid: String(invoice.amount ?? 0) })) }, [invoice.amount])

  const patch = async (p: Record<string, unknown>, action: string) => {
    setBusy(true)
    const supabase = createClient()
    const { error } = await supabase.from('invoices').update(p).eq('id', invoice.id)
    setBusy(false)
    if (error) { toast.error(error.message); return false }
    void logAudit(action, {
      table_name: 'invoices', record_id: invoice.id,
      new_value: { invoice_number: invoice.invoice_number, ...p },
    })
    onSaved()
    return true
  }

  const markSent = async () => {
    const ok = await patch({ status: 'sent', sent_at: new Date().toISOString() }, 'invoice.sent')
    if (ok) toast.success('Marked sent')
  }

  const markFactored = async () => {
    const ok = await patch({ status: 'factored', factored_at: new Date().toISOString() }, 'invoice.factored')
    if (ok) toast.success('Submitted to factor')
  }

  const recordPayment = async () => {
    const amt = num(pay.amount_paid)
    const full = amt >= (invoice.amount ?? 0)
    const ok = await patch({
      status: full ? 'paid' : 'partial',
      amount_paid: amt,
      paid_date: pay.paid_date || todayISO(),
      payment_method: pay.payment_method,
      payment_reference: pay.payment_reference.trim() || null,
    }, 'invoice.payment')
    if (!ok) return
    // Only a fully-paid invoice settles the load.
    if (full && invoice.load_id) {
      const supabase = createClient()
      await supabase.from('loads').update({ status: 'paid' }).eq('id', invoice.load_id)
    }
    toast.success(full ? 'Invoice paid' : 'Partial payment recorded')
  }

  const voidInvoice = async () => {
    const reason = prompt('Why is this invoice being voided?')
    if (!reason?.trim()) return
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const ok = await patch({
      status: 'void', voided_at: new Date().toISOString(),
      voided_by: user?.id ?? null, void_reason: reason.trim(),
    }, 'invoice.void')
    if (ok) toast.success('Invoice voided')
  }

  const logTrace = async () => {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('invoice_traces').insert({
      invoice_id: invoice.id,
      method: trace.method,
      outcome: trace.outcome,
      contact_name: trace.contact_name.trim() || null,
      promised_date: trace.promised_date || null,
      notes: trace.notes.trim() || null,
      created_by: user?.id ?? null,
    })
    if (error) { toast.error(error.message); return }
    // The DB trigger maintains trace_count / last_traced_at / next_follow_up.
    if (trace.outcome === 'disputed' && invoice.status !== 'disputed') {
      await supabase.from('invoices').update({
        status: 'disputed', dispute_reason: trace.notes.trim() || 'Disputed by broker',
      }).eq('id', invoice.id)
    }
    void logAudit('invoice.trace', {
      table_name: 'invoice_traces', record_id: invoice.id,
      new_value: { invoice_number: invoice.invoice_number, outcome: trace.outcome },
    })
    setTrace({ method: 'call', outcome: 'no_answer', contact_name: '', promised_date: '', notes: '' })
    toast.success('Trace logged')
    fetchTraces()
    onSaved()
  }

  const pastDue = daysPastDue(invoice.due_date)
  const outstanding = (invoice.amount ?? 0) - (invoice.amount_paid ?? 0)

  return (
    <Sheet open onOpenChange={o => { if (!o) onClose() }}>
      <SheetContent side="right" className="!w-[75vw] !max-w-[900px] flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 py-4 border-b dark:border-gray-800">
          <SheetTitle className="text-lg font-semibold flex items-center gap-3">
            {invoice.invoice_number}
            <Badge className={`border ${INVOICE_STATUS_COLORS[invoice.status]}`}>{INVOICE_STATUS_LABELS[invoice.status]}</Badge>
          </SheetTitle>
          <SheetDescription>
            {clientName} → {brokerName}
            {factorName && <> · assigned to {factorName}</>}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Money */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Amount</div>
              <div className="text-xl font-bold text-gray-900 dark:text-white">{money2(invoice.amount)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Paid</div>
              <div className="text-xl font-bold text-emerald-700 dark:text-emerald-400">{money2(invoice.amount_paid)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Outstanding</div>
              <div className="text-xl font-bold text-gray-900 dark:text-white">{money2(outstanding)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Age</div>
              <div className={`text-xl font-bold ${pastDue > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white'}`}>
                {pastDue > 0 ? `${pastDue}d late` : 'Current'}
              </div>
              <div className="text-[11px] text-gray-400">Due {longDate(invoice.due_date)}</div>
            </div>
          </div>

          {/* Actions */}
          {canModify && invoice.status !== 'void' && (
            <div className="flex flex-wrap gap-2">
              {invoice.status === 'draft' && (
                <Button size="sm" className="h-8 gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-700 text-white" disabled={busy} onClick={markSent}>
                  <PackageCheck className="h-3.5 w-3.5" />Mark sent
                </Button>
              )}
              {invoice.factoring_company_id && ['draft', 'sent'].includes(invoice.status) && (
                <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" disabled={busy} onClick={markFactored}>
                  <Banknote className="h-3.5 w-3.5" />Submit to factor
                </Button>
              )}
              {canVoidInvoices && (
                <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs text-red-600 hover:text-red-700 ml-auto" disabled={busy} onClick={voidInvoice}>
                  <Ban className="h-3.5 w-3.5" />Void
                </Button>
              )}
            </div>
          )}

          {invoice.status === 'void' && (
            <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-white/5 px-4 py-3 text-sm">
              <div className="font-medium text-gray-700 dark:text-gray-200">Voided {dateTime(invoice.voided_at)}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">{invoice.void_reason || 'No reason recorded'}</div>
            </div>
          )}

          {/* Record payment */}
          {canRecordPayment && !['void', 'paid'].includes(invoice.status) && (
            <section className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Record a payment</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Amount received</Label>
                  <Input className="mt-1 h-9" type="number" value={pay.amount_paid} onChange={e => setPay(p => ({ ...p, amount_paid: e.target.value }))} />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Date</Label>
                  <Input className="mt-1 h-9" type="date" value={pay.paid_date} onChange={e => setPay(p => ({ ...p, paid_date: e.target.value }))} />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Method</Label>
                  <Select value={pay.payment_method} onValueChange={v => setPay(p => ({ ...p, payment_method: v ?? 'ach' }))}>
                    <SelectTrigger className="mt-1 h-9 w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {['ach', 'check', 'wire', 'factor', 'other'].map(m => (
                        <SelectItem key={m} value={m}>{m.toUpperCase()}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Reference</Label>
                  <Input className="mt-1 h-9" value={pay.payment_reference} onChange={e => setPay(p => ({ ...p, payment_reference: e.target.value }))} />
                </div>
              </div>
              <Button size="sm" className="h-8 gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white" disabled={busy} onClick={recordPayment}>
                <CheckCircle2 className="h-3.5 w-3.5" />Record payment
              </Button>
            </section>
          )}

          {/* Tracing */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Invoice tracing
              </p>
              <span className="text-[11px] text-gray-400">
                {invoice.trace_count} attempt{invoice.trace_count === 1 ? '' : 's'}
                {invoice.last_traced_at && ` · last ${dateTime(invoice.last_traced_at)}`}
              </span>
            </div>

            {canModify && invoice.status !== 'void' && (
              <div className="rounded-lg border dark:border-gray-800 p-3 space-y-3">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Method</Label>
                    <Select value={trace.method} onValueChange={v => setTrace(t => ({ ...t, method: v ?? 'call' }))}>
                      <SelectTrigger className="mt-1 h-8 text-sm w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {['call', 'email', 'portal', 'letter', 'other'].map(m => (
                          <SelectItem key={m} value={m}>{m}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Outcome</Label>
                    <Select value={trace.outcome} onValueChange={v => setTrace(t => ({ ...t, outcome: v ?? 'no_answer' }))}>
                      <SelectTrigger className="mt-1 h-8 text-sm w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(TRACE_OUTCOME_LABELS).map(([k, v]) => (
                          <SelectItem key={k} value={k}>{v}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Who you spoke to</Label>
                    <Input className="mt-1 h-8 text-sm" value={trace.contact_name} onChange={e => setTrace(t => ({ ...t, contact_name: e.target.value }))} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Promised date</Label>
                    <Input className="mt-1 h-8 text-sm" type="date" value={trace.promised_date} onChange={e => setTrace(t => ({ ...t, promised_date: e.target.value }))} />
                  </div>
                </div>
                <Textarea rows={2} className="text-sm" placeholder="What did they say?" value={trace.notes} onChange={e => setTrace(t => ({ ...t, notes: e.target.value }))} />
                <div className="flex justify-end">
                  <Button size="sm" className="h-8 gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-700 text-white" onClick={logTrace}>
                    <Phone className="h-3.5 w-3.5" />Log attempt
                  </Button>
                </div>
              </div>
            )}

            {loadingTraces ? (
              <div className="flex items-center gap-2 text-xs text-gray-400 py-3">
                <Loader2 className="h-4 w-4 animate-spin" />Loading history…
              </div>
            ) : traces.length === 0 ? (
              <p className="text-xs text-gray-400 py-4 text-center border border-dashed dark:border-gray-800 rounded-lg">
                No collection attempts logged yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {traces.map(t => (
                  <li key={t.id} className="rounded-lg border dark:border-gray-800 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-gray-900 dark:text-white">
                        {TRACE_OUTCOME_LABELS[t.outcome] ?? t.outcome}
                      </span>
                      <span className="text-[11px] text-gray-400">{dateTime(t.traced_at)} · {t.method}</span>
                    </div>
                    {t.contact_name && <div className="text-xs text-gray-500 dark:text-gray-400">Spoke with {t.contact_name}</div>}
                    {t.promised_date && <div className="text-xs text-amber-600 dark:text-amber-400">Promised {longDate(t.promised_date)}</div>}
                    {t.notes && <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">{t.notes}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <DocumentsPanel
            entityType="invoice" entityId={invoice.id} clientId={invoice.client_id}
            canModify={canModify} title="Invoice packet"
          />
        </div>

        <div className="border-t dark:border-gray-800 px-6 py-4 flex items-center justify-end gap-3">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function InvoicingPage() {
  const { canModify } = useRole()
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [brokers, setBrokers] = useState<Broker[]>([])
  const [factors, setFactors] = useState<FactoringCompany[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('open')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Invoice | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const [{ data: inv }, { data: c }, { data: b }, { data: f }] = await Promise.all([
      supabase.from('invoices').select('*').order('issued_date', { ascending: false, nullsFirst: false }).limit(1000),
      supabase.from('clients').select('*').is('deleted_at', null),
      supabase.from('brokers').select('*'),
      supabase.from('factoring_companies').select('*'),
    ])
    setInvoices((inv ?? []) as Invoice[])
    setClients((c ?? []) as Client[])
    setBrokers((b ?? []) as Broker[])
    setFactors((f ?? []) as FactoringCompany[])
    setLoading(false)
    // Keep an open sheet in sync with the refreshed row.
    setSelected(prev => prev ? (((inv ?? []) as Invoice[]).find(i => i.id === prev.id) ?? null) : null)
  }, [])

  useEffect(() => { load() }, [load])

  const nameOf = useCallback((list: { id: string; name?: string; legal_name?: string; dba_name?: string | null }[], id: string | null) => {
    if (!id) return '—'
    const r = list.find(x => x.id === id)
    if (!r) return '—'
    return r.dba_name || r.legal_name || r.name || '—'
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return invoices.filter(i => {
      if (filter === 'open') {
        if (!OPEN_INVOICE_STATUSES.includes(i.status)) return false
      } else if (filter === 'overdue') {
        if (!OPEN_INVOICE_STATUSES.includes(i.status) || daysPastDue(i.due_date) <= 0) return false
      } else if (filter === 'needs_trace') {
        // Past due and either never chased or not chased in the last week.
        if (!OPEN_INVOICE_STATUSES.includes(i.status) || daysPastDue(i.due_date) <= 0) return false
        const last = i.last_traced_at ? new Date(i.last_traced_at).getTime() : 0
        if (Date.now() - last < 7 * 86_400_000) return false
      } else if (filter !== 'all' && i.status !== filter) {
        return false
      }
      if (!q) return true
      const hay = [
        i.invoice_number, nameOf(clients, i.client_id), nameOf(brokers, i.broker_id),
        i.payment_reference, i.factoring_reference,
      ].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [invoices, filter, search, clients, brokers, nameOf])

  const { sorted, sort, toggle } = useSort<Invoice, InvoiceSortKey>(filtered, INVOICE_SORT)

  const aging = useMemo(() => {
    const buckets: Record<string, number> = { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 }
    for (const i of invoices) {
      if (!OPEN_INVOICE_STATUSES.includes(i.status)) continue
      buckets[agingBucket(i.due_date)] += (i.amount ?? 0) - (i.amount_paid ?? 0)
    }
    return buckets
  }, [invoices])

  const totalOpen = useMemo(
    () => invoices.filter(i => OPEN_INVOICE_STATUSES.includes(i.status))
      .reduce((s, i) => s + ((i.amount ?? 0) - (i.amount_paid ?? 0)), 0),
    [invoices],
  )

  const exportCsv = () => downloadCSV(
    `invoices-${new Date().toISOString().slice(0, 10)}.csv`,
    ['Invoice #', 'Status', 'Client', 'Broker', 'Issued', 'Due', 'Terms',
     'Amount', 'Paid', 'Outstanding', 'Days Past Due', 'Traces', 'Last Traced'],
    sorted.map(i => [
      i.invoice_number, INVOICE_STATUS_LABELS[i.status],
      nameOf(clients, i.client_id), nameOf(brokers, i.broker_id),
      i.issued_date ?? '', i.due_date ?? '', i.terms ?? '',
      i.amount, i.amount_paid, (i.amount ?? 0) - (i.amount_paid ?? 0),
      Math.max(0, daysPastDue(i.due_date)), i.trace_count, i.last_traced_at ?? '',
    ]),
  )

  return (
    <>
      <Header title="Invoicing / AR" subtitle="Billing brokers on our clients' behalf — and chasing it" />
      <div className="p-6 space-y-6">

        {/* Aging strip */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          <Card>
            <CardContent className="py-4">
              <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Total open AR</div>
              <div className="text-2xl font-bold text-gray-900 dark:text-white">{money(totalOpen)}</div>
            </CardContent>
          </Card>
          {(['current', '1-30', '31-60', '61-90', '90+'] as const).map(b => (
            <Card key={b}>
              <CardContent className="py-4">
                <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{AGING_LABELS[b]}</div>
                <div className={`text-2xl font-bold ${
                  b === '90+' ? 'text-red-600 dark:text-red-400'
                  : b === '61-90' ? 'text-orange-600 dark:text-orange-400'
                  : b === '31-60' ? 'text-amber-600 dark:text-amber-400'
                  : 'text-gray-900 dark:text-white'}`}>
                  {money(aging[b])}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input placeholder="Search invoice #, client, broker…" className="pl-9 h-9" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <Select value={filter} onValueChange={v => setFilter(v ?? 'open')}>
            <SelectTrigger className="h-9 w-52"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Open (unpaid)</SelectItem>
              <SelectItem value="overdue">Overdue</SelectItem>
              <SelectItem value="needs_trace">Needs a trace</SelectItem>
              <SelectItem value="all">All invoices</SelectItem>
              {INVOICE_STATUSES.map(s => <SelectItem key={s} value={s}>{INVOICE_STATUS_LABELS[s]}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" className="gap-2 h-9" onClick={exportCsv} disabled={filtered.length === 0}>
              <Download className="h-4 w-4" />Export
            </Button>
            {canModify && <NewInvoiceSheet onCreated={load} />}
          </div>
        </div>

        <Card>
          <CardContent className="p-0">
            {loading ? (
              <div className="flex items-center justify-center py-20 text-gray-400">
                <Loader2 className="h-6 w-6 animate-spin mr-2" />Loading invoices…
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
                <div className="p-3 rounded-full bg-indigo-50 dark:bg-indigo-950 text-indigo-500"><FileText className="h-7 w-7" /></div>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
                  {invoices.length === 0 ? 'No invoices yet' : 'Nothing matches these filters'}
                </p>
                <p className="text-xs text-gray-400 max-w-sm">
                  {invoices.length === 0
                    ? 'Deliver a load and collect the paperwork, then invoice the broker from here.'
                    : 'Try “All invoices” or clear the search.'}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortableTh label="Invoice #" k="invoice_number" sort={sort} toggle={toggle} />
                      <SortableTh label="Client"    k="client"         sort={sort} toggle={toggle} />
                      <SortableTh label="Broker"    k="broker"         sort={sort} toggle={toggle} />
                      <SortableTh label="Issued"    k="issued"         sort={sort} toggle={toggle} />
                      <SortableTh label="Due"       k="due"            sort={sort} toggle={toggle} />
                      <SortableTh label="Aging"     k="aging"          sort={sort} toggle={toggle} />
                      <TableHead>Traces</TableHead>
                      <SortableTh label="Status"    k="status"         sort={sort} toggle={toggle} />
                      <SortableTh label="Amount"    k="amount"         sort={sort} toggle={toggle} align="right" />
                      <TableHead className="text-right">Open</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sorted.map(i => {
                      const pd = daysPastDue(i.due_date)
                      const open = (i.amount ?? 0) - (i.amount_paid ?? 0)
                      return (
                        <TableRow key={i.id} className="cursor-pointer" onClick={() => setSelected(i)}>
                          <TableCell className="font-medium text-indigo-700 dark:text-indigo-400 whitespace-nowrap">
                            {i.invoice_number}
                          </TableCell>
                          <TableCell className="max-w-[160px] truncate">{nameOf(clients, i.client_id)}</TableCell>
                          <TableCell className="max-w-[150px] truncate text-sm text-gray-600 dark:text-gray-300">
                            {nameOf(brokers, i.broker_id)}
                          </TableCell>
                          <TableCell className="text-sm text-gray-600 dark:text-gray-300 whitespace-nowrap">{longDate(i.issued_date)}</TableCell>
                          <TableCell className="text-sm text-gray-600 dark:text-gray-300 whitespace-nowrap">{longDate(i.due_date)}</TableCell>
                          <TableCell className="whitespace-nowrap text-sm">
                            {OPEN_INVOICE_STATUSES.includes(i.status) && pd > 0
                              ? <span className={pd > 60 ? 'text-red-600 dark:text-red-400 font-semibold' : pd > 30 ? 'text-amber-600 dark:text-amber-400 font-medium' : 'text-gray-700 dark:text-gray-200'}>
                                  {pd}d late
                                </span>
                              : <span className="text-gray-400">—</span>}
                          </TableCell>
                          <TableCell className="text-sm text-gray-600 dark:text-gray-300">
                            {i.trace_count > 0
                              ? <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3 text-gray-400" />{i.trace_count}</span>
                              : <span className="text-gray-300 dark:text-gray-600">—</span>}
                          </TableCell>
                          <TableCell>
                            <Badge className={`border ${INVOICE_STATUS_COLORS[i.status]}`}>{INVOICE_STATUS_LABELS[i.status]}</Badge>
                          </TableCell>
                          <TableCell className="text-right tabular-nums whitespace-nowrap">{money(i.amount)}</TableCell>
                          <TableCell className="text-right tabular-nums whitespace-nowrap font-semibold">
                            {open > 0 ? money(open) : <span className="text-emerald-600 dark:text-emerald-400">Settled</span>}
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
          <p className="text-xs text-gray-400 flex items-center gap-1.5">
            <Clock className="h-3 w-3" />
            {filtered.length} of {invoices.length} invoice{invoices.length !== 1 ? 's' : ''}
          </p>
        )}
      </div>

      {selected && (
        <InvoiceSheet
          invoice={selected}
          clientName={nameOf(clients, selected.client_id)}
          brokerName={nameOf(brokers, selected.broker_id)}
          factorName={selected.factoring_company_id
            ? (factors.find(f => f.id === selected.factoring_company_id)?.name ?? null)
            : null}
          onSaved={load}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  )
}
