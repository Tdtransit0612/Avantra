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
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table'
import { DocumentsPanel } from '@/components/DocumentsPanel'
import {
  ArrowLeft, Loader2, Plus, Truck, User, ShieldCheck, CheckCircle2, Circle,
  AlertTriangle, Percent, Save, Trash2, MessageSquarePlus, Package, ChevronRight,
} from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { logAudit } from '@/lib/audit'
import { useRole } from '@/lib/role-context'
import {
  CLIENT_STATUSES, CLIENT_STATUS_LABELS, CLIENT_STATUS_COLORS,
  COMPLIANCE_KINDS, COMPLIANCE_KIND_LABEL, COMPLIANCE_STATUS_LABELS, COMPLIANCE_STATUS_COLORS,
  LOAD_STATUS_LABELS, LOAD_STATUS_COLORS, EQUIPMENT_TYPES,
  describeFeePlan, money, longDate, dateTime, shortDate, lane, daysUntil, num,
} from '@/lib/dispatch'
import type {
  Client, ClientDriver, ClientEquipment, OnboardingStep, ComplianceItem,
  ClientNote, Load, ClientStatus, FactoringCompany,
} from '@/types'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">{label}</span>
      <span className="text-sm text-gray-800 dark:text-gray-100 text-right min-w-0">{children}</span>
    </div>
  )
}

// ── Driver sheet ─────────────────────────────────────────────────────────────
const DRIVER_BLANK = {
  full_name: '', phone: '', email: '', cdl_number: '', cdl_state: '',
  cdl_expiry: '', medical_expiry: '', hazmat_endorsed: false, is_owner: false,
}

