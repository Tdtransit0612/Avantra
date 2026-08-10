import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { rateLimit, getIp } from '@/lib/rate-limit'

// ── High-risk action definitions ──────────────────────────────────────────────

interface RiskDef {
  label: string
  severity: 'critical' | 'high' | 'medium'
  color: string    // hex for email header
}

// Keep in sync with ALERT_ACTIONS in @/lib/audit — that list decides which
// client-side actions POST here at all, this one decides how they're labelled.
const HIGH_RISK: Record<string, RiskDef> = {
  'user.role_change':        { label: 'User Role Changed',        severity: 'critical', color: '#dc2626' },
  'client.status_change':    { label: 'Client Status Changed',    severity: 'medium',   color: '#d97706' },
  // Money that stops being owed to us, or to our client.
  'invoice.void':            { label: 'Invoice Voided',           severity: 'critical', color: '#dc2626' },
  'statement.void':          { label: 'Fee Statement Voided',     severity: 'critical', color: '#dc2626' },
  // Fee overrides are how revenue quietly walks out the door.
  'load.money_update':       { label: 'Load Rates / Fee Changed', severity: 'high',     color: '#ea580c' },
}

// Wildcard matches — any action containing these substrings
const HIGH_RISK_PATTERNS = [
  { pattern: 'bulk',   label: 'Bulk Operation',  severity: 'high'     as const, color: '#ea580c' },
  { pattern: 'delete', label: 'Record Deleted',  severity: 'high'     as const, color: '#dc2626' },
  { pattern: 'export', label: 'Data Exported',   severity: 'critical' as const, color: '#dc2626' },
  { pattern: 'void',   label: 'Record Voided',   severity: 'critical' as const, color: '#dc2626' },
]

export function getRiskDef(action: string): RiskDef | null {
  if (HIGH_RISK[action]) return HIGH_RISK[action]
  for (const { pattern, label, severity, color } of HIGH_RISK_PATTERNS) {
    if (action.includes(pattern)) return { label, severity, color }
  }
  return null
}

// ── HTML escaping helper ──────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ── Startup check ─────────────────────────────────────────────────────────────

