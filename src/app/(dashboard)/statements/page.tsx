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
  Plus, Search, Loader2, Receipt, AlertTriangle, Download, Save,
  CheckCircle2, Ban, Send, Trash2, Percent,
} from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { logAudit } from '@/lib/audit'
import { useRole } from '@/lib/role-context'
import { downloadCSV } from '@/lib/csv'
import { useSort, type SortAccessors } from '@/lib/use-sort'
import {
  STATEMENT_STATUSES, STATEMENT_STATUS_LABELS, STATEMENT_STATUS_COLORS,
  money, money2, longDate, dateTime, todayISO, daysPastDue, num, shortDate,
} from '@/lib/dispatch'
import type {
  ClientStatement, StatementLine, StatementStatus, Client, Load, ServiceRequest,
} from '@/types'

type StmtSortKey = 'statement_number' | 'client' | 'period' | 'due' | 'amount' | 'status'
const STMT_SORT: SortAccessors<ClientStatement, StmtSortKey> = {
  statement_number: s => s.statement_number ?? '',
  client:           s => s.client_id,
  period:           s => s.period_end,
  due:              s => s.due_date ?? '',
  amount:           s => s.amount_due,
  status:           s => s.status,
}

// Monday-anchored week containing `d`, as [start, end] ISO dates.
function weekOf(d: Date): [string, string] {
  const day = d.getDay()                    // 0 = Sunday
  const diffToMonday = (day + 6) % 7
  const start = new Date(d)
  start.setDate(d.getDate() - diffToMonday)
  const end = new Date(start)
  end.setDate(start.getDate() + 6)
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)]
}

