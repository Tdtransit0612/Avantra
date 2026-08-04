import { NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

// GET /api/health/resend — report Resend email configuration/connectivity for the
// Settings → Integrations health panel. Reports whether the API key is present, the
// from-address is set, and (best-effort) whether the key can reach Resend.
// Adapted from Top Dawg's health/resend.
//
// Staff-gated: this leaks the configured from-address and Resend connectivity, so
// require an authenticated staff session (same idiom as /api/protected/update).

export async function GET() {
  // Authenticate: staff session only. Resolve role via the service-role admin
  // client so RLS on profiles can't hide the caller's row.
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!serviceKey || !supabaseUrl) {
    return NextResponse.json({ error: 'Server not configured (missing Supabase service key).' }, { status: 500 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const admin = createServiceClient(supabaseUrl, serviceKey)
  const { data: caller } = await admin
    .from('profiles').select('role, is_master_admin').eq('id', user.id).single()
  const role = (caller?.role as string | null) ?? null
  const isStaff = caller?.is_master_admin === true
    || role === 'admin' || role === 'dispatcher' || role === 'back_office' || role === 'sales'
  if (!isStaff) return NextResponse.json({ error: 'You don’t have permission to view this.' }, { status: 403 })

  // Strip a leading UTF-8 BOM some editors prepend to .env values.
  const apiKey = process.env.RESEND_API_KEY?.replace(/^﻿/, '').trim()
  const fromEmail = process.env.RESEND_FROM_EMAIL?.trim() || null

  if (!apiKey) return NextResponse.json({ status: 'not_configured', from_configured: !!fromEmail, from_email: fromEmail })

  try {
    // Lightweight call — list domains (no side effects, fast).
    const res = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (res.ok) {
      return NextResponse.json({ status: 'connected', from_configured: !!fromEmail, from_email: fromEmail })
    }
    const body = await res.json().catch(() => ({}))
    // A send-only (restricted) key can't list domains but CAN send email — which is
    // the only thing we use Resend for. Treat that as connected, not an error.
    const name = String((body as { name?: unknown })?.name ?? '')
    const message = String((body as { message?: unknown })?.message ?? '')
    if (name === 'restricted_api_key' || /restricted|only send/i.test(message)) {
      return NextResponse.json({
        status: 'connected',
        message: 'Send-only key (valid for sending email)',
        from_configured: !!fromEmail,
        from_email: fromEmail,
      })
    }
    return NextResponse.json(
      { status: 'error', message: message || `HTTP ${res.status}`, from_configured: !!fromEmail, from_email: fromEmail },
      { status: 503 },
    )
  } catch (err: unknown) {
    return NextResponse.json(
      { status: 'error', message: err instanceof Error ? err.message : 'API error', from_configured: !!fromEmail, from_email: fromEmail },
      { status: 503 },
    )
  }
}