if (process.env.NODE_ENV === 'production' && !process.env.RESEND_FROM_EMAIL) {
  console.warn('[audit-alert] RESEND_FROM_EMAIL not set — alert emails will use sandbox domain and may land in spam')
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // NOTE: The IP-based rate limiter is in-memory and resets on cold starts.
  // This is an infrastructure limitation; a Redis-backed store would be needed
  // to persist limits across instances/restarts. The per-user limit below is
  // more meaningful for the authenticated-user threat model and survives proxy
  // IP collapse.
  const rl = rateLimit(`audit-alert:${getIp(req)}`, 60, 60_000)
  if (!rl.ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  // Require authentication — only internal calls from authenticated STAFF.
  // External portal logins (carrier/shipper) share this Supabase project, so
  // authentication alone is not enough: gate on a staff role or they could
  // trigger admin security-alert emails.
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const STAFF_ROLES = ['admin', 'dispatcher', 'back_office', 'sales']
  const { data: callerProfile } = await supabase
    .from('profiles').select('role, is_master_admin').eq('id', user.id).single()
  const isStaff = callerProfile?.is_master_admin === true || STAFF_ROLES.includes(callerProfile?.role ?? '')
  if (!isStaff) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Per-user rate limit — survives proxy IP collapse and is more meaningful
  // for the authenticated-user threat model (10 calls/minute per user).
  const rlUser = rateLimit(`audit-alert:user:${user.id}`, 10, 60_000)
  if (!rlUser.ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }) }

  const action     = body.action as string | undefined
  const tableName  = body.table_name as string | undefined
  const recordId   = body.record_id  as string | undefined
  const oldValue   = body.old_value  as Record<string, unknown> | undefined
  const newValue   = body.new_value  as Record<string, unknown> | undefined

  if (!action) return NextResponse.json({ error: 'Missing action' }, { status: 400 })

  const risk = getRiskDef(action)
  if (!risk) return NextResponse.json({ skipped: true, reason: 'Not a high-risk action' })

  const resendKey = process.env.RESEND_API_KEY
  if (!resendKey) return NextResponse.json({ skipped: true, reason: 'RESEND_API_KEY not set' })

  // Fetch admin-only emails to notify (dispatchers excluded from security alerts)
  const admin = createAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  const { data: admins } = await admin
    .from('profiles')
    .select('email, full_name')
    .in('role', ['admin'])

  const recipients = (admins ?? [])
    .map(a => a.email as string)
    .filter(Boolean)

  if (recipients.length === 0) {
    return NextResponse.json({ skipped: true, reason: 'No admin recipients found' })
  }

  // Get the acting user's profile for the email
  const { data: actor } = await admin
    .from('profiles')
    .select('full_name, email, role')
    .eq('id', user.id)
    .single()

  const now = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })
  const severityLabel = risk.severity.toUpperCase()

  // Escape all user-controlled values before HTML interpolation (C2)
  const safeAction    = escapeHtml(action)
  const safeTable     = tableName ? escapeHtml(tableName) : undefined
  const safeRecordId  = recordId  ? escapeHtml(recordId)  : undefined
  const safeName      = escapeHtml(actor?.full_name ?? 'Unknown')
  const safeEmail     = escapeHtml(actor?.email ?? user.email ?? '')
  const safeRole      = escapeHtml(actor?.role ?? '?')
  const safeNow       = escapeHtml(now)

  const formatValue = (v: unknown) =>
    v ? `<pre style="background:#f3f4f6;padding:8px;border-radius:4px;font-size:12px;overflow-x:auto;margin:0">${escapeHtml(JSON.stringify(v, null, 2))}</pre>` : '<em style="color:#9ca3af">—</em>'

  const html = `
    <div style="font-family:sans-serif;max-width:580px;margin:0 auto">
      <div style="background:${risk.color};padding:20px 24px;border-radius:8px 8px 0 0">
        <h2 style="color:white;margin:0;font-size:17px">⚠️ ${severityLabel}: ${risk.label}</h2>
        <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:13px">TD Transit · Audit Alert</p>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px;background:#fff">
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:5px 0;color:#6b7280;font-size:13px;width:140px">Action</td><td style="padding:5px 0;font-weight:600;font-size:13px;font-family:monospace">${safeAction}</td></tr>
          <tr><td style="padding:5px 0;color:#6b7280;font-size:13px">Performed by</td><td style="padding:5px 0;font-size:13px">${safeName} (${safeEmail}) · <em>${safeRole}</em></td></tr>
          <tr><td style="padding:5px 0;color:#6b7280;font-size:13px">Time (CT)</td><td style="padding:5px 0;font-size:13px">${safeNow}</td></tr>
          ${safeTable    ? `<tr><td style="padding:5px 0;color:#6b7280;font-size:13px">Table</td><td style="padding:5px 0;font-size:13px;font-family:monospace">${safeTable}</td></tr>` : ''}
          ${safeRecordId ? `<tr><td style="padding:5px 0;color:#6b7280;font-size:13px">Record ID</td><td style="padding:5px 0;font-size:12px;font-family:monospace;word-break:break-all">${safeRecordId}</td></tr>` : ''}
        </table>
        ${oldValue ? `<div style="margin-top:16px"><p style="font-size:12px;color:#6b7280;margin-bottom:4px;font-weight:600">Before</p>${formatValue(oldValue)}</div>` : ''}
        ${newValue ? `<div style="margin-top:12px"><p style="font-size:12px;color:#6b7280;margin-bottom:4px;font-weight:600">After</p>${formatValue(newValue)}</div>` : ''}
        <div style="margin-top:20px;padding-top:16px;border-top:1px solid #f3f4f6;color:#9ca3af;font-size:12px">
          Automated security alert from TD Transit · Audit Log
        </div>
      </div>
    </div>
  `

  const resend = new Resend(resendKey)
  const FROM = process.env.RESEND_FROM_EMAIL ?? 'TD Transit <onboarding@resend.dev>'
  const subject = `[${severityLabel}] ${risk.label} — TD Transit`

  // Send one email per recipient so admins don't see each other's addresses (H3)
  try {
    await Promise.all(
      recipients.map(email =>
        resend.emails.send({ from: FROM, to: [email], subject, html })
      )
    )
  } catch (err) {
    console.error('[audit-alert] Resend failed:', err)
    return NextResponse.json({ error: 'Email send failed' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, notified: recipients.length })
}
