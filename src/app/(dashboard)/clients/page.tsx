'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
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
  Plus, Search, Loader2, Users, Truck, AlertTriangle, Download,
  ShieldCheck, Percent,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { logAudit } from '@/lib/audit'
import { useRole } from '@/lib/role-context'
import { downloadCSV } from '@/lib/csv'
import { useSort, type SortAccessors } from '@/lib/use-sort'
import {
  CLIENT_STATUSES, CLIENT_STATUS_LABELS, CLIENT_STATUS_COLORS,
  ONBOARDING_TEMPLATE, EQUIPMENT_TYPES, describeFeePlan, num, daysUntil,
} from '@/lib/dispatch'
import type { Client, ClientStatus, FactoringCompany } from '@/types'

// ── Sorting ──────────────────────────────────────────────────────────────────
type ClientSortKey =
  | 'client_number' | 'name' | 'status' | 'mc' | 'authority' | 'fee' | 'insurance' | 'created'

const CLIENT_SORT: SortAccessors<Client, ClientSortKey> = {
  client_number: c => c.client_number ?? '',
  name:          c => c.dba_name || c.legal_name || '',
  status:        c => c.status,
  mc:            c => c.mc_number ?? '',
  authority:     c => c.authority_status,
  // Sort by what the plan is actually worth, so flat and % plans compare sanely.
  fee:           c => (c.fee_type === 'flat' ? c.fee_flat : c.fee_percent),
  insurance:     c => c.insurance_expiry ?? '',
  created:       c => c.created_at,
}

// ── New Client Sheet ─────────────────────────────────────────────────────────
const BLANK = {
  legal_name: '', dba_name: '', status: 'prospect' as ClientStatus,
  mc_number: '', dot_number: '', ein: '',
  contact_name: '', phone: '', email: '', billing_email: '',
  address: '', city: '', state: '', zip: '',
  fee_type: 'percent', fee_percent: '10', fee_flat: '0', fee_basis: 'gross', fee_minimum: '0',
  billing_cycle: 'weekly',
  factoring_company_id: '', factors_invoices: false,
  insurance_provider: '', liability_amount: '', cargo_amount: '', insurance_expiry: '',
  home_base_city: '', home_base_state: '', min_rate_per_mile: '',
  hazmat: false, team: false,
  notes: '',
}

interface FmcsaResult {
  configured?: boolean
  legalName?: string | null
  dbaName?: string | null
  dotNumber?: string | null
  mcNumber?: string | null
  allowedToOperate?: boolean | null
  safetyRating?: string | null
  phyStreet?: string | null
  phyCity?: string | null
  phyState?: string | null
  phyZip?: string | null
  error?: string
}

