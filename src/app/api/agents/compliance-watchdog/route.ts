import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { authorizeCron, adminRecipients, escapeHtml, digestHtml } from '@/lib/cron-auth'
import { COMPLIANCE_KIND_LABEL } from '@/lib/dispatch'

/**
 * GET /api/agents/compliance-watchdog — daily sweep of everything that expires.
 *
 * Runs via Vercel Cron (Bearer CRON_SECRET) or on demand from a staff session.
 *
 * There's a subtlety worth stating: compliance_items.status is derived by a
 * BEFORE-INSERT/UPDATE trigger, so it only re-evaluates when a row is WRITTEN. A
 * COI that was "ok" when saved silently becomes stale as the calendar moves. So
 * the first thing this agent does is touch every dated row (`last_checked_at =
 * now()`), which fires derive_compliance_status() and brings the whole board
 * back in line with today. That touch IS the job; the email is just the report.
 *
 * Driver CDL / medical dates live on client_drivers rather than compliance_items,
 * so they're swept separately and folded into the same digest — same as the
 * /compliance page does.
 */

const HORIZON_DAYS = 30

interface DigestRow {
  client: string
  item: string
  subject: string
  expiry: string | null
  days: number | null
  severity: 'expired' | 'expiring' | 'missing'
}

function daysUntil(d: string | null): number | null {
  if (!d) return null
  const then = new Date(`${d.slice(0, 10)}T00:00:00`).getTime()
  const now = new Date(new Date().toDateString()).getTime()
  return Math.round((then - now) / 86_400_000)
}

