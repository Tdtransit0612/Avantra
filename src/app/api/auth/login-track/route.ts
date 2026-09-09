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

  const { data: record, error: readErr } = await supabase
    .from('login_attempts')
    .select('*')
    .eq('email', normalEmail)
    .maybeSingle()

  // Fail CLOSED. This error used to be discarded, and the consequence was not
  // a degraded lockout but no lockout at all: the table did not exist in any
  // migration, so every read errored, `record` came back undefined, the counter
  // restarted at 1 on every attempt, and the endpoint cheerfully reported
  // "4 attempts remaining" forever while allowing unlimited password guessing.
  //
  // A lockout store we cannot reach is indistinguishable from one that would
  // have said "locked", so we must not answer as if it said "not locked".
  // Refusing logins during an outage is the cheaper failure.
  if (readErr) {
    console.error('[login-track] lockout store unreachable:', readErr.code, readErr.message)
    return NextResponse.json(
      { error: 'Sign-in is temporarily unavailable. Please try again shortly.' },
      { status: 503 },
    )
  }

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
    const { error: resetErr } = await supabase.from('login_attempts').upsert(
      { email: normalEmail, failed_count: 0, locked_until: null, last_attempt_at: now.toISOString() },
      { onConflict: 'email' }
    )
    // Worth logging but not worth blocking on: the user authenticated correctly,
    // and the only cost of a missed reset is a stale counter that expires anyway.
    if (resetErr) console.error('[login-track] could not reset counter:', resetErr.message)
    return NextResponse.json({ locked: false })
  }

  // ── failed ───────────────────────────────────────────────────────────────
  const newCount    = (record?.failed_count ?? 0) + 1
  const lockedUntil = newCount >= MAX_ATTEMPTS
    ? new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString()
    : null

  const { error: writeErr } = await supabase.from('login_attempts').upsert(
    {
      email: normalEmail,
      failed_count: newCount,
      locked_until: lockedUntil,
      last_attempt_at: now.toISOString(),
    },
    { onConflict: 'email' }
  )

  // A failed write here is the whole lockout failing: the count never persists,
  // so the next attempt starts from zero and the threshold is never reached.
  // Refuse rather than report a limit that is not being enforced.
  if (writeErr) {
    console.error('[login-track] could not record failure:', writeErr.code, writeErr.message)
    return NextResponse.json(
      { error: 'Sign-in is temporarily unavailable. Please try again shortly.' },
      { status: 503 },
    )
  }

  return NextResponse.json({
    locked: !!lockedUntil,
    locked_until: lockedUntil,
    retry_after_mins: lockedUntil ? LOCK_MINUTES : undefined,
    attempts_remaining: Math.max(0, MAX_ATTEMPTS - newCount),
  })
}
