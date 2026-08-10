'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Header from '@/components/layout/Header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet'
import { DocumentsPanel } from '@/components/DocumentsPanel'
import {
  ArrowLeft, Loader2, MapPin, ChevronRight, ChevronsRight, Truck, Phone,
  DollarSign, Percent, AlertTriangle, Save, Link2, Copy, Trash2, Ban,
  CalendarDays, Building2, FileText, Plus,
} from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { logAudit } from '@/lib/audit'
import { useRole } from '@/lib/role-context'
import {
  LOAD_STATUSES, LOAD_STATUS_LABELS, LOAD_STATUS_COLORS, NEXT_STATUS,
  ADVANCE_LABELS, statusPatch, computeFee, money2, longDate, dateTime, lane, num,
  LOAD_SOURCE_LABELS,
} from '@/lib/dispatch'
import type {
  Load, LoadStatus, Client, ClientDriver, ClientEquipment, CheckCall, Broker,
} from '@/types'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">{label}</span>
      <span className="text-sm text-gray-800 dark:text-gray-100 text-right min-w-0">{children}</span>
    </div>
  )
}

// ── Check-call composer ──────────────────────────────────────────────────────
function CheckCallForm({ loadId, onLogged }: { loadId: string; onLogged: () => void }) {
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    city: '', state: '', status_note: '', eta: '', temperature: '', notes: '', is_public: true,
  })
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm(f => ({ ...f, [k]: v }))

  const submit = async () => {
    if (!form.city && !form.status_note) {
      toast.error('Log at least a location or a status note.')
      return
    }
    setSaving(true)
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('load_check_calls').insert({
      load_id: loadId,
      city: form.city.trim() || null,
      state: form.state.toUpperCase().slice(0, 2) || null,
      location: [form.city.trim(), form.state.toUpperCase()].filter(Boolean).join(', ') || null,
      status_note: form.status_note.trim() || null,
      eta: form.eta ? new Date(form.eta).toISOString() : null,
      temperature: form.temperature.trim() || null,
      notes: form.notes.trim() || null,
      is_public: form.is_public,
      created_by: user?.id ?? null,
    })
    setSaving(false)
    if (error) { toast.error(error.message); return }
    setForm({ city: '', state: '', status_note: '', eta: '', temperature: '', notes: '', is_public: true })
    toast.success('Check call logged')
    onLogged()
  }

  return (
    <div className="rounded-lg border dark:border-gray-800 p-3 space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="col-span-2 md:col-span-1">
          <Label className="text-xs text-gray-500 dark:text-gray-400">City</Label>
          <Input className="mt-1 h-8 text-sm" value={form.city} onChange={e => set('city', e.target.value)} />
        </div>
        <div>
          <Label className="text-xs text-gray-500 dark:text-gray-400">State</Label>
          <Input className="mt-1 h-8 text-sm" maxLength={2} value={form.state} onChange={e => set('state', e.target.value.toUpperCase())} />
        </div>
        <div>
          <Label className="text-xs text-gray-500 dark:text-gray-400">ETA</Label>
          <Input className="mt-1 h-8 text-sm" type="datetime-local" value={form.eta} onChange={e => set('eta', e.target.value)} />
        </div>
        <div>
          <Label className="text-xs text-gray-500 dark:text-gray-400">Temp</Label>
          <Input className="mt-1 h-8 text-sm" value={form.temperature} onChange={e => set('temperature', e.target.value)} placeholder="34°F" />
        </div>
      </div>
      <div>
        <Label className="text-xs text-gray-500 dark:text-gray-400">Status</Label>
        <Input className="mt-1 h-8 text-sm" value={form.status_note} onChange={e => set('status_note', e.target.value)} placeholder="Loaded, rolling · At receiver door 12 · Waiting on lumper" />
      </div>
      <div>
        <Label className="text-xs text-gray-500 dark:text-gray-400">Internal note (never shown publicly)</Label>
        <Textarea className="mt-1 text-sm" rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} />
      </div>
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
          <input type="checkbox" checked={form.is_public} onChange={e => set('is_public', e.target.checked)} />
          Show on the public tracking page
        </label>
        <Button size="sm" className="h-8 gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white" disabled={saving} onClick={submit}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Phone className="h-3.5 w-3.5" />}
          Log check call
        </Button>
      </div>
    </div>
  )
}

