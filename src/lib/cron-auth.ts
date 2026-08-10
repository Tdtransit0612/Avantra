import { NextRequest, NextResponse } from 'next/server'
import { createClient as createAdmin, type SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { STAFF_ROLES } from '@/lib/access'

// Shared authorization for the cron agents. Each agent is reachable two ways:
//   • Vercel Cron, which sends `Authorization: Bearer $CRON_SECRET`
//   • a signed-in staff member hitting "Run now" from the app
//
// Without CRON_SECRET set, the Bearer path is refused outright rather than
// falling open — an unauthenticated GET that sweeps the whole book and emails a
// digest is not something to leave exposed on a public URL.

export interface CronContext {
  admin: SupabaseClient
  /** Set when a human triggered the run; null for a scheduled run. */
  actingUserId: string | null
  /** True when this came from the scheduler rather than a person. */
  scheduled: boolean
}

export async function authorizeCron(
  req: NextRequest,
): Promise<{ ctx: CronContext } | { error: NextResponse }> {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!serviceKey || !supabaseUrl) {
    return { error: NextResponse.json({ error: 'Server not configured (missing Supabase service key).' }, { status: 500 }) }
  }
  const admin = createAdmin(supabaseUrl, serviceKey)

  const authHeader = req.headers.get('authorization') ?? ''
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    return { ctx: { admin, actingUserId: null, scheduled: true } }
  }

  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const { data: profile } = await admin
    .from('profiles').select('role, is_master_admin').eq('id', user.id).single()
  const role = (profile?.role as string | null) ?? null
  const isStaff = profile?.is_master_admin === true
    || (role !== null && (STAFF_ROLES as readonly string[]).includes(role))
  if (!isStaff) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  return { ctx: { admin, actingUserId: user.id, scheduled: false } }
}

/** Recipients for agent digests: every admin / master admin with an email. */
export async function adminRecipients(admin: SupabaseClient): Promise<string[]> {
  const { data } = await admin
    .from('profiles')
    .select('email, role, is_master_admin')
    .or('role.eq.admin,is_master_admin.eq.true')
  return (data ?? [])
    .map(r => (r.email as string | null) ?? '')
    .filter(e => e.includes('@'))
}

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Shared shell for a digest email so the two agents look like one product. */
export function digestHtml(opts: {
  title: string
  subtitle: string
  bodyHtml: string
  appUrl?: string
  ctaLabel?: string
  ctaPath?: string
}): string {
  const base = opts.appUrl || process.env.NEXT_PUBLIC_APP_URL || ''
  const cta = base && opts.ctaPath
    ? `<div style="margin-top:20px;text-align:center">
         <a href="${base}${opts.ctaPath}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600">${escapeHtml(opts.ctaLabel ?? 'Open Avantra')}</a>
       </div>`
    : ''
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto">
      <div style="background:#312e81;padding:22px 24px;border-radius:8px 8px 0 0">
        <h2 style="color:#ffffff;margin:0;font-size:19px">Avantra Carrier Services</h2>
        <p style="color:#c7d2fe;margin:4px 0 0;font-size:13px">${escapeHtml(opts.subtitle)}</p>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px;background:#fff">
        <h3 style="margin:0 0 14px;font-size:16px;color:#111827">${escapeHtml(opts.title)}</h3>
        ${opts.bodyHtml}
        ${cta}
        <div style="margin-top:20px;padding-top:16px;border-top:1px solid #f3f4f6;color:#9ca3af;font-size:12px">
          Automated digest from Avantra. You're receiving this because you're an admin.
        </div>
      </div>
    </div>`
}
