'use client'

import { useState, useEffect, useMemo } from 'react'
import Header from '@/components/layout/Header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts'
import { Loader2, Download, TrendingUp, Percent, Truck, Package } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { downloadCSV } from '@/lib/csv'
import { money, money2, num } from '@/lib/dispatch'
import type { Load, Client } from '@/types'

// Reporting reads from loads, which is where all the money on a job lives.
// Everything here is derived client-side from the delivered set for the window —
// no separate rollup table to drift out of sync.

function monthsAgo(n: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() - n)
  d.setDate(1)
  return d.toISOString().slice(0, 10)
}

const CHART_INDIGO = '#6366f1'
const CHART_EMERALD = '#10b981'

export default function ReportsPage() {
  const [loads, setLoads] = useState<Load[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [from, setFrom] = useState(monthsAgo(5))
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10))

  useEffect(() => {
    const supabase = createClient()
    ;(async () => {
      const [{ data: l }, { data: c }] = await Promise.all([
        supabase.from('loads').select('*').is('deleted_at', null).limit(5000),
        supabase.from('clients').select('*').is('deleted_at', null),
      ])
      setLoads((l ?? []) as Load[])
      setClients((c ?? []) as Client[])
      setLoading(false)
    })()
  }, [])

  // Delivered work only — a sourced or cancelled load has no earned fee.
  const inWindow = useMemo(
    () => loads.filter(l => {
      if (l.status === 'cancelled' || l.status === 'sourced' || l.status === 'offered') return false
      const d = l.delivery_date
      return !!d && d >= from && d <= to
    }),
    [loads, from, to],
  )

  const totals = useMemo(() => {
    const gross = inWindow.reduce((s, l) => s + (l.gross_total ?? 0), 0)
    const fees = inWindow.reduce((s, l) => s + (l.dispatch_fee ?? 0), 0)
    const miles = inWindow.reduce((s, l) => s + (l.miles ?? 0), 0)
    return {
      loads: inWindow.length,
      gross,
      fees,
      net: gross - fees,
      miles,
      avgFeePct: gross > 0 ? (fees / gross) * 100 : 0,
      revPerMile: miles > 0 ? gross / miles : 0,
    }
  }, [inWindow])

  const byMonth = useMemo(() => {
    const m = new Map<string, { month: string; gross: number; fees: number; loads: number }>()
    for (const l of inWindow) {
      const key = (l.delivery_date ?? '').slice(0, 7)
      if (!key) continue
      const e = m.get(key) ?? { month: key, gross: 0, fees: 0, loads: 0 }
      e.gross += l.gross_total ?? 0
      e.fees += l.dispatch_fee ?? 0
      e.loads += 1
      m.set(key, e)
    }
    return [...m.values()].sort((a, b) => a.month.localeCompare(b.month))
  }, [inWindow])

  const byClient = useMemo(() => {
    const m = new Map<string, { id: string; name: string; loads: number; gross: number; fees: number; miles: number }>()
    for (const l of inWindow) {
      if (!l.client_id) continue
      const c = clients.find(x => x.id === l.client_id)
      const name = c ? (c.dba_name || c.legal_name) : (l.client_name ?? 'Unknown')
      const e = m.get(l.client_id) ?? { id: l.client_id, name, loads: 0, gross: 0, fees: 0, miles: 0 }
      e.loads += 1
      e.gross += l.gross_total ?? 0
      e.fees += l.dispatch_fee ?? 0
      e.miles += l.miles ?? 0
      m.set(l.client_id, e)
    }
    return [...m.values()].sort((a, b) => b.fees - a.fees)
  }, [inWindow, clients])

  const byLane = useMemo(() => {
    const m = new Map<string, { lane: string; loads: number; gross: number; fees: number; miles: number }>()
    for (const l of inWindow) {
      const key = `${l.pickup_state ?? '??'} → ${l.delivery_state ?? '??'}`
      const e = m.get(key) ?? { lane: key, loads: 0, gross: 0, fees: 0, miles: 0 }
      e.loads += 1
      e.gross += l.gross_total ?? 0
      e.fees += l.dispatch_fee ?? 0
      e.miles += l.miles ?? 0
      m.set(key, e)
    }
    return [...m.values()].sort((a, b) => b.loads - a.loads).slice(0, 15)
  }, [inWindow])

  const exportClients = () => downloadCSV(
    `client-performance-${from}-to-${to}.csv`,
    ['Client', 'Loads', 'Gross Hauled', 'Avantra Fees', 'Net to Client', 'Miles', 'Avg Fee %', 'Gross $/mi'],
    byClient.map(c => [
      c.name, c.loads, c.gross, c.fees, c.gross - c.fees, c.miles,
      c.gross > 0 ? ((c.fees / c.gross) * 100).toFixed(1) : '0',
      c.miles > 0 ? (c.gross / c.miles).toFixed(2) : '',
    ]),
  )

  const exportLanes = () => downloadCSV(
    `lane-performance-${from}-to-${to}.csv`,
    ['Lane', 'Loads', 'Gross', 'Fees', 'Miles', 'Gross $/mi'],
    byLane.map(l => [
      l.lane, l.loads, l.gross, l.fees, l.miles,
      l.miles > 0 ? (l.gross / l.miles).toFixed(2) : '',
    ]),
  )

  if (loading) {
    return (
      <>
        <Header title="Reports" subtitle="Loading…" />
        <div className="flex items-center justify-center py-24 text-gray-400">
          <Loader2 className="h-6 w-6 animate-spin mr-2" />Crunching numbers…
        </div>
      </>
    )
  }

  return (
    <>
      <Header title="Reports" subtitle="Delivered work, by month, client, and lane" />
      <div className="p-6 space-y-6">

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label className="text-xs text-gray-500 dark:text-gray-400">From (delivery date)</Label>
            <Input className="mt-1 h-9 w-44" type="date" value={from} onChange={e => setFrom(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs text-gray-500 dark:text-gray-400">To</Label>
            <Input className="mt-1 h-9 w-44" type="date" value={to} onChange={e => setTo(e.target.value)} />
          </div>
          <p className="text-xs text-gray-400 pb-2.5">
            Cancelled, sourced, and offered loads are excluded — nothing was earned on them.
          </p>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <Card><CardContent className="flex items-center gap-3 py-4">
            <div className="p-2 rounded-lg bg-indigo-100 dark:bg-indigo-950 text-indigo-600"><Package className="h-5 w-5" /></div>
            <div>
              <div className="text-2xl font-bold text-gray-900 dark:text-white">{totals.loads}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Loads delivered</div>
            </div>
          </CardContent></Card>
          <Card><CardContent className="py-4">
            <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Gross hauled</div>
            <div className="text-2xl font-bold text-gray-900 dark:text-white">{money(totals.gross)}</div>
          </CardContent></Card>
          <Card><CardContent className="py-4">
            <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 flex items-center gap-1">
              <Percent className="h-3 w-3" />Avantra fees
            </div>
            <div className="text-2xl font-bold text-indigo-700 dark:text-indigo-400">{money(totals.fees)}</div>
            <div className="text-[11px] text-gray-400">{totals.avgFeePct.toFixed(1)}% of gross</div>
          </CardContent></Card>
          <Card><CardContent className="py-4">
            <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 flex items-center gap-1">
              <Truck className="h-3 w-3" />Net to clients
            </div>
            <div className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">{money(totals.net)}</div>
          </CardContent></Card>
          <Card><CardContent className="py-4">
            <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Gross per mile</div>
            <div className="text-2xl font-bold text-gray-900 dark:text-white">
              {totals.revPerMile > 0 ? `$${totals.revPerMile.toFixed(2)}` : '—'}
            </div>
            <div className="text-[11px] text-gray-400">{totals.miles.toLocaleString()} mi</div>
          </CardContent></Card>
        </div>

        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><TrendingUp className="h-4 w-4" />By month</CardTitle></CardHeader>
          <CardContent>
            {byMonth.length === 0 ? (
              <p className="text-sm text-gray-400 py-10 text-center">No delivered loads in this window.</p>
            ) : (
              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={byMonth} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-gray-200 dark:text-gray-800" />
                    <XAxis dataKey="month" tick={{ fontSize: 12 }} stroke="currentColor" className="text-gray-500" />
                    <YAxis tick={{ fontSize: 12 }} stroke="currentColor" className="text-gray-500"
                      tickFormatter={v => `$${(Number(v) / 1000).toFixed(0)}k`} />
                    <Tooltip
                      formatter={(v, name) => [money2(num(v as string | number)), String(name)]}
                      contentStyle={{ fontSize: 12, borderRadius: 8 }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="gross" name="Gross hauled" fill={CHART_EMERALD} radius={[4, 4, 0, 0]} />
                    <Bar dataKey="fees" name="Avantra fees" fill={CHART_INDIGO} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">By client</CardTitle>
            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={exportClients} disabled={byClient.length === 0}>
              <Download className="h-3.5 w-3.5" />Export
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            {byClient.length === 0 ? (
              <p className="text-sm text-gray-400 py-10 text-center">Nothing to report yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Client</TableHead>
                    <TableHead className="text-right">Loads</TableHead>
                    <TableHead className="text-right">Gross</TableHead>
                    <TableHead className="text-right">Fees</TableHead>
                    <TableHead className="text-right">Net to client</TableHead>
                    <TableHead className="text-right">Fee %</TableHead>
                    <TableHead className="text-right">Gross $/mi</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {byClient.map(c => (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium max-w-[220px] truncate">{c.name}</TableCell>
                        <TableCell className="text-right tabular-nums">{c.loads}</TableCell>
                        <TableCell className="text-right tabular-nums">{money(c.gross)}</TableCell>
                        <TableCell className="text-right tabular-nums font-semibold text-indigo-700 dark:text-indigo-400">{money(c.fees)}</TableCell>
                        <TableCell className="text-right tabular-nums text-emerald-700 dark:text-emerald-400">{money(c.gross - c.fees)}</TableCell>
                        <TableCell className="text-right tabular-nums text-sm text-gray-600 dark:text-gray-300">
                          {c.gross > 0 ? `${((c.fees / c.gross) * 100).toFixed(1)}%` : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-sm text-gray-600 dark:text-gray-300">
                          {c.miles > 0 ? `$${(c.gross / c.miles).toFixed(2)}` : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Top lanes</CardTitle>
            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={exportLanes} disabled={byLane.length === 0}>
              <Download className="h-3.5 w-3.5" />Export
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            {byLane.length === 0 ? (
              <p className="text-sm text-gray-400 py-10 text-center">Nothing to report yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Lane</TableHead>
                    <TableHead className="text-right">Loads</TableHead>
                    <TableHead className="text-right">Gross</TableHead>
                    <TableHead className="text-right">Fees</TableHead>
                    <TableHead className="text-right">Gross $/mi</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {byLane.map(l => (
                      <TableRow key={l.lane}>
                        <TableCell className="font-medium">{l.lane}</TableCell>
                        <TableCell className="text-right tabular-nums">{l.loads}</TableCell>
                        <TableCell className="text-right tabular-nums">{money(l.gross)}</TableCell>
                        <TableCell className="text-right tabular-nums text-indigo-700 dark:text-indigo-400">{money(l.fees)}</TableCell>
                        <TableCell className="text-right tabular-nums text-sm text-gray-600 dark:text-gray-300">
                          {l.miles > 0 ? `$${(l.gross / l.miles).toFixed(2)}` : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
