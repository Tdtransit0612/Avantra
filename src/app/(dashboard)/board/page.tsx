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
  Search, Loader2, Package, ChevronRight, ChevronsRight, Truck,
  MapPin, CalendarDays, Ban, RefreshCw, AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { logAudit } from '@/lib/audit'
import { useRole } from '@/lib/role-context'
import {
  BOARD_COLUMNS, LOAD_STATUS_LABELS, LOAD_STATUS_COLORS, NEXT_STATUS,
  ADVANCE_LABELS, statusPatch, money, shortDate, lane,
} from '@/lib/dispatch'
import type { Load, Client, LoadStatus } from '@/types'

// The board shows only live work. Anything past delivery+docs is the back
// office's problem and lives in /loads and /invoicing instead.
const BOARD_STATUSES: LoadStatus[] = BOARD_COLUMNS.flatMap(c => c.key)

function LoadCard({
  load, onAdvance, canDispatch, busy,
}: {
  load: Load
  onAdvance: (l: Load) => void
  canDispatch: boolean
  busy: boolean
}) {
  const router = useRouter()
  const { from, to } = lane(load)
  const next = NEXT_STATUS[load.status]
  const needsDriver = !load.driver_id && ['booked', 'dispatched'].includes(load.status)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => router.push(`/loads/${load.id}`)}
      onKeyDown={e => { if (e.key === 'Enter') router.push(`/loads/${load.id}`) }}
      className="group rounded-lg border dark:border-gray-800 bg-white dark:bg-gray-900 p-3 space-y-2 cursor-pointer hover:border-indigo-400 hover:shadow-sm transition-all"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-semibold text-sm text-indigo-700 dark:text-indigo-400">{load.load_number}</span>
        <Badge className={`border text-[10px] ${LOAD_STATUS_COLORS[load.status]}`}>
          {LOAD_STATUS_LABELS[load.status]}
        </Badge>
      </div>

      <div className="text-sm font-medium text-gray-900 dark:text-white truncate">
        {load.client_name || <span className="text-gray-400">No client</span>}
      </div>

      <div className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
        <MapPin className="h-3 w-3 text-gray-400 shrink-0" />
        <span className="truncate">{from}</span>
        <ChevronRight className="h-3 w-3 text-gray-400 shrink-0" />
        <span className="truncate">{to}</span>
      </div>

      <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
        <span className="flex items-center gap-1">
          <CalendarDays className="h-3 w-3" />{shortDate(load.pickup_date)} → {shortDate(load.delivery_date)}
        </span>
      </div>

      <div className="flex items-center justify-between gap-2 pt-1 border-t dark:border-gray-800">
        <span className="flex items-center gap-1 text-xs truncate">
          <Truck className="h-3 w-3 text-gray-400 shrink-0" />
          {load.driver_name
            ? <span className="text-gray-600 dark:text-gray-300 truncate">{load.driver_name}</span>
            : <span className={needsDriver ? 'text-amber-600 dark:text-amber-400 font-medium' : 'text-gray-400'}>
                {needsDriver ? 'Needs driver' : 'Unassigned'}
              </span>}
        </span>
        <span className="text-xs tabular-nums shrink-0">
          <span className="text-gray-500 dark:text-gray-400">{money(load.gross_total)}</span>
          {load.fee_waived
            ? <span className="ml-1.5 inline-flex items-center gap-0.5 text-gray-400"><Ban className="h-2.5 w-2.5" />fee</span>
            : <span className="ml-1.5 font-semibold text-indigo-700 dark:text-indigo-400">{money(load.dispatch_fee)}</span>}
        </span>
      </div>

      {canDispatch && next && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          className="w-full h-7 text-xs gap-1 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          onClick={e => { e.stopPropagation(); onAdvance(load) }}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ChevronsRight className="h-3 w-3" />}
          {ADVANCE_LABELS[load.status] ?? 'Advance'}
        </Button>
      )}
    </div>
  )
}

