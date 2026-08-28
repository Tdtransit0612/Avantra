'use client'

import { useEffect, useState, useMemo } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Package, Truck, Users, FileText, Receipt, ShieldAlert, Wrench,
  ArrowRight, AlertTriangle, ChevronRight, Loader2, Percent, Phone,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useRole } from '@/lib/role-context'
import {
  OPEN_LOAD_STATUSES, OPEN_INVOICE_STATUSES, OPEN_SERVICE_STATUSES,
  LOAD_STATUS_LABELS, LOAD_STATUS_COLORS,
  money, shortDate, lane, daysPastDue, daysUntil, todayISO,
} from '@/lib/dispatch'
import type { Load, Invoice, Client, ClientStatement, ServiceRequest, ComplianceItem } from '@/types'

function Tile({ href, label, value, sub, icon, tone }: {
  href: string
  label: string
  value: string | number
  sub?: string
  icon: React.ReactNode
  tone: string
}) {
  return (
    <Link href={href}>
      <Card className="h-full transition-shadow hover:shadow-md">
        <CardContent className="flex items-start gap-3 py-4">
          <div className={`p-2 rounded-lg ${tone}`}>{icon}</div>
          <div className="min-w-0">
            <div className="text-2xl font-bold text-gray-900 dark:text-white">{value}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
            {sub && <div className="text-[11px] text-gray-400 mt-0.5">{sub}</div>}
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}

export default function DashboardPage() {
  const { role, allowedNav, isAdmin, isMasterAdmin } = useRole()
  const [loads, setLoads] = useState<Load[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [statements, setStatements] = useState<ClientStatement[]>([])
  const [services, setServices] = useState<ServiceRequest[]>([])
  const [compliance, setCompliance] = useState<ComplianceItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const supabase = createClient()
    ;(async () => {
      try {
        // Every query is RLS-gated, so a role without access simply gets an empty
        // set rather than an error — the tiles below then render zeros and the
        // links stay hidden by the nav check.
        const [l, i, c, s, sr, ci] = await Promise.all([
          supabase.from('loads').select('*').is('deleted_at', null).order('pickup_date', { ascending: true, nullsFirst: false }).limit(500),
          supabase.from('invoices').select('*').limit(1000),
          supabase.from('clients').select('*').is('deleted_at', null).limit(500),
          supabase.from('client_statements').select('*').limit(500),
          supabase.from('service_requests').select('*').limit(500),
          supabase.from('compliance_items').select('*').limit(1000),
        ])
        if (cancelled) return

        // Report the first real failure rather than silently rendering zeros —
        // an empty dashboard and a broken dashboard look identical otherwise.
        const failed = [l, i, c, s, sr, ci].find(r => r.error)
        if (failed?.error) { setError(failed.error.message); return }

        setLoads((l.data ?? []) as Load[])
        setInvoices((i.data ?? []) as Invoice[])
        setClients((c.data ?? []) as Client[])
        setStatements((s.data ?? []) as ClientStatement[])
        setServices((sr.data ?? []) as ServiceRequest[])
        setCompliance((ci.data ?? []) as ComplianceItem[])
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not reach the server.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const can = (key: string) => isAdmin || isMasterAdmin || allowedNav.has(key)

  const stats = useMemo(() => {
    const open = loads.filter(l => OPEN_LOAD_STATUSES.includes(l.status))
    const needsDriver = loads.filter(l => !l.driver_id && ['booked', 'sourced', 'offered'].includes(l.status))
    const readyToInvoice = loads.filter(l => ['delivered', 'docs_received'].includes(l.status))
    const openInv = invoices.filter(i => OPEN_INVOICE_STATUSES.includes(i.status))
    const overdue = openInv.filter(i => daysPastDue(i.due_date) > 0)

    // Fees we've earned this calendar month, by delivery date — the closest thing
    // to "what did Avantra make" before statements are cut.
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
    const feesThisMonth = loads
      .filter(l => l.delivery_date && l.delivery_date >= monthStart && l.status !== 'cancelled')
      .reduce((t, l) => t + (l.dispatch_fee ?? 0), 0)

    const unpaidStatements = statements.filter(s => ['sent', 'partial', 'overdue'].includes(s.status))

    const complianceAlerts = compliance.filter(x => ['expired', 'expiring', 'missing'].includes(x.status))
    const coiAlerts = clients.filter(c => {
      const d = daysUntil(c.insurance_expiry)
      return d != null && d <= 30
    })

    const openServices = services.filter(r => OPEN_SERVICE_STATUSES.includes(r.status))
    const overdueServices = openServices.filter(r => {
      const d = daysUntil(r.due_date)
      return d != null && d < 0
    })

    return {
      openLoads: open.length,
      openFees: open.reduce((t, l) => t + (l.dispatch_fee ?? 0), 0),
      needsDriver: needsDriver.length,
      readyToInvoice: readyToInvoice.length,
      openAr: openInv.reduce((t, i) => t + ((i.amount ?? 0) - (i.amount_paid ?? 0)), 0),
      overdueCount: overdue.length,
      feesThisMonth,
      unpaidStatementValue: unpaidStatements.reduce((t, s) => t + ((s.amount_due ?? 0) - (s.amount_paid ?? 0)), 0),
      unpaidStatementCount: unpaidStatements.length,
      activeClients: clients.filter(c => c.status === 'active').length,
      complianceAlerts: complianceAlerts.length + coiAlerts.length,
      openServices: openServices.length,
      overdueServices: overdueServices.length,
    }
  }, [loads, invoices, clients, statements, services, compliance])

  const today = todayISO()
  const todaysLoads = useMemo(
    () => loads
      .filter(l => OPEN_LOAD_STATUSES.includes(l.status))
      .filter(l => (l.pickup_date && l.pickup_date <= today) || (l.delivery_date && l.delivery_date <= today))
      .slice(0, 8),
    [loads, today],
  )

  const needsTrace = useMemo(
    () => invoices
      .filter(i => OPEN_INVOICE_STATUSES.includes(i.status) && daysPastDue(i.due_date) > 0)
      .sort((a, b) => daysPastDue(b.due_date) - daysPastDue(a.due_date))
      .slice(0, 6),
    [invoices],
  )

  const clientName = (id: string | null) => {
    if (!id) return '—'
    const c = clients.find(x => x.id === id)
    return c ? (c.dba_name || c.legal_name) : '—'
  }

  if (error) {
    return (
      <>
        <Header title="Dashboard" subtitle="Something went wrong" />
        <div className="p-6">
          <Card>
            <CardContent className="py-8 space-y-3">
              <div className="flex items-center gap-2 text-red-600 dark:text-red-400 font-medium">
                <AlertTriangle className="h-5 w-5" />Couldn&apos;t load the dashboard
              </div>
              <code className="block text-xs bg-gray-100 dark:bg-white/5 rounded p-3 break-words text-gray-700 dark:text-gray-300">
                {error}
              </code>
              <button
                onClick={() => window.location.reload()}
                className="rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm px-4 py-2 transition-colors"
              >
                Retry
              </button>
            </CardContent>
          </Card>
        </div>
      </>
    )
  }

  if (loading) {
    return (
      <>
        <Header title="Dashboard" subtitle="Loading…" />
        <div className="flex items-center justify-center py-24 text-gray-400">
          <Loader2 className="h-6 w-6 animate-spin mr-2" />Loading your day…
        </div>
      </>
    )
  }

  if (!role || role === 'pending') {
    return (
      <>
        <Header title="Dashboard" subtitle="Awaiting access" />
        <div className="p-6">
          <Card><CardContent className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">
            Your account is set up but hasn&apos;t been given a role yet. An admin needs to grant access.
          </CardContent></Card>
        </div>
      </>
    )
  }

  return (
    <>
      <Header title="Dashboard" subtitle="Where things stand right now" />
      <div className="p-6 space-y-6">

        {/* Operations */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {can('board') && (
            <Tile href="/board" label="Open loads" value={stats.openLoads}
              sub={`${money(stats.openFees)} in fees riding on them`}
              icon={<Package className="h-5 w-5" />} tone="bg-indigo-100 dark:bg-indigo-950 text-indigo-600" />
          )}
          {can('loads') && (
            <Tile href="/loads" label="Need a driver" value={stats.needsDriver}
              sub={stats.needsDriver > 0 ? 'Booked with nobody on them' : 'All covered'}
              icon={<Truck className="h-5 w-5" />} tone="bg-amber-100 dark:bg-amber-950 text-amber-600" />
          )}
          {can('invoicing') && (
            <Tile href="/invoicing" label="Ready to invoice" value={stats.readyToInvoice}
              sub="Delivered, paperwork in"
              icon={<FileText className="h-5 w-5" />} tone="bg-teal-100 dark:bg-teal-950 text-teal-600" />
          )}
          {can('clients') && (
            <Tile href="/clients" label="Active clients" value={stats.activeClients}
              sub={`${clients.length} total on the book`}
              icon={<Users className="h-5 w-5" />} tone="bg-violet-100 dark:bg-violet-950 text-violet-600" />
          )}
        </div>

        {/* Money */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {can('invoicing') && (
            <Tile href="/invoicing" label="Open AR (clients' money)" value={money(stats.openAr)}
              sub={stats.overdueCount > 0 ? `${stats.overdueCount} invoice${stats.overdueCount === 1 ? '' : 's'} overdue` : 'Nothing overdue'}
              icon={<FileText className="h-5 w-5" />} tone="bg-blue-100 dark:bg-blue-950 text-blue-600" />
          )}
          {can('statements') && (
            <Tile href="/statements" label="Fees owed to Avantra" value={money(stats.unpaidStatementValue)}
              sub={`${stats.unpaidStatementCount} statement${stats.unpaidStatementCount === 1 ? '' : 's'} outstanding`}
              icon={<Receipt className="h-5 w-5" />} tone="bg-emerald-100 dark:bg-emerald-950 text-emerald-600" />
          )}
          {can('statements') && (
            <Tile href="/statements" label="Fees earned this month" value={money(stats.feesThisMonth)}
              sub="On loads delivered since the 1st"
              icon={<Percent className="h-5 w-5" />} tone="bg-indigo-100 dark:bg-indigo-950 text-indigo-600" />
          )}
          {can('compliance') && (
            <Tile href="/compliance" label="Compliance alerts" value={stats.complianceAlerts}
              sub={stats.complianceAlerts > 0 ? 'Expired, expiring, or missing' : 'Everything current'}
              icon={<ShieldAlert className="h-5 w-5" />}
              tone={stats.complianceAlerts > 0 ? 'bg-red-100 dark:bg-red-950 text-red-600' : 'bg-emerald-100 dark:bg-emerald-950 text-emerald-600'} />
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Today's freight */}
          {can('board') && (
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">Needs eyes today</CardTitle>
                <Link href="/board" className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1">
                  Board<ArrowRight className="h-3 w-3" />
                </Link>
              </CardHeader>
              <CardContent>
                {todaysLoads.length === 0 ? (
                  <p className="text-sm text-gray-400 py-6 text-center">
                    Nothing picking up or delivering today.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {todaysLoads.map(l => {
                      const { from, to } = lane(l)
                      return (
                        <li key={l.id}>
                          <Link href={`/loads/${l.id}`}
                            className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors">
                            <span className="text-sm font-medium text-indigo-700 dark:text-indigo-400 shrink-0">
                              {l.load_number}
                            </span>
                            <span className="text-xs text-gray-600 dark:text-gray-300 truncate flex-1">
                              {from}<ChevronRight className="inline h-3 w-3 mx-0.5 text-gray-400" />{to}
                            </span>
                            <span className="text-[11px] text-gray-400 shrink-0 tabular-nums">
                              {shortDate(l.pickup_date)}
                            </span>
                            <Badge className={`border shrink-0 text-[10px] ${LOAD_STATUS_COLORS[l.status]}`}>
                              {LOAD_STATUS_LABELS[l.status]}
                            </Badge>
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}

          {/* Collections */}
          {can('invoicing') && (
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">Chase the money</CardTitle>
                <Link href="/invoicing" className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1">
                  AR<ArrowRight className="h-3 w-3" />
                </Link>
              </CardHeader>
              <CardContent>
                {needsTrace.length === 0 ? (
                  <p className="text-sm text-gray-400 py-6 text-center">No overdue invoices. Nice.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {needsTrace.map(i => {
                      const pd = daysPastDue(i.due_date)
                      return (
                        <li key={i.id} className="flex items-center gap-3 rounded-lg px-2 py-2">
                          <span className="text-sm font-medium text-indigo-700 dark:text-indigo-400 shrink-0">
                            {i.invoice_number}
                          </span>
                          <span className="text-xs text-gray-600 dark:text-gray-300 truncate flex-1">
                            {clientName(i.client_id)}
                          </span>
                          {i.trace_count > 0 && (
                            <span className="text-[11px] text-gray-400 inline-flex items-center gap-0.5 shrink-0">
                              <Phone className="h-3 w-3" />{i.trace_count}
                            </span>
                          )}
                          <span className={`text-xs shrink-0 tabular-nums font-medium ${pd > 60 ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}`}>
                            {pd}d
                          </span>
                          <span className="text-sm shrink-0 tabular-nums text-gray-900 dark:text-white">
                            {money((i.amount ?? 0) - (i.amount_paid ?? 0))}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Services strip */}
        {can('services') && stats.openServices > 0 && (
          <Card>
            <CardContent className="flex flex-wrap items-center gap-4 py-4">
              <div className="p-2 rounded-lg bg-violet-100 dark:bg-violet-950 text-violet-600"><Wrench className="h-5 w-5" /></div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-900 dark:text-white">
                  {stats.openServices} open service request{stats.openServices === 1 ? '' : 's'}
                </div>
                {stats.overdueServices > 0 && (
                  <div className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />{stats.overdueServices} past due
                  </div>
                )}
              </div>
              <Link href="/services" className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1">
                Open queue<ArrowRight className="h-3 w-3" />
              </Link>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  )
}
