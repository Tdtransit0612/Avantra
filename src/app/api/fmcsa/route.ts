import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { rateLimit } from '@/lib/rate-limit'
import { lookupByDot, lookupByMc, FmcsaNotConfiguredError } from '@/lib/fmcsa'

// POST /api/fmcsa — { mc?: string, dot?: string }
//
// FMCSA authority lookup, shared by two callers:
//   • Clients — confirm a prospective client carrier actually holds active
//     operating authority before we dispatch a load in their name, and pre-fill
//     their authority / insurance / address fields at onboarding.
//   • Brokers — check a broker's authority and identity before hauling for them.
//
// Middleware does NOT gate /api/* (see src/proxy.ts), so — exactly like Top Dawg's
// rate-con/parse — this route MUST self-authenticate. Otherwise anyone could POST
// here and burn our FMCSA webkey quota (and use us as a free FMCSA proxy). Restrict
// to signed-in office staff.
const STAFF_ROLES = ['admin', 'dispatcher', 'back_office', 'sales']

export async function POST(req: NextRequest) {
  try {
    // ── Auth gate: signed-in office staff only ──
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles').select('role, is_master_admin').eq('id', user.id).single()
    const isStaff = profile?.is_master_admin === true || STAFF_ROLES.includes((profile?.role as string) ?? '')
    if (!isStaff) return NextResponse.json({ error: 'You don’t have permission to do this.' }, { status: 403 })

    // Protect our free FMCSA quota from an authenticated hot-loop (30 lookups/min/user).
    const rl = rateLimit(`fmcsa:user:${user.id}`, 30, 60_000)
    if (!rl.ok) return NextResponse.json({ error: 'Too many requests — slow down.' }, { status: 429 })

    let body: { mc?: string; dot?: string }
    try { body = await req.json() } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }) }

    // Digits-only; a DOT wins if both are supplied (it's the more exact key).
    const dot = String(body.dot ?? '').replace(/\D/g, '')
    const mc = String(body.mc ?? '').replace(/\D/g, '')
    if (!dot && !mc) {
      return NextResponse.json({ error: 'Provide a DOT or MC number.' }, { status: 400 })
    }

    const result = dot ? await lookupByDot(dot) : await lookupByMc(mc)
    return NextResponse.json(result)
  } catch (err: unknown) {
    // Missing webkey is a configuration state, not a failure — return 200 so the UI
    // can show a graceful "FMCSA lookup not configured" note rather than an error.
    if (err instanceof FmcsaNotConfiguredError) {
      return NextResponse.json({ configured: false, error: 'FMCSA_WEBKEY not set' })
    }
    const message = err instanceof Error ? err.message : 'FMCSA lookup failed'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
