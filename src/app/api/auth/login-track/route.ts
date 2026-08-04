import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { rateLimit, getIp } from '@/lib/rate-limit'

const MAX_ATTEMPTS   = 5
const LOCK_MINUTES   = 15

export async function POST(req: NextRequest) {
  // Guard the endpoint itself against abuse
  const rl = rateLimit(`login-track:${getIp(req)}`, 30, 60_000)
  if (!rl.ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  let body: { email?: string; outcome?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }) }

  const { email, outcome } = body
  if (!email || !['failed', 'success', 'check'].includes(outcome ?? '')) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const normalEmail = email.toLowerCase().trim()
  const now = new Date()

  const { data: record } = await supabase
    .from('login_attempts')
    .select('*')
    .eq('email', normalEmail)
    .maybeSingle()

  // If currently locked, return that immediately regardless of outcome
  if (record?.locked_until && new Date(record.locked_until) > now) {
    const retryAfterMins = Math.ceil(
      (new Date(record.locked_until).getTime() - now.getTime()) / 60_000
    )
    return NextResponse.json({
      locked: true,
      retry_after_mins: retryAfterMins,
      locked_until: record.locked_until,
    })
  }

  // ── check ────────────────────────────────────────────────────────────────
  if (outcome === 'check') {
    return NextResponse.json({
      locked: false,
      attempts: record?.failed_count ?? 0,
    })
  }

  // ── success ──────────────────────────────────────────────────────────────
  if (outcome === 'success') {
    await supabase.from('login_attempts').upsert(
      { email: normalEmail, failed_count: 0, locked_until: null, last_attempt_at: now.toISOString() },
      { onConflict: 'email' }
    )
    return NextResponse.json({ locked: false })
  }

  // ── failed ───────────────────────────────────────────────────────────────
  const newCount    = (record?.failed_count ?? 0) + 1
  const lockedUntil = newCount >= MAX_ATTEMPTS
    ? new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString()
    : null

  await supabase.from('login_attempts').upsert(
    {
      email: normalEmail,
      failed_count: newCount,
      locked_until: lockedUntil,
      last_attempt_at: now.toISOString(),
    },
    { onConflict: 'email' }
  )

  return NextResponse.json({
    locked: !!lockedUntil,
    locked_until: lockedUntil,
    retry_after_mins: lockedUntil ? LOCK_MINUTES : undefined,
    attempts_remaining: Math.max(0, MAX_ATTEMPTS - newCount),
  })
}
