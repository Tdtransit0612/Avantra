'use client'

import { useState, useEffect, useCallback } from 'react'
import Header from '@/components/layout/Header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Loader2, ShieldCheck, Banknote, Play, Clock, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { dateTime, money } from '@/lib/dispatch'

// The two scheduled agents, and a way to run them by hand. Each route is
// idempotent — running it twice in a row just re-derives the same state — so the
// "Run now" button is safe to lean on while testing.

interface AgentRun {
  created_at: string
  new_value: Record<string, unknown> | null
}

interface AgentDef {
  key: string
  action: string
  path: string
  name: string
  schedule: string
  icon: React.ReactNode
  tone: string
  what: string
  summarize: (v: Record<string, unknown>) => string
}

const AGENTS: AgentDef[] = [
  {
    key: 'compliance',
    action: 'agent.compliance_watchdog',
    path: '/api/agents/compliance-watchdog',
    name: 'Compliance Watchdog',
    schedule: 'Daily · 12:00 UTC',
    icon: <ShieldCheck className="h-5 w-5" />,
    tone: 'bg-red-100 dark:bg-red-950 text-red-600',
    what:
      'Re-derives every dated compliance item against today, then emails admins anything ' +
      'expired, missing, or expiring within 30 days — including client COIs and driver ' +
      'CDL/medical dates. Without this, a certificate that was current when saved stays ' +
      'marked current forever.',
    summarize: v =>
      `${v.expired ?? 0} expired · ${v.missing ?? 0} missing · ${v.expiring ?? 0} expiring`,
  },
  {
    key: 'ar',
    action: 'agent.ar_chaser',
    path: '/api/agents/ar-chaser',
    name: 'AR Chaser',
    schedule: 'Daily · 13:00 UTC',
    icon: <Banknote className="h-5 w-5" />,
    tone: 'bg-amber-100 dark:bg-amber-950 text-amber-600',
    what:
      'Flips past-due broker invoices to Overdue, then emails the back office a worklist ' +
      'ranked by age — flagging anything not chased in a week and any broker who missed a ' +
      'promised payment date. It never emails brokers; a person works the queue.',
    summarize: v =>
      `${v.newly_overdue ?? 0} newly overdue · ${v.open_overdue ?? 0} open · ` +
      `${money(Number(v.outstanding ?? 0))} outstanding`,
  },
]

export default function AgentsPage() {
  const [runs, setRuns] = useState<Record<string, AgentRun | null>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const entries = await Promise.all(AGENTS.map(async a => {
      const { data } = await supabase.from('audit_log')
        .select('created_at, new_value')
        .eq('action', a.action)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      return [a.key, (data as AgentRun) ?? null] as const
    }))
    setRuns(Object.fromEntries(entries))
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const run = async (a: AgentDef) => {
    setBusy(a.key)
    try {
      const res = await fetch(a.path)
      const json = await res.json() as Record<string, unknown> & { error?: string }
      if (!res.ok) { toast.error(json.error ?? 'The agent failed.'); return }
      toast.success(`${a.name} ran`, {
        description: json.emailed ? 'Digest emailed to admins.' : 'Nothing worth emailing.',
      })
      load()
    } catch {
      toast.error('Could not reach the server.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <Header title="Agents" subtitle="Scheduled sweeps that keep the boards honest" />
      <div className="p-6 space-y-6">

        <div className="flex items-start gap-2 rounded-lg border border-indigo-200 dark:border-indigo-900/60 bg-indigo-50/70 dark:bg-indigo-950/30 px-4 py-3 text-sm">
          <Clock className="h-4 w-4 text-indigo-500 shrink-0 mt-0.5" />
          <div className="text-gray-700 dark:text-gray-200">
            These run automatically on Vercel Cron once <code className="text-xs">CRON_SECRET</code> is set
            and the schedules are declared in <code className="text-xs">vercel.json</code>. Digest emails
            need <code className="text-xs">RESEND_API_KEY</code>; without it the sweeps still run and update
            the data, they just don&apos;t email.
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {AGENTS.map(a => {
            const last = runs[a.key]
            const v = (last?.new_value ?? {}) as Record<string, unknown>
            return (
              <Card key={a.key}>
                <CardHeader className="flex-row items-start justify-between space-y-0 gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className={`p-2 rounded-lg shrink-0 ${a.tone}`}>{a.icon}</div>
                    <div className="min-w-0">
                      <CardTitle className="text-base">{a.name}</CardTitle>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{a.schedule}</p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    className="h-8 gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-700 text-white shrink-0"
                    disabled={busy === a.key}
                    onClick={() => run(a)}
                  >
                    {busy === a.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                    Run now
                  </Button>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-gray-600 dark:text-gray-300">{a.what}</p>

                  <div className="rounded-lg border dark:border-gray-800 px-3 py-2">
                    <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
                      Last run
                    </div>
                    {loading ? (
                      <div className="flex items-center gap-2 text-xs text-gray-400">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />Checking…
                      </div>
                    ) : !last ? (
                      <div className="flex items-center gap-1.5 text-xs text-gray-400">
                        <AlertTriangle className="h-3.5 w-3.5" />Never run
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-100">
                          {dateTime(last.created_at)}
                          <Badge className="border bg-gray-100 text-gray-700 border-gray-200 dark:bg-white/10 dark:text-gray-300 dark:border-white/10 text-[10px]">
                            {v.scheduled ? 'scheduled' : 'manual'}
                          </Badge>
                          {v.emailed ? (
                            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                              <CheckCircle2 className="h-3 w-3" />emailed
                            </span>
                          ) : null}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          {a.summarize(v)}
                        </div>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>
    </>
  )
}
