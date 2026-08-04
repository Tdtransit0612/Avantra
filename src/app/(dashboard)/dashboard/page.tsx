'use client'

import { useEffect, useState } from 'react'
import Header from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'
import {
  Package, Building2, Truck, TrendingUp, FileText, Wallet, ShieldAlert,
  ArrowRight, DollarSign, AlertTriangle, CheckCircle2, MapPin,
} from 'lucide-react'

const BOOKED = ['covered', 'in_transit', 'delivered', 'invoiced', 'paid']

function money(n: number) {
  return `$${Math.round(n).toLocaleString()}`
}

interface TodayLoad {
  id: string
  load_number: string
  status: string
  customer_name: string | null
  pickup_city: string | null
  pickup_state: string | null
  delivery_city: string | null
  delivery_state: string | null
}

function TodayRow({ l }: { l: TodayLoad }) {
  const from = [l.pickup_city, l.pickup_state].filter(Boolean).join(', ') || '—'
  const to = [l.delivery_city, l.delivery_state].filter(Boolean).join(', ') || '—'
  return (
    <Link href={`/loads/${l.id}`} className="flex items-center justify-between py-2 hover:bg-gray-50 dark:hover:bg-white/5 -mx-2 px-2 rounded">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-900 dark:text-white">{l.load_number}</span>
          <Badge className={STATUS_BADGE[l.status] ?? STATUS_BADGE.quote}>{l.status.replace('_', ' ')}</Badge>
        </div>
        <div className="text-xs text-gray-400 truncate">{l.customer_name ?? '—'} · {from} → {to}</div>
      </div>
    </Link>
  )
}

interface Stats {
  activeLoads: number
  needCarrier: number
  toInvoice: number
  openMargin: number
  revenueBooked: number
  arOutstanding: number
  arOverdue: number
  openCarrierAlerts: number
  complianceDone: number
  complianceTotal: number
}

interface RecentLoad {
  id: string
  load_number: string
  status: string
  customer_name: string | null
  pickup_city: string | null
  pickup_state: string | null
  delivery_city: string | null
  delivery_state: string | null
  margin: number | null
}

interface AtRiskLoad {
  id: string
  load_number: string
  status: string
  customer_name: string | null
  pickup_city: string | null
  pickup_state: string | null
  delivery_city: string | null
  delivery_state: string | null
  pickup_date: string | null
  delivery_date: string | null
  reason: string
}