// ── Money editor ─────────────────────────────────────────────────────────────
function MoneySheet({ load, onSaved }: { load: Load; onSaved: () => void }) {
  const { canOverrideFee } = useRole()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [f, setF] = useState({
    line_haul: '', fuel_surcharge: '', accessorials: '', detention: '', lumper: '', other_charges: '',
    fee_type: 'percent' as 'percent' | 'flat', fee_percent: '', fee_flat: '',
    fee_basis: 'gross' as 'gross' | 'linehaul', fee_minimum: '',
    fee_waived: false, fee_waived_reason: '',
  })

  useEffect(() => {
    if (!open) return
    setF({
      line_haul: String(load.line_haul ?? 0),
      fuel_surcharge: String(load.fuel_surcharge ?? 0),
      accessorials: String(load.accessorials ?? 0),
      detention: String(load.detention ?? 0),
      lumper: String(load.lumper ?? 0),
      other_charges: String(load.other_charges ?? 0),
      fee_type: load.fee_type,
      fee_percent: String(load.fee_percent ?? 0),
      fee_flat: String(load.fee_flat ?? 0),
      fee_basis: load.fee_basis,
      fee_minimum: String(load.fee_minimum ?? 0),
      fee_waived: load.fee_waived,
      fee_waived_reason: load.fee_waived_reason ?? '',
    })
  }, [open, load])

  const preview = useMemo(() => computeFee({ ...f, status: load.status }), [f, load.status])

  const save = async () => {
    setSaving(true)
    const supabase = createClient()
    // gross_total / dispatch_fee / net_to_client are trigger-owned — never sent.
    const patch: Record<string, unknown> = {
      line_haul: num(f.line_haul),
      fuel_surcharge: num(f.fuel_surcharge),
      accessorials: num(f.accessorials),
      detention: num(f.detention),
      lumper: num(f.lumper),
      other_charges: num(f.other_charges),
    }
    if (canOverrideFee) {
      patch.fee_type = f.fee_type
      patch.fee_percent = num(f.fee_percent)
      patch.fee_flat = num(f.fee_flat)
      patch.fee_basis = f.fee_basis
      patch.fee_minimum = num(f.fee_minimum)
      patch.fee_waived = f.fee_waived
      patch.fee_waived_reason = f.fee_waived ? (f.fee_waived_reason.trim() || null) : null
    }
    const { error } = await supabase.from('loads').update(patch).eq('id', load.id)
    setSaving(false)
    if (error) { toast.error(error.message); return }
    void logAudit('load.money_update', {
      table_name: 'loads', record_id: load.id,
      old_value: { gross: load.gross_total, fee: load.dispatch_fee },
      new_value: { gross: preview.gross, fee: preview.fee, fee_waived: f.fee_waived },
    })
    toast.success('Rates updated')
    setOpen(false)
    onSaved()
  }

  return (
    <>
      <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setOpen(true)}>
        <DollarSign className="h-3.5 w-3.5" />Edit rates
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        {open && (
          <SheetContent side="right" className="!w-[75vw] !max-w-[900px] flex flex-col gap-0 p-0">
            <SheetHeader className="px-6 py-4 border-b dark:border-gray-800">
              <SheetTitle className="text-lg font-semibold">Rates on {load.load_number}</SheetTitle>
              <SheetDescription>
                What the broker pays goes to the client. Avantra keeps the dispatch fee.
              </SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
              <section className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Broker charges</p>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {([
                    ['line_haul', 'Linehaul'], ['fuel_surcharge', 'Fuel'], ['accessorials', 'Accessorials'],
                    ['detention', 'Detention'], ['lumper', 'Lumper'], ['other_charges', 'Other'],
                  ] as const).map(([k, label]) => (
                    <div key={k}>
                      <Label className="text-xs text-gray-500 dark:text-gray-400">{label}</Label>
                      <Input className="mt-1 h-9" type="number" value={f[k]}
                        onChange={e => setF(s => ({ ...s, [k]: e.target.value }))} />
                    </div>
                  ))}
                </div>
              </section>

              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Dispatch fee</p>
                  {!canOverrideFee && <span className="text-[11px] text-gray-400">Locked — needs fee-override permission</span>}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Type</Label>
                    <Select value={f.fee_type} onValueChange={v => setF(s => ({ ...s, fee_type: (v ?? 'percent') as 'percent' | 'flat' }))}>
                      <SelectTrigger className="mt-1 h-9 w-full" disabled={!canOverrideFee}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="percent">Percent</SelectItem>
                        <SelectItem value="flat">Flat</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {f.fee_type === 'percent' ? (
                    <>
                      <div>
                        <Label className="text-xs text-gray-500 dark:text-gray-400">Fee %</Label>
                        <Input className="mt-1 h-9" type="number" step="0.1" disabled={!canOverrideFee}
                          value={f.fee_percent} onChange={e => setF(s => ({ ...s, fee_percent: e.target.value }))} />
                      </div>
                      <div>
                        <Label className="text-xs text-gray-500 dark:text-gray-400">Basis</Label>
                        <Select value={f.fee_basis} onValueChange={v => setF(s => ({ ...s, fee_basis: (v ?? 'gross') as 'gross' | 'linehaul' }))}>
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
                        value={f.fee_flat} onChange={e => setF(s => ({ ...s, fee_flat: e.target.value }))} />
                    </div>
                  )}
                  <div>
                    <Label className="text-xs text-gray-500 dark:text-gray-400">Minimum ($)</Label>
                    <Input className="mt-1 h-9" type="number" disabled={!canOverrideFee}
                      value={f.fee_minimum} onChange={e => setF(s => ({ ...s, fee_minimum: e.target.value }))} />
                  </div>
                </div>
                {canOverrideFee && (
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
                      <input type="checkbox" checked={f.fee_waived} onChange={e => setF(s => ({ ...s, fee_waived: e.target.checked }))} />
                      Waive the dispatch fee on this load
                    </label>
                    {f.fee_waived && (
                      <Input className="h-9" placeholder="Reason (appears on the client's statement)"
                        value={f.fee_waived_reason} onChange={e => setF(s => ({ ...s, fee_waived_reason: e.target.value }))} />
                    )}
                  </div>
                )}
              </section>

              <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-indigo-200 dark:border-indigo-900/60 bg-indigo-50/70 dark:bg-indigo-950/30 px-4 py-3">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Gross</div>
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
                  <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Net to client</div>
                  <div className="text-lg font-bold text-emerald-700 dark:text-emerald-400">{money2(preview.net)}</div>
                </div>
              </div>
            </div>
            <div className="border-t dark:border-gray-800 px-6 py-4 flex items-center justify-end gap-3">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white" disabled={saving} onClick={save}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Save rates
              </Button>
            </div>
          </SheetContent>
        )}
      </Sheet>
    </>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function LoadDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { canModify, canDispatch, canDeleteLoads } = useRole()

  const [load, setLoad] = useState<Load | null>(null)
  const [client, setClient] = useState<Client | null>(null)
  const [broker, setBroker] = useState<Broker | null>(null)
  const [drivers, setDrivers] = useState<ClientDriver[]>([])
  const [equipment, setEquipment] = useState<ClientEquipment[]>([])
  const [calls, setCalls] = useState<CheckCall[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const fetchAll = useCallback(async () => {
    const supabase = createClient()
    const { data: l } = await supabase.from('loads').select('*').eq('id', id).maybeSingle()
    if (!l) { setLoading(false); return }
    const row = l as Load
    setLoad(row)

    const [{ data: c }, { data: b }, { data: cc }] = await Promise.all([
      row.client_id
        ? supabase.from('clients').select('*').eq('id', row.client_id).maybeSingle()
        : Promise.resolve({ data: null }),
      row.broker_id
        ? supabase.from('brokers').select('*').eq('id', row.broker_id).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.from('load_check_calls').select('*').eq('load_id', id).order('occurred_at', { ascending: false }),
    ])
    setClient((c as Client) ?? null)
    setBroker((b as Broker) ?? null)
    setCalls((cc ?? []) as CheckCall[])

    if (row.client_id) {
      const [{ data: d }, { data: e }] = await Promise.all([
        supabase.from('client_drivers').select('*').eq('client_id', row.client_id).eq('status', 'active').order('full_name'),
        supabase.from('client_equipment').select('*').eq('client_id', row.client_id).eq('status', 'active').order('unit_number'),
      ])
      setDrivers((d ?? []) as ClientDriver[])
      setEquipment((e ?? []) as ClientEquipment[])
    }
    setLoading(false)
  }, [id])

  useEffect(() => { fetchAll() }, [fetchAll])

  const patchLoad = async (patch: Record<string, unknown>, auditAction: string, extra?: Record<string, unknown>) => {
    if (!load) return
    setBusy(true)
    const supabase = createClient()
    const { error } = await supabase.from('loads').update(patch).eq('id', load.id)
    setBusy(false)
    if (error) { toast.error(error.message); return }
    void logAudit(auditAction, {
      table_name: 'loads', record_id: load.id,
      new_value: { load_number: load.load_number, ...patch, ...extra },
    })
    fetchAll()
  }

  const changeStatus = async (to: LoadStatus) => {
    if (!load) return
    if (to === 'dispatched' && !load.driver_id) {
      toast.error('Assign a driver before dispatching.')
      return
    }
    await patchLoad(statusPatch(to), 'load.status_change', { from: load.status })
    toast.success(`Status → ${LOAD_STATUS_LABELS[to]}`)
  }

  const assign = async (driverId: string | null, truckId: string | null, trailerId: string | null) => {
    const driver = drivers.find(d => d.id === driverId) ?? null
    await patchLoad({
      driver_id: driverId, driver_name: driver?.full_name ?? null,
      truck_id: truckId, trailer_id: trailerId,
    }, 'load.assign')
    toast.success(driver ? `Assigned to ${driver.full_name}` : 'Assignment cleared')
  }

  const softDelete = async () => {
    if (!load) return
    if (!confirm(`Delete ${load.load_number}? It will be hidden from all lists.`)) return
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('loads')
      .update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null })
      .eq('id', load.id)
    if (error) { toast.error(error.message); return }
    void logAudit('load.delete', {
      table_name: 'loads', record_id: load.id,
      old_value: { load_number: load.load_number, status: load.status, gross: load.gross_total },
    })
    toast.success(`${load.load_number} deleted`)
    router.push('/loads')
  }

  const trackUrl = useMemo(() => {
    if (!load) return ''
    const base = process.env.NEXT_PUBLIC_TRACK_BASE_URL
      || process.env.NEXT_PUBLIC_APP_URL
      || (typeof window !== 'undefined' ? window.location.origin : '')
    return `${base}/track/${load.tracking_token}`
  }, [load])

  if (loading) {
    return (
      <>
        <Header title="Load" subtitle="Loading…" />
        <div className="flex items-center justify-center py-24 text-gray-400">
          <Loader2 className="h-6 w-6 animate-spin mr-2" />Loading load…
        </div>
      </>
    )
  }

  if (!load) {
    return (
      <>
        <Header title="Load not found" subtitle="It may have been deleted" />
        <div className="p-6">
          <Button variant="outline" className="gap-2" onClick={() => router.push('/loads')}>
            <ArrowLeft className="h-4 w-4" />Back to loads
          </Button>
        </div>
      </>
    )
  }

  const { from, to } = lane(load)
  const next = NEXT_STATUS[load.status]
  const pct = load.gross_total > 0 ? (load.dispatch_fee / load.gross_total) * 100 : 0

  return (
    <>
      <Header title={load.load_number} subtitle={`${from} → ${to}`} />
      <div className="p-6 space-y-6">

        {/* Action bar */}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => router.push('/loads')}>
            <ArrowLeft className="h-3.5 w-3.5" />Loads
          </Button>
          <Badge className={`border ${LOAD_STATUS_COLORS[load.status]}`}>{LOAD_STATUS_LABELS[load.status]}</Badge>

          {canDispatch && next && (
            <Button size="sm" className="h-8 gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-700 text-white"
              disabled={busy} onClick={() => changeStatus(next)}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronsRight className="h-3.5 w-3.5" />}
              {ADVANCE_LABELS[load.status] ?? 'Advance'}
            </Button>
          )}

          {canModify && (
            <Select value={load.status} onValueChange={v => v && changeStatus(v as LoadStatus)}>
              <SelectTrigger className="h-8 w-40 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {LOAD_STATUSES.map(s => <SelectItem key={s} value={s}>{LOAD_STATUS_LABELS[s]}</SelectItem>)}
              </SelectContent>
            </Select>
          )}

          <div className="ml-auto flex items-center gap-2">
            {canModify && <MoneySheet load={load} onSaved={fetchAll} />}
            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs"
              onClick={() => { navigator.clipboard.writeText(trackUrl); toast.success('Tracking link copied') }}>
              <Copy className="h-3.5 w-3.5" />Tracking link
            </Button>
            {canDeleteLoads && (
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs text-red-600 hover:text-red-700" onClick={softDelete}>
                <Trash2 className="h-3.5 w-3.5" />Delete
              </Button>
            )}
          </div>
        </div>

        {/* Money strip */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card>
            <CardContent className="py-4">
              <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Gross — broker pays</div>
              <div className="text-2xl font-bold text-gray-900 dark:text-white">{money2(load.gross_total)}</div>
              <div className="text-[11px] text-gray-400 mt-0.5">
                {load.miles ? `${load.miles.toLocaleString()} mi · $${(load.gross_total / load.miles).toFixed(2)}/mi` : 'No mileage entered'}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 flex items-center gap-1">
                <Percent className="h-3 w-3" />Avantra fee
              </div>
              <div className="text-2xl font-bold text-indigo-700 dark:text-indigo-400">
                {load.fee_waived ? <span className="text-gray-400 text-lg inline-flex items-center gap-1"><Ban className="h-4 w-4" />Waived</span> : money2(load.dispatch_fee)}
              </div>
              <div className="text-[11px] text-gray-400 mt-0.5">
                {load.fee_waived
                  ? (load.fee_waived_reason || 'No reason recorded')
                  : `${pct.toFixed(1)}% effective · ${load.fee_type === 'flat' ? 'flat' : `${load.fee_percent}% of ${load.fee_basis}`}`}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 flex items-center gap-1">
                <Truck className="h-3 w-3" />Net to client
              </div>
              <div className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">{money2(load.net_to_client)}</div>
              <div className="text-[11px] text-gray-400 mt-0.5">
                {load.miles ? `$${(load.net_to_client / load.miles).toFixed(2)}/mi net` : '—'}
              </div>
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="assignment">Assignment</TabsTrigger>
            <TabsTrigger value="tracking">Check Calls ({calls.length})</TabsTrigger>
            <TabsTrigger value="documents">Documents</TabsTrigger>
          </TabsList>

          {/* Overview */}
          <TabsContent value="overview">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card>
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><MapPin className="h-4 w-4 text-indigo-500" />Pickup</CardTitle></CardHeader>
                <CardContent className="divide-y dark:divide-gray-800">
                  <Row label="Shipper">{load.shipper_name || '—'}</Row>
                  <Row label="Address">{load.shipper_address || '—'}</Row>
                  <Row label="City / State">{from}</Row>
                  <Row label="Date">{longDate(load.pickup_date)}{load.pickup_time ? ` · ${load.pickup_time}` : ''}</Row>
                  <Row label="Appointment">{load.pickup_appt || '—'}</Row>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><MapPin className="h-4 w-4 text-green-500" />Delivery</CardTitle></CardHeader>
                <CardContent className="divide-y dark:divide-gray-800">
                  <Row label="Consignee">{load.consignee_name || '—'}</Row>
                  <Row label="Address">{load.consignee_address || '—'}</Row>
                  <Row label="City / State">{to}</Row>
                  <Row label="Date">{longDate(load.delivery_date)}{load.delivery_time ? ` · ${load.delivery_time}` : ''}</Row>
                  <Row label="Appointment">{load.delivery_appt || '—'}</Row>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><Building2 className="h-4 w-4" />Parties</CardTitle></CardHeader>
                <CardContent className="divide-y dark:divide-gray-800">
                  <Row label="Client carrier">
                    {client
                      ? <button className="text-indigo-600 dark:text-indigo-400 hover:underline" onClick={() => router.push(`/clients/${client.id}`)}>
                          {client.dba_name || client.legal_name}
                        </button>
                      : '—'}
                  </Row>
                  <Row label="Broker">
                    <span className="inline-flex items-center gap-1.5">
                      {broker?.do_not_use && <Ban className="h-3.5 w-3.5 text-red-500" />}
                      {load.broker_name || '—'}
                    </span>
                  </Row>
                  <Row label="Broker load #">{load.broker_load_number || '—'}</Row>
                  <Row label="Source">{LOAD_SOURCE_LABELS[load.source] ?? load.source}</Row>
                  {broker && (
                    <Row label="Broker terms">
                      {broker.payment_terms || '—'}
                      {broker.days_to_pay ? ` · pays in ~${broker.days_to_pay}d` : ''}
                    </Row>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><FileText className="h-4 w-4" />Freight &amp; references</CardTitle></CardHeader>
                <CardContent className="divide-y dark:divide-gray-800">
                  <Row label="Equipment">{load.equipment_type || '—'}{load.temperature ? ` · ${load.temperature}` : ''}</Row>
                  <Row label="Commodity">{load.commodity || '—'}</Row>
                  <Row label="Weight">{load.weight ? `${load.weight.toLocaleString()} lbs` : '—'}</Row>
                  <Row label="Miles">{load.miles ? load.miles.toLocaleString() : '—'}</Row>
                  <Row label="Ref / PO / BOL">
                    {[load.ref_number, load.po_number, load.bol_number].filter(Boolean).join(' · ') || '—'}
                  </Row>
                  <Row label="Notes">{load.notes || '—'}</Row>
                </CardContent>
              </Card>

              <Card className="lg:col-span-2">
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><CalendarDays className="h-4 w-4" />Timeline</CardTitle></CardHeader>
                <CardContent className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 text-sm">
                  {([
                    ['Created', load.created_at], ['Offered', load.offered_at], ['Booked', load.booked_at],
                    ['Dispatched', load.dispatched_at], ['Picked up', load.picked_up_at], ['Delivered', load.delivered_at],
                  ] as const).map(([label, val]) => (
                    <div key={label}>
                      <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</div>
                      <div className={val ? 'text-gray-800 dark:text-gray-100' : 'text-gray-300 dark:text-gray-600'}>
                        {val ? dateTime(val) : '—'}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Assignment */}
          <TabsContent value="assignment">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2"><Truck className="h-4 w-4" />Driver &amp; equipment</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {!client ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    This load has no client carrier, so there&apos;s nobody to assign. Set a client first.
                  </p>
                ) : drivers.length === 0 && equipment.length === 0 ? (
                  <div className="text-sm text-gray-500 dark:text-gray-400 space-y-2">
                    <p>{client.dba_name || client.legal_name} has no active drivers or equipment on file.</p>
                    <Button variant="outline" size="sm" className="gap-1.5" onClick={() => router.push(`/clients/${client.id}`)}>
                      <Plus className="h-3.5 w-3.5" />Add them on the client
                    </Button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <Label className="text-xs text-gray-500 dark:text-gray-400">Driver</Label>
                      <Select
                        value={load.driver_id ?? null}
                        onValueChange={v => assign((v && v !== '__none') ? v : null, load.truck_id, load.trailer_id)}
                      >
                        <SelectTrigger className="mt-1 h-9 w-full" disabled={!canDispatch}>
                          <SelectValue placeholder="Unassigned" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none">Unassigned</SelectItem>
                          {drivers.map(d => <SelectItem key={d.id} value={d.id}>{d.full_name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs text-gray-500 dark:text-gray-400">Truck</Label>
                      <Select
                        value={load.truck_id ?? null}
                        onValueChange={v => assign(load.driver_id, (v && v !== '__none') ? v : null, load.trailer_id)}
                      >
                        <SelectTrigger className="mt-1 h-9 w-full" disabled={!canDispatch}>
                          <SelectValue placeholder="None" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none">None</SelectItem>
                          {equipment.filter(e => e.kind === 'truck').map(e => (
                            <SelectItem key={e.id} value={e.id}>
                              {e.unit_number || `${e.year ?? ''} ${e.make ?? ''} ${e.model ?? ''}`.trim() || 'Truck'}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs text-gray-500 dark:text-gray-400">Trailer</Label>
                      <Select
                        value={load.trailer_id ?? null}
                        onValueChange={v => assign(load.driver_id, load.truck_id, (v && v !== '__none') ? v : null)}
                      >
                        <SelectTrigger className="mt-1 h-9 w-full" disabled={!canDispatch}>
                          <SelectValue placeholder="None" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none">None</SelectItem>
                          {equipment.filter(e => e.kind === 'trailer').map(e => (
                            <SelectItem key={e.id} value={e.id}>
                              {e.unit_number || e.equipment_type || 'Trailer'}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}

                {load.driver_id && (() => {
                  const d = drivers.find(x => x.id === load.driver_id)
                  if (!d) return null
                  return (
                    <div className="rounded-lg border dark:border-gray-800 p-3 text-sm space-y-1">
                      <div className="font-medium text-gray-900 dark:text-white">{d.full_name}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {[d.phone, d.email].filter(Boolean).join(' · ') || 'No contact on file'}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        CDL {d.cdl_number || '—'}{d.cdl_state ? ` (${d.cdl_state})` : ''}
                        {d.cdl_expiry ? ` · expires ${longDate(d.cdl_expiry)}` : ''}
                      </div>
                    </div>
                  )
                })()}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Check calls */}
          <TabsContent value="tracking">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2"><Phone className="h-4 w-4" />Check calls</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-2 rounded-lg border dark:border-gray-800 px-3 py-2 text-xs">
                  <Link2 className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                  <code className="flex-1 truncate text-gray-600 dark:text-gray-300">{trackUrl}</code>
                  <button
                    className="text-indigo-600 dark:text-indigo-400 hover:underline shrink-0"
                    onClick={() => { navigator.clipboard.writeText(trackUrl); toast.success('Copied') }}
                  >Copy</button>
                </div>

                {canModify && <CheckCallForm loadId={load.id} onLogged={fetchAll} />}

                {calls.length === 0 ? (
                  <p className="text-xs text-gray-400 py-6 text-center border border-dashed dark:border-gray-800 rounded-lg">
                    No check calls logged yet.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {calls.map(c => (
                      <li key={c.id} className="rounded-lg border dark:border-gray-800 px-3 py-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm text-gray-900 dark:text-white">
                              {c.status_note || c.location || 'Check call'}
                            </div>
                            <div className="text-[11px] text-gray-400">
                              {dateTime(c.occurred_at)}
                              {c.location ? ` · ${c.location}` : ''}
                              {c.temperature ? ` · ${c.temperature}` : ''}
                              {c.eta ? ` · ETA ${dateTime(c.eta)}` : ''}
                            </div>
                            {c.notes && (
                              <div className="mt-1 text-xs text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-white/5 rounded px-2 py-1">
                                {c.notes}
                              </div>
                            )}
                          </div>
                          {!c.is_public && (
                            <Badge className="border shrink-0 bg-gray-100 text-gray-700 border-gray-200 dark:bg-white/10 dark:text-gray-300 dark:border-white/10">
                              Internal
                            </Badge>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Documents */}
          <TabsContent value="documents">
            <Card>
              <CardContent className="py-5">
                <DocumentsPanel
                  entityType="load"
                  entityId={load.id}
                  clientId={load.client_id}
                  canModify={canModify}
                  title="Load paperwork"
                />
                <p className="mt-3 text-[11px] text-gray-400 flex items-start gap-1.5">
                  <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                  Rate con, BOL, and POD live here. The invoice packet pulls from these — collecting
                  them is what lets the back office bill the broker.
                </p>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </>
  )
}