// ── Generate statement ───────────────────────────────────────────────────────
function GenerateSheet({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [clients, setClients] = useState<Client[]>([])
  const [clientId, setClientId] = useState('')

  const lastWeek = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() - 7)
    return weekOf(d)
  }, [])
  const [periodStart, setPeriodStart] = useState(lastWeek[0])
  const [periodEnd, setPeriodEnd] = useState(lastWeek[1])
  const [dueDate, setDueDate] = useState(todayISO())

  const [candidates, setCandidates] = useState<Load[]>([])
  const [services, setServices] = useState<ServiceRequest[]>([])
  const [scanning, setScanning] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(''); setClientId(''); setCandidates([]); setServices([])
    const supabase = createClient()
    supabase.from('clients').select('*').is('deleted_at', null)
      .in('status', ['active', 'paused']).order('legal_name')
      .then(({ data }) => setClients((data ?? []) as Client[]))
  }, [open])

  // Find every load in the window whose fee hasn't been billed yet, plus any
  // billable completed service requests. The unique index on
  // statement_lines(load_id) is the real double-bill guard; this just previews.
  const scan = useCallback(async () => {
    if (!clientId || !periodStart || !periodEnd) { setCandidates([]); setServices([]); return }
    setScanning(true)
    const supabase = createClient()
    const [{ data: loads }, { data: billed }, { data: srv }] = await Promise.all([
      supabase.from('loads').select('*')
        .eq('client_id', clientId).is('deleted_at', null)
        .not('status', 'in', '("cancelled","sourced","offered")')
        .gte('delivery_date', periodStart).lte('delivery_date', periodEnd)
        .order('delivery_date'),
      supabase.from('statement_lines').select('load_id').eq('kind', 'fee').not('load_id', 'is', null),
      supabase.from('service_requests').select('*')
        .eq('client_id', clientId).eq('billable', true).eq('status', 'done')
        .is('billed_at', null),
    ])
    const already = new Set((billed ?? []).map(r => r.load_id))
    setCandidates(((loads ?? []) as Load[]).filter(l => !already.has(l.id) && !l.fee_waived && l.dispatch_fee > 0))
    setServices((srv ?? []) as ServiceRequest[])
    setScanning(false)
  }, [clientId, periodStart, periodEnd])

  useEffect(() => { scan() }, [scan])

  const totals = useMemo(() => {
    const gross = candidates.reduce((s, l) => s + (l.gross_total ?? 0), 0)
    const fees = candidates.reduce((s, l) => s + (l.dispatch_fee ?? 0), 0)
    const svc = services.reduce((s, r) => s + (r.fee_amount ?? 0), 0)
    return { gross, fees, svc, due: fees + svc }
  }, [candidates, services])

  const submit = async () => {
    if (!clientId) { setError('Pick a client.'); return }
    if (candidates.length === 0 && services.length === 0) {
      setError('Nothing to bill in this period.')
      return
    }
    setSaving(true); setError('')
    const supabase = createClient()

    const { data: stmt, error: err } = await supabase.from('client_statements').insert({
      client_id: clientId,
      period_start: periodStart,
      period_end: periodEnd,
      status: 'draft' as StatementStatus,
      issued_date: todayISO(),
      due_date: dueDate || null,
    }).select('id, statement_number').single()

    if (err || !stmt) { setSaving(false); setError(err?.message ?? 'Could not create the statement.'); return }

    const lines = [
      ...candidates.map((l, i) => ({
        statement_id: stmt.id,
        load_id: l.id,
        kind: 'fee' as const,
        description: `${l.load_number} · ${[l.pickup_city, l.pickup_state].filter(Boolean).join(', ')} → ${[l.delivery_city, l.delivery_state].filter(Boolean).join(', ')}`,
        load_gross: l.gross_total,
        amount: l.dispatch_fee,
        sort_order: i,
      })),
      ...services.map((r, i) => ({
        statement_id: stmt.id,
        load_id: null,
        kind: 'service' as const,
        description: `${r.request_number} · ${r.title}`,
        load_gross: 0,
        amount: r.fee_amount,
        sort_order: candidates.length + i,
      })),
    ]

    const { error: lineErr } = await supabase.from('statement_lines').insert(lines)
    if (lineErr) {
      // Roll the header back so a half-built statement never sits in the list.
      await supabase.from('client_statements').delete().eq('id', stmt.id)
      setSaving(false)
      setError(lineErr.code === '23505'
        ? 'One of these loads was already billed on another statement. Re-scan and try again.'
        : lineErr.message)
      return
    }

    if (services.length > 0) {
      await supabase.from('service_requests')
        .update({ billed_at: new Date().toISOString(), statement_id: stmt.id })
        .in('id', services.map(r => r.id))
    }

    setSaving(false)
    void logAudit('statement.create', {
      table_name: 'client_statements', record_id: stmt.id,
      new_value: {
        statement_number: stmt.statement_number, client_id: clientId,
        period: `${periodStart}..${periodEnd}`, loads: candidates.length, amount_due: totals.due,
      },
    })
    toast.success(`${stmt.statement_number} created — ${money2(totals.due)}`)
    setOpen(false)
    onCreated()
  }

  return (
    <>
      <Button className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />Generate Statement
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        {open && (
          <SheetContent side="right" className="!w-[75vw] !max-w-[900px] flex flex-col gap-0 p-0">
            <SheetHeader className="px-6 py-4 border-b dark:border-gray-800">
              <SheetTitle className="text-lg font-semibold">Generate a Fee Statement</SheetTitle>
              <SheetDescription>
                What the client owes Avantra for the period. This is our revenue — separate from the
                freight money the broker pays them.
              </SheetDescription>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div className="md:col-span-2">
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Client *</Label>
                  <Select value={clientId || null} onValueChange={v => setClientId(v ?? '')}>
                    <SelectTrigger className="mt-1 h-9 w-full">
                      <SelectValue placeholder={clients.length ? 'Pick a client' : 'No active clients'} />
                    </SelectTrigger>
                    <SelectContent>
                      {clients.map(c => <SelectItem key={c.id} value={c.id}>{c.dba_name || c.legal_name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Period start</Label>
                  <Input className="mt-1 h-9" type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Period end</Label>
                  <Input className="mt-1 h-9" type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Due date</Label>
                  <Input className="mt-1 h-9" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
                </div>
              </div>

              {scanning ? (
                <div className="flex items-center gap-2 text-sm text-gray-400 py-6">
                  <Loader2 className="h-4 w-4 animate-spin" />Scanning unbilled loads…
                </div>
              ) : clientId ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-indigo-200 dark:border-indigo-900/60 bg-indigo-50/70 dark:bg-indigo-950/30 px-4 py-3">
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Loads billed</div>
                      <div className="font-semibold text-gray-900 dark:text-white">{candidates.length}</div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Gross hauled</div>
                      <div className="font-semibold text-gray-900 dark:text-white">{money2(totals.gross)}</div>
                    </div>
                    {totals.svc > 0 && (
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Services</div>
                        <div className="font-semibold text-gray-900 dark:text-white">{money2(totals.svc)}</div>
                      </div>
                    )}
                    <div className="text-right">
                      <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 flex items-center justify-end gap-1">
                        <Percent className="h-3 w-3" />Amount due Avantra
                      </div>
                      <div className="text-lg font-bold text-indigo-700 dark:text-indigo-400">{money2(totals.due)}</div>
                    </div>
                  </div>

                  {candidates.length === 0 && services.length === 0 ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-8 border border-dashed dark:border-gray-800 rounded-lg">
                      No unbilled loads delivered in this window. Loads already on a statement are
                      excluded, as are waived-fee loads.
                    </p>
                  ) : (
                    <div className="rounded-lg border dark:border-gray-800 overflow-hidden">
                      <Table>
                        <TableHeader><TableRow>
                          <TableHead>Load</TableHead><TableHead>Delivered</TableHead>
                          <TableHead className="text-right">Gross</TableHead>
                          <TableHead className="text-right">Fee</TableHead>
                        </TableRow></TableHeader>
                        <TableBody>
                          {candidates.map(l => (
                            <TableRow key={l.id}>
                              <TableCell className="text-sm">
                                <span className="font-medium text-indigo-700 dark:text-indigo-400">{l.load_number}</span>
                                <span className="text-gray-500 dark:text-gray-400">
                                  {' '}· {[l.pickup_city, l.pickup_state].filter(Boolean).join(', ')} → {[l.delivery_city, l.delivery_state].filter(Boolean).join(', ')}
                                </span>
                              </TableCell>
                              <TableCell className="text-sm tabular-nums">{shortDate(l.delivery_date)}</TableCell>
                              <TableCell className="text-right tabular-nums text-sm">{money(l.gross_total)}</TableCell>
                              <TableCell className="text-right tabular-nums text-sm font-semibold text-indigo-700 dark:text-indigo-400">
                                {money(l.dispatch_fee)}
                              </TableCell>
                            </TableRow>
                          ))}
                          {services.map(r => (
                            <TableRow key={r.id}>
                              <TableCell className="text-sm">
                                <span className="font-medium text-violet-700 dark:text-violet-400">{r.request_number}</span>
                                <span className="text-gray-500 dark:text-gray-400"> · {r.title}</span>
                              </TableCell>
                              <TableCell className="text-sm text-gray-400">service</TableCell>
                              <TableCell className="text-right text-gray-300 dark:text-gray-600">—</TableCell>
                              <TableCell className="text-right tabular-nums text-sm font-semibold text-violet-700 dark:text-violet-400">
                                {money(r.fee_amount)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </>
              ) : null}

              {error && (
                <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 rounded-lg px-4 py-2.5">
                  <AlertTriangle className="h-4 w-4 shrink-0" />{error}
                </div>
              )}
            </div>

            <div className="border-t dark:border-gray-800 px-6 py-4 flex items-center justify-end gap-3">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white"
                disabled={saving || (candidates.length === 0 && services.length === 0)}
                onClick={submit}
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Create statement
              </Button>
            </div>
          </SheetContent>
        )}
      </Sheet>
    </>
  )
}

// ── Statement detail ─────────────────────────────────────────────────────────
function StatementSheet({ statement, clientName, onSaved, onClose }: {
  statement: ClientStatement
  clientName: string
  onSaved: () => void
  onClose: () => void
}) {
  const { canIssueStatements, canRecordPayment, canVoidInvoices, canModify } = useRole()
  const [lines, setLines] = useState<StatementLine[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [adj, setAdj] = useState({ description: '', amount: '' })
  const [pay, setPay] = useState({ amount_paid: '', paid_date: todayISO(), payment_method: 'ach', payment_reference: '' })

  const fetchLines = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const { data } = await supabase.from('statement_lines').select('*')
      .eq('statement_id', statement.id).order('sort_order')
    setLines((data ?? []) as StatementLine[])
    setLoading(false)
  }, [statement.id])

  useEffect(() => { fetchLines() }, [fetchLines])
  useEffect(() => { setPay(p => ({ ...p, amount_paid: String(statement.amount_due ?? 0) })) }, [statement.amount_due])

  const patch = async (p: Record<string, unknown>, action: string) => {
    setBusy(true)
    const supabase = createClient()
    const { error } = await supabase.from('client_statements').update(p).eq('id', statement.id)
    setBusy(false)
    if (error) { toast.error(error.message); return false }
    void logAudit(action, {
      table_name: 'client_statements', record_id: statement.id,
      new_value: { statement_number: statement.statement_number, ...p },
    })
    onSaved()
    return true
  }

  const send = async () => {
    const ok = await patch({ status: 'sent', sent_at: new Date().toISOString() }, 'statement.sent')
    if (ok) toast.success('Statement marked sent')
  }

  const recordPayment = async () => {
    const amt = num(pay.amount_paid)
    const full = amt >= (statement.amount_due ?? 0)
    const ok = await patch({
      status: full ? 'paid' : 'partial',
      amount_paid: amt,
      paid_date: pay.paid_date || todayISO(),
      payment_method: pay.payment_method,
      payment_reference: pay.payment_reference.trim() || null,
    }, 'statement.payment')
    if (ok) toast.success(full ? 'Statement paid' : 'Partial payment recorded')
  }

  const voidStatement = async () => {
    const reason = prompt('Why is this statement being voided?')
    if (!reason?.trim()) return
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    // Release any service requests so they can land on a future statement.
    await supabase.from('service_requests')
      .update({ billed_at: null, statement_id: null }).eq('statement_id', statement.id)
    const ok = await patch({
      status: 'void', voided_at: new Date().toISOString(),
      voided_by: user?.id ?? null, void_reason: reason.trim(),
    }, 'statement.void')
    if (ok) toast.success('Statement voided')
  }

  const addAdjustment = async () => {
    if (!adj.description.trim() || !adj.amount) return
    const supabase = createClient()
    const amount = num(adj.amount)
    const { error } = await supabase.from('statement_lines').insert({
      statement_id: statement.id,
      kind: amount < 0 ? 'credit' : 'adjustment',
      description: adj.description.trim(),
      amount,
      sort_order: lines.length,
    })
    if (error) { toast.error(error.message); return }
    // The recalc_statement_totals trigger updates the header.
    setAdj({ description: '', amount: '' })
    toast.success('Adjustment added')
    fetchLines(); onSaved()
  }

  const removeLine = async (line: StatementLine) => {
    if (line.kind === 'fee') {
      toast.error('Fee lines come from loads. Void the statement instead of editing them.')
      return
    }
    const supabase = createClient()
    const { error } = await supabase.from('statement_lines').delete().eq('id', line.id)
    if (error) { toast.error(error.message); return }
    fetchLines(); onSaved()
  }

  const editable = statement.status === 'draft'
  const outstanding = (statement.amount_due ?? 0) - (statement.amount_paid ?? 0)

  return (
    <Sheet open onOpenChange={o => { if (!o) onClose() }}>
      <SheetContent side="right" className="!w-[75vw] !max-w-[900px] flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 py-4 border-b dark:border-gray-800">
          <SheetTitle className="text-lg font-semibold flex items-center gap-3">
            {statement.statement_number}
            <Badge className={`border ${STATEMENT_STATUS_COLORS[statement.status]}`}>
              {STATEMENT_STATUS_LABELS[statement.status]}
            </Badge>
          </SheetTitle>
          <SheetDescription>
            {clientName} · {longDate(statement.period_start)} – {longDate(statement.period_end)}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Loads</div>
              <div className="text-xl font-bold text-gray-900 dark:text-white">{statement.load_count}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Gross hauled</div>
              <div className="text-xl font-bold text-gray-900 dark:text-white">{money2(statement.total_gross)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Amount due</div>
              <div className="text-xl font-bold text-indigo-700 dark:text-indigo-400">{money2(statement.amount_due)}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Outstanding</div>
              <div className="text-xl font-bold text-gray-900 dark:text-white">{money2(outstanding)}</div>
              <div className="text-[11px] text-gray-400">Due {longDate(statement.due_date)}</div>
            </div>
          </div>

          {canModify && statement.status !== 'void' && (
            <div className="flex flex-wrap gap-2">
              {statement.status === 'draft' && canIssueStatements && (
                <Button size="sm" className="h-8 gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-700 text-white" disabled={busy} onClick={send}>
                  <Send className="h-3.5 w-3.5" />Mark sent
                </Button>
              )}
              {canVoidInvoices && (
                <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs text-red-600 hover:text-red-700 ml-auto" disabled={busy} onClick={voidStatement}>
                  <Ban className="h-3.5 w-3.5" />Void
                </Button>
              )}
            </div>
          )}

          {statement.status === 'void' && (
            <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-white/5 px-4 py-3 text-sm">
              <div className="font-medium text-gray-700 dark:text-gray-200">Voided {dateTime(statement.voided_at)}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">{statement.void_reason || 'No reason recorded'}</div>
            </div>
          )}

          {/* Lines */}
          <section className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Lines</p>
            {loading ? (
              <div className="flex items-center gap-2 text-xs text-gray-400 py-3">
                <Loader2 className="h-4 w-4 animate-spin" />Loading lines…
              </div>
            ) : (
              <div className="rounded-lg border dark:border-gray-800 overflow-hidden">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Load gross</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    {editable && <TableHead className="w-10"></TableHead>}
                  </TableRow></TableHeader>
                  <TableBody>
                    {lines.map(l => (
                      <TableRow key={l.id}>
                        <TableCell className="text-sm">
                          {l.description}
                          {l.kind !== 'fee' && (
                            <Badge className="ml-2 border bg-gray-100 text-gray-700 border-gray-200 dark:bg-white/10 dark:text-gray-300 dark:border-white/10 text-[10px]">
                              {l.kind}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-sm text-gray-600 dark:text-gray-300">
                          {l.load_gross > 0 ? money(l.load_gross) : '—'}
                        </TableCell>
                        <TableCell className={`text-right tabular-nums text-sm font-semibold ${l.amount < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-900 dark:text-white'}`}>
                          {money2(l.amount)}
                        </TableCell>
                        {editable && (
                          <TableCell>
                            {l.kind !== 'fee' && (
                              <button onClick={() => removeLine(l)} className="text-gray-400 hover:text-red-600 transition-colors" title="Remove line">
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {editable && canModify && (
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Adjustment / credit</Label>
                  <Input className="mt-1 h-9" placeholder="Description (e.g. goodwill credit)"
                    value={adj.description} onChange={e => setAdj(a => ({ ...a, description: e.target.value }))} />
                </div>
                <div className="w-36">
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Amount (− for credit)</Label>
                  <Input className="mt-1 h-9" type="number" value={adj.amount} onChange={e => setAdj(a => ({ ...a, amount: e.target.value }))} />
                </div>
                <Button className="h-9 gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white"
                  disabled={!adj.description.trim() || !adj.amount} onClick={addAdjustment}>
                  <Plus className="h-4 w-4" />Add
                </Button>
              </div>
            )}
          </section>

          {canRecordPayment && !['void', 'paid'].includes(statement.status) && (
            <section className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Record a payment</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Amount</Label>
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
                      {['ach', 'check', 'wire', 'card', 'other'].map(m => <SelectItem key={m} value={m}>{m.toUpperCase()}</SelectItem>)}
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

          {statement.notes && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">Notes</p>
              <Textarea readOnly value={statement.notes} rows={2} />
            </div>
          )}
        </div>

        <div className="border-t dark:border-gray-800 px-6 py-4 flex items-center justify-end gap-3">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function StatementsPage() {
  const { canModify } = useRole()
  const [statements, setStatements] = useState<ClientStatement[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<ClientStatement | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const [{ data: s }, { data: c }] = await Promise.all([
      supabase.from('client_statements').select('*').order('period_end', { ascending: false }).limit(1000),
      supabase.from('clients').select('*').is('deleted_at', null),
    ])
    setStatements((s ?? []) as ClientStatement[])
    setClients((c ?? []) as Client[])
    setLoading(false)
    setSelected(prev => prev ? (((s ?? []) as ClientStatement[]).find(x => x.id === prev.id) ?? null) : null)
  }, [])

  useEffect(() => { load() }, [load])

  const clientName = useCallback((id: string) => {
    const c = clients.find(x => x.id === id)
    return c ? (c.dba_name || c.legal_name) : '—'
  }, [clients])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return statements.filter(s => {
      if (filter === 'unpaid') {
        if (!['sent', 'partial', 'overdue'].includes(s.status)) return false
      } else if (filter !== 'all' && s.status !== filter) return false
      if (!q) return true
      return [s.statement_number, clientName(s.client_id)].filter(Boolean).join(' ').toLowerCase().includes(q)
    })
  }, [statements, filter, search, clientName])

  const { sorted, sort, toggle } = useSort<ClientStatement, StmtSortKey>(filtered, STMT_SORT)

  const stats = useMemo(() => {
    const unpaid = statements.filter(s => ['sent', 'partial', 'overdue'].includes(s.status))
    const draft = statements.filter(s => s.status === 'draft')
    const paidThisMonth = statements.filter(s => {
      if (s.status !== 'paid' || !s.paid_date) return false
      const d = new Date(`${s.paid_date}T00:00:00`)
      const now = new Date()
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
    })
    return {
      outstanding: unpaid.reduce((t, s) => t + ((s.amount_due ?? 0) - (s.amount_paid ?? 0)), 0),
      draftCount: draft.length,
      draftValue: draft.reduce((t, s) => t + (s.amount_due ?? 0), 0),
      collected: paidThisMonth.reduce((t, s) => t + (s.amount_paid ?? 0), 0),
    }
  }, [statements])

  const exportCsv = () => downloadCSV(
    `fee-statements-${new Date().toISOString().slice(0, 10)}.csv`,
    ['Statement #', 'Client', 'Period Start', 'Period End', 'Status', 'Loads',
     'Gross Hauled', 'Fees', 'Adjustments', 'Amount Due', 'Paid', 'Due Date', 'Paid Date'],
    sorted.map(s => [
      s.statement_number, clientName(s.client_id), s.period_start, s.period_end,
      STATEMENT_STATUS_LABELS[s.status], s.load_count, s.total_gross, s.total_fees,
      s.adjustments, s.amount_due, s.amount_paid, s.due_date ?? '', s.paid_date ?? '',
    ]),
  )

  return (
    <>
      <Header title="Fee Statements" subtitle="What our clients owe Avantra — the revenue side" />
      <div className="p-6 space-y-6">

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card><CardContent className="py-4">
            <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Outstanding fees</div>
            <div className="text-2xl font-bold text-indigo-700 dark:text-indigo-400">{money(stats.outstanding)}</div>
          </CardContent></Card>
          <Card><CardContent className="py-4">
            <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Drafts not sent</div>
            <div className="text-2xl font-bold text-gray-900 dark:text-white">{stats.draftCount}</div>
            <div className="text-[11px] text-gray-400">{money(stats.draftValue)} unbilled</div>
          </CardContent></Card>
          <Card><CardContent className="py-4">
            <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Collected this month</div>
            <div className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">{money(stats.collected)}</div>
          </CardContent></Card>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input placeholder="Search statement # or client…" className="pl-9 h-9" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <Select value={filter} onValueChange={v => setFilter(v ?? 'all')}>
            <SelectTrigger className="h-9 w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statements</SelectItem>
              <SelectItem value="unpaid">Unpaid</SelectItem>
              {STATEMENT_STATUSES.map(s => <SelectItem key={s} value={s}>{STATEMENT_STATUS_LABELS[s]}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" className="gap-2 h-9" onClick={exportCsv} disabled={filtered.length === 0}>
              <Download className="h-4 w-4" />Export
            </Button>
            {canModify && <GenerateSheet onCreated={load} />}
          </div>
        </div>

        <Card>
          <CardContent className="p-0">
            {loading ? (
              <div className="flex items-center justify-center py-20 text-gray-400">
                <Loader2 className="h-6 w-6 animate-spin mr-2" />Loading statements…
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
                <div className="p-3 rounded-full bg-indigo-50 dark:bg-indigo-950 text-indigo-500"><Receipt className="h-7 w-7" /></div>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
                  {statements.length === 0 ? 'No statements yet' : 'Nothing matches these filters'}
                </p>
                <p className="text-xs text-gray-400 max-w-sm">
                  {statements.length === 0
                    ? 'Generate a statement to bill a client for the dispatch fees on their delivered loads.'
                    : 'Try clearing the filter.'}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortableTh label="Statement #" k="statement_number" sort={sort} toggle={toggle} />
                      <SortableTh label="Client"      k="client"           sort={sort} toggle={toggle} />
                      <SortableTh label="Period"      k="period"           sort={sort} toggle={toggle} />
                      <TableHead className="text-right">Loads</TableHead>
                      <TableHead className="text-right">Gross</TableHead>
                      <SortableTh label="Due"         k="due"              sort={sort} toggle={toggle} />
                      <SortableTh label="Status"      k="status"           sort={sort} toggle={toggle} />
                      <SortableTh label="Amount due"  k="amount"           sort={sort} toggle={toggle} align="right" />
                      <TableHead className="text-right">Open</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sorted.map(s => {
                      const open = (s.amount_due ?? 0) - (s.amount_paid ?? 0)
                      const pd = ['sent', 'partial', 'overdue'].includes(s.status) ? daysPastDue(s.due_date) : 0
                      return (
                        <TableRow key={s.id} className="cursor-pointer" onClick={() => setSelected(s)}>
                          <TableCell className="font-medium text-indigo-700 dark:text-indigo-400 whitespace-nowrap">
                            {s.statement_number}
                          </TableCell>
                          <TableCell className="max-w-[200px] truncate">{clientName(s.client_id)}</TableCell>
                          <TableCell className="whitespace-nowrap text-sm text-gray-600 dark:text-gray-300">
                            {shortDate(s.period_start)} – {shortDate(s.period_end)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-sm">{s.load_count}</TableCell>
                          <TableCell className="text-right tabular-nums text-sm text-gray-600 dark:text-gray-300">{money(s.total_gross)}</TableCell>
                          <TableCell className="whitespace-nowrap text-sm">
                            {longDate(s.due_date)}
                            {pd > 0 && <span className="ml-1 text-red-600 dark:text-red-400 font-medium">({pd}d)</span>}
                          </TableCell>
                          <TableCell>
                            <Badge className={`border ${STATEMENT_STATUS_COLORS[s.status]}`}>{STATEMENT_STATUS_LABELS[s.status]}</Badge>
                          </TableCell>
                          <TableCell className="text-right tabular-nums font-semibold text-indigo-700 dark:text-indigo-400">
                            {money(s.amount_due)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
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
      </div>

      {selected && (
        <StatementSheet
          statement={selected}
          clientName={clientName(selected.client_id)}
          onSaved={load}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  )
}