const STATUS_BADGE: Record<string, string> = {
  quote: 'bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-gray-300',
  available: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  covered: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  in_transit: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300',
  delivered: 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300',
  invoiced: 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300',
  paid: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  cancelled: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [recent, setRecent] = useState<RecentLoad[]>([])
  const [pickups, setPickups] = useState<TodayLoad[]>([])
  const [deliveries, setDeliveries] = useState<TodayLoad[]>([])
  const [atRisk, setAtRisk] = useState<AtRiskLoad[]>([])

  useEffect(() => {
    const supabase = createClient()
    const today = new Date().toISOString().slice(0, 10)
    const TODAY_COLS = 'id, load_number, status, customer_name, pickup_city, pickup_state, delivery_city, delivery_state'

    ;(async () => {
      const [
        { data: loads }, { data: invoices }, { data: alerts }, { data: compliance },
        { data: recentLoads }, { data: pickupLoads }, { data: deliveryLoads },
        { data: atRiskRaw },
      ] = await Promise.all([
        supabase.from('loads').select('status, customer_rate, fuel_surcharge, accessorials, carrier_rate, margin').is('deleted_at', null),
        supabase.from('invoices').select('status, amount, amount_paid, due_date'),
        supabase.from('compliance_alerts').select('id').eq('entity_type', 'carrier').is('resolved_at', null),
        supabase.from('company_compliance').select('status'),
        supabase.from('loads').select('id, load_number, status, customer_name, pickup_city, pickup_state, delivery_city, delivery_state, margin').is('deleted_at', null).order('created_at', { ascending: false }).limit(6),
        // Today's operational board: what picks up / delivers today (still in motion).
        supabase.from('loads').select(TODAY_COLS).is('deleted_at', null).eq('pickup_date', today).in('status', ['quote', 'available', 'covered', 'in_transit']).order('load_number'),
        supabase.from('loads').select(TODAY_COLS).is('deleted_at', null).eq('delivery_date', today).in('status', ['covered', 'in_transit', 'delivered']).order('load_number'),
        // Operational watchdog: in-motion loads whose timing is slipping.
        supabase.from('loads').select('id, load_number, status, customer_name, pickup_city, pickup_state, delivery_city, delivery_state, pickup_date, delivery_date, carrier_id').is('deleted_at', null).in('status', ['available', 'covered', 'in_transit']).limit(300),
      ])

      const L = loads ?? []
      const booked = L.filter(l => BOOKED.includes(l.status))
      const activeLoads = L.filter(l => ['available', 'covered', 'in_transit'].includes(l.status)).length
      const needCarrier = L.filter(l => l.status === 'available').length
      const toInvoice = L.filter(l => l.status === 'delivered').length
      const openMargin = booked.reduce((s, l) => s + Number(l.margin ?? 0), 0)
      const revenueBooked = booked.reduce((s, l) => s + Number(l.customer_rate ?? 0) + Number(l.fuel_surcharge ?? 0) + Number(l.accessorials ?? 0), 0)

      const AR = (invoices ?? []).filter(i => i.status === 'sent' || i.status === 'overdue')
      const arDue = (i: { amount: number; amount_paid: number }) => Math.max(0, Number(i.amount) - Number(i.amount_paid ?? 0))
      const arOutstanding = AR.reduce((s, i) => s + arDue(i), 0)
      const arOverdue = AR.filter(i => i.status === 'overdue' || (i.due_date && i.due_date < today)).reduce((s, i) => s + arDue(i), 0)

      const comp = compliance ?? []
      setStats({
        activeLoads, needCarrier, toInvoice, openMargin, revenueBooked,
        arOutstanding, arOverdue,
        openCarrierAlerts: (alerts ?? []).length,
        complianceDone: comp.filter(c => c.status === 'active' || c.status === 'not_required').length,
        complianceTotal: comp.length,
      })
      setRecent((recentLoads ?? []) as RecentLoad[])
      setPickups((pickupLoads ?? []) as TodayLoad[])
      setDeliveries((deliveryLoads ?? []) as TodayLoad[])

      // Timing risks: available needing a carrier soon/overdue, covered past pickup,
      // in-transit past delivery. Earliest date first; cap the list.
      const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)
      const risky = (atRiskRaw ?? []).map(l => {
        let reason: string | null = null
        if (l.status === 'available' && !l.carrier_id && l.pickup_date && l.pickup_date <= soon) {
          reason = l.pickup_date < today ? 'No carrier — pickup overdue' : 'Needs a carrier — pickup soon'
        } else if (l.status === 'covered' && l.pickup_date && l.pickup_date < today) {
          reason = 'Covered — pickup date passed'
        } else if (l.status === 'in_transit' && l.delivery_date && l.delivery_date < today) {
          reason = 'In transit — delivery date passed'
        }
        return reason ? ({ ...l, reason } as AtRiskLoad) : null
      }).filter((x): x is AtRiskLoad => x !== null)
      risky.sort((a, b) => ((a.pickup_date ?? a.delivery_date ?? '9999') < (b.pickup_date ?? b.delivery_date ?? '9999') ? -1 : 1))
      setAtRisk(risky.slice(0, 8))
    })()
  }, [])

  const kpis = stats ? [
    { label: 'Active loads', value: String(stats.activeLoads), sub: `${stats.needCarrier} need a carrier`, icon: Package, href: '/loads', color: 'text-sky-600 bg-sky-100 dark:bg-sky-950' },
    { label: 'Open margin', value: money(stats.openMargin), sub: `on ${money(stats.revenueBooked)} booked`, icon: TrendingUp, href: '/margin', color: 'text-green-600 bg-green-100 dark:bg-green-950' },
    { label: 'AR outstanding', value: money(stats.arOutstanding), sub: stats.arOverdue > 0 ? `${money(stats.arOverdue)} overdue` : 'none overdue', icon: DollarSign, href: '/invoicing', color: 'text-purple-600 bg-purple-100 dark:bg-purple-950' },
    { label: 'Ready to invoice', value: String(stats.toInvoice), sub: 'delivered loads', icon: FileText, href: '/invoicing', color: 'text-teal-600 bg-teal-100 dark:bg-teal-950' },
  ] : []

  return (
    <>
      <Header title="Dashboard" subtitle="Avantra freight brokerage" />
      <div className="p-6 space-y-6">
        {/* KPI row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {(stats ? kpis : Array.from({ length: 4 })).map((k, i) => (
            <Link key={i} href={(k as { href?: string })?.href ?? '#'}>
              <Card className="h-full transition-colors hover:border-sky-400">
                <CardContent className="pt-5">
                  {stats && k ? (
                    <>
                      <div className="flex items-center justify-between">
                        <div className={`p-2 rounded-lg ${(k as { color: string }).color}`}>
                          {(() => { const Icon = (k as { icon: React.ComponentType<{ className?: string }> }).icon; return <Icon className="h-4 w-4" /> })()}
                        </div>
                      </div>
                      <div className="mt-3 text-2xl font-bold text-gray-900 dark:text-white">{(k as { value: string }).value}</div>
                      <div className="text-xs text-gray-500 mt-0.5">{(k as { label: string }).label}</div>
                      <div className="text-[11px] text-gray-400 mt-1">{(k as { sub: string }).sub}</div>
                    </>
                  ) : (
                    <div className="h-20 animate-pulse bg-gray-100 dark:bg-white/5 rounded" />
                  )}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>

        {/* Loads needing attention — operational timing watchdog */}
        {atRisk.length > 0 && (
          <Card className="border-amber-200 dark:border-amber-800/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4" />Loads needing attention ({atRisk.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="divide-y dark:divide-gray-800">
                {atRisk.map(l => (
                  <Link key={l.id} href={`/loads/${l.id}`} className="flex items-center justify-between gap-3 py-2 hover:bg-gray-50 dark:hover:bg-white/5 -mx-2 px-2 rounded">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900 dark:text-white">{l.load_number}</span>
                        <Badge className={STATUS_BADGE[l.status] ?? STATUS_BADGE.quote}>{l.status.replace('_', ' ')}</Badge>
                      </div>
                      <div className="text-xs text-gray-400 truncate">{l.customer_name ?? '—'} · {l.pickup_city ?? '?'}, {l.pickup_state ?? ''} → {l.delivery_city ?? '?'}, {l.delivery_state ?? ''}</div>
                    </div>
                    <span className="text-xs font-medium text-amber-700 dark:text-amber-400 shrink-0 text-right">{l.reason}</span>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Today's schedule — what moves today */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2"><MapPin className="h-4 w-4 text-sky-500" />Pickups today</CardTitle>
              {stats && <span className="text-xs text-gray-400">{pickups.length}</span>}
            </CardHeader>
            <CardContent>
              {!stats ? (
                <div className="h-16 animate-pulse bg-gray-100 dark:bg-white/5 rounded" />
              ) : pickups.length === 0 ? (
                <p className="text-sm text-gray-500 py-4 text-center">No pickups scheduled today.</p>
              ) : (
                <div className="divide-y dark:divide-gray-800">
                  {pickups.map(l => <TodayRow key={l.id} l={l} />)}
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2"><Truck className="h-4 w-4 text-green-500" />Deliveries today</CardTitle>
              {stats && <span className="text-xs text-gray-400">{deliveries.length}</span>}
            </CardHeader>
            <CardContent>
              {!stats ? (
                <div className="h-16 animate-pulse bg-gray-100 dark:bg-white/5 rounded" />
              ) : deliveries.length === 0 ? (
                <p className="text-sm text-gray-500 py-4 text-center">No deliveries scheduled today.</p>
              ) : (
                <div className="divide-y dark:divide-gray-800">
                  {deliveries.map(l => <TodayRow key={l.id} l={l} />)}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Recent loads */}
          <Card className="lg:col-span-2">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">Recent loads</CardTitle>
              <Link href="/loads" className="text-xs text-sky-600 hover:underline flex items-center gap-1">View all <ArrowRight className="h-3 w-3" /></Link>
            </CardHeader>
            <CardContent>
              {recent.length === 0 ? (
                <p className="text-sm text-gray-500 py-6 text-center">No loads yet. <Link href="/loads" className="text-sky-600 hover:underline">Book your first load →</Link></p>
              ) : (
                <div className="divide-y dark:divide-gray-800">
                  {recent.map(l => (
                    <Link key={l.id} href={`/loads/${l.id}`} className="flex items-center justify-between py-2.5 hover:bg-gray-50 dark:hover:bg-white/5 -mx-2 px-2 rounded">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-900 dark:text-white">{l.load_number}</span>
                          <Badge className={STATUS_BADGE[l.status] ?? STATUS_BADGE.quote}>{l.status.replace('_', ' ')}</Badge>
                        </div>
                        <div className="text-xs text-gray-400 truncate">{l.customer_name ?? '—'} · {l.pickup_city ?? '?'}, {l.pickup_state ?? ''} → {l.delivery_city ?? '?'}, {l.delivery_state ?? ''}</div>
                      </div>
                      <div className="text-sm font-semibold text-green-600 shrink-0 ml-3">{money(Number(l.margin ?? 0))}</div>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Attention / health */}
          <Card>
            <CardHeader><CardTitle className="text-base">Needs attention</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {!stats ? (
                <div className="h-24 animate-pulse bg-gray-100 dark:bg-white/5 rounded" />
              ) : (
                <>
                  <Link href="/carriers" className="flex items-center gap-3 text-sm">
                    <div className={`p-1.5 rounded-lg ${stats.openCarrierAlerts > 0 ? 'bg-red-100 text-red-600 dark:bg-red-950' : 'bg-green-100 text-green-600 dark:bg-green-950'}`}>
                      {stats.openCarrierAlerts > 0 ? <ShieldAlert className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                    </div>
                    <span className="text-gray-700 dark:text-gray-200">{stats.openCarrierAlerts > 0 ? `${stats.openCarrierAlerts} carrier compliance alert${stats.openCarrierAlerts > 1 ? 's' : ''}` : 'Carriers all compliant'}</span>
                  </Link>
                  <Link href="/invoicing" className="flex items-center gap-3 text-sm">
                    <div className={`p-1.5 rounded-lg ${stats.arOverdue > 0 ? 'bg-red-100 text-red-600 dark:bg-red-950' : 'bg-green-100 text-green-600 dark:bg-green-950'}`}>
                      {stats.arOverdue > 0 ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                    </div>
                    <span className="text-gray-700 dark:text-gray-200">{stats.arOverdue > 0 ? `${money(stats.arOverdue)} overdue AR` : 'No overdue AR'}</span>
                  </Link>
                  {stats.complianceTotal > 0 && (
                    <Link href="/compliance" className="flex items-center gap-3 text-sm">
                      <div className="p-1.5 rounded-lg bg-sky-100 text-sky-600 dark:bg-sky-950"><Wallet className="h-4 w-4" /></div>
                      <span className="text-gray-700 dark:text-gray-200">Go-live checklist: {stats.complianceDone}/{stats.complianceTotal} complete</span>
                    </Link>
                  )}
                </>
              )}
              <div className="pt-2 border-t dark:border-gray-800 grid grid-cols-3 gap-2">
                {[
                  { href: '/loads', label: 'New load', icon: Package },
                  { href: '/carriers', label: 'Carrier', icon: Truck },
                  { href: '/customers', label: 'Customer', icon: Building2 },
                ].map(({ href, label, icon: Icon }) => (
                  <Link key={href} href={href} className="flex flex-col items-center gap-1 p-2 rounded-lg hover:bg-sky-50 dark:hover:bg-sky-950/30 text-center">
                    <Icon className="h-4 w-4 text-sky-600" />
                    <span className="text-[11px] text-gray-600 dark:text-gray-300">{label}</span>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}
