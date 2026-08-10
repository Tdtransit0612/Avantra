'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { supabaseConfigured } from '@/lib/supabase/config'
import SetupRequired from '@/components/SetupRequired'
import { useRouter, useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Compass, Loader2, Mail, CheckCircle, ShieldCheck, Lock } from 'lucide-react'
import { Suspense } from 'react'

// ── Lockout helpers ───────────────────────────────────────────────────────────
async function trackLoginAttempt(email: string, outcome: 'failed' | 'success' | 'check') {
  try {
    const res = await fetch('/api/auth/login-track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, outcome }),
    })
    return await res.json()
  } catch {
    return { locked: false }
  }
}

function LoginForm() {
  const [mode, setMode]           = useState<'signin' | 'signup'>('signin')
  const [step, setStep]           = useState<'credentials' | 'mfa'>('credentials')
  const [email, setEmail]         = useState('')
  const [password, setPassword]   = useState('')
  const [name, setName]           = useState('')
  const [mfaCode, setMfaCode]     = useState('')
  const [mfaFactorId, setMfaFactorId] = useState('')
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')
  const [lockoutMins, setLockoutMins] = useState<number | null>(null)
  const [confirmationSent, setConfirmationSent] = useState(false)
  const [resending,        setResending]        = useState(false)
  const [resendSent,       setResendSent]       = useState(false)
  const [unconfirmedEmail, setUnconfirmedEmail] = useState('')
  const router  = useRouter()
  const params  = useSearchParams()
  const supabase = createClient()

  const callbackError = params.get('error')
  const idleReason    = params.get('reason') === 'idle'

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    setLockoutMins(null)

    // ── Pre-check: is this account locked? ────────────────────────────────
    const check = await trackLoginAttempt(email, 'check')
    if (check.locked) {
      setLockoutMins(check.retry_after_mins ?? 15)
      setLoading(false)
      return
    }

    // ── Attempt sign-in ───────────────────────────────────────────────────
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      // Track failed attempt and surface remaining count
      const result = await trackLoginAttempt(email, 'failed')
      if (result.locked) {
        setLockoutMins(result.retry_after_mins ?? 15)
      } else if (error.message.toLowerCase().includes('email not confirmed')) {
        setUnconfirmedEmail(email)
        setError('Please confirm your email before signing in. Check your inbox for the confirmation link.')
      } else if (error.message.toLowerCase().includes('invalid login')) {
        const remaining = result.attempts_remaining ?? 0
        setError(
          remaining > 0
            ? `Incorrect email or password. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining before lockout.`
            : 'Incorrect email or password. Please try again.'
        )
      } else {
        setError(error.message)
      }
      setLoading(false)
      return
    }

    // ── Success — reset lockout counter ───────────────────────────────────
    await trackLoginAttempt(email, 'success')

    // Check if MFA is required
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aal?.nextLevel === 'aal2' && aal.nextLevel !== aal.currentLevel) {
      const { data: factors } = await supabase.auth.mfa.listFactors()
      const totp = factors?.totp?.[0]
      if (totp) {
        setMfaFactorId(totp.id)
        setStep('mfa')
        setLoading(false)
        return
      }
    }
    router.push('/dashboard')
    router.refresh()
  }

  const handleMfaVerify = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({ factorId: mfaFactorId })
    if (challengeErr) { setError(challengeErr.message); setLoading(false); return }
    const { error: verifyErr } = await supabase.auth.mfa.verify({
      factorId:    mfaFactorId,
      challengeId: challenge.id,
      code:        mfaCode.replace(/\s/g, ''),
    })
    if (verifyErr) {
      setError('Invalid code. Please try again.')
      setMfaCode('')
      setLoading(false)
      return
    }
    router.push('/dashboard')
    router.refresh()
  }

  const handleResendConfirmation = async () => {
    if (!unconfirmedEmail || resending) return
    setResending(true)
    setResendSent(false)
    const { error: resendErr } = await supabase.auth.resend({ type: 'signup', email: unconfirmedEmail })
    setResending(false)
    if (resendErr) {
      setError(`Couldn't resend: ${resendErr.message}`)
    } else {
      setResendSent(true)
      setError('')
    }
  }

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: name },
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    })
    setLoading(false)
    if (error) {
      setError(error.message)
      return
    }
    if (!data.session) {
      setConfirmationSent(true)
      return
    }
    router.push('/dashboard')
    router.refresh()
  }

  // ── Confirmation sent screen ──────────────────────────────────────────────
  if (confirmationSent) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="flex flex-col items-center mb-8">
            <div className="bg-indigo-600 p-3 rounded-xl mb-3">
              <Compass className="h-8 w-8 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-white">Avantra</h1>
            <p className="text-gray-400 text-sm mt-1">Carrier Services</p>
          </div>
          <Card>
            <CardContent className="pt-6 text-center space-y-4">
              <div className="flex justify-center">
                <div className="bg-green-100 dark:bg-green-900/30 p-4 rounded-full">
                  <Mail className="h-10 w-10 text-green-600 dark:text-green-400" />
                </div>
              </div>
              <div>
                <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-2">Check your email</h2>
                <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
                  We sent a confirmation link to <strong className="text-gray-700 dark:text-gray-200">{email}</strong>.
                  Click it to activate your account, then sign in.
                </p>
              </div>
              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 text-xs text-blue-700 dark:text-blue-300 text-left">
                <CheckCircle className="h-3.5 w-3.5 inline mr-1" />
                Once confirmed, an admin will assign your role before you can access the dashboard.
              </div>
              <button
                onClick={() => { setConfirmationSent(false); setMode('signin') }}
                className="text-sm text-indigo-600 hover:underline"
              >
                Back to sign in
              </button>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  // ── MFA challenge screen ──────────────────────────────────────────────────
  if (step === 'mfa') {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="flex flex-col items-center mb-8">
            <div className="bg-indigo-600 p-3 rounded-xl">
              <Compass className="h-8 w-8 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-white mt-3">Two-Factor Auth</h1>
            <p className="text-gray-400 text-sm mt-1">Enter the code from your authenticator app</p>
          </div>
          <Card>
            <CardContent className="pt-6">
              <form onSubmit={handleMfaVerify} className="space-y-4">
                <div>
                  <Label>6-Digit Code</Label>
                  <Input
                    className="mt-1 text-center text-2xl font-mono tracking-[0.4em]"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9 ]*"
                    maxLength={7}
                    placeholder="000 000"
                    value={mfaCode}
                    onChange={e => setMfaCode(e.target.value.replace(/[^0-9 ]/g, ''))}
                    autoFocus
                    required
                  />
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1.5">
                    Open Google Authenticator, Authy, or your authenticator app.
                  </p>
                </div>
                {error && <p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30 p-3 rounded-lg">{error}</p>}
                <Button type="submit" className="w-full bg-indigo-600 hover:bg-indigo-700" disabled={loading || mfaCode.replace(/\s/g,'').length < 6}>
                  {loading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Verify
                </Button>
                <button type="button" onClick={() => { setStep('credentials'); setError(''); setMfaCode('') }} className="w-full text-sm text-gray-400 hover:text-gray-200 text-center">
                  ← Back to login
                </button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="bg-indigo-600 p-3 rounded-xl">
              <Compass className="h-8 w-8 text-white" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-white mt-3">Avantra</h1>
          <p className="text-gray-400 text-sm mt-1">Carrier Services</p>
        </div>

        {/* Idle timeout notice */}
        {idleReason && (
          <div className="mb-4 p-3 rounded-lg bg-yellow-900/30 border border-yellow-700 text-sm text-yellow-300 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 shrink-0" />
            You were signed out after 30 minutes of inactivity.
          </div>
        )}

        {/* Callback error banner */}
        {callbackError === 'confirmation_failed' && (
          <div className="mb-4 p-3 rounded-lg bg-red-900/30 border border-red-700 text-sm text-red-300">
            The confirmation link has expired or is invalid. Please sign up again or contact your admin.
          </div>
        )}

        {/* Account lockout banner */}
        {lockoutMins !== null && (
          <div className="mb-4 p-4 rounded-lg bg-red-900/30 border border-red-700 text-sm text-red-300 flex items-start gap-3">
            <Lock className="h-5 w-5 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Account temporarily locked</p>
              <p className="text-xs mt-0.5 text-red-400">
                Too many failed attempts. Try again in {lockoutMins} minute{lockoutMins === 1 ? '' : 's'}.
              </p>
            </div>
          </div>
        )}

        <Card>
          <CardHeader>
            <div className="flex rounded-lg bg-gray-100 dark:bg-white/10 p-1">
              <button
                onClick={() => { setMode('signin'); setError(''); setLockoutMins(null) }}
                className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-all ${
                  mode === 'signin'
                    ? 'bg-white dark:bg-white/20 shadow text-gray-900 dark:text-white'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                }`}
              >
                Sign In
              </button>
              <button
                onClick={() => { setMode('signup'); setError(''); setLockoutMins(null) }}
                className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-all ${
                  mode === 'signup'
                    ? 'bg-white dark:bg-white/20 shadow text-gray-900 dark:text-white'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                }`}
              >
                Create Account
              </button>
            </div>
          </CardHeader>
          <CardContent>
            {mode === 'signin' ? (
              <form onSubmit={handleSignIn} className="space-y-4">
                <div>
                  <Label>Email</Label>
                  <Input className="mt-1" type="email" placeholder="you@company.com" value={email} onChange={e => setEmail(e.target.value)} required />
                </div>
                <div>
                  <Label>Password</Label>
                  <Input className="mt-1" type="password" value={password} onChange={e => setPassword(e.target.value)} required />
                </div>
                {resendSent && (
                  <div className="text-sm text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/30 p-3 rounded-lg flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 shrink-0" />
                    Confirmation email resent — check your inbox (and spam folder).
                  </div>
                )}
                {error && (
                  <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30 p-3 rounded-lg space-y-2">
                    <p>{error}</p>
                    {unconfirmedEmail && (
                      <button
                        type="button"
                        onClick={handleResendConfirmation}
                        disabled={resending}
                        className="flex items-center gap-1.5 text-indigo-600 dark:text-indigo-400 hover:underline font-medium text-xs"
                      >
                        {resending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Mail className="h-3 w-3" />}
                        {resending ? 'Sending…' : 'Resend confirmation email'}
                      </button>
                    )}
                  </div>
                )}
                <Button type="submit" className="w-full bg-indigo-600 hover:bg-indigo-700" disabled={loading || lockoutMins !== null}>
                  {loading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Sign In
                </Button>
              </form>
            ) : (
              <form onSubmit={handleSignUp} className="space-y-4">
                <div>
                  <Label>Full Name</Label>
                  <Input className="mt-1" type="text" placeholder="John Smith" value={name} onChange={e => setName(e.target.value)} required />
                </div>
                <div>
                  <Label>Email</Label>
                  <Input className="mt-1" type="email" placeholder="you@company.com" value={email} onChange={e => setEmail(e.target.value)} required />
                </div>
                <div>
                  <Label>Password</Label>
                  <Input className="mt-1" type="password" placeholder="At least 6 characters" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} />
                </div>
                {error && <p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30 p-3 rounded-lg">{error}</p>}
                <Button type="submit" className="w-full bg-indigo-600 hover:bg-indigo-700" disabled={loading}>
                  {loading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Create Account
                </Button>
                <p className="text-xs text-gray-400 text-center">
                  An admin will assign your role after you confirm your email.
                </p>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export default function LoginPage() {
  // There is nothing to sign in to before Supabase exists, and LoginForm builds
  // a client on submit — so explain the setup rather than failing at the button.
  if (!supabaseConfigured()) return <SetupRequired />

  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-900" />}>
      <LoginForm />
    </Suspense>
  )
}