export default function BoardPage() {
  const { canDispatch } = useRole()
  const [loads, setLoads] = useState<Load[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [search, setSearch] = useState('')
  const [clientFilter, setClientFilter] = useState('all')
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true)
    const supabase = createClient()
    const [{ data }, { data: c }] = await Promise.all([
      supabase.from('loads').select('*')
        .is('deleted_at', null)
        .in('status', BOARD_STATUSES)
        .order('pickup_date', { ascending: true, nullsFirst: false })
        .limit(500),
      supabase.from('clients').select('*').is('deleted_at', null)
        .eq('status', 'active').order('legal_name'),
    ])
    setLoads((data ?? []) as Load[])
    setClients((c ?? []) as Client[])
    setLoading(false); setRefreshing(false)
  }, [])

  useEffect(() => { load() }, [load])

  const advance = async (l: Load) => {
    const next = NEXT_STATUS[l.status]
    if (!next) return
    // Dispatching without a driver assigned is almost always a mistake — the
    // rate con goes out with nobody on it. Send them to the load to fix it.
    if (next === 'dispatched' && !l.driver_id) {
      toast.error('Assign a driver before dispatching.', {
        description: `Open ${l.load_number} to pick a driver and truck.`,
      })
      return
    }
    setBusyId(l.id)
    const supabase = createClient()
    const patch = statusPatch(next)
    const { error } = await supabase.from('loads').update(patch).eq('id', l.id)
    setBusyId(null)
    if (error) { toast.error(error.message); return }

    void logAudit('load.status_change', {
      table_name: 'loads',
      record_id: l.id,
      old_value: { status: l.status },
      new_value: { status: next, load_number: l.load_number },
    })
    toast.success(`${l.load_number} → ${LOAD_STATUS_LABELS[next]}`)
    // Optimistic local move so the card jumps columns without a full refetch.
    setLoads(prev => prev.map(x => x.id === l.id ? { ...x, ...patch } as Load : x)
                         .filter(x => BOARD_STATUSES.includes(x.status)))
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return loads.filter(l => {
      if (clientFilter !== 'all' && l.client_id !== clientFilter) return false
      if (!q) return true
      const hay = [
        l.load_number, l.client_name, l.broker_name, l.driver_name,
        l.pickup_city, l.pickup_state, l.delivery_city, l.delivery_state, l.commodity,
      ].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [loads, search, clientFilter])

  const columns = useMemo(
    () => BOARD_COLUMNS.map(col => ({
      ...col,
      loads: filtered.filter(l => col.key.includes(l.status)),
    })),
    [filtered],
  )

  const needsDriverCount = useMemo(
    () => filtered.filter(l => !l.driver_id && ['booked', 'dispatched'].includes(l.status)).length,
    [filtered],
  )

  return (
    <>
      <Header title="Dispatch Board" subtitle="Every live load, by where it is right now" />
      <div className="p-6 space-y-4">

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input placeholder="Search load, client, driver, lane…" className="pl-9 h-9" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <Select value={clientFilter} onValueChange={v => setClientFilter(v ?? 'all')}>
            <SelectTrigger className="h-9 w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All clients</SelectItem>
              {clients.map(c => (
                <SelectItem key={c.id} value={c.id}>{c.dba_name || c.legal_name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {needsDriverCount > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 rounded-full px-3 py-1.5">
              <AlertTriangle className="h-3.5 w-3.5" />
              {needsDriverCount} load{needsDriverCount === 1 ? '' : 's'} without a driver
            </span>
          )}
          <Button variant="outline" className="ml-auto gap-2 h-9" onClick={() => load(true)} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />Refresh
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-24 text-gray-400">
            <Loader2 className="h-6 w-6 animate-spin mr-2" />Loading the board…
          </div>
        ) : filtered.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-20 gap-3 text-center">
              <div className="p-3 rounded-full bg-indigo-50 dark:bg-indigo-950 text-indigo-500"><Package className="h-7 w-7" /></div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
                {loads.length === 0 ? 'Nothing on the board' : 'No loads match your filters'}
              </p>
              <p className="text-xs text-gray-400 max-w-sm">
                {loads.length === 0
                  ? 'The board shows loads from sourced through delivered. Book a load to see it here.'
                  : 'Try clearing the search or client filter.'}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4 items-start">
            {columns.map(col => {
              const colFees = col.loads.reduce((s, l) => s + (l.dispatch_fee ?? 0), 0)
              return (
                <div key={col.label} className="rounded-xl bg-gray-100/70 dark:bg-white/5 p-3 space-y-3">
                  <div>
                    <div className="flex items-center justify-between">
                      <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">{col.label}</h2>
                      <span className="text-xs font-medium text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-900 rounded-full px-2 py-0.5">
                        {col.loads.length}
                      </span>
                    </div>
                    <p className="text-[11px] text-gray-400 mt-0.5">{col.hint}</p>
                    {colFees > 0 && (
                      <p className="text-[11px] text-indigo-600 dark:text-indigo-400 font-medium mt-0.5">
                        {money(colFees)} in fees
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    {col.loads.length === 0 ? (
                      <p className="text-xs text-gray-400 text-center py-6">Empty</p>
                    ) : col.loads.map(l => (
                      <LoadCard
                        key={l.id}
                        load={l}
                        onAdvance={advance}
                        canDispatch={canDispatch}
                        busy={busyId === l.id}
                      />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
