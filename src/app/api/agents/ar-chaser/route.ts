import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { authorizeCron, adminRecipients, escapeHtml, digestHtml } from '@/lib/cron-auth'

/**
 * GET /api/agents/ar-chaser — daily AR sweep against broker invoices.
 *
 * Runs via Vercel Cron (Bearer CRON_SECRET) or on demand from a staff session.
 *
 * Two jobs:
 *   1. Flip `sent` / `factored` / `partial` invoices past their due date to
 *      `overdue`. Nothing else does this — status is set by humans at each step,
 *      so without a sweep an invoice sits at "sent" forever and the aging tiles
 *      under-report.
 *   2. Email the back office a worklist: what's overdue, how long, how many
 *      times we've already chased it, and anything with a promised-payment date
 *      that has now come and gone.
 *
 * It deliberately does NOT email brokers. Chasing is a judgement call and a
 * relationship — this surfaces the queue, a person works it and logs the trace.
 */

const STALE_TRACE_DAYS = 7

function daysPastDue(due: string | null): number {
  if (!due) return 0
  const d = new Date(`${due.slice(0, 10)}T00:00:00`).getTime()
  const now = new Date(new Date().toDateString()).getTime()
  return Math.round((now - d) / 86_400_000)
}

export async function GET(req: NextRequest) {
  const auth = await authorizeCron(req)
  if ('error' in auth) return auth.error
  const { admin, actingUserId, scheduled } = auth.ctx

  const today = new Date().toISOString().slice(0, 10)

  // ── 1. Mark newly-overdue invoices ────────────────────────────────────────
  // `partial` is included: a short payment still leaves a balance owed.
  const { data: flipped, error: flipErr } = await admin
    .from('invoices')
    .update({ status: 'overdue' })
    .in('status', ['sent', 'factored', 'partial'])
    .lt('due_date', today)
    .select('id, invoice_number')
  if (flipErr) {
    return NextResponse.json({ error: `Could not update overdue invoices: ${flipErr.message}` }, { status: 500 })
  }

  // ── 2. Build the worklist ─────────────────────────────────────────────────
  const [{ data: invoices }, { data: clients }, { data: brokers }] = await Promise.all([
    admin.from('invoices')
      .select('id, invoice_number, client_id, broker_id, amount, amount_paid, due_date, status, trace_count, last_traced_at, next_follow_up')
      .in('status', ['overdue', 'disputed'])
      .order('due_date', { ascending: true }),
    admin.from('clients').select('id, legal_name, dba_name'),
    admin.from('brokers').select('id, name, do_not_use'),
  ])

  const clientName = new Map((clients ?? []).map(c => [c.id as string, (c.dba_name as string | null) || (c.legal_name as string)]))
  const brokerName = new Map((brokers ?? []).map(b => [b.id as string, b.name as string]))

  const staleCutoff = Date.now() - STALE_TRACE_DAYS * 86_400_000

  const rows = (invoices ?? []).map(i => {
    const outstanding = Number(i.amount ?? 0) - Number(i.amount_paid ?? 0)
    const lastTraced = i.last_traced_at ? new Date(i.last_traced_at as string).getTime() : 0
    return {
      id: i.id as string,
      invoice_number: i.invoice_number as string,
      client: clientName.get(i.client_id as string) ?? '—',
      broker: brokerName.get(i.broker_id as string) ?? '—',
      outstanding,
      due_date: i.due_date as string | null,
      pastDue: daysPastDue(i.due_date as string | null),
      traceCount: Number(i.trace_count ?? 0),
      // Never chased, or not chased in a week — these are the ones to work today.
      needsTrace: lastTraced < staleCutoff,
      // A promise that has come due and the money still isn't here.
      brokenPromise: !!i.next_follow_up && (i.next_follow_up as string) < today,
      disputed: i.status === 'disputed',
    }
  }).filter(r => r.outstanding > 0)

  rows.sort((a, b) => b.pastDue - a.pastDue)

  const totalOutstanding = rows.reduce((s, r) => s + r.outstanding, 0)
  const needsTrace = rows.filter(r => r.needsTrace)
  const brokenPromises = rows.filter(r => r.brokenPromise)
  const over60 = rows.filter(r => r.pastDue > 60)

  const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`

  // ── 3. Digest ─────────────────────────────────────────────────────────────
  const worthSending = rows.length > 0
  let emailed = false
  let recipients: string[] = []

  if (worthSending && process.env.RESEND_API_KEY) {
    recipients = await adminRecipients(admin)
    if (recipients.length > 0) {
      const body = `
        <p style="margin:0 0 14px;font-size:14px;color:#374151">
          <strong>${money(totalOutstanding)}</strong> outstanding across ${rows.length} invoice${rows.length === 1 ? '' : 's'}.
          ${needsTrace.length} need${needsTrace.length === 1 ? 's' : ''} a call today.
          ${over60.length > 0 ? `<span style="color:#dc2626">${over60.length} over 60 days.</span>` : ''}
        </p>
        ${brokenPromises.length > 0 ? `
          <p style="margin:0 0 12px;padding:10px 12px;background:#fef2f2;border-left:3px solid #dc2626;font-size:13px;color:#991b1b">
            ${brokenPromises.length} broker${brokenPromises.length === 1 ? '' : 's'} missed a promised payment date.
          </p>` : ''}
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr style="text-align:left;color:#6b7280;font-size:11px;text-transform:uppercase">
            <th style="padding:6px 4px">Invoice</th><th style="padding:6px 4px">Broker</th>
            <th style="padding:6px 4px">Client</th><th style="padding:6px 4px;text-align:right">Open</th>
            <th style="padding:6px 4px;text-align:right">Late</th><th style="padding:6px 4px;text-align:right">Traces</th>
          </tr>
          ${rows.slice(0, 40).map(r => `
            <tr style="border-top:1px solid #f3f4f6">
              <td style="padding:6px 4px;font-weight:600">${escapeHtml(r.invoice_number)}${r.disputed ? ' <span style="color:#ea580c;font-size:11px">disputed</span>' : ''}</td>
              <td style="padding:6px 4px">${escapeHtml(r.broker)}</td>
              <td style="padding:6px 4px;color:#6b7280">${escapeHtml(r.client)}</td>
              <td style="padding:6px 4px;text-align:right">${money(r.outstanding)}</td>
              <td style="padding:6px 4px;text-align:right;${r.pastDue > 60 ? 'color:#dc2626;font-weight:700' : r.pastDue > 30 ? 'color:#d97706' : ''}">${r.pastDue}d</td>
              <td style="padding:6px 4px;text-align:right;color:${r.needsTrace ? '#dc2626' : '#6b7280'}">${r.traceCount}${r.needsTrace ? ' ⚑' : ''}</td>
            </tr>`).join('')}
        </table>
        ${rows.length > 40 ? `<p style="margin:12px 0 0;font-size:12px;color:#9ca3af">…and ${rows.length - 40} more.</p>` : ''}
        <p style="margin:14px 0 0;font-size:12px;color:#9ca3af">⚑ = not chased in ${STALE_TRACE_DAYS}+ days.</p>`

      try {
        const resend = new Resend(process.env.RESEND_API_KEY)
        await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL ?? 'Avantra <onboarding@resend.dev>',
          to: recipients,
          subject: `AR: ${money(totalOutstanding)} overdue, ${needsTrace.length} to chase · Avantra`,
          html: digestHtml({
            title: 'Invoices to chase today',
            subtitle: 'Daily AR sweep',
            bodyHtml: body,
            ctaLabel: 'Open the AR board',
            ctaPath: '/invoicing',
          }),
        })
        emailed = true
      } catch (e) {
        console.error('[ar-chaser] email failed:', e)
      }
    }
  }

  await admin.from('audit_log').insert({
    user_id: actingUserId,
    action: 'agent.ar_chaser',
    table_name: 'invoices',
    new_value: {
      scheduled,
      newly_overdue: flipped?.length ?? 0,
      open_overdue: rows.length,
      outstanding: totalOutstanding,
      needs_trace: needsTrace.length,
      broken_promises: brokenPromises.length,
      emailed,
    },
  }).then(() => {}, () => {})

  return NextResponse.json({
    ok: true,
    scheduled,
    newlyOverdue: flipped?.length ?? 0,
    openOverdue: rows.length,
    outstanding: totalOutstanding,
    needsTrace: needsTrace.length,
    brokenPromises: brokenPromises.length,
    emailed,
  })
}