function DriverSheet({ clientId, existing, onSaved, trigger }: {
  clientId: string
  existing?: ClientDriver
  onSaved: () => void
  trigger: (open: () => void) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [f, setF] = useState({ ...DRIVER_BLANK })

  useEffect(() => {
    if (!open) return
    setError('')
    setF(existing ? {
      full_name: existing.full_name, phone: existing.phone ?? '', email: existing.email ?? '',
      cdl_number: existing.cdl_number ?? '', cdl_state: existing.cdl_state ?? '',
      cdl_expiry: existing.cdl_expiry ?? '', medical_expiry: existing.medical_expiry ?? '',
      hazmat_endorsed: existing.hazmat_endorsed, is_owner: existing.is_owner,
    } : { ...DRIVER_BLANK })
  }, [open, existing])

  const save = async () => {
    if (!f.full_name.trim()) { setError('Driver name is required.'); return }
    setSaving(true); setError('')
    const supabase = createClient()
    const payload = {
      client_id: clientId,
      full_name: f.full_name.trim(),
      phone: f.phone.trim() || null,
      email: f.email.trim() || null,
      cdl_number: f.cdl_number.trim() || null,
      cdl_state: f.cdl_state.toUpperCase().slice(0, 2) || null,
      cdl_expiry: f.cdl_expiry || null,
      medical_expiry: f.medical_expiry || null,
      hazmat_endorsed: f.hazmat_endorsed,
      is_owner: f.is_owner,
    }
    const res = existing
      ? await supabase.from('client_drivers').update(payload).eq('id', existing.id).select('id').single()
      : await supabase.from('client_drivers').insert(payload).select('id').single()
    setSaving(false)
    if (res.error) { setError(res.error.message); return }
    void logAudit(existing ? 'client_driver.update' : 'client_driver.create', {
      table_name: 'client_drivers', record_id: res.data?.id,
      new_value: { client_id: clientId, full_name: payload.full_name },
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
              <SheetTitle className="text-lg font-semibold">{existing ? 'Edit Driver' : 'Add a Driver'}</SheetTitle>
              <SheetDescription>Drivers belong to the client carrier — we dispatch them, we don&apos;t employ them.</SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Full name *</Label>
                  <Input className="mt-1 h-9" value={f.full_name} onChange={e => setF(s => ({ ...s, full_name: e.target.value }))} />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Phone</Label>
                  <Input className="mt-1 h-9" value={f.phone} onChange={e => setF(s => ({ ...s, phone: e.target.value }))} />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Email</Label>
                  <Input className="mt-1 h-9" type="email" value={f.email} onChange={e => setF(s => ({ ...s, email: e.target.value }))} />
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">CDL #</Label>
                  <Input className="mt-1 h-9" value={f.cdl_number} onChange={e => setF(s => ({ ...s, cdl_number: e.target.value }))} />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">CDL state</Label>
                  <Input className="mt-1 h-9" maxLength={2} value={f.cdl_state} onChange={e => setF(s => ({ ...s, cdl_state: e.target.value.toUpperCase() }))} />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">CDL expires</Label>
                  <Input className="mt-1 h-9" type="date" value={f.cdl_expiry} onChange={e => setF(s => ({ ...s, cdl_expiry: e.target.value }))} />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Medical expires</Label>
                  <Input className="mt-1 h-9" type="date" value={f.medical_expiry} onChange={e => setF(s => ({ ...s, medical_expiry: e.target.value }))} />
                </div>
              </div>
              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200 cursor-pointer">
                  <input type="checkbox" checked={f.hazmat_endorsed} onChange={e => setF(s => ({ ...s, hazmat_endorsed: e.target.checked }))} />
                  Hazmat endorsed
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200 cursor-pointer">
                  <input type="checkbox" checked={f.is_owner} onChange={e => setF(s => ({ ...s, is_owner: e.target.checked }))} />
                  Owner-operator (drives their own truck)
                </label>
              </div>
              {error && (
                <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 rounded-lg px-4 py-2.5">
                  <AlertTriangle className="h-4 w-4 shrink-0" />{error}
                </div>
              )}
            </div>
            <div className="border-t dark:border-gray-800 px-6 py-4 flex items-center justify-end gap-3">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white" disabled={saving} onClick={save}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Save driver
              </Button>
            </div>
          </SheetContent>
        )}
      </Sheet>
    </>
  )
}

// ── Equipment sheet ──────────────────────────────────────────────────────────
const EQUIP_BLANK = {
  kind: 'truck' as 'truck' | 'trailer',
  unit_number: '', equipment_type: '', year: '', make: '', model: '',
  vin: '', plate: '', plate_state: '', length_ft: '',
}

function EquipmentSheet({ clientId, existing, onSaved, trigger }: {
  clientId: string
  existing?: ClientEquipment
  onSaved: () => void
  trigger: (open: () => void) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [f, setF] = useState({ ...EQUIP_BLANK })

  useEffect(() => {
    if (!open) return
    setError('')
    setF(existing ? {
      kind: existing.kind,
      unit_number: existing.unit_number ?? '',
      equipment_type: existing.equipment_type ?? '',
      year: existing.year?.toString() ?? '',
      make: existing.make ?? '', model: existing.model ?? '',
      vin: existing.vin ?? '', plate: existing.plate ?? '',
      plate_state: existing.plate_state ?? '',
      length_ft: existing.length_ft?.toString() ?? '',
    } : { ...EQUIP_BLANK })
  }, [open, existing])

  const save = async () => {
    if (!f.unit_number.trim() && !f.vin.trim()) {
      setError('Give at least a unit number or a VIN so it can be identified.')
      return
    }
    setSaving(true); setError('')
    const supabase = createClient()
    const payload = {
      client_id: clientId,
      kind: f.kind,
      unit_number: f.unit_number.trim() || null,
      equipment_type: f.equipment_type || null,
      year: f.year ? Math.round(num(f.year)) : null,
      make: f.make.trim() || null,
      model: f.model.trim() || null,
      vin: f.vin.trim() || null,
      plate: f.plate.trim() || null,
      plate_state: f.plate_state.toUpperCase().slice(0, 2) || null,
      length_ft: f.length_ft ? Math.round(num(f.length_ft)) : null,
    }
    const res = existing
      ? await supabase.from('client_equipment').update(payload).eq('id', existing.id).select('id').single()
      : await supabase.from('client_equipment').insert(payload).select('id').single()
    setSaving(false)
    if (res.error) { setError(res.error.message); return }
    void logAudit(existing ? 'client_equipment.update' : 'client_equipment.create', {
      table_name: 'client_equipment', record_id: res.data?.id,
      new_value: { client_id: clientId, kind: payload.kind, unit_number: payload.unit_number },
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
              <SheetTitle className="text-lg font-semibold">{existing ? 'Edit Equipment' : 'Add Equipment'}</SheetTitle>
              <SheetDescription>Trucks and trailers the client runs, so loads can be assigned to real units.</SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Type</Label>
                  <Select value={f.kind} onValueChange={v => setF(s => ({ ...s, kind: (v ?? 'truck') as 'truck' | 'trailer' }))}>
                    <SelectTrigger className="mt-1 h-9 w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="truck">Truck</SelectItem>
                      <SelectItem value="trailer">Trailer</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Unit #</Label>
                  <Input className="mt-1 h-9" value={f.unit_number} onChange={e => setF(s => ({ ...s, unit_number: e.target.value }))} />
                </div>
                {f.kind === 'trailer' && (
                  <>
                    <div>
                      <Label className="text-xs text-gray-500 dark:text-gray-400">Equipment type</Label>
                      <Select value={f.equipment_type || null} onValueChange={v => setF(s => ({ ...s, equipment_type: v ?? '' }))}>
                        <SelectTrigger className="mt-1 h-9 w-full"><SelectValue placeholder="Select" /></SelectTrigger>
                        <SelectContent>
                          {EQUIPMENT_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs text-gray-500 dark:text-gray-400">Length (ft)</Label>
                      <Input className="mt-1 h-9" type="number" value={f.length_ft} onChange={e => setF(s => ({ ...s, length_ft: e.target.value }))} />
                    </div>
                  </>
                )}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Year</Label>
                  <Input className="mt-1 h-9" type="number" value={f.year} onChange={e => setF(s => ({ ...s, year: e.target.value }))} />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Make</Label>
                  <Input className="mt-1 h-9" value={f.make} onChange={e => setF(s => ({ ...s, make: e.target.value }))} />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Model</Label>
                  <Input className="mt-1 h-9" value={f.model} onChange={e => setF(s => ({ ...s, model: e.target.value }))} />
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">VIN</Label>
                  <Input className="mt-1 h-9" value={f.vin} onChange={e => setF(s => ({ ...s, vin: e.target.value }))} />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Plate</Label>
                  <Input className="mt-1 h-9" value={f.plate} onChange={e => setF(s => ({ ...s, plate: e.target.value }))} />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Plate state</Label>
                  <Input className="mt-1 h-9" maxLength={2} value={f.plate_state} onChange={e => setF(s => ({ ...s, plate_state: e.target.value.toUpperCase() }))} />
                </div>
              </div>
              {error && (
                <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 rounded-lg px-4 py-2.5">
                  <AlertTriangle className="h-4 w-4 shrink-0" />{error}
                </div>
              )}
            </div>
            <div className="border-t dark:border-gray-800 px-6 py-4 flex items-center justify-end gap-3">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white" disabled={saving} onClick={save}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Save equipment
              </Button>
            </div>
          </SheetContent>
        )}
      </Sheet>
    </>
  )
}

// ── Compliance item sheet ────────────────────────────────────────────────────
function ComplianceSheet({ clientId, existing, onSaved, trigger }: {
  clientId: string
  existing?: ComplianceItem
  onSaved: () => void
  trigger: (open: () => void) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [f, setF] = useState({
    kind: 'authority', provider: '', reference: '', amount: '',
    effective_date: '', expiry_date: '', notes: '',
  })

  useEffect(() => {
    if (!open) return
    setError('')
    setF(existing ? {
      kind: existing.kind, provider: existing.provider ?? '', reference: existing.reference ?? '',
      amount: existing.amount?.toString() ?? '',
      effective_date: existing.effective_date ?? '', expiry_date: existing.expiry_date ?? '',
      notes: existing.notes ?? '',
    } : {
      kind: 'authority', provider: '', reference: '', amount: '',
      effective_date: '', expiry_date: '', notes: '',
    })
  }, [open, existing])

  const save = async () => {
    setSaving(true); setError('')
    const supabase = createClient()
    // status is derived by the derive_compliance_status() trigger — never sent.
    const payload = {
      client_id: clientId,
      entity_type: 'client',
      kind: f.kind,
      provider: f.provider.trim() || null,
      reference: f.reference.trim() || null,
      amount: f.amount ? num(f.amount) : null,
      effective_date: f.effective_date || null,
      expiry_date: f.expiry_date || null,
      notes: f.notes.trim() || null,
      last_checked_at: new Date().toISOString(),
    }
    const res = existing
      ? await supabase.from('compliance_items').update(payload).eq('id', existing.id).select('id').single()
      // The unique index makes a repeat kind an upsert rather than a duplicate.
      : await supabase.from('compliance_items')
          .upsert(payload, { onConflict: 'client_id,entity_type,entity_id,kind' })
          .select('id').single()
    setSaving(false)
    if (res.error) { setError(res.error.message); return }
    void logAudit(existing ? 'compliance.update' : 'compliance.create', {
      table_name: 'compliance_items', record_id: res.data?.id,
      new_value: { client_id: clientId, kind: payload.kind, expiry_date: payload.expiry_date },
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
              <SheetTitle className="text-lg font-semibold">{existing ? 'Edit Compliance Item' : 'Track a Compliance Item'}</SheetTitle>
              <SheetDescription>Status is derived from the expiry date automatically.</SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Item</Label>
                  <Select value={f.kind} onValueChange={v => setF(s => ({ ...s, kind: v ?? 'authority' }))}>
                    <SelectTrigger className="mt-1 h-9 w-full" disabled={!!existing}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {COMPLIANCE_KINDS.filter(k => k.entity === 'client').map(k => (
                        <SelectItem key={k.kind} value={k.kind}>{k.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Provider / filer</Label>
                  <Input className="mt-1 h-9" value={f.provider} onChange={e => setF(s => ({ ...s, provider: e.target.value }))} />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Reference / policy #</Label>
                  <Input className="mt-1 h-9" value={f.reference} onChange={e => setF(s => ({ ...s, reference: e.target.value }))} />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Coverage amount ($)</Label>
                  <Input className="mt-1 h-9" type="number" value={f.amount} onChange={e => setF(s => ({ ...s, amount: e.target.value }))} />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Effective</Label>
                  <Input className="mt-1 h-9" type="date" value={f.effective_date} onChange={e => setF(s => ({ ...s, effective_date: e.target.value }))} />
                </div>
                <div>
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Expires</Label>
                  <Input className="mt-1 h-9" type="date" value={f.expiry_date} onChange={e => setF(s => ({ ...s, expiry_date: e.target.value }))} />
                </div>
              </div>
              <div>
                <Label className="text-xs text-gray-500 dark:text-gray-400">Notes</Label>
                <Textarea className="mt-1" rows={3} value={f.notes} onChange={e => setF(s => ({ ...s, notes: e.target.value }))} />
              </div>
              {error && (
                <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 rounded-lg px-4 py-2.5">
                  <AlertTriangle className="h-4 w-4 shrink-0" />{error}
                </div>
              )}
            </div>
            <div className="border-t dark:border-gray-800 px-6 py-4 flex items-center justify-end gap-3">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white" disabled={saving} onClick={save}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Save item
              </Button>
            </div>
          </SheetContent>
        )}
      </Sheet>
    </>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function ClientDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { canModify, canOnboardClient, canManageCompliance } = useRole()

  const [client, setClient] = useState<Client | null>(null)
  const [factor, setFactor] = useState<FactoringCompany | null>(null)
  const [drivers, setDrivers] = useState<ClientDriver[]>([])
  const [equipment, setEquipment] = useState<ClientEquipment[]>([])
  const [steps, setSteps] = useState<OnboardingStep[]>([])
  const [compliance, setCompliance] = useState<ComplianceItem[]>([])
  const [notes, setNotes] = useState<ClientNote[]>([])
  const [loads, setLoads] = useState<Load[]>([])
  const [loading, setLoading] = useState(true)
  const [noteBody, setNoteBody] = useState('')

  const fetchAll = useCallback(async () => {
    const supabase = createClient()
    const { data: c } = await supabase.from('clients').select('*').eq('id', id).maybeSingle()
    if (!c) { setLoading(false); return }
    setClient(c as Client)

    const [{ data: d }, { data: e }, { data: s }, { data: comp }, { data: n }, { data: l }, { data: fc }] =
      await Promise.all([
        supabase.from('client_drivers').select('*').eq('client_id', id).order('full_name'),
        supabase.from('client_equipment').select('*').eq('client_id', id).order('kind').order('unit_number'),
        supabase.from('client_onboarding_steps').select('*').eq('client_id', id).order('sort_order'),
        supabase.from('compliance_items').select('*').eq('client_id', id).order('expiry_date', { nullsFirst: false }),
        supabase.from('client_notes').select('*').eq('client_id', id).order('created_at', { ascending: false }).limit(50),
        supabase.from('loads').select('*').eq('client_id', id).is('deleted_at', null)
          .order('created_at', { ascending: false }).limit(100),
        (c as Client).factoring_company_id
          ? supabase.from('factoring_companies').select('*').eq('id', (c as Client).factoring_company_id!).maybeSingle()
          : Promise.resolve({ data: null }),
      ])

    setDrivers((d ?? []) as ClientDriver[])
    setEquipment((e ?? []) as ClientEquipment[])
    setSteps((s ?? []) as OnboardingStep[])
    setCompliance((comp ?? []) as ComplianceItem[])
    setNotes((n ?? []) as ClientNote[])
    setLoads((l ?? []) as Load[])
    setFactor((fc as FactoringCompany) ?? null)
    setLoading(false)
  }, [id])

  useEffect(() => { fetchAll() }, [fetchAll])

  const setStatus = async (status: ClientStatus) => {
    if (!client) return
    const supabase = createClient()
    const patch: Record<string, unknown> = { status }
    if (status === 'active' && !client.onboarded_at) patch.onboarded_at = new Date().toISOString().slice(0, 10)
    if (status === 'terminated') patch.terminated_at = new Date().toISOString().slice(0, 10)
    const { error } = await supabase.from('clients').update(patch).eq('id', client.id)
    if (error) { toast.error(error.message); return }
    void logAudit('client.status_change', {
      table_name: 'clients', record_id: client.id,
      old_value: { status: client.status }, new_value: { status },
    })
    toast.success(`Status → ${CLIENT_STATUS_LABELS[status]}`)
    fetchAll()
  }

  const toggleStep = async (step: OnboardingStep) => {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const done = !!step.completed_at
    const { error } = await supabase.from('client_onboarding_steps').update({
      completed_at: done ? null : new Date().toISOString(),
      completed_by: done ? null : (user?.id ?? null),
    }).eq('id', step.id)
    if (error) { toast.error(error.message); return }
    void logAudit('client.onboarding_step', {
      table_name: 'client_onboarding_steps', record_id: step.id,
      new_value: { client_id: id, step_key: step.step_key, completed: !done },
    })
    fetchAll()
  }

  const addNote = async () => {
    if (!noteBody.trim()) return
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('client_notes').insert({
      client_id: id, body: noteBody.trim(), kind: 'note', created_by: user?.id ?? null,
    })
    if (error) { toast.error(error.message); return }
    setNoteBody('')
    fetchAll()
  }

  const removeRow = async (table: 'client_drivers' | 'client_equipment' | 'compliance_items', rowId: string, label: string) => {
    if (!confirm(`Delete ${label}?`)) return
    const supabase = createClient()
    const { error } = await supabase.from(table).delete().eq('id', rowId)
    if (error) { toast.error(error.message); return }
    void logAudit(`${table}.delete`, { table_name: table, record_id: rowId, old_value: { label } })
    toast.success('Deleted')
    fetchAll()
  }

  const onboardingProgress = useMemo(() => {
    const required = steps.filter(s => s.is_required)
    const done = required.filter(s => s.completed_at).length
    return { done, total: required.length, pct: required.length ? (done / required.length) * 100 : 0 }
  }, [steps])

  const loadStats = useMemo(() => {
    const settled = loads.filter(l => !['cancelled'].includes(l.status))
    return {
      count: settled.length,
      gross: settled.reduce((s, l) => s + (l.gross_total ?? 0), 0),
      fees: settled.reduce((s, l) => s + (l.dispatch_fee ?? 0), 0),
      net: settled.reduce((s, l) => s + (l.net_to_client ?? 0), 0),
    }
  }, [loads])

  if (loading) {
    return (
      <>
        <Header title="Client" subtitle="Loading…" />
        <div className="flex items-center justify-center py-24 text-gray-400">
          <Loader2 className="h-6 w-6 animate-spin mr-2" />Loading client…
        </div>
      </>
    )
  }

  if (!client) {
    return (
      <>
        <Header title="Client not found" subtitle="It may have been deleted" />
        <div className="p-6">
          <Button variant="outline" className="gap-2" onClick={() => router.push('/clients')}>
            <ArrowLeft className="h-4 w-4" />Back to clients
          </Button>
        </div>
      </>
    )
  }

  const coiDays = daysUntil(client.insurance_expiry)

  return (
    <>
      <Header title={client.dba_name || client.legal_name} subtitle={`${client.client_number} · ${describeFeePlan(client)}`} />
      <div className="p-6 space-y-6">

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => router.push('/clients')}>
            <ArrowLeft className="h-3.5 w-3.5" />Clients
          </Button>
          <Badge className={`border ${CLIENT_STATUS_COLORS[client.status]}`}>{CLIENT_STATUS_LABELS[client.status]}</Badge>
          {canOnboardClient && (
            <Select value={client.status} onValueChange={v => v && setStatus(v as ClientStatus)}>
              <SelectTrigger className="h-8 w-40 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CLIENT_STATUSES.map(s => <SelectItem key={s} value={s}>{CLIENT_STATUS_LABELS[s]}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* Stat strip */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card><CardContent className="py-4">
            <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Loads</div>
            <div className="text-2xl font-bold text-gray-900 dark:text-white">{loadStats.count}</div>
          </CardContent></Card>
          <Card><CardContent className="py-4">
            <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Gross hauled</div>
            <div className="text-2xl font-bold text-gray-900 dark:text-white">{money(loadStats.gross)}</div>
          </CardContent></Card>
          <Card><CardContent className="py-4">
            <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 flex items-center gap-1">
              <Percent className="h-3 w-3" />Fees earned
            </div>
            <div className="text-2xl font-bold text-indigo-700 dark:text-indigo-400">{money(loadStats.fees)}</div>
          </CardContent></Card>
          <Card><CardContent className="py-4">
            <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Onboarding</div>
            <div className="text-2xl font-bold text-gray-900 dark:text-white">
              {onboardingProgress.done}/{onboardingProgress.total}
            </div>
            <div className="mt-1.5 h-1.5 w-full rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${onboardingProgress.pct}%` }} />
            </div>
          </CardContent></Card>
        </div>

        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="onboarding">Onboarding</TabsTrigger>
            <TabsTrigger value="drivers">Drivers ({drivers.length})</TabsTrigger>
            <TabsTrigger value="equipment">Equipment ({equipment.length})</TabsTrigger>
            <TabsTrigger value="compliance">Compliance</TabsTrigger>
            <TabsTrigger value="loads">Loads ({loads.length})</TabsTrigger>
            <TabsTrigger value="documents">Documents</TabsTrigger>
            <TabsTrigger value="notes">Notes</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card>
                <CardHeader><CardTitle className="text-base">Identity &amp; authority</CardTitle></CardHeader>
                <CardContent className="divide-y dark:divide-gray-800">
                  <Row label="Legal name">{client.legal_name}</Row>
                  <Row label="DBA">{client.dba_name || '—'}</Row>
                  <Row label="MC #">{client.mc_number || '—'}</Row>
                  <Row label="DOT #">{client.dot_number || '—'}</Row>
                  <Row label="Authority">
                    <Badge className={`border ${client.authority_status === 'active'
                      ? 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-800/50'
                      : client.authority_status === 'inactive' || client.authority_status === 'not_authorized'
                        ? 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-800/50'
                        : 'bg-gray-100 text-gray-700 border-gray-200 dark:bg-white/10 dark:text-gray-300 dark:border-white/10'}`}>
                      {client.authority_status}
                    </Badge>
                  </Row>
                  <Row label="Safety rating">{client.safety_rating || '—'}</Row>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="text-base">Contact</CardTitle></CardHeader>
                <CardContent className="divide-y dark:divide-gray-800">
                  <Row label="Contact">{client.contact_name || '—'}</Row>
                  <Row label="Phone">{client.phone || '—'}</Row>
                  <Row label="Email">{client.email || '—'}</Row>
                  <Row label="Billing email">{client.billing_email || '—'}</Row>
                  <Row label="Address">
                    {[client.address, client.city, client.state, client.zip].filter(Boolean).join(', ') || '—'}
                  </Row>
                  <Row label="Home base">
                    {[client.home_base_city, client.home_base_state].filter(Boolean).join(', ') || '—'}
                  </Row>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><Percent className="h-4 w-4" />Fee plan &amp; billing</CardTitle></CardHeader>
                <CardContent className="divide-y dark:divide-gray-800">
                  <Row label="Plan">{describeFeePlan(client)}</Row>
                  <Row label="Billing cycle">{client.billing_cycle}</Row>
                  <Row label="Factoring">
                    {client.factors_invoices
                      ? (factor?.name ?? 'Factored — company not set')
                      : 'Not factored'}
                  </Row>
                  {client.factors_invoices && (
                    <Row label="Remit note">
                      <span className="text-amber-700 dark:text-amber-400 text-xs">
                        Broker invoices must remit to the factor, not the carrier.
                      </span>
                    </Row>
                  )}
                  <Row label="Agreement signed">{client.agreement_signed_at ? longDate(client.agreement_signed_at) : <span className="text-red-600 dark:text-red-400">Not on file</span>}</Row>
                  <Row label="POA signed">{client.poa_signed_at ? longDate(client.poa_signed_at) : <span className="text-amber-600 dark:text-amber-400">Not on file</span>}</Row>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><ShieldCheck className="h-4 w-4" />Insurance &amp; preferences</CardTitle></CardHeader>
                <CardContent className="divide-y dark:divide-gray-800">
                  <Row label="Provider">{client.insurance_provider || '—'}</Row>
                  <Row label="Auto liability">{client.liability_amount ? money(client.liability_amount) : '—'}</Row>
                  <Row label="Cargo">{client.cargo_amount ? money(client.cargo_amount) : '—'}</Row>
                  <Row label="COI expires">
                    {client.insurance_expiry
                      ? <span className={coiDays != null && coiDays < 0 ? 'text-red-600 dark:text-red-400 font-medium' : coiDays != null && coiDays <= 30 ? 'text-amber-600 dark:text-amber-400 font-medium' : ''}>
                          {longDate(client.insurance_expiry)}{coiDays != null && ` (${coiDays < 0 ? `${-coiDays}d ago` : `in ${coiDays}d`})`}
                        </span>
                      : '—'}
                  </Row>
                  <Row label="Equipment">{client.equipment_types?.length ? client.equipment_types.join(', ') : '—'}</Row>
                  <Row label="Min $/mile">{client.min_rate_per_mile ? `$${client.min_rate_per_mile.toFixed(2)}` : '—'}</Row>
                  <Row label="Flags">
                    {[client.hazmat && 'Hazmat', client.team && 'Team'].filter(Boolean).join(', ') || '—'}
                  </Row>
                </CardContent>
              </Card>

              {client.notes && (
                <Card className="lg:col-span-2">
                  <CardHeader><CardTitle className="text-base">Dispatcher notes</CardTitle></CardHeader>
                  <CardContent><p className="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap">{client.notes}</p></CardContent>
                </Card>
              )}
            </div>
          </TabsContent>

          <TabsContent value="onboarding">
            <Card>
              <CardHeader><CardTitle className="text-base">Onboarding checklist</CardTitle></CardHeader>
              <CardContent>
                {steps.length === 0 ? (
                  <p className="text-sm text-gray-400 py-6 text-center">No checklist on this client.</p>
                ) : (
                  <ul className="space-y-1">
                    {steps.map(s => {
                      const done = !!s.completed_at
                      return (
                        <li key={s.id}>
                          <button
                            type="button"
                            disabled={!canOnboardClient}
                            onClick={() => toggleStep(s)}
                            className={`w-full flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                              canOnboardClient ? 'hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer' : 'cursor-default'
                            }`}
                          >
                            {done
                              ? <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                              : <Circle className="h-4 w-4 text-gray-300 dark:text-gray-600 shrink-0" />}
                            <span className={`flex-1 text-sm ${done ? 'text-gray-400 line-through' : 'text-gray-800 dark:text-gray-100'}`}>
                              {s.label}
                            </span>
                            {!s.is_required && <span className="text-[11px] text-gray-400">optional</span>}
                            {done && <span className="text-[11px] text-gray-400">{dateTime(s.completed_at)}</span>}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="drivers">
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base flex items-center gap-2"><User className="h-4 w-4" />Drivers</CardTitle>
                {canModify && (
                  <DriverSheet clientId={client.id} onSaved={fetchAll} trigger={open => (
                    <Button size="sm" className="h-8 gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-700 text-white" onClick={open}>
                      <Plus className="h-3.5 w-3.5" />Add driver
                    </Button>
                  )} />
                )}
              </CardHeader>
              <CardContent className="p-0">
                {drivers.length === 0 ? (
                  <p className="text-sm text-gray-400 py-10 text-center">No drivers on file.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader><TableRow>
                        <TableHead>Name</TableHead><TableHead>Contact</TableHead>
                        <TableHead>CDL</TableHead><TableHead>CDL expiry</TableHead>
                        <TableHead>Medical</TableHead><TableHead>Status</TableHead>
                        <TableHead className="w-20"></TableHead>
                      </TableRow></TableHeader>
                      <TableBody>
                        {drivers.map(d => {
                          const cdlDays = daysUntil(d.cdl_expiry)
                          const medDays = daysUntil(d.medical_expiry)
                          const warn = (n: number | null) => n != null && n < 0 ? 'text-red-600 dark:text-red-400 font-medium'
                            : n != null && n <= 30 ? 'text-amber-600 dark:text-amber-400 font-medium' : ''
                          return (
                            <TableRow key={d.id}>
                              <TableCell className="font-medium">
                                {d.full_name}
                                {d.is_owner && <span className="ml-1.5 text-[11px] text-gray-400">(owner)</span>}
                              </TableCell>
                              <TableCell className="text-sm text-gray-600 dark:text-gray-300">
                                {[d.phone, d.email].filter(Boolean).join(' · ') || '—'}
                              </TableCell>
                              <TableCell className="text-sm text-gray-600 dark:text-gray-300">
                                {d.cdl_number || '—'}{d.cdl_state ? ` (${d.cdl_state})` : ''}
                              </TableCell>
                              <TableCell className={`text-sm ${warn(cdlDays)}`}>{d.cdl_expiry ? longDate(d.cdl_expiry) : '—'}</TableCell>
                              <TableCell className={`text-sm ${warn(medDays)}`}>{d.medical_expiry ? longDate(d.medical_expiry) : '—'}</TableCell>
                              <TableCell><Badge className="border bg-gray-100 text-gray-700 border-gray-200 dark:bg-white/10 dark:text-gray-300 dark:border-white/10">{d.status}</Badge></TableCell>
                              <TableCell>
                                {canModify && (
                                  <div className="flex items-center gap-1">
                                    <DriverSheet clientId={client.id} existing={d} onSaved={fetchAll} trigger={open => (
                                      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={open}>Edit</Button>
                                    )} />
                                    <button onClick={() => removeRow('client_drivers', d.id, d.full_name)}
                                      className="text-gray-400 hover:text-red-600 transition-colors" title="Delete driver">
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </div>
                                )}
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
          </TabsContent>

          <TabsContent value="equipment">
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base flex items-center gap-2"><Truck className="h-4 w-4" />Equipment</CardTitle>
                {canModify && (
                  <EquipmentSheet clientId={client.id} onSaved={fetchAll} trigger={open => (
                    <Button size="sm" className="h-8 gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-700 text-white" onClick={open}>
                      <Plus className="h-3.5 w-3.5" />Add equipment
                    </Button>
                  )} />
                )}
              </CardHeader>
              <CardContent className="p-0">
                {equipment.length === 0 ? (
                  <p className="text-sm text-gray-400 py-10 text-center">No trucks or trailers on file.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader><TableRow>
                        <TableHead>Kind</TableHead><TableHead>Unit</TableHead><TableHead>Type</TableHead>
                        <TableHead>Year / Make / Model</TableHead><TableHead>VIN</TableHead>
                        <TableHead>Plate</TableHead><TableHead className="w-20"></TableHead>
                      </TableRow></TableHeader>
                      <TableBody>
                        {equipment.map(e => (
                          <TableRow key={e.id}>
                            <TableCell className="capitalize text-sm">{e.kind}</TableCell>
                            <TableCell className="font-medium">{e.unit_number || '—'}</TableCell>
                            <TableCell className="text-sm text-gray-600 dark:text-gray-300">
                              {e.equipment_type || '—'}{e.length_ft ? ` · ${e.length_ft}'` : ''}
                            </TableCell>
                            <TableCell className="text-sm text-gray-600 dark:text-gray-300">
                              {[e.year, e.make, e.model].filter(Boolean).join(' ') || '—'}
                            </TableCell>
                            <TableCell className="text-sm text-gray-600 dark:text-gray-300 font-mono text-xs">{e.vin || '—'}</TableCell>
                            <TableCell className="text-sm text-gray-600 dark:text-gray-300">
                              {e.plate || '—'}{e.plate_state ? ` (${e.plate_state})` : ''}
                            </TableCell>
                            <TableCell>
                              {canModify && (
                                <div className="flex items-center gap-1">
                                  <EquipmentSheet clientId={client.id} existing={e} onSaved={fetchAll} trigger={open => (
                                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={open}>Edit</Button>
                                  )} />
                                  <button onClick={() => removeRow('client_equipment', e.id, e.unit_number || 'this unit')}
                                    className="text-gray-400 hover:text-red-600 transition-colors" title="Delete equipment">
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
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
          </TabsContent>

          <TabsContent value="compliance">
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base flex items-center gap-2"><ShieldCheck className="h-4 w-4" />Compliance</CardTitle>
                {canManageCompliance && (
                  <ComplianceSheet clientId={client.id} onSaved={fetchAll} trigger={open => (
                    <Button size="sm" className="h-8 gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-700 text-white" onClick={open}>
                      <Plus className="h-3.5 w-3.5" />Track item
                    </Button>
                  )} />
                )}
              </CardHeader>
              <CardContent className="p-0">
                {compliance.length === 0 ? (
                  <p className="text-sm text-gray-400 py-10 text-center">
                    Nothing tracked yet. Add authority, COIs, IFTA, UCR, and the rest here.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader><TableRow>
                        <TableHead>Item</TableHead><TableHead>Provider</TableHead>
                        <TableHead>Reference</TableHead><TableHead>Expires</TableHead>
                        <TableHead>Status</TableHead><TableHead className="w-20"></TableHead>
                      </TableRow></TableHeader>
                      <TableBody>
                        {compliance.map(ci => (
                          <TableRow key={ci.id}>
                            <TableCell className="font-medium">{ci.label || COMPLIANCE_KIND_LABEL[ci.kind] || ci.kind}</TableCell>
                            <TableCell className="text-sm text-gray-600 dark:text-gray-300">{ci.provider || '—'}</TableCell>
                            <TableCell className="text-sm text-gray-600 dark:text-gray-300">{ci.reference || '—'}</TableCell>
                            <TableCell className="text-sm text-gray-600 dark:text-gray-300">{ci.expiry_date ? longDate(ci.expiry_date) : '—'}</TableCell>
                            <TableCell>
                              <Badge className={`border ${COMPLIANCE_STATUS_COLORS[ci.status]}`}>
                                {COMPLIANCE_STATUS_LABELS[ci.status]}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              {canManageCompliance && (
                                <div className="flex items-center gap-1">
                                  <ComplianceSheet clientId={client.id} existing={ci} onSaved={fetchAll} trigger={open => (
                                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={open}>Edit</Button>
                                  )} />
                                  <button onClick={() => removeRow('compliance_items', ci.id, COMPLIANCE_KIND_LABEL[ci.kind] ?? ci.kind)}
                                    className="text-gray-400 hover:text-red-600 transition-colors" title="Delete item">
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
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
          </TabsContent>

          <TabsContent value="loads">
            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><Package className="h-4 w-4" />Loads</CardTitle></CardHeader>
              <CardContent className="p-0">
                {loads.length === 0 ? (
                  <p className="text-sm text-gray-400 py-10 text-center">No loads for this client yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader><TableRow>
                        <TableHead>Load #</TableHead><TableHead>Broker</TableHead><TableHead>Lane</TableHead>
                        <TableHead>PU</TableHead><TableHead>Status</TableHead>
                        <TableHead className="text-right">Gross</TableHead>
                        <TableHead className="text-right">Fee</TableHead>
                        <TableHead className="text-right">Net</TableHead>
                      </TableRow></TableHeader>
                      <TableBody>
                        {loads.map(l => {
                          const { from, to } = lane(l)
                          return (
                            <TableRow key={l.id} className="cursor-pointer" onClick={() => router.push(`/loads/${l.id}`)}>
                              <TableCell className="font-medium text-indigo-700 dark:text-indigo-400">{l.load_number}</TableCell>
                              <TableCell className="max-w-[140px] truncate text-sm">{l.broker_name || '—'}</TableCell>
                              <TableCell className="whitespace-nowrap text-sm">
                                {from}<ChevronRight className="inline h-3 w-3 mx-0.5 text-gray-400" />{to}
                              </TableCell>
                              <TableCell className="text-sm tabular-nums">{shortDate(l.pickup_date)}</TableCell>
                              <TableCell><Badge className={`border ${LOAD_STATUS_COLORS[l.status]}`}>{LOAD_STATUS_LABELS[l.status]}</Badge></TableCell>
                              <TableCell className="text-right tabular-nums">{money(l.gross_total)}</TableCell>
                              <TableCell className="text-right tabular-nums text-indigo-700 dark:text-indigo-400">{money(l.dispatch_fee)}</TableCell>
                              <TableCell className="text-right tabular-nums text-emerald-700 dark:text-emerald-400">{money(l.net_to_client)}</TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="documents">
            <Card>
              <CardContent className="py-5">
                <DocumentsPanel entityType="client" entityId={client.id} clientId={client.id} canModify={canModify} title="Client file" />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="notes">
            <Card>
              <CardHeader><CardTitle className="text-base">Notes</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                {canModify && (
                  <div className="flex items-start gap-2">
                    <Textarea rows={2} placeholder="Log a call, an issue, anything the next person needs."
                      value={noteBody} onChange={e => setNoteBody(e.target.value)} />
                    <Button className="gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white shrink-0" onClick={addNote} disabled={!noteBody.trim()}>
                      <MessageSquarePlus className="h-4 w-4" />Add
                    </Button>
                  </div>
                )}
                {notes.length === 0 ? (
                  <p className="text-sm text-gray-400 py-6 text-center">No notes yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {notes.map(n => (
                      <li key={n.id} className="rounded-lg border dark:border-gray-800 px-3 py-2">
                        <p className="text-sm text-gray-800 dark:text-gray-100 whitespace-pre-wrap">{n.body}</p>
                        <p className="mt-1 text-[11px] text-gray-400">{dateTime(n.created_at)}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </>
  )
}