export async function GET(req: NextRequest) {
  const auth = await authorizeCron(req)
  if ('error' in auth) return auth.error
  const { admin, actingUserId, scheduled } = auth.ctx

  // ── 1. Re-derive every dated compliance row against today ─────────────────
  // Touching last_checked_at fires the status trigger. Rows with no expiry date
  // are left alone: their status is about presence, not the calendar.
  const { error: touchErr } = await admin
    .from('compliance_items')
    .update({ last_checked_at: new Date().toISOString() })
    .not('expiry_date', 'is', null)
    .neq('status', 'not_applicable')
  if (touchErr) {
    return NextResponse.json({ error: `Could not refresh compliance statuses: ${touchErr.message}` }, { status: 500 })
  }

  // ── 2. Collect what needs attention ───────────────────────────────────────
  const [{ data: items }, { data: clients }, { data: drivers }] = await Promise.all([
    admin.from('compliance_items')
      .select('client_id, kind, label, status, expiry_date')
      .in('status', ['expired', 'expiring', 'missing']),
    admin.from('clients')
      .select('id, legal_name, dba_name, status, insurance_expiry, authority_status')
      .is('deleted_at', null)
      .in('status', ['active', 'onboarding']),
    admin.from('client_drivers')
      .select('client_id, full_name, cdl_expiry, medical_expiry')
      .eq('status', 'active'),
  ])

  const clientMap = new Map(
    (clients ?? []).map(c => [c.id as string, (c.dba_name as string | null) || (c.legal_name as string)]),
  )
  const nameOf = (id: string | null) => (id ? clientMap.get(id) ?? null : null)

  const rows: DigestRow[] = []

  for (const i of items ?? []) {
    // Only report on clients we're actively serving; a terminated client's
    // expired COI is not an action item.
    const client = nameOf(i.client_id as string)
    if (!client) continue
    rows.push({
      client,
      item: (i.label as string | null) || COMPLIANCE_KIND_LABEL[i.kind as string] || (i.kind as string),
      subject: client,
      expiry: i.expiry_date as string | null,
      days: daysUntil(i.expiry_date as string | null),
      severity: i.status as DigestRow['severity'],
    })
  }

  for (const c of clients ?? []) {
    const d = daysUntil(c.insurance_expiry as string | null)
    if (d !== null && d <= HORIZON_DAYS) {
      rows.push({
        client: (c.dba_name as string | null) || (c.legal_name as string),
        item: 'Certificate of insurance',
        subject: (c.dba_name as string | null) || (c.legal_name as string),
        expiry: c.insurance_expiry as string,
        days: d,
        severity: d < 0 ? 'expired' : 'expiring',
      })
    }
    if (c.authority_status === 'inactive' || c.authority_status === 'not_authorized') {
      rows.push({
        client: (c.dba_name as string | null) || (c.legal_name as string),
        item: 'Operating authority',
        subject: (c.dba_name as string | null) || (c.legal_name as string),
        expiry: null, days: null, severity: 'expired',
      })
    }
  }

  for (const dr of drivers ?? []) {
    const client = nameOf(dr.client_id as string)
    if (!client) continue
    for (const [field, label] of [['cdl_expiry', 'CDL'], ['medical_expiry', 'Medical card']] as const) {
      const val = dr[field] as string | null
      const d = daysUntil(val)
      if (d !== null && d <= HORIZON_DAYS) {
        rows.push({
          client, item: label, subject: dr.full_name as string,
          expiry: val, days: d, severity: d < 0 ? 'expired' : 'expiring',
        })
      }
    }
  }

  // Worst first, then soonest.
  const rank = { expired: 0, missing: 1, expiring: 2 } as const
  rows.sort((a, b) =>
    rank[a.severity] - rank[b.severity] || (a.days ?? 9999) - (b.days ?? 9999))

  const expired = rows.filter(r => r.severity === 'expired').length
  const expiring = rows.filter(r => r.severity === 'expiring').length
  const missing = rows.filter(r => r.severity === 'missing').length

  // ── 3. Email a digest, but only when it's worth interrupting for ──────────
  // A scheduled run that finds only future-dated items stays quiet; a human who
  // clicked "Run now" always gets a reply so the button doesn't feel broken.
  const worthSending = expired > 0 || missing > 0 || expiring > 0
  let emailed = false
  let recipients: string[] = []

  if (worthSending && process.env.RESEND_API_KEY) {
    recipients = await adminRecipients(admin)
    if (recipients.length > 0) {
      const badge = (s: DigestRow['severity']) =>
        s === 'expired' ? '<span style="color:#dc2626;font-weight:700">EXPIRED</span>'
        : s === 'missing' ? '<span style="color:#ea580c;font-weight:700">MISSING</span>'
        : '<span style="color:#d97706;font-weight:700">EXPIRING</span>'

      const body = `
        <p style="margin:0 0 14px;font-size:14px;color:#374151">
          ${expired} expired · ${missing} missing · ${expiring} expiring within ${HORIZON_DAYS} days.
        </p>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr style="text-align:left;color:#6b7280;font-size:11px;text-transform:uppercase">
            <th style="padding:6px 4px">Client</th><th style="padding:6px 4px">Item</th>
            <th style="padding:6px 4px">Who</th><th style="padding:6px 4px">Expires</th>
            <th style="padding:6px 4px">Status</th>
          </tr>
          ${rows.slice(0, 40).map(r => `
            <tr style="border-top:1px solid #f3f4f6">
              <td style="padding:6px 4px">${escapeHtml(r.client)}</td>
              <td style="padding:6px 4px">${escapeHtml(r.item)}</td>
              <td style="padding:6px 4px;color:#6b7280">${escapeHtml(r.subject)}</td>
              <td style="padding:6px 4px;color:#6b7280">${escapeHtml(r.expiry ?? '—')}${r.days !== null ? ` (${r.days < 0 ? `${-r.days}d ago` : `${r.days}d`})` : ''}</td>
              <td style="padding:6px 4px">${badge(r.severity)}</td>
            </tr>`).join('')}
        </table>
        ${rows.length > 40 ? `<p style="margin:12px 0 0;font-size:12px;color:#9ca3af">…and ${rows.length - 40} more.</p>` : ''}`

      try {
        const resend = new Resend(process.env.RESEND_API_KEY)
        await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL ?? 'Avantra <onboarding@resend.dev>',
          to: recipients,
          subject: `Compliance: ${expired} expired, ${expiring} expiring · Avantra`,
          html: digestHtml({
            title: 'Compliance needs attention',
            subtitle: 'Daily compliance watchdog',
            bodyHtml: body,
            ctaLabel: 'Open compliance board',
            ctaPath: '/compliance',
          }),
        })
        emailed = true
      } catch (e) {
        console.error('[compliance-watchdog] email failed:', e)
      }
    }
  }

  await admin.from('audit_log').insert({
    user_id: actingUserId,
    action: 'agent.compliance_watchdog',
    table_name: 'compliance_items',
    new_value: { scheduled, expired, expiring, missing, total: rows.length, emailed, recipients: recipients.length },
  }).then(() => {}, () => {})

  return NextResponse.json({
    ok: true, scheduled, expired, expiring, missing, total: rows.length, emailed,
  })
}
