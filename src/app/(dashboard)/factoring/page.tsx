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
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet'
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table'
import {
  Plus, Loader2, Banknote, AlertTriangle, Save, ExternalLink, Users, PencilLine,
} from 'lucide-react'

import { createClient } from '@/lib/supabase/client'
import { logAudit } from '@/lib/audit'
import { useRole } from '@/lib/role-context'
import {
  INVOICE_STATUS_LABELS, INVOICE_STATUS_COLORS, money, money2, longDate, num,
} from '@/lib/dispatch'
import type { FactoringCompany, Client, Invoice } from '@/types'

const BLANK = {
  name: '', contact_name: '', email: '', phone: '', submission_email: '',
  portal_url: '', advance_rate: '', fee_percent: '', notes: '', is_active: true,
}

function FactorSheet({ existing, onSaved, trigger }: {
  existing?: FactoringCompany
  onSaved: () => void
  trigger: (open: () => void) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [f, setF] = useState({ ...BLANK })

  useEffect(() => {
    if (!open) return
    setError('')
    setF(existing ? {
      name: existing.name,
      contact_name: existing.contact_name ?? '',
      email: existing.email ?? '',
      phone: existing.phone ?? '',
      submission_email: existing.submission_email ?? '',
      portal_url: existing.portal_url ?? '',
      advance_rate: existing.advance_rate?.toString() ?? '',
      fee_percent: existing.fee_percent?.toString() ?? '',
      notes: existing.notes ?? '',
      is_active: existing.is_active,
    } : { ...BLANK })
  }, [open, existing])

  const save = async () => {
    if (!f.name.trim()) { setError('Factoring company name is required.'); return }
    setSaving(true); setError('')
    const supabase = createClient()
    const payload = {
      name: f.name.trim(),
      contact_name: f.contact_name.trim() || null,
      email: f.email.trim() || null,
      phone: f.phone.trim() || null,
      submission_email: f.submission_email.trim() || null,
      portal_url: f.portal_url.trim() || null,
      advance_rate: f.advance_rate ? num(f.advance_rate) : null,
      fee_percent: f.fee_percent ? num(f.fee_percent) : null,
      notes: f.notes.trim() || null,
      is_active: f.is_active,
    }
    const res = existing
      ? await supabase.from('factoring_companies').update(payload).eq('id', existing.id).select('id').single()
      : await supabase.from('factoring_companies').insert(payload).select('id').single()
    setSaving(false)
    if (res.error) {
      setError(res.error.code === '23505' ? 'A factoring company with that name already exists.' : res.error.message)
      return
    }
    void logAudit(existing ? 'factoring_company.update' : 'factoring_company.create', {
      table_name: 'factoring_companies', record_id: res.data?.id, new_value: { name: payload.name },
    })
    setOpen(false); onSaved()
  }

  return (
    <>
      {trigger(() => setOpen(true))}
      <Sheet open={open} onOpenChange={setOpen}>
        {open && (
          <SheetContent side="right" className="!w-[75vw] !max-w-[900px] flex flex-col gap-0 p-0">
            <SheetHeader className="px-6 py-4 border-b dark:border-gray-800">
              <SheetTitle className="text-lg font-semibold">
                {existing ? 'Edit Factoring Company' : 'Add a Factoring Company'}
              </SheetTitle>
              <SheetDescription>
                Where a client&apos;s receivables are assigned. Invoices for a factored client must remit
                here — paying the carrier directly does not discharge the debt.
              </SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Company name *</Label>
                  <Input className="mt-1 h-9" value={f.name} onChange={e => setF(s => ({ ...s, name: e.target.value }))} />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Contact</Label>
                  <Input className="mt-1 h-9" value={f.contact_name} onChange={e => setF(s => ({ ...s, contact_name: e.target.value }))} />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Email</Label>
                  <Input className="mt-1 h-9" type="email" value={f.email} onChange={e => setF(s => ({ ...s, email: e.target.value }))} />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Phone</Label>
                  <Input className="mt-1 h-9" value={f.phone} onChange={e => setF(s => ({ ...s, phone: e.target.value }))} />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Invoice submission email</Label>
                  <Input className="mt-1 h-9" type="email" value={f.submission_email} onChange={e => setF(s => ({ ...s, submission_email: e.target.value }))}
                    placeholder="Where invoice packets get sent" />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Portal URL</Label>
                  <Input className="mt-1 h-9" value={f.portal_url} onChange={e => setF(s => ({ ...s, portal_url: e.target.value }))} placeholder="https://…" />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Advance rate (%)</Label>
                  <Input className="mt-1 h-9" type="number" step="0.1" value={f.advance_rate} onChange={e => setF(s => ({ ...s, advance_rate: e.target.value }))} placeholder="95" />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Factoring fee (%)</Label>
                  <Input className="mt-1 h-9" type="number" step="0.1" value={f.fee_percent} onChange={e => setF(s => ({ ...s, fee_percent: e.target.value }))} placeholder="3" />
                </div>
              </div>
              <div>
                <Label className="text-xs text-gray-500 dark:text-gray-400">Notes</Label>
                <Textarea className="mt-1" rows={3} value={f.notes} onChange={e => setF(s => ({ ...s, notes: e.target.value }))} />
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200 cursor-pointer">
                <input type="checkbox" checked={f.is_active} onChange={e => setF(s => ({ ...s, is_active: e.target.checked }))} />
                Active — available when setting up a client
              </label>
              {error && (
                <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 rounded-lg px-4 py-2.5">
                  <AlertTriangle className="h-4 w-4 shrink-0" />{error}
                </div>
              )}
            </div>
            <div className="border-t dark:border-gray-800 px-6 py-4 flex items-center justify-end gap-3">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white" disabled={saving} onClick={save}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Save
              </Button>
            </div>
          </SheetContent>
        )}
      </Sheet>
    </>
  )
}

export default function FactoringPage() {
  const { canModify } = useRole()
  const [factors, setFactors] = useState<FactoringCompany[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const [{ data: f }, { data: c }, { data: i }] = await Promise.all([
      supabase.from('factoring_companies').select('*').order('name'),
      supabase.from('clients').select('*').is('deleted_at', null),
      supabase.from('invoices').select('*').not('factoring_company_id', 'is', null),
    ])
    setFactors((f ?? []) as FactoringCompany[])
    setClients((c ?? []) as Client[])
    setInvoices((i ?? []) as Invoice[])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const byFactor = useMemo(() => {
    const m = new Map<string, { clients: Client[]; submitted: Invoice[]; awaiting: Invoice[]; funded: number }>()
    for (const f of factors) m.set(f.id, { clients: [], submitted: [], awaiting: [], funded: 0 })
    for (const c of clients) {
      if (c.factoring_company_id && m.has(c.factoring_company_id)) {
        m.get(c.factoring_company_id)!.clients.push(c)
      }
    }
    for (const inv of invoices) {
      const e = inv.factoring_company_id ? m.get(inv.factoring_company_id) : undefined
      if (!e) continue
      if (inv.status === 'void') continue
      e.submitted.push(inv)
      if (inv.factored_at && !inv.funded_at) e.awaiting.push(inv)
      e.funded += inv.funded_amount ?? 0
    }
    return m
  }, [factors, clients, invoices])

  // Invoices sitting at a factor with no funding recorded — the thing worth
  // chasing on this page.
  const awaitingAll = useMemo(
    () => invoices.filter(i => i.status !== 'void' && i.factored_at && !i.funded_at),
    [invoices],
  )

  const clientName = useCallback((id: string | null) => {
    if (!id) return '—'
    const c = clients.find(x => x.id === id)
    return c ? (c.dba_name || c.legal_name) : '—'
  }, [clients])

  return (
    <>
      <Header title="Factoring" subtitle="Where our clients' receivables are assigned" />
      <div className="p-6 space-y-6">

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card><CardContent className="flex items-center gap-3 py-4">
            <div className="p-2 rounded-lg bg-violet-100 dark:bg-violet-950 text-violet-600"><Banknote className="h-5 w-5" /></div>
            <div>
              <div className="text-2xl font-bold text-gray-900 dark:text-white">{factors.filter(f => f.is_active).length}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Active factors</div>
            </div>
          </CardContent></Card>
          <Card><CardContent className="flex items-center gap-3 py-4">
            <div className="p-2 rounded-lg bg-indigo-100 dark:bg-indigo-950 text-indigo-600"><Users className="h-5 w-5" /></div>
            <div>
              <div className="text-2xl font-bold text-gray-900 dark:text-white">{clients.filter(c => c.factors_invoices).length}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Clients factoring</div>
            </div>
          </CardContent></Card>
          <Card><CardContent className="flex items-center gap-3 py-4">
            <div className="p-2 rounded-lg bg-amber-100 dark:bg-amber-950 text-amber-600"><AlertTriangle className="h-5 w-5" /></div>
            <div>
              <div className="text-2xl font-bold text-gray-900 dark:text-white">{awaitingAll.length}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Submitted, awaiting funding · {money(awaitingAll.reduce((s, i) => s + (i.amount ?? 0), 0))}
              </div>
            </div>
          </CardContent></Card>
        </div>

        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Factoring companies</h2>
          {canModify && (
            <FactorSheet onSaved={load} trigger={open => (
              <Button className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white" onClick={open}>
                <Plus className="h-4 w-4" />Add Factor
              </Button>
            )} />
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20 text-gray-400">
            <Loader2 className="h-6 w-6 animate-spin mr-2" />Loading factoring…
          </div>
        ) : factors.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-20 gap-3 text-center">
              <div className="p-3 rounded-full bg-violet-50 dark:bg-violet-950 text-violet-500"><Banknote className="h-7 w-7" /></div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-200">No factoring companies yet</p>
              <p className="text-xs text-gray-400 max-w-sm">
                Add the factors your clients use so invoices can be submitted and remit instructions
                point at the right place.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {factors.map(f => {
              const e = byFactor.get(f.id)
              return (
                <Card key={f.id} className={f.is_active ? undefined : 'opacity-60'}>
                  <CardContent className="py-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold text-gray-900 dark:text-white truncate">{f.name}</h3>
                          {!f.is_active && (
                            <Badge className="border bg-gray-100 text-gray-700 border-gray-200 dark:bg-white/10 dark:text-gray-300 dark:border-white/10">
                              Inactive
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {[f.contact_name, f.phone, f.email].filter(Boolean).join(' · ') || 'No contact on file'}
                        </p>
                      </div>
                      {canModify && (
                        <FactorSheet existing={f} onSaved={load} trigger={open => (
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0" onClick={open} title="Edit factor">
                            <PencilLine className="h-4 w-4" />
                          </Button>
                        )} />
                      )}
                    </div>

                    <div className="grid grid-cols-3 gap-3 text-sm">
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Advance</div>
                        <div className="text-gray-800 dark:text-gray-100">{f.advance_rate != null ? `${f.advance_rate}%` : '—'}</div>
                      </div>
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Fee</div>
                        <div className="text-gray-800 dark:text-gray-100">{f.fee_percent != null ? `${f.fee_percent}%` : '—'}</div>
                      </div>
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Clients</div>
                        <div className="text-gray-800 dark:text-gray-100">{e?.clients.length ?? 0}</div>
                      </div>
                    </div>

                    {e && e.clients.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {e.clients.map(c => (
                          <span key={c.id} className="text-[11px] rounded-full bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 px-2 py-0.5">
                            {c.dba_name || c.legal_name}
                          </span>
                        ))}
                      </div>
                    )}

                    {e && e.awaiting.length > 0 && (
                      <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                        {e.awaiting.length} invoice{e.awaiting.length === 1 ? '' : 's'} submitted, awaiting funding
                        {' · '}{money(e.awaiting.reduce((s, i) => s + (i.amount ?? 0), 0))}
                      </div>
                    )}

                    <div className="flex items-center gap-3 text-xs">
                      {f.submission_email && (
                        <span className="text-gray-500 dark:text-gray-400 truncate">Submit to {f.submission_email}</span>
                      )}
                      {f.portal_url && (
                        <a href={f.portal_url} target="_blank" rel="noopener noreferrer"
                          className="ml-auto inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400 hover:underline shrink-0">
                          Portal<ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}

        {awaitingAll.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Awaiting funding</h2>
            <Card>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>Invoice #</TableHead><TableHead>Client</TableHead>
                      <TableHead>Factor</TableHead><TableHead>Submitted</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {awaitingAll.map(i => (
                        <TableRow key={i.id}>
                          <TableCell className="font-medium text-indigo-700 dark:text-indigo-400">{i.invoice_number}</TableCell>
                          <TableCell className="max-w-[180px] truncate text-sm">{clientName(i.client_id)}</TableCell>
                          <TableCell className="text-sm text-gray-600 dark:text-gray-300">
                            {factors.find(f => f.id === i.factoring_company_id)?.name ?? '—'}
                          </TableCell>
                          <TableCell className="text-sm text-gray-600 dark:text-gray-300">{longDate(i.factored_at)}</TableCell>
                          <TableCell>
                            <Badge className={`border ${INVOICE_STATUS_COLORS[i.status]}`}>{INVOICE_STATUS_LABELS[i.status]}</Badge>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{money2(i.amount)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </>
  )
}
