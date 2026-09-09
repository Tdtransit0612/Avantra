import { NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

// POST /api/auth/mfa-enrolled — mark the caller as 2FA-enrolled.
//
// profiles.mfa_enrolled is what the middleware trusts when it decides whether to
// force a user to /setup-2fa. It used to be written straight from the browser
// after a successful TOTP verify, which made it self-attested: any account could
// PATCH the flag true and walk past the control that protects it. Migration 08
// pins the column against non-service-role writes, so this route is now the only
// way to set it.
//
// Being the only way is not enough on its own — a route that simply sets the
// flag for whoever calls it is the same hole with an extra step. So this asks
// Supabase for the caller's ACTUAL factors and refuses unless a verified TOTP
// factor exists. The claim is checked rather than accepted.
//
// Middleware does not gate /api/*, so this route self-authenticates.

export async function POST() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!serviceKey || !supabaseUrl) {
    return NextResponse.json(
      { error: 'Server not configured (missing Supabase service key).' },
      { status: 500 },
    )
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const admin = createServiceClient(supabaseUrl, serviceKey)

  // The authoritative check. Read the factors from Supabase itself rather than
  // believing the caller — the browser reporting "I verified" is exactly the
  // assertion this endpoint exists to stop trusting.
  const { data: factors, error: factorErr } = await admin.auth.admin.mfa.listFactors({
    userId: user.id,
  })
  if (factorErr) {
    // Fail CLOSED. If we cannot confirm enrollment, we do not record it — the
    // cost is the user repeating a step, versus a permanently disabled control.
    return NextResponse.json(
      { error: 'Could not confirm your authenticator with the server. Try again.' },
      { status: 502 },
    )
  }

  const verified = (factors?.factors ?? []).some(
    (f) => f.factor_type === 'totp' && f.status === 'verified',
  )
  if (!verified) {
    return NextResponse.json(
      { error: 'No verified authenticator found on this account.' },
      { status: 400 },
    )
  }

  const { error: updateErr } = await admin
    .from('profiles')
    .update({ mfa_enrolled: true })
    .eq('id', user.id)
  if (updateErr) {
    return NextResponse.json({ error: 'Could not save your 2FA status.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
