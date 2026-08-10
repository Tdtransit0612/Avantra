'use client'

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC shipment tracking page — Avantra.
//
// This route lives OUTSIDE the (dashboard) group and is exempted by the proxy
// matcher, so it renders with NO login and NO staff chrome (no Header / Sidebar /
// useRole). It reads through the anon-granted SECURITY DEFINER RPC
// `get_load_tracking`, which whitelists SAFE fields only — it can NEVER return
// line_haul, gross_total, dispatch_fee, or net_to_client. Anyone holding a
// tracking link (typically the broker or their shipper) must not be able to see
// what the carrier nets or what Avantra charges.
//
// The RPC itself enforces `tracking_active = true AND deleted_at IS NULL`, so an
// inactive/soft-deleted/unknown token simply returns zero rows → "not available".
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import {
  Compass, Truck, MapPin, Package, PackageCheck, PackageX,
  Calendar, Thermometer, Loader2, Box, ArrowRight, Ban,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

// Shape returned by public.get_load_tracking(p_token uuid) — whitelisted columns only.
type Tracking = {
  load_number: string
  status: string
  equipment_type: string | null
  client_name: string | null
  pickup_city: string | null
  pickup_state: string | null
  pickup_date: string | null
  delivery_city: string | null
  delivery_state: string | null
  delivery_date: string | null
  commodity: string | null
  temperature: string | null
  stop_count: number | null
  tracking_active: boolean
}

// Whitelisted public check-in from public.get_load_tracking_events(p_token uuid).
// Note the internal `notes` column is deliberately absent from the RPC.
type TrackEvent = {
  occurred_at: string
  location: string | null
  city: string | null
  state: string | null
  status_note: string | null
  temperature: string | null
  eta: string | null
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// ── Status → timeline mapping ────────────────────────────────────────────────
const STEPS = [
  { key: 'scheduled',  label: 'Scheduled',  icon: Package },
  { key: 'in_transit', label: 'In Transit', icon: Truck },
  { key: 'delivered',  label: 'Delivered',  icon: PackageCheck },
] as const

/** Index of the current timeline step (0-2), or -1 for cancelled. */
function currentStep(status: string): number {
  switch (status) {
    case 'cancelled':
    case 'tonu':                          return -1
    case 'at_pickup':
    case 'in_transit':
    case 'at_delivery':                   return 1
    case 'delivered':
    case 'docs_received':
    case 'invoiced':
    case 'paid':                          return 2
    // sourced / offered / booked / dispatched / anything else → scheduled
    default:                              return 0
  }
}

/**
 * Public-facing label for the raw load status. Deliberately coarse: the person
 * holding this link doesn't need to know whether we've invoiced or been paid,
 * and internal states like `sourced` would leak that the load wasn't committed.
 */
function statusLabel(status: string): string {
  const map: Record<string, string> = {
    sourced:       'Scheduled',
    offered:       'Scheduled',
    booked:        'Scheduled',
    dispatched:    'Driver Assigned',
    at_pickup:     'At Pickup',
    in_transit:    'In Transit',
    at_delivery:   'At Delivery',
    delivered:     'Delivered',
    docs_received: 'Delivered',
    invoiced:      'Delivered',
    paid:          'Delivered',
    cancelled:     'Cancelled',
    tonu:          'Cancelled',
  }
  return map[status] ?? 'In Progress'
}

// Parse a date-only string as LOCAL midnight to avoid an off-by-one from UTC.
function formatDate(d: string | null): string | null {
  if (!d) return null
  const parts = d.slice(0, 10).split('-').map(Number)
  const [y, m, day] = parts
  if (!y || !m || !day) return d
  return new Date(y, m - 1, day).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  })
}

function cityState(city: string | null, state: string | null): string {
  return [city, state].filter(Boolean).join(', ') || 'TBD'
}

