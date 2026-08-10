import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { isRouteAllowed, type RolePermissions } from '@/lib/access'
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, supabaseConfigured, missingSupabaseVars,
} from '@/lib/supabase/config'

// ── CSP nonce helper ──────────────────────────────────────────────────────────
// Generates a fresh per-request nonce and the matching Content-Security-Policy.
// 'unsafe-inline' is removed from script-src; the nonce + strict-dynamic replace it.
// Styles keep 'unsafe-inline' because Tailwind injects them at runtime in dev.
function buildCsp(nonce: string) {
  const isDev = process.env.NODE_ENV === 'development'
  return [
    "default-src 'self'",
    // maps.googleapis.com loads the Maps JS API (address autocomplete + lane maps);
    // strict-dynamic lets it propagate trust to sub-scripts
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://maps.googleapis.com${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    // Supabase Storage (signed doc/image URLs) + Google Maps tiles
    "img-src 'self' data: blob: https://*.supabase.co https://*.googleapis.com https://*.gstatic.com",
    // Supabase (REST + realtime) + Google Maps + OSM geocoding
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://nominatim.openstreetmap.org https://maps.googleapis.com https://maps.gstatic.com",
    // Google Maps uses blob: web workers
    "worker-src 'self' blob:",
    // blob: allows inline PDF preview via <embed> / <iframe> with a local blob URL
    "frame-src blob:",
    "object-src blob:",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join('; ')
}

export async function updateSession(request: NextRequest) {
  // Generate a unique nonce for this request
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const csp   = buildCsp(nonce)

  // Inject the nonce into request headers so server components can read it
  // via `headers().get('x-nonce')`.  All downstream NextResponse.next() calls
  // must forward these headers so the injection is visible to RSC.
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('Content-Security-Policy', csp)

  // Helper: stamp the nonce + CSP onto any response before it leaves this function
  const stamp = (res: NextResponse) => {
    res.headers.set('Content-Security-Policy', csp)
    return res
  }

  let supabaseResponse = NextResponse.next({
    request: { headers: requestHeaders },
  })

  // Not configured yet (fresh clone, no .env.local): pass the request straight
  // through instead of letting createServerClient throw. Every route would 500
  // otherwise — including /login — with nothing on screen saying why. The pages
  // render a setup screen in this state; there is no security cost, because with
  // no Supabase there is no session and no data to protect.
  if (!supabaseConfigured()) {
    console.warn(
      `[proxy] Supabase is not configured — missing ${missingSupabaseVars().join(', ')}. ` +
      'Copy .env.local.example to .env.local and fill it in. Auth is disabled until then.',
    )
    return stamp(supabaseResponse)
  }

  const supabase = createServerClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          // Preserve the injected headers when refreshing the response
          supabaseResponse = NextResponse.next({ request: { headers: requestHeaders } })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Wrap auth resolution so a transient Supabase outage can't 500 every protected
  // route — treat an unreachable auth service as "not authenticated" (→ /login).
  let user: Awaited<ReturnType<typeof supabase.auth.getUser>>['data']['user'] = null
  try {
    const res = await supabase.auth.getUser()
    user = res.data.user
  } catch {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return stamp(NextResponse.redirect(url))
  }

  const pathname         = request.nextUrl.pathname
  const isAuthPage       = pathname.startsWith('/login') || pathname.startsWith('/register')
  const isPendingPage    = pathname.startsWith('/pending')
  const isTerminatedPage = pathname.startsWith('/terminated')
  const isMfaSetupPage   = pathname.startsWith('/setup-2fa')
  const isApiRoute       = pathname.startsWith('/api')
  // /auth/* (e.g. the email-confirmation callback) must run BEFORE any auth check —
  // the visitor has a ?code= but no session cookie yet, and the callback route is
  // what exchanges it. Gating it would bounce email-confirm signups to /login.
  const isCallbackRoute  = pathname.startsWith('/auth')
  const isProtected      = !isAuthPage && !isApiRoute && !isCallbackRoute && pathname !== '/'

  if (!user && isProtected) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return stamp(NextResponse.redirect(url))
  }

  if (user && isAuthPage) {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    return stamp(NextResponse.redirect(url))
  }

  // Role + MFA check for all authenticated, non-API requests (never the auth
  // callback — it must finish establishing the session before any role gating).
  if (user && !isAuthPage && !isApiRoute && !isCallbackRoute) {
    // maybeSingle: a 0-row / transient read must not throw (would 500 the route).
    let profile: { role?: string; mfa_enrolled?: boolean; is_master_admin?: boolean } | null = null
    try {
      const res = await supabase
        .from('profiles')
        .select('role, mfa_enrolled, is_master_admin')
        .eq('id', user.id)
        .maybeSingle()
      profile = res.data
    } catch {
      profile = null
    }

    const role          = profile?.role
    const mfaEnrolled   = profile?.mfa_enrolled === true
    const isMasterAdmin = profile?.is_master_admin === true

    if (role === 'pending' && !isPendingPage) {
      const url = request.nextUrl.clone()
      url.pathname = '/pending'
      return stamp(NextResponse.redirect(url))
    }

    if (role === 'terminated' && !isTerminatedPage) {
      const url = request.nextUrl.clone()
      url.pathname = '/terminated'
      return stamp(NextResponse.redirect(url))
    }

    // External portal roles never use the TMS — their portal lives on the
    // website. Send the whole session there. API routes pass through (they
    // self-authenticate: data routes gate on is_staff() and now audit/alert
    // does too; login-track is intentionally pre-auth).
    if ((role === 'carrier' || role === 'shipper') && !isApiRoute) {
      let portalUrl: URL
      try {
        portalUrl = new URL(process.env.NEXT_PUBLIC_PORTAL_URL || 'https://avantra.com/portal')
      } catch {
        portalUrl = new URL('https://avantra.com/portal') // never let a bad env var 500 the session
      }
      return stamp(NextResponse.redirect(portalUrl))
    }

    if (role !== 'pending' && isPendingPage) {
      const url = request.nextUrl.clone()
      url.pathname = '/dashboard'
      return stamp(NextResponse.redirect(url))
    }

    if (role !== 'terminated' && isTerminatedPage) {
      const url = request.nextUrl.clone()
      url.pathname = '/dashboard'
      return stamp(NextResponse.redirect(url))
    }

    // Force MFA enrollment for active staff who haven't set it up yet — UNLESS the
    // company has turned the requirement off (Settings → Security → Company 2FA Policy),
    // in which case 2FA is opt-in per user. The policy read only runs for un-enrolled
    // staff (rare), so already-enrolled users pay no extra query. Default = required:
    // if the column/row is absent or the read errors, 2FA stays mandatory.
    const activeRoles = ['admin', 'dispatcher', 'back_office', 'sales']
    if (
      role &&
      activeRoles.includes(role) &&
      !mfaEnrolled &&
      !isMfaSetupPage
    ) {
      let requireMfa = true
      try {
        const { data: cs2fa, error: cs2faErr } = await supabase
          .from('company_settings')
          .select('require_2fa')
          .limit(1)
          .maybeSingle()
        if (!cs2faErr && cs2fa && (cs2fa as { require_2fa?: boolean }).require_2fa === false) requireMfa = false
      } catch { /* keep requireMfa = true */ }
      if (requireMfa) {
        const url = request.nextUrl.clone()
        url.pathname = '/setup-2fa'
        return stamp(NextResponse.redirect(url))
      }
    }

    // ── Server-side route gating ──────────────────────────────────────────────
    // Defense-in-depth beyond the client AccessGate: a non-admin can't even load
    // the HTML/data of a module they don't have access to. Uses the SAME resolver
    // (@/lib/access) the client uses, reading the admin-editable role_permissions,
    // so the two can't drift. A failed/missing config falls back to role defaults.
    if (role && role !== 'admin' && !isMasterAdmin) {
      let stored: RolePermissions | null = null
      try {
        const { data: cs } = await supabase
          .from('company_settings')
          .select('role_permissions')
          .limit(1)
          .maybeSingle()
        stored = (cs?.role_permissions as RolePermissions) ?? null
      } catch {
        stored = null
      }
      if (!isRouteAllowed(role, isMasterAdmin, stored, pathname)) {
        const url = request.nextUrl.clone()
        url.pathname = '/dashboard'
        return stamp(NextResponse.redirect(url))
      }
    }
  }

  return stamp(supabaseResponse)
}
