/**
 * /auth/callback
 *
 * Handles Supabase email confirmation and magic-link redirects.
 * Supabase sends users here after they click the confirmation link
 * in their email. We exchange the token for a session and redirect
 * them into the app (middleware then routes by role).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)

  const code         = searchParams.get('code')
  const token_hash   = searchParams.get('token_hash')
  const type         = searchParams.get('type')
  // Validate `next` to prevent open redirect — must be a relative path
  const rawNext      = searchParams.get('next') ?? '/dashboard'
  const next         = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/dashboard'

  const cookieStore = await cookies()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        },
      },
    }
  )

  if (code) {
    // PKCE flow (default in newer Supabase versions)
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`)
    }
  }

  if (token_hash && type) {
    // Email OTP / magic-link flow
    const { error } = await supabase.auth.verifyOtp({ token_hash, type: type as any })
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`)
    }
  }

  // Something went wrong — send to login with an error flag
  return NextResponse.redirect(`${origin}/login?error=confirmation_failed`)
}