// ── Timeline component ───────────────────────────────────────────────────────
function Timeline({ step }: { step: number }) {
  return (
    <div className="flex items-start justify-between">
      {STEPS.map((s, i) => {
        const Icon = s.icon
        const done = i <= step
        const isCurrent = i === step
        return (
          <div key={s.key} className="flex-1 flex flex-col items-center relative">
            {/* Connector to the previous node */}
            {i > 0 && (
              <span
                className={`absolute top-5 right-1/2 h-0.5 w-full -z-0 ${i <= step ? 'bg-indigo-500' : 'bg-slate-200 dark:bg-slate-700'}`}
                aria-hidden
              />
            )}
            <div
              className={`relative z-10 flex h-10 w-10 items-center justify-center rounded-full border-2 transition-colors ${
                done
                  ? 'border-indigo-500 bg-indigo-500 text-white'
                  : 'border-slate-200 bg-white text-slate-300 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-600'
              } ${isCurrent ? 'ring-4 ring-indigo-100 dark:ring-indigo-900/40' : ''}`}
            >
              <Icon className="h-5 w-5" />
            </div>
            <span
              className={`mt-2 text-center text-xs font-semibold ${
                done ? 'text-indigo-700 dark:text-indigo-300' : 'text-slate-400 dark:text-slate-500'
              }`}
            >
              {s.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Page shell (branded background + brand mark) ─────────────────────────────
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-indigo-50 via-white to-indigo-100 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 flex flex-col items-center px-4 py-10 sm:py-16">
      <div className="w-full max-w-xl">
        {/* Brand mark */}
        <div className="flex flex-col items-center text-center mb-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-lg shadow-indigo-600/20">
            <Compass className="h-7 w-7" />
          </div>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900 dark:text-white">Avantra</h1>
          <p className="text-sm font-medium text-indigo-600 dark:text-indigo-400">Shipment Tracking</p>
        </div>
        {children}
        <p className="mt-8 text-center text-xs text-slate-400 dark:text-slate-600">
          Live shipment status · No login required · Powered by Avantra
        </p>
      </div>
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────
export default function TrackPage() {
  const { token } = useParams<{ token: string }>()
  const [data, setData] = useState<Tracking | null>(null)
  const [events, setEvents] = useState<TrackEvent[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'not_found' | 'error'>('loading')

  useEffect(() => {
    if (!token) { setState('not_found'); return }
    let mounted = true

    ;(async () => {
      try {
        const supabase = createClient()
        // Fetch status + public check-ins together; the events RPC is best-effort
        // (returns null if not migrated yet → no timeline, page still renders).
        const [{ data: rows, error }, evRes] = await Promise.all([
          supabase.rpc('get_load_tracking', { p_token: token }),
          supabase.rpc('get_load_tracking_events', { p_token: token }),
        ])
        if (!mounted) return
        if (error) { setState('error'); return }
        const row = (Array.isArray(rows) ? rows[0] : rows) as Tracking | undefined
        if (!row) { setState('not_found'); return }
        setData(row)
        setEvents(Array.isArray(evRes.data) ? (evRes.data as TrackEvent[]) : [])
        setState('ready')
      } catch {
        if (mounted) setState('error')
      }
    })()

    return () => { mounted = false }
  }, [token])

  // ── Loading ──
  if (state === 'loading') {
    return (
      <Shell>
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm p-12 flex flex-col items-center gap-3">
          <Loader2 className="h-7 w-7 animate-spin text-indigo-500" />
          <p className="text-sm text-slate-400 dark:text-slate-500">Loading shipment status…</p>
        </div>
      </Shell>
    )
  }

  // ── Not found / inactive / error ──
  if (state !== 'ready' || !data) {
    const isError = state === 'error'
    return (
      <Shell>
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm p-10 flex flex-col items-center text-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800">
            <PackageX className="h-6 w-6 text-slate-400" />
          </div>
          <p className="text-base font-semibold text-slate-800 dark:text-slate-200">
            {isError ? 'Something went wrong' : 'Tracking not available'}
          </p>
          <p className="max-w-xs text-sm text-slate-500 dark:text-slate-400">
            {isError
              ? 'We couldn’t load this shipment right now. Please try again in a moment.'
              : 'This tracking link is inactive or no longer available. Check the link, or contact your Avantra representative for an update.'}
          </p>
        </div>
      </Shell>
    )
  }

  // ── Ready ──
  const step = currentStep(data.status)
  const cancelled = data.status === 'cancelled'
  const pickupDate = formatDate(data.pickup_date)
  const deliveryDate = formatDate(data.delivery_date)

  return (
    <Shell>
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
        {/* Header band */}
        <div className="border-b border-slate-100 dark:border-slate-800 px-6 py-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">Load</p>
              <p className="text-xl font-bold text-slate-900 dark:text-white">{data.load_number}</p>
            </div>
            {cancelled ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 dark:bg-red-900/30 px-3 py-1 text-xs font-semibold text-red-700 dark:text-red-300">
                <Ban className="h-3.5 w-3.5" /> Cancelled
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 dark:bg-indigo-900/30 px-3 py-1 text-xs font-semibold text-indigo-700 dark:text-indigo-300">
                {data.tracking_active && (
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-500" />
                  </span>
                )}
                {statusLabel(data.status)}
              </span>
            )}
          </div>
        </div>

        {/* Timeline or cancelled notice */}
        <div className="px-6 py-6">
          {cancelled ? (
            <div className="rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/40 px-4 py-4 text-center">
              <p className="text-sm font-medium text-red-700 dark:text-red-300">This shipment has been cancelled.</p>
              <p className="mt-1 text-xs text-red-600/80 dark:text-red-400/80">Please contact your Avantra representative for details.</p>
            </div>
          ) : (
            <Timeline step={step} />
          )}
        </div>

        {/* Route */}
        <div className="border-t border-slate-100 dark:border-slate-800 px-6 py-6">
          <div className="flex items-stretch gap-3">
            {/* Origin */}
            <div className="flex-1">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                <MapPin className="h-3.5 w-3.5 text-indigo-500" /> Origin
              </div>
              <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{cityState(data.pickup_city, data.pickup_state)}</p>
              {pickupDate && (
                <p className="mt-1 flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
                  <Calendar className="h-3 w-3" /> {pickupDate}
                </p>
              )}
            </div>

            <div className="flex items-center px-1 text-slate-300 dark:text-slate-600">
              <ArrowRight className="h-5 w-5" />
            </div>

            {/* Destination */}
            <div className="flex-1 text-right">
              <div className="flex items-center justify-end gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Destination <MapPin className="h-3.5 w-3.5 text-indigo-500" />
              </div>
              <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{cityState(data.delivery_city, data.delivery_state)}</p>
              {deliveryDate && (
                <p className="mt-1 flex items-center justify-end gap-1 text-xs text-slate-500 dark:text-slate-400">
                  <Calendar className="h-3 w-3" /> {deliveryDate}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Freight details */}
        {(data.commodity || data.temperature || data.equipment_type) && (
          <div className="border-t border-slate-100 dark:border-slate-800 px-6 py-5 grid grid-cols-3 gap-3">
            <Detail icon={<Box className="h-4 w-4 text-indigo-500" />} label="Commodity" value={data.commodity} />
            <Detail icon={<Thermometer className="h-4 w-4 text-indigo-500" />} label="Temperature" value={data.temperature} />
            <Detail icon={<Truck className="h-4 w-4 text-indigo-500" />} label="Equipment" value={data.equipment_type} />
          </div>
        )}

        {/* Recent check-ins. The RPC returns only rows a dispatcher flagged
            public, and never the internal note column. */}
        {events.length > 0 && (
          <div className="border-t border-slate-100 dark:border-slate-800 px-6 py-5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500 mb-3">
              <MapPin className="h-3.5 w-3.5 text-indigo-500" /> Recent check-ins
            </div>
            <div className="space-y-3">
              {events.map((ev, i) => {
                const where = ev.location || [ev.city, ev.state].filter(Boolean).join(', ')
                return (
                  <div key={i} className="flex items-start gap-3">
                    <div className="mt-1.5 h-2 w-2 rounded-full bg-indigo-500 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-slate-700 dark:text-slate-200">
                        {ev.status_note || where || 'Status update'}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {[
                          formatDateTime(ev.occurred_at),
                          ev.status_note ? where : null,
                          ev.temperature,
                          ev.eta ? `ETA ${formatDateTime(ev.eta)}` : null,
                        ].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </Shell>
  )
}

function Detail({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">{label}</span>
      </div>
      <p className="mt-1 text-sm font-medium text-slate-800 dark:text-slate-200 break-words">{value || '—'}</p>
    </div>
  )
}
