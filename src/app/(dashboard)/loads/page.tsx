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
import { AddressAutocompleteInput } from '@/components/ui/AddressAutocompleteInput'
import {
  Plus, Search, MapPin, Loader2, Package, Truck, DollarSign, Percent,
  AlertTriangle, ChevronRight, Download, Ban,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { logAudit } from '@/lib/audit'
import { useRole } from '@/lib/role-context'
import { downloadCSV } from '@/lib/csv'
import { useSort, type SortAccessors } from '@/lib/use-sort'
import {
  LOAD_STATUSES, LOAD_STATUS_LABELS, LOAD_STATUS_COLORS, OPEN_LOAD_STATUSES,
  EQUIPMENT_TYPES, LOAD_SOURCE_LABELS, computeFee, describeFeePlan,
  num, money, money2, shortDate, lane,
} from '@/lib/dispatch'
import type { Load, LoadStatus, Client, Broker } from '@/types'

// ── Sorting ──────────────────────────────────────────────────────────────────
type LoadSortKey =
  | 'load_number' | 'client' | 'broker' | 'pickup' | 'delivery' | 'equipment'
  | 'driver' | 'status' | 'gross' | 'fee' | 'net'

const LOAD_SORT: SortAccessors<Load, LoadSortKey> = {
  load_number: l => l.load_number ?? '',
  client:      l => l.client_name ?? '',
  broker:      l => l.broker_name ?? '',
  pickup:      l => l.pickup_date ?? '',
  delivery:    l => l.delivery_date ?? '',
  equipment:   l => l.equipment_type ?? '',
  // Loads with no driver sort last within a direction, but still group together.
  driver:      l => l.driver_name ?? (l.driver_id ? 'zzz' : ''),
  status:      l => l.status,
  gross:       l => l.gross_total,
  fee:         l => l.dispatch_fee,
  net:         l => l.net_to_client,
}

// ── Book Load Sheet ──────────────────────────────────────────────────────────
const BLANK = {
  client_id: '', broker_id: '', broker_load_number: '', source: 'broker_direct',
  shipper_name: '', shipper_address: '', pickup_city: '', pickup_state: '', pickup_zip: '',
  pickup_date: '', pickup_time: '', pickup_appt: '',
  consignee_name: '', consignee_address: '', delivery_city: '', delivery_state: '', delivery_zip: '',
  delivery_date: '', delivery_time: '', delivery_appt: '',
  commodity: '', weight: '', temperature: '', equipment_type: 'Dry Van', miles: '',
  line_haul: '', fuel_surcharge: '', accessorials: '', detention: '', lumper: '', other_charges: '',
  ref_number: '', po_number: '', bol_number: '',
  notes: '',
}

function BookLoadSheet({ onCreated }: { onCreated: () => void }) {
  const { canOverrideFee } = useRole()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [clients, setClients] = useState<Client[]>([])
  const [brokers, setBrokers] = useState<Broker[]>([])
  const [form, setForm] = useState({ ...BLANK })

  // Fee override — starts off the selected client's plan, editable only with
  // canOverrideFee. Whatever is here gets SNAPSHOTTED onto the load.
  const [feeOverride, setFeeOverride] = useState<{
    fee_type: 'percent' | 'flat'; fee_percent: string; fee_flat: string
    fee_basis: 'gross' | 'linehaul'; fee_minimum: string; fee_waived: boolean; fee_waived_reason: string
  } | null>(null)

  const set = <K extends keyof typeof BLANK>(k: K, v: (typeof BLANK)[K]) =>
    setForm(f => ({ ...f, [k]: v }))

  useEffect(() => {
    if (!open) return
    const supabase = createClient()
    ;(async () => {
      const [{ data: c }, { data: b }] = await Promise.all([
        supabase.from('clients').select('*').is('deleted_at', null)
          .in('status', ['active', 'onboarding']).order('legal_name'),
        supabase.from('brokers').select('*').order('name'),
      ])
      setClients((c ?? []) as Client[])
      setBrokers((b ?? []) as Broker[])
    })()
  }, [open])

  const client = useMemo(() => clients.find(c => c.id === form.client_id) ?? null, [clients, form.client_id])
  const broker = useMemo(() => brokers.find(b => b.id === form.broker_id) ?? null, [brokers, form.broker_id])

  // Reset the fee override whenever the client changes — a new client means a new
  // plan, and carrying the last one over would silently misprice the load.
  useEffect(() => {
    if (!client) { setFeeOverride(null); return }
    setFeeOverride({
      fee_type: client.fee_type,
      fee_percent: String(client.fee_percent ?? 0),
      fee_flat: String(client.fee_flat ?? 0),
      fee_basis: client.fee_basis,
      fee_minimum: String(client.fee_minimum ?? 0),
      fee_waived: false,
      fee_waived_reason: '',
    })
  }, [client])

  const preview = useMemo(() => computeFee({
    line_haul: form.line_haul,
    fuel_surcharge: form.fuel_surcharge,
    accessorials: form.accessorials,
    detention: form.detention,
    lumper: form.lumper,
    other_charges: form.other_charges,
    fee_type: feeOverride?.fee_type ?? 'percent',
    fee_percent: feeOverride?.fee_percent ?? 0,
    fee_flat: feeOverride?.fee_flat ?? 0,
    fee_basis: feeOverride?.fee_basis ?? 'gross',
    fee_minimum: feeOverride?.fee_minimum ?? 0,
    fee_waived: feeOverride?.fee_waived ?? false,
  }), [form, feeOverride])

  // Guardrails a dispatcher should see BEFORE committing, not after.
  const warnings = useMemo(() => {
    const out: string[] = []
    if (broker?.do_not_use) out.push(`${broker.name} is flagged DO NOT USE${broker.do_not_use_reason ? ` — ${broker.do_not_use_reason}` : ''}.`)
    if (broker && broker.packet_status !== 'complete') out.push(`Setup packet with ${broker.name} isn’t complete — the invoice may bounce.`)
    if (client?.authority_status === 'inactive' || client?.authority_status === 'not_authorized') {
      out.push(`${client.dba_name || client.legal_name} does not show active operating authority.`)
    }
    if (client && !client.agreement_signed_at) out.push('No signed dispatch agreement on file for this client.')
    if (client?.insurance_expiry) {
      const days = Math.round((new Date(`${client.insurance_expiry}T00:00:00`).getTime() - Date.now()) / 86_400_000)
      if (days < 0) out.push('This client’s certificate of insurance has EXPIRED.')
      else if (days <= 14) out.push(`This client’s COI expires in ${days} day${days === 1 ? '' : 's'}.`)
    }
    if (client?.min_rate_per_mile && num(form.miles) > 0) {
      const rpm = preview.gross / num(form.miles)
      if (rpm < client.min_rate_per_mile) {
        out.push(`$${rpm.toFixed(2)}/mi is below this client’s $${client.min_rate_per_mile.toFixed(2)}/mi floor.`)
      }
    }
    if (client?.equipment_types?.length && form.equipment_type
        && !client.equipment_types.includes(form.equipment_type)) {
      out.push(`${client.dba_name || client.legal_name} doesn’t list ${form.equipment_type} equipment.`)
    }
    return out
  }, [broker, client, form.miles, form.equipment_type, preview.gross])

  const [ack, setAck] = useState(false)
  useEffect(() => { setAck(false) }, [warnings.length])

  const reset = () => { setForm({ ...BLANK }); setFeeOverride(null); setError(''); setAck(false) }

  const handleSubmit = async () => {
    if (!form.client_id) { setError('Pick the client carrier this load is for.'); return }
    if (!form.pickup_city || !form.pickup_state || !form.delivery_city || !form.delivery_state) {
      setError('Enter a pickup and delivery city/state so the lane is defined.'); return
    }
    setSaving(true); setError('')
    const supabase = createClient()

    // A load with a broker and a rate is committed work → booked. Without either
    // it's still just something we're chasing → sourced.
    const status: LoadStatus = (form.broker_id && num(form.line_haul) > 0) ? 'booked' : 'sourced'

    // NOTE: do NOT set load_number, gross_total, dispatch_fee, or net_to_client —
    // the DB assigns the number and recalc_load_money() owns the math.
    const payload = {
      status,
      client_id: form.client_id,
      client_name: client ? (client.dba_name || client.legal_name) : null,
      broker_id: form.broker_id || null,
      broker_name: broker?.name ?? null,
      broker_load_number: form.broker_load_number.trim() || null,
      source: form.source,
      shipper_name: form.shipper_name.trim() || null,
      shipper_address: form.shipper_address.trim() || null,
      pickup_city: form.pickup_city.trim() || null,
      pickup_state: form.pickup_state.toUpperCase().slice(0, 2) || null,
      pickup_zip: form.pickup_zip.trim() || null,
      pickup_date: form.pickup_date || null,
      pickup_time: form.pickup_time.trim() || null,
      pickup_appt: form.pickup_appt.trim() || null,
      consignee_name: form.consignee_name.trim() || null,
      consignee_address: form.consignee_address.trim() || null,
      delivery_city: form.delivery_city.trim() || null,
      delivery_state: form.delivery_state.toUpperCase().slice(0, 2) || null,
      delivery_zip: form.delivery_zip.trim() || null,
      delivery_date: form.delivery_date || null,
      delivery_time: form.delivery_time.trim() || null,
      delivery_appt: form.delivery_appt.trim() || null,
      commodity: form.commodity.trim() || null,
      weight: form.weight ? num(form.weight) : null,
      temperature: form.temperature.trim() || null,
      equipment_type: form.equipment_type || null,
      miles: form.miles ? num(form.miles) : null,
      line_haul: num(form.line_haul),
      fuel_surcharge: num(form.fuel_surcharge),
      accessorials: num(form.accessorials),
      detention: num(form.detention),
      lumper: num(form.lumper),
      other_charges: num(form.other_charges),
      // Fee terms snapshotted from the client (or the override).
      fee_type: feeOverride?.fee_type ?? client?.fee_type ?? 'percent',
      fee_percent: num(feeOverride?.fee_percent ?? client?.fee_percent ?? 0),
      fee_flat: num(feeOverride?.fee_flat ?? client?.fee_flat ?? 0),
      fee_basis: feeOverride?.fee_basis ?? client?.fee_basis ?? 'gross',
      fee_minimum: num(feeOverride?.fee_minimum ?? client?.fee_minimum ?? 0),
      fee_waived: feeOverride?.fee_waived ?? false,
      fee_waived_reason: feeOverride?.fee_waived ? (feeOverride.fee_waived_reason.trim() || null) : null,
      ref_number: form.ref_number.trim() || null,
      po_number: form.po_number.trim() || null,
      bol_number: form.bol_number.trim() || null,
      notes: form.notes.trim() || null,
      booked_at: status === 'booked' ? new Date().toISOString() : null,
    }

    const { data: created, error: err } = await supabase
      .from('loads').insert(payload).select('id, load_number, dispatch_fee, net_to_client').single()

    setSaving(false)
    if (err) { setError(err.message); return }

    void logAudit('load.create', {
      table_name: 'loads',
      record_id: created?.id,
      new_value: {
        load_number: created?.load_number,
        status,
        client: payload.client_name,
        broker: payload.broker_name,
        lane: `${form.pickup_city}, ${form.pickup_state} → ${form.delivery_city}, ${form.delivery_state}`,
        gross: preview.gross,
        dispatch_fee: created?.dispatch_fee,
        fee_waived: payload.fee_waived,
      },
    })

    setOpen(false)
    reset()
    onCreated()
  }

  return (
    <>
      <Button className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />Book Load
      </Button>

      <Sheet open={open} onOpenChange={o => { setOpen(o); if (!o) reset() }}>
        {open && (
          <SheetContent side="right" className="!w-[75vw] !max-w-[900px] flex flex-col gap-0 p-0">
            <SheetHeader className="px-6 py-4 border-b dark:border-gray-800">
              <SheetTitle className="text-lg font-semibold">Book a Load</SheetTitle>
              <SheetDescription>
                Freight sourced for a client carrier. The gross is theirs — we take the dispatch fee.
              </SheetDescription>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
              {/* Parties */}
              <section className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Parties</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Client carrier *</Label>
                    <Select value={form.client_id || null} onValueChange={v => set('client_id', v ?? '')}>
                      <SelectTrigger className="mt-1 h-9 w-full">
                        <SelectValue placeholder={clients.length ? 'Who are we dispatching?' : 'No active clients yet'} />
                      </SelectTrigger>
                      <SelectContent>
                        {clients.map(c => (
                          <SelectItem key={c.id} value={c.id}>{c.dba_name || c.legal_name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {client && (
                      <p className="mt-1 text-[11px] text-gray-400">
                        Plan: {describeFeePlan(client)}
                        {client.equipment_types?.length ? ` · runs ${client.equipment_types.join(', ')}` : ''}
                      </p>
                    )}
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Broker</Label>
                    <Select value={form.broker_id || null} onValueChange={v => set('broker_id', (v && v !== '__none') ? v : '')}>
                      <SelectTrigger className="mt-1 h-9 w-full">
                        <SelectValue placeholder={brokers.length ? 'Who pays the freight bill?' : 'No brokers yet'} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none">Not confirmed yet</SelectItem>
                        {brokers.map(b => (
                          <SelectItem key={b.id} value={b.id}>
                            {b.do_not_use ? `⚠ ${b.name}` : b.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Broker load #</Label>
                    <Input className="mt-1 h-9" value={form.broker_load_number} onChange={e => set('broker_load_number', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Source</Label>
                    <Select value={form.source} onValueChange={v => set('source', v ?? 'broker_direct')}>
                      <SelectTrigger className="mt-1 h-9 w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(LOAD_SOURCE_LABELS).map(([k, v]) => (
                          <SelectItem key={k} value={k}>{v}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {warnings.length > 0 && (
                  <div className="rounded-lg border border-amber-300 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-2 text-xs">
                    <div className="flex items-center gap-2 font-semibold text-amber-800 dark:text-amber-300">
                      <AlertTriangle className="h-4 w-4" />Before you book
                    </div>
                    <ul className="list-disc pl-5 space-y-0.5 text-amber-800 dark:text-amber-300">
                      {warnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                    <label className="flex items-center gap-2 text-amber-900 dark:text-amber-200 cursor-pointer">
                      <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />
                      Book anyway — I&apos;ve reviewed these.
                    </label>
                  </div>
                )}
              </section>

              {/* Lane */}
              <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
                    <MapPin className="h-3.5 w-3.5 text-indigo-500" />Pickup
                  </p>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Shipper</Label>
                    <Input className="mt-1 h-9" value={form.shipper_name} onChange={e => set('shipper_name', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Address</Label>
                    <AddressAutocompleteInput
                      className="mt-1"
                      value={form.shipper_address}
                      onChange={v => set('shipper_address', v)}
                      onPlaceSelect={p => setForm(f => ({ ...f, shipper_address: p.address, pickup_city: p.city, pickup_state: p.state }))}
                      placeholder="Pickup address"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2">
                      <Label className="text-xs text-gray-500 dark:text-gray-400">City</Label>
                      <Input className="mt-1 h-9" value={form.pickup_city} onChange={e => set('pickup_city', e.target.value)} />
                    </div>
                    <div>
                      <Label className="text-xs text-gray-500 dark:text-gray-400">State</Label>
                      <Input className="mt-1 h-9" maxLength={2} value={form.pickup_state} onChange={e => set('pickup_state', e.target.value.toUpperCase())} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs text-gray-500 dark:text-gray-400">Date</Label>
                      <Input className="mt-1 h-9" type="date" value={form.pickup_date} onChange={e => set('pickup_date', e.target.value)} />
                    </div>
                    <div>
                      <Label className="text-xs text-gray-500 dark:text-gray-400">Time / window</Label>
                      <Input className="mt-1 h-9" value={form.pickup_time} onChange={e => set('pickup_time', e.target.value)} placeholder="08:00-14:00" />
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
                    <MapPin className="h-3.5 w-3.5 text-green-500" />Delivery
                  </p>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Consignee</Label>
                    <Input className="mt-1 h-9" value={form.consignee_name} onChange={e => set('consignee_name', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Address</Label>
                    <AddressAutocompleteInput
                      className="mt-1"
                      value={form.consignee_address}
                      onChange={v => set('consignee_address', v)}
                      onPlaceSelect={p => setForm(f => ({ ...f, consignee_address: p.address, delivery_city: p.city, delivery_state: p.state }))}
                      placeholder="Delivery address"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2">
                      <Label className="text-xs text-gray-500 dark:text-gray-400">City</Label>
                      <Input className="mt-1 h-9" value={form.delivery_city} onChange={e => set('delivery_city', e.target.value)} />
                    </div>
                    <div>
                      <Label className="text-xs text-gray-500 dark:text-gray-400">State</Label>
                      <Input className="mt-1 h-9" maxLength={2} value={form.delivery_state} onChange={e => set('delivery_state', e.target.value.toUpperCase())} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs text-gray-500 dark:text-gray-400">Date</Label>
                      <Input className="mt-1 h-9" type="date" value={form.delivery_date} onChange={e => set('delivery_date', e.target.value)} />
                    </div>
                    <div>
                      <Label className="text-xs text-gray-500 dark:text-gray-400">Time / window</Label>
                      <Input className="mt-1 h-9" value={form.delivery_time} onChange={e => set('delivery_time', e.target.value)} />
                    </div>
                  </div>
                </div>
              </section>

              {/* Freight */}
              <section className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Freight</p>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Equipment</Label>
                    <Select value={form.equipment_type} onValueChange={v => set('equipment_type', v ?? 'Dry Van')}>
                      <SelectTrigger className="mt-1 h-9 w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {EQUIPMENT_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Temp</Label>
                    <Input className="mt-1 h-9" value={form.temperature} onChange={e => set('temperature', e.target.value)} placeholder="34°F" />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Weight (lbs)</Label>
                    <Input className="mt-1 h-9" type="number" value={form.weight} onChange={e => set('weight', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Miles</Label>
                    <Input className="mt-1 h-9" type="number" value={form.miles} onChange={e => set('miles', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Commodity</Label>
                    <Input className="mt-1 h-9" value={form.commodity} onChange={e => set('commodity', e.target.value)} />
                  </div>
                </div>
              </section>

              {/* Money */}
              <section className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  What the broker pays
                </p>
                <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1"><DollarSign className="h-3 w-3" />Linehaul</Label>
                    <Input className="mt-1 h-9" type="number" value={form.line_haul} onChange={e => set('line_haul', e.target.value)} placeholder="0.00" />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Fuel</Label>
                    <Input className="mt-1 h-9" type="number" value={form.fuel_surcharge} onChange={e => set('fuel_surcharge', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Accessorials</Label>
                    <Input className="mt-1 h-9" type="number" value={form.accessorials} onChange={e => set('accessorials', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Detention</Label>
                    <Input className="mt-1 h-9" type="number" value={form.detention} onChange={e => set('detention', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Lumper</Label>
                    <Input className="mt-1 h-9" type="number" value={form.lumper} onChange={e => set('lumper', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Other</Label>
                    <Input className="mt-1 h-9" type="number" value={form.other_charges} onChange={e => set('other_charges', e.target.value)} />
                  </div>
                </div>

                {/* Fee plan override */}
                {feeOverride && (
                  <div className="rounded-lg border dark:border-gray-800 p-3 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold text-gray-600 dark:text-gray-300 flex items-center gap-1.5">
                        <Percent className="h-3.5 w-3.5 text-indigo-500" />Dispatch fee terms for this load
                      </p>
                      {!canOverrideFee && (
                        <span className="text-[11px] text-gray-400">Locked to the client&apos;s plan</span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div>
                        <Label className="text-xs text-gray-500 dark:text-gray-400">Type</Label>
                        <Select
                          value={feeOverride.fee_type}
                          onValueChange={v => setFeeOverride(f => f && ({ ...f, fee_type: (v ?? 'percent') as 'percent' | 'flat' }))}
                        >
                          <SelectTrigger className="mt-1 h-9 w-full" disabled={!canOverrideFee}><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="percent">Percent</SelectItem>
                            <SelectItem value="flat">Flat</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {feeOverride.fee_type === 'percent' ? (
                        <>
                          <div>
                            <Label className="text-xs text-gray-500 dark:text-gray-400">Fee %</Label>
                            <Input className="mt-1 h-9" type="number" step="0.1" disabled={!canOverrideFee}
                              value={feeOverride.fee_percent}
                              onChange={e => setFeeOverride(f => f && ({ ...f, fee_percent: e.target.value }))} />
                          </div>
                          <div>
                            <Label className="text-xs text-gray-500 dark:text-gray-400">Basis</Label>
                            <Select
                              value={feeOverride.fee_basis}
                              onValueChange={v => setFeeOverride(f => f && ({ ...f, fee_basis: (v ?? 'gross') as 'gross' | 'linehaul' }))}
                            >
                              <SelectTrigger className="mt-1 h-9 w-full" disabled={!canOverrideFee}><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="gross">Gross</SelectItem>
                                <SelectItem value="linehaul">Linehaul only</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </>
                      ) : (
                        <div className="md:col-span-2">
                          <Label className="text-xs text-gray-500 dark:text-gray-400">Flat fee ($)</Label>
                          <Input className="mt-1 h-9" type="number" disabled={!canOverrideFee}
                            value={feeOverride.fee_flat}
                            onChange={e => setFeeOverride(f => f && ({ ...f, fee_flat: e.target.value }))} />
                        </div>
                      )}
                      <div>
                        <Label className="text-xs text-gray-500 dark:text-gray-400">Minimum ($)</Label>
                        <Input className="mt-1 h-9" type="number" disabled={!canOverrideFee}
                          value={feeOverride.fee_minimum}
                          onChange={e => setFeeOverride(f => f && ({ ...f, fee_minimum: e.target.value }))} />
                      </div>
                    </div>
                    {canOverrideFee && (
                      <div className="space-y-2">
                        <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
                          <input type="checkbox" checked={feeOverride.fee_waived}
                            onChange={e => setFeeOverride(f => f && ({ ...f, fee_waived: e.target.checked }))} />
                          Waive the dispatch fee on this load
                        </label>
                        {feeOverride.fee_waived && (
                          <Input className="h-9" placeholder="Why is the fee waived? (goes on the statement)"
                            value={feeOverride.fee_waived_reason}
                            onChange={e => setFeeOverride(f => f && ({ ...f, fee_waived_reason: e.target.value }))} />
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Live money preview */}
                <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-indigo-200 dark:border-indigo-900/60 bg-indigo-50/70 dark:bg-indigo-950/30 px-4 py-3">
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Gross (broker pays)</div>
                    <div className="font-semibold text-gray-900 dark:text-white">{money2(preview.gross)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Avantra fee</div>
                    <div className="font-semibold text-indigo-700 dark:text-indigo-400">
                      {money2(preview.fee)}
                      {preview.gross > 0 && <span className="ml-1 text-xs font-normal">({preview.effectivePct.toFixed(1)}%)</span>}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 flex items-center justify-end gap-1">
                      <Truck className="h-3 w-3" />Net to client
                    </div>
                    <div className="text-lg font-bold text-emerald-700 dark:text-emerald-400">{money2(preview.net)}</div>
                    {num(form.miles) > 0 && (
                      <div className="text-[11px] text-gray-400">
                        ${(preview.net / num(form.miles)).toFixed(2)}/mi net · ${(preview.gross / num(form.miles)).toFixed(2)}/mi gross
                      </div>
                    )}
                  </div>
                </div>
              </section>

              {/* References */}
              <section className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">References</p>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Ref #</Label>
                    <Input className="mt-1 h-9" value={form.ref_number} onChange={e => set('ref_number', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">PO #</Label>
                    <Input className="mt-1 h-9" value={form.po_number} onChange={e => set('po_number', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">BOL #</Label>
                    <Input className="mt-1 h-9" value={form.bol_number} onChange={e => set('bol_number', e.target.value)} />
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Notes</Label>
                  <Textarea className="mt-1" rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} />
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
              <Button
                className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white"
                disabled={saving || (warnings.length > 0 && !ack)}
                onClick={handleSubmit}
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {saving ? 'Saving…' : 'Book Load'}
              </Button>
            </div>
          </SheetContent>
        )}
      </Sheet>
    </>
  )
}

// ── Loads list page ──────────────────────────────────────────────────────────
export default function LoadsPage() {
  const router = useRouter()
  const { canModify } = useRole()
  const [loads, setLoads] = useState<Load[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const { data } = await supabase
      .from('loads').select('*').is('deleted_at', null)
      .order('created_at', { ascending: false }).limit(500)
    setLoads((data ?? []) as Load[])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return loads.filter(l => {
      if (statusFilter === 'open') {
        if (!OPEN_LOAD_STATUSES.includes(l.status)) return false
      } else if (statusFilter === 'needs_driver') {
        if (l.driver_id || !['booked', 'sourced', 'offered'].includes(l.status)) return false
      } else if (statusFilter === 'needs_invoice') {
        if (!['delivered', 'docs_received'].includes(l.status)) return false
      } else if (statusFilter !== 'all' && l.status !== statusFilter) {
        return false
      }
      if (!q) return true
      const hay = [
        l.load_number, l.client_name, l.broker_name, l.broker_load_number, l.driver_name,
        l.shipper_name, l.consignee_name, l.pickup_city, l.pickup_state,
        l.delivery_city, l.delivery_state, l.commodity, l.ref_number, l.po_number, l.bol_number,
      ].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [loads, statusFilter, search])

  const { sorted, sort, toggle } = useSort<Load, LoadSortKey>(filtered, LOAD_SORT)

  const exportCsv = () => downloadCSV(
    `loads-${new Date().toISOString().slice(0, 10)}.csv`,
    ['Load #', 'Status', 'Client', 'Broker', 'Broker Load #', 'Driver',
     'Pickup City', 'Pickup State', 'Pickup Date', 'Delivery City', 'Delivery State', 'Delivery Date',
     'Equipment', 'Commodity', 'Weight', 'Miles',
     'Linehaul', 'Fuel', 'Accessorials', 'Detention', 'Lumper', 'Other',
     'Gross', 'Dispatch Fee', 'Net to Client'],
    sorted.map(l => [
      l.load_number ?? '', LOAD_STATUS_LABELS[l.status], l.client_name ?? '', l.broker_name ?? '',
      l.broker_load_number ?? '', l.driver_name ?? '',
      l.pickup_city ?? '', l.pickup_state ?? '', l.pickup_date ?? '',
      l.delivery_city ?? '', l.delivery_state ?? '', l.delivery_date ?? '',
      l.equipment_type ?? '', l.commodity ?? '', l.weight ?? '', l.miles ?? '',
      l.line_haul, l.fuel_surcharge, l.accessorials, l.detention, l.lumper, l.other_charges,
      l.gross_total, l.dispatch_fee, l.net_to_client,
    ]),
  )

  // KPIs come from the full non-deleted set, not the filtered view.
  const stats = useMemo(() => {
    const open = loads.filter(l => OPEN_LOAD_STATUSES.includes(l.status))
    const needsDriver = loads.filter(l => !l.driver_id && ['booked', 'sourced', 'offered'].includes(l.status)).length
    const needsInvoice = loads.filter(l => ['delivered', 'docs_received'].includes(l.status)).length
    const openFees = open.reduce((s, l) => s + (l.dispatch_fee ?? 0), 0)
    return { open: open.length, needsDriver, needsInvoice, openFees }
  }, [loads])

  const tile = (
    key: string, value: string | number, label: string,
    icon: React.ReactNode, ring: string, bg: string,
  ) => (
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
      <Header title="Loads" subtitle="Freight sourced and dispatched for client carriers" />
      <div className="p-6 space-y-6">

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {tile('open', stats.open, 'Open loads',
            <Package className="h-5 w-5" />, 'ring-indigo-500', 'bg-indigo-100 dark:bg-indigo-950 text-indigo-600')}
          {tile('needs_driver', stats.needsDriver, 'Need a driver',
            <Truck className="h-5 w-5" />, 'ring-amber-500', 'bg-amber-100 dark:bg-amber-950 text-amber-600')}
          {tile('needs_invoice', stats.needsInvoice, 'Ready to invoice',
            <DollarSign className="h-5 w-5" />, 'ring-teal-500', 'bg-teal-100 dark:bg-teal-950 text-teal-600')}
          <Card>
            <CardContent className="flex items-center gap-3 py-4">
              <div className="p-2 rounded-lg bg-emerald-100 dark:bg-emerald-950 text-emerald-600"><Percent className="h-5 w-5" /></div>
              <div>
                <div className="text-2xl font-bold text-gray-900 dark:text-white">{money(stats.openFees)}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">Fees on open loads</div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input placeholder="Search load #, client, broker, lane…" className="pl-9 h-9" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <Select value={statusFilter} onValueChange={v => setStatusFilter(v ?? 'all')}>
            <SelectTrigger className="h-9 w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="open">Open (live)</SelectItem>
              <SelectItem value="needs_driver">Needs a driver</SelectItem>
              <SelectItem value="needs_invoice">Ready to invoice</SelectItem>
              {LOAD_STATUSES.map(s => <SelectItem key={s} value={s}>{LOAD_STATUS_LABELS[s]}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" className="gap-2 h-9" onClick={exportCsv} disabled={filtered.length === 0}>
              <Download className="h-4 w-4" />Export
            </Button>
            {canModify && <BookLoadSheet onCreated={load} />}
          </div>
        </div>

        <Card>
          <CardContent className="p-0">
            {loading ? (
              <div className="flex items-center justify-center py-20 text-gray-400">
                <Loader2 className="h-6 w-6 animate-spin mr-2" />Loading loads…
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
                <div className="p-3 rounded-full bg-indigo-50 dark:bg-indigo-950 text-indigo-500"><Package className="h-7 w-7" /></div>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
                  {loads.length === 0 ? 'No loads yet' : 'No loads match your filters'}
                </p>
                <p className="text-xs text-gray-400 max-w-xs">
                  {loads.length === 0
                    ? 'Book the first load for one of your client carriers.'
                    : 'Try clearing the search or status filter.'}
                </p>
                {loads.length === 0 && canModify && <div className="mt-1"><BookLoadSheet onCreated={load} /></div>}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortableTh label="Load #"   k="load_number" sort={sort} toggle={toggle} />
                      <SortableTh label="Client"   k="client"      sort={sort} toggle={toggle} />
                      <SortableTh label="Broker"   k="broker"      sort={sort} toggle={toggle} />
                      <TableHead>Lane</TableHead>
                      <SortableTh label="PU"       k="pickup"      sort={sort} toggle={toggle} />
                      <SortableTh label="DEL"      k="delivery"    sort={sort} toggle={toggle} />
                      <SortableTh label="Driver"   k="driver"      sort={sort} toggle={toggle} />
                      <SortableTh label="Status"   k="status"      sort={sort} toggle={toggle} />
                      <SortableTh label="Gross"    k="gross"       sort={sort} toggle={toggle} align="right" />
                      <SortableTh label="Fee"      k="fee"         sort={sort} toggle={toggle} align="right" />
                      <SortableTh label="Net"      k="net"         sort={sort} toggle={toggle} align="right" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sorted.map(l => {
                      const { from, to } = lane(l)
                      const pct = l.gross_total > 0 ? (l.dispatch_fee / l.gross_total) * 100 : 0
                      return (
                        <TableRow key={l.id} className="cursor-pointer" onClick={() => router.push(`/loads/${l.id}`)}>
                          <TableCell className="font-medium text-indigo-700 dark:text-indigo-400 whitespace-nowrap">
                            {l.load_number || '—'}
                          </TableCell>
                          <TableCell className="max-w-[160px] truncate">{l.client_name || <span className="text-gray-400">—</span>}</TableCell>
                          <TableCell className="max-w-[150px] truncate text-sm text-gray-600 dark:text-gray-300">
                            {l.broker_name || <span className="text-gray-400">—</span>}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-sm">
                            <span className="text-gray-700 dark:text-gray-200">{from}</span>
                            <ChevronRight className="inline h-3.5 w-3.5 mx-0.5 text-gray-400" />
                            <span className="text-gray-700 dark:text-gray-200">{to}</span>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-sm text-gray-600 dark:text-gray-300 tabular-nums">{shortDate(l.pickup_date)}</TableCell>
                          <TableCell className="whitespace-nowrap text-sm text-gray-600 dark:text-gray-300 tabular-nums">{shortDate(l.delivery_date)}</TableCell>
                          <TableCell className="max-w-[140px] truncate">
                            {l.driver_id
                              ? (l.driver_name || <span className="text-gray-400">assigned</span>)
                              : <Badge className="border bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800/50">No driver</Badge>}
                          </TableCell>
                          <TableCell>
                            <Badge className={`border ${LOAD_STATUS_COLORS[l.status]}`}>{LOAD_STATUS_LABELS[l.status]}</Badge>
                          </TableCell>
                          <TableCell className="text-right whitespace-nowrap tabular-nums">{money(l.gross_total)}</TableCell>
                          <TableCell className="text-right whitespace-nowrap tabular-nums font-semibold text-indigo-700 dark:text-indigo-400">
                            {l.fee_waived
                              ? <span className="inline-flex items-center gap-1 text-gray-400 font-normal"><Ban className="h-3 w-3" />waived</span>
                              : <>{money(l.dispatch_fee)}{l.gross_total > 0 && <span className="ml-1 text-xs font-normal">{pct.toFixed(0)}%</span>}</>}
                          </TableCell>
                          <TableCell className="text-right whitespace-nowrap tabular-nums text-emerald-700 dark:text-emerald-400">
                            {money(l.net_to_client)}
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
          <p className="text-xs text-gray-400">{filtered.length} of {loads.length} load{loads.length !== 1 ? 's' : ''}</p>
        )}
      </div>
    </>
  )
}