function NewClientSheet({ onCreated, factors }: { onCreated: () => void; factors: FactoringCompany[] }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ ...BLANK })
  const [equipment, setEquipment] = useState<string[]>([])
  const set = <K extends keyof typeof BLANK>(k: K, v: (typeof BLANK)[K]) =>
    setForm(f => ({ ...f, [k]: v }))

  // FMCSA lookup state
  const [looking, setLooking] = useState(false)
  const [lookupNote, setLookupNote] = useState('')

  const reset = () => { setForm({ ...BLANK }); setEquipment([]); setError(''); setLookupNote('') }

  const runFmcsa = async () => {
    const mc = form.mc_number.replace(/\D/g, '')
    const dot = form.dot_number.replace(/\D/g, '')
    if (!mc && !dot) { setLookupNote('Enter an MC or DOT number first.'); return }
    setLooking(true); setLookupNote('')
    try {
      const res = await fetch('/api/fmcsa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        legal_name: data.legalName || f.legal_name,
        dba_name:   data.dbaName || f.dba_name,
        dot_number: data.dotNumber || f.dot_number,
        mc_number:  data.mcNumber || f.mc_number,
        address:    data.phyStreet || f.address,
        city:       data.phyCity || f.city,
        state:      data.phyState || f.state,
        zip:        data.phyZip || f.zip,
      }))
      setLookupNote(
        data.allowedToOperate === false
          ? 'Heads up: FMCSA says this carrier is NOT authorized to operate.'
          : `Found${data.safetyRating ? ` — safety rating ${data.safetyRating}` : ''}. Fields prefilled.`,
      )
    } catch {
      setLookupNote('Lookup failed. Enter details manually.')
    } finally {
      setLooking(false)
    }
  }

  const toggleEquip = (t: string) =>
    setEquipment(e => e.includes(t) ? e.filter(x => x !== t) : [...e, t])

  const handleSubmit = async () => {
    if (!form.legal_name.trim()) { setError('Legal name is required.'); return }
    setSaving(true); setError('')
    const supabase = createClient()

    const payload = {
      legal_name: form.legal_name.trim(),
      dba_name: form.dba_name.trim() || null,
      status: form.status,
      mc_number: form.mc_number.trim() || null,
      dot_number: form.dot_number.trim() || null,
      ein: form.ein.trim() || null,
      contact_name: form.contact_name.trim() || null,
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      billing_email: form.billing_email.trim() || null,
      address: form.address.trim() || null,
      city: form.city.trim() || null,
      state: form.state.toUpperCase().slice(0, 2) || null,
      zip: form.zip.trim() || null,
      fee_type: form.fee_type,
      fee_percent: num(form.fee_percent),
      fee_flat: num(form.fee_flat),
      fee_basis: form.fee_basis,
      fee_minimum: num(form.fee_minimum),
      billing_cycle: form.billing_cycle,
      factoring_company_id: form.factoring_company_id || null,
      factors_invoices: form.factors_invoices,
      insurance_provider: form.insurance_provider.trim() || null,
      liability_amount: form.liability_amount ? num(form.liability_amount) : null,
      cargo_amount: form.cargo_amount ? num(form.cargo_amount) : null,
      insurance_expiry: form.insurance_expiry || null,
      equipment_types: equipment,
      home_base_city: form.home_base_city.trim() || null,
      home_base_state: form.home_base_state.toUpperCase().slice(0, 2) || null,
      min_rate_per_mile: form.min_rate_per_mile ? num(form.min_rate_per_mile) : null,
      hazmat: form.hazmat,
      team: form.team,
      notes: form.notes.trim() || null,
    }

    const { data: created, error: err } = await supabase
      .from('clients').insert(payload).select('id, client_number').single()

    if (err) { setSaving(false); setError(err.message); return }

    // Seed the onboarding checklist so the client starts with a real to-do list
    // rather than an empty tab. Non-fatal: a client without steps still works.
    if (created?.id) {
      const steps = ONBOARDING_TEMPLATE.map((s, i) => ({
        client_id: created.id, step_key: s.step_key, label: s.label,
        sort_order: i, is_required: s.is_required,
      }))
      const { error: stepErr } = await supabase.from('client_onboarding_steps').insert(steps)
      if (stepErr) console.warn('[clients] onboarding seed failed:', stepErr.message)
    }

    setSaving(false)
    void logAudit('client.create', {
      table_name: 'clients',
      record_id: created?.id,
      new_value: {
        client_number: created?.client_number,
        legal_name: payload.legal_name,
        mc_number: payload.mc_number,
        status: payload.status,
        fee: describeFeePlan({
          fee_type: payload.fee_type as 'percent' | 'flat',
          fee_percent: payload.fee_percent,
          fee_flat: payload.fee_flat,
          fee_basis: payload.fee_basis as 'gross' | 'linehaul',
          fee_minimum: payload.fee_minimum,
        }),
      },
    })

    setOpen(false)
    reset()
    onCreated()
  }

  const feePreview = describeFeePlan({
    fee_type: form.fee_type as 'percent' | 'flat',
    fee_percent: num(form.fee_percent),
    fee_flat: num(form.fee_flat),
    fee_basis: form.fee_basis as 'gross' | 'linehaul',
    fee_minimum: num(form.fee_minimum),
  })

  return (
    <>
      <Button className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />New Client
      </Button>

      <Sheet open={open} onOpenChange={o => { setOpen(o); if (!o) reset() }}>
        {open && (
          <SheetContent side="right" className="!w-[75vw] !max-w-[900px] flex flex-col gap-0 p-0">
            <SheetHeader className="px-6 py-4 border-b dark:border-gray-800">
              <SheetTitle className="text-lg font-semibold">Add a Carrier Client</SheetTitle>
              <SheetDescription>
                A motor carrier Avantra dispatches for. Their authority, their trucks, our fee.
              </SheetDescription>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
              {/* Identity + authority */}
              <section className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Carrier identity
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Legal name *</Label>
                    <Input className="mt-1 h-9" value={form.legal_name} onChange={e => set('legal_name', e.target.value)} placeholder="ABC Trucking LLC" />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">DBA</Label>
                    <Input className="mt-1 h-9" value={form.dba_name} onChange={e => set('dba_name', e.target.value)} />
                  </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">MC #</Label>
                    <Input className="mt-1 h-9" value={form.mc_number} onChange={e => set('mc_number', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">DOT #</Label>
                    <Input className="mt-1 h-9" value={form.dot_number} onChange={e => set('dot_number', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">EIN</Label>
                    <Input className="mt-1 h-9" value={form.ein} onChange={e => set('ein', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Status</Label>
                    <Select value={form.status} onValueChange={v => set('status', (v ?? 'prospect') as ClientStatus)}>
                      <SelectTrigger className="mt-1 h-9 w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {CLIENT_STATUSES.map(s => <SelectItem key={s} value={s}>{CLIENT_STATUS_LABELS[s]}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Button type="button" variant="outline" className="gap-2 h-9" onClick={runFmcsa} disabled={looking}>
                    {looking ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                    Look up FMCSA
                  </Button>
                  {lookupNote && (
                    <p className={`text-xs ${lookupNote.startsWith('Heads up') ? 'text-red-600 dark:text-red-400 font-medium' : 'text-gray-500 dark:text-gray-400'}`}>
                      {lookupNote}
                    </p>
                  )}
                </div>
              </section>

              {/* Contact */}
              <section className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Contact</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Primary contact</Label>
                    <Input className="mt-1 h-9" value={form.contact_name} onChange={e => set('contact_name', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Phone</Label>
                    <Input className="mt-1 h-9" value={form.phone} onChange={e => set('phone', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Email</Label>
                    <Input className="mt-1 h-9" type="email" value={form.email} onChange={e => set('email', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Billing email</Label>
                    <Input className="mt-1 h-9" type="email" value={form.billing_email} onChange={e => set('billing_email', e.target.value)} placeholder="Where fee statements go" />
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div className="md:col-span-2">
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Address</Label>
                    <Input className="mt-1 h-9" value={form.address} onChange={e => set('address', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">City</Label>
                    <Input className="mt-1 h-9" value={form.city} onChange={e => set('city', e.target.value)} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
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

              {/* Fee plan */}
              <section className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Dispatch fee plan
                </p>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Fee type</Label>
                    <Select value={form.fee_type} onValueChange={v => set('fee_type', v ?? 'percent')}>
                      <SelectTrigger className="mt-1 h-9 w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="percent">Percent</SelectItem>
                        <SelectItem value="flat">Flat</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {form.fee_type === 'percent' ? (
                    <>
                      <div>
                        <Label className="text-xs text-gray-500 dark:text-gray-400">Fee %</Label>
                        <Input className="mt-1 h-9" type="number" step="0.1" value={form.fee_percent} onChange={e => set('fee_percent', e.target.value)} />
                      </div>
                      <div>
                        <Label className="text-xs text-gray-500 dark:text-gray-400">Basis</Label>
                        <Select value={form.fee_basis} onValueChange={v => set('fee_basis', v ?? 'gross')}>
                          <SelectTrigger className="mt-1 h-9 w-full"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="gross">Gross</SelectItem>
                            <SelectItem value="linehaul">Linehaul only</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </>
                  ) : (
                    <div className="md:col-span-2">
                      <Label className="text-xs text-gray-500 dark:text-gray-400">Flat fee per load ($)</Label>
                      <Input className="mt-1 h-9" type="number" value={form.fee_flat} onChange={e => set('fee_flat', e.target.value)} />
                    </div>
                  )}
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Minimum ($)</Label>
                    <Input className="mt-1 h-9" type="number" value={form.fee_minimum} onChange={e => set('fee_minimum', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Billing cycle</Label>
                    <Select value={form.billing_cycle} onValueChange={v => set('billing_cycle', v ?? 'weekly')}>
                      <SelectTrigger className="mt-1 h-9 w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="weekly">Weekly</SelectItem>
                        <SelectItem value="biweekly">Bi-weekly</SelectItem>
                        <SelectItem value="monthly">Monthly</SelectItem>
                        <SelectItem value="per_load">Per load</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex items-center gap-2 rounded-lg border border-indigo-200 dark:border-indigo-900/60 bg-indigo-50/70 dark:bg-indigo-950/30 px-4 py-2.5 text-sm">
                  <Percent className="h-4 w-4 text-indigo-500 shrink-0" />
                  <span className="text-gray-700 dark:text-gray-200">
                    Avantra earns <strong>{feePreview}</strong>. Every load snapshots these terms at booking.
                  </span>
                </div>
              </section>

              {/* Factoring + insurance */}
              <section className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Factoring &amp; insurance
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Factoring company</Label>
                    <Select
                      value={form.factoring_company_id || null}
                      onValueChange={v => {
                        const id = (v && v !== '__none') ? v : ''
                        setForm(f => ({ ...f, factoring_company_id: id, factors_invoices: !!id }))
                      }}
                    >
                      <SelectTrigger className="mt-1 h-9 w-full">
                        <SelectValue placeholder={factors.length ? 'Not factored' : 'No factors on file yet'} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none">Not factored</SelectItem>
                        {factors.map(f => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <p className="mt-1 text-[11px] text-gray-400">
                      When set, broker invoices remit to the factor, not the carrier.
                    </p>
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Insurance provider</Label>
                    <Input className="mt-1 h-9" value={form.insurance_provider} onChange={e => set('insurance_provider', e.target.value)} />
                  </div>
                  <div className="grid grid-cols-3 gap-2 md:col-span-2">
                    <div>
                      <Label className="text-xs text-gray-500 dark:text-gray-400">Auto liability ($)</Label>
                      <Input className="mt-1 h-9" type="number" value={form.liability_amount} onChange={e => set('liability_amount', e.target.value)} placeholder="1000000" />
                    </div>
                    <div>
                      <Label className="text-xs text-gray-500 dark:text-gray-400">Cargo ($)</Label>
                      <Input className="mt-1 h-9" type="number" value={form.cargo_amount} onChange={e => set('cargo_amount', e.target.value)} placeholder="100000" />
                    </div>
                    <div>
                      <Label className="text-xs text-gray-500 dark:text-gray-400">COI expires</Label>
                      <Input className="mt-1 h-9" type="date" value={form.insurance_expiry} onChange={e => set('insurance_expiry', e.target.value)} />
                    </div>
                  </div>
                </div>
              </section>

              {/* Dispatch preferences */}
              <section className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Dispatch preferences
                </p>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Equipment they run</Label>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {EQUIPMENT_TYPES.map(t => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => toggleEquip(t)}
                        className={`px-3 py-1.5 rounded-full border text-xs transition-colors ${
                          equipment.includes(t)
                            ? 'bg-indigo-600 border-indigo-600 text-white'
                            : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-indigo-400'
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Home base city</Label>
                    <Input className="mt-1 h-9" value={form.home_base_city} onChange={e => set('home_base_city', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">State</Label>
                    <Input className="mt-1 h-9" maxLength={2} value={form.home_base_state} onChange={e => set('home_base_state', e.target.value.toUpperCase())} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Min $/mile</Label>
                    <Input className="mt-1 h-9" type="number" step="0.01" value={form.min_rate_per_mile} onChange={e => set('min_rate_per_mile', e.target.value)} placeholder="2.00" />
                  </div>
                  <div className="flex items-end gap-4 pb-1.5">
                    <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
                      <input type="checkbox" checked={form.hazmat} onChange={e => set('hazmat', e.target.checked)} />Hazmat
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
                      <input type="checkbox" checked={form.team} onChange={e => set('team', e.target.checked)} />Team
                    </label>
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Notes</Label>
                  <Textarea className="mt-1" rows={3} value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Anything a dispatcher should know before booking for them." />
                </div>
              </section>

              {error && (
                <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 rounded-lg px-4 py-2.5">
                  <AlertTriangle className="h-4 w-4 shrink-0" />{error}
                </div>
              )}
            </div>

            <div className="border-t dark:border-gray-800 px-6 py-4 flex items-center justify-end gap-3">
              <Button variant="outline" onClick={() => { setOpen(false); reset() }}>Cancel</Button>
              <Button className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white" disabled={saving} onClick={handleSubmit}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {saving ? 'Saving…' : 'Create Client'}
              </Button>
            </div>
          </SheetContent>
        )}
      </Sheet>
    </>
  )
}

// ── Clients list page ────────────────────────────────────────────────────────
export default function ClientsPage() {
  const router = useRouter()
  const { canModify } = useRole()
  const [clients, setClients] = useState<Client[]>([])
  const [factors, setFactors] = useState<FactoringCompany[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const [{ data }, { data: f }] = await Promise.all([
      supabase.from('clients').select('*').is('deleted_at', null)
        .order('created_at', { ascending: false }).limit(500),
      supabase.from('factoring_companies').select('*').eq('is_active', true).order('name'),
    ])
    setClients((data ?? []) as Client[])
    setFactors((f ?? []) as FactoringCompany[])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return clients.filter(c => {
      if (statusFilter === 'needs_attention') {
        const coiDays = daysUntil(c.insurance_expiry)
        const paperworkGap = !c.agreement_signed_at || !c.w9_on_file || !c.coi_on_file
        const coiProblem = coiDays != null && coiDays <= 30
        const authProblem = c.authority_status === 'inactive' || c.authority_status === 'not_authorized'
        if (!(paperworkGap || coiProblem || authProblem)) return false
      } else if (statusFilter !== 'all' && c.status !== statusFilter) {
        return false
      }
      if (!q) return true
      const hay = [
        c.client_number, c.legal_name, c.dba_name, c.mc_number, c.dot_number,
        c.contact_name, c.email, c.phone, c.city, c.state,
      ].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [clients, statusFilter, search])

  const { sorted, sort, toggle } = useSort<Client, ClientSortKey>(filtered, CLIENT_SORT)

  const exportCsv = () => downloadCSV(
    `clients-${new Date().toISOString().slice(0, 10)}.csv`,
    ['Client #', 'Legal Name', 'DBA', 'Status', 'MC', 'DOT', 'Authority', 'Contact', 'Phone',
     'Email', 'City', 'State', 'Fee Plan', 'Billing Cycle', 'COI Expiry', 'Factored'],
    sorted.map(c => [
      c.client_number ?? '', c.legal_name, c.dba_name ?? '', CLIENT_STATUS_LABELS[c.status],
      c.mc_number ?? '', c.dot_number ?? '', c.authority_status, c.contact_name ?? '',
      c.phone ?? '', c.email ?? '', c.city ?? '', c.state ?? '',
      describeFeePlan(c), c.billing_cycle, c.insurance_expiry ?? '', c.factors_invoices ? 'Yes' : 'No',
    ]),
  )

  const stats = useMemo(() => {
    const active = clients.filter(c => c.status === 'active').length
    const onboarding = clients.filter(c => c.status === 'onboarding' || c.status === 'prospect').length
    const attention = clients.filter(c => {
      const coiDays = daysUntil(c.insurance_expiry)
      return !c.agreement_signed_at || !c.w9_on_file || !c.coi_on_file
        || (coiDays != null && coiDays <= 30)
        || c.authority_status === 'inactive' || c.authority_status === 'not_authorized'
    }).length
    return { active, onboarding, attention }
  }, [clients])

  return (
    <>
      <Header title="Clients" subtitle="The carriers Avantra dispatches for" />
      <div className="p-6 space-y-6">

        {/* KPI strip — tiles double as one-click work-queue filters */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card
            role="button" tabIndex={0}
            onClick={() => setStatusFilter(f => f === 'active' ? 'all' : 'active')}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setStatusFilter(f => f === 'active' ? 'all' : 'active') } }}
            className={`cursor-pointer transition-shadow hover:shadow-md ${statusFilter === 'active' ? 'ring-2 ring-emerald-500' : ''}`}
          >
            <CardContent className="flex items-center gap-3 py-4">
              <div className="p-2 rounded-lg bg-emerald-100 dark:bg-emerald-950 text-emerald-600"><Truck className="h-5 w-5" /></div>
              <div>
                <div className="text-2xl font-bold text-gray-900 dark:text-white">{stats.active}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">Active clients</div>
              </div>
            </CardContent>
          </Card>
          <Card
            role="button" tabIndex={0}
            onClick={() => setStatusFilter(f => f === 'onboarding' ? 'all' : 'onboarding')}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setStatusFilter(f => f === 'onboarding' ? 'all' : 'onboarding') } }}
            className={`cursor-pointer transition-shadow hover:shadow-md ${statusFilter === 'onboarding' ? 'ring-2 ring-amber-500' : ''}`}
          >
            <CardContent className="flex items-center gap-3 py-4">
              <div className="p-2 rounded-lg bg-amber-100 dark:bg-amber-950 text-amber-600"><Users className="h-5 w-5" /></div>
              <div>
                <div className="text-2xl font-bold text-gray-900 dark:text-white">{stats.onboarding}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">Prospects &amp; onboarding</div>
              </div>
            </CardContent>
          </Card>
          <Card
            role="button" tabIndex={0}
            onClick={() => setStatusFilter(f => f === 'needs_attention' ? 'all' : 'needs_attention')}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setStatusFilter(f => f === 'needs_attention' ? 'all' : 'needs_attention') } }}
            className={`cursor-pointer transition-shadow hover:shadow-md ${statusFilter === 'needs_attention' ? 'ring-2 ring-red-500' : ''}`}
          >
            <CardContent className="flex items-center gap-3 py-4">
              <div className="p-2 rounded-lg bg-red-100 dark:bg-red-950 text-red-600"><AlertTriangle className="h-5 w-5" /></div>
              <div>
                <div className="text-2xl font-bold text-gray-900 dark:text-white">{stats.attention}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">Paperwork gaps</div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              placeholder="Search name, MC/DOT, contact…"
              className="pl-9 h-9"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <Select value={statusFilter} onValueChange={v => setStatusFilter(v ?? 'all')}>
            <SelectTrigger className="h-9 w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="needs_attention">Needs attention</SelectItem>
              {CLIENT_STATUSES.map(s => <SelectItem key={s} value={s}>{CLIENT_STATUS_LABELS[s]}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" className="gap-2 h-9" onClick={exportCsv} disabled={filtered.length === 0}>
              <Download className="h-4 w-4" />Export
            </Button>
            {canModify && <NewClientSheet onCreated={load} factors={factors} />}
          </div>
        </div>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            {loading ? (
              <div className="flex items-center justify-center py-20 text-gray-400">
                <Loader2 className="h-6 w-6 animate-spin mr-2" />Loading clients…
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
                <div className="p-3 rounded-full bg-indigo-50 dark:bg-indigo-950 text-indigo-500"><Users className="h-7 w-7" /></div>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
                  {clients.length === 0 ? 'No clients yet' : 'No clients match your filters'}
                </p>
                <p className="text-xs text-gray-400 max-w-xs">
                  {clients.length === 0
                    ? 'Add the first carrier you dispatch for to start booking loads.'
                    : 'Try clearing the search or status filter.'}
                </p>
                {clients.length === 0 && canModify && (
                  <div className="mt-1"><NewClientSheet onCreated={load} factors={factors} /></div>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortableTh label="Client #"  k="client_number" sort={sort} toggle={toggle} />
                      <SortableTh label="Carrier"   k="name"          sort={sort} toggle={toggle} />
                      <SortableTh label="MC / DOT"  k="mc"            sort={sort} toggle={toggle} />
                      <SortableTh label="Authority" k="authority"     sort={sort} toggle={toggle} />
                      <TableHead>Contact</TableHead>
                      <TableHead>Base</TableHead>
                      <SortableTh label="Fee plan"  k="fee"           sort={sort} toggle={toggle} />
                      <SortableTh label="COI"       k="insurance"     sort={sort} toggle={toggle} />
                      <SortableTh label="Status"    k="status"        sort={sort} toggle={toggle} />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sorted.map(c => {
                      const coiDays = daysUntil(c.insurance_expiry)
                      const coiBad = coiDays != null && coiDays < 0
                      const coiSoon = coiDays != null && coiDays >= 0 && coiDays <= 30
                      const authBad = c.authority_status === 'inactive' || c.authority_status === 'not_authorized'
                      return (
                        <TableRow key={c.id} className="cursor-pointer" onClick={() => router.push(`/clients/${c.id}`)}>
                          <TableCell className="font-medium text-indigo-700 dark:text-indigo-400 whitespace-nowrap">
                            {c.client_number || '—'}
                          </TableCell>
                          <TableCell className="max-w-[220px]">
                            <div className="truncate font-medium text-gray-900 dark:text-white">
                              {c.dba_name || c.legal_name}
                            </div>
                            {c.dba_name && <div className="truncate text-xs text-gray-400">{c.legal_name}</div>}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-sm text-gray-600 dark:text-gray-300">
                            {c.mc_number ? `MC ${c.mc_number}` : '—'}
                            {c.dot_number && <span className="text-gray-400"> · DOT {c.dot_number}</span>}
                          </TableCell>
                          <TableCell>
                            <Badge className={`border ${authBad ? 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-800/50' : c.authority_status === 'active' ? 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-800/50' : 'bg-gray-100 text-gray-700 border-gray-200 dark:bg-white/10 dark:text-gray-300 dark:border-white/10'}`}>
                              {c.authority_status === 'not_authorized' ? 'Not authorized' : c.authority_status}
                            </Badge>
                          </TableCell>
                          <TableCell className="max-w-[160px] truncate text-sm text-gray-600 dark:text-gray-300">
                            {c.contact_name || c.email || c.phone || '—'}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-sm text-gray-600 dark:text-gray-300">
                            {[c.home_base_city, c.home_base_state].filter(Boolean).join(', ') || '—'}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-sm text-gray-700 dark:text-gray-200">
                            {describeFeePlan(c)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-sm">
                            {c.insurance_expiry
                              ? <span className={coiBad ? 'text-red-600 dark:text-red-400 font-medium' : coiSoon ? 'text-amber-600 dark:text-amber-400 font-medium' : 'text-gray-600 dark:text-gray-300'}>
                                  {c.insurance_expiry}
                                </span>
                              : <span className="text-gray-400">—</span>}
                          </TableCell>
                          <TableCell>
                            <Badge className={`border ${CLIENT_STATUS_COLORS[c.status]}`}>{CLIENT_STATUS_LABELS[c.status]}</Badge>
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
            {filtered.length} of {clients.length} client{clients.length !== 1 ? 's' : ''}
          </p>
        )}
      </div>
    </>
  )
}
