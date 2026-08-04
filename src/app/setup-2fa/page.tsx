'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { Snowflake, ShieldCheck, Loader2, AlertTriangle } from 'lucide-react'

type Step = 'checking' | 'already_enrolled' | 'intro' | 'qr' | 'verify' | 'done'

export default function SetupMfaPage() {
  const router  = useRouter()
  const supabase = createClient()

  const [step,       setStep]       = useState<Step>('checking')
  const [qrCode,     setQrCode]     = useState('')
  const [secret,     setSecret]     = useState('')
  const [factorId,   setFactorId]   = useState('')
  const [code,       setCode]       = useState('')
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState('')
  // Reconfigure mode (from the Settings → My Account "new device" button): allow
  // re-enrolling even when a verified factor already exists.
  const [reconfigure, setReconfigure] = useState(false)

  // On mount: only a VERIFIED factor counts as "enrolled". Wrapped in try/catch so
  // a transient MFA API error can never strand the user on the "checking" spinner.
  // Any stale UNVERIFIED factor (an interrupted prior attempt) is cleaned up so the
  // next enroll can't hit a "friendly name already exists" conflict.
  useEffect(() => {
    const isReconfig = new URLSearchParams(window.location.search).get('reconfigure') === '1'
    setReconfigure(isReconfig)
    ;(async () => {
      try {
        const { data, error } = await supabase.auth.mfa.listFactors()
        if (error) { setStep('intro'); return }
        const all = data?.all ?? []
        const verified = all.find(f => f.factor_type === 'totp' && f.status === 'verified')
        // Already enrolled: bounce to the dashboard — UNLESS the user explicitly asked
        // to reconfigure (swap in a new authenticator device), in which case fall
        // through to the intro and let handleStart clear the old factor first.
        if (verified && !isReconfig) {
          const { data: { user } } = await supabase.auth.getUser()
          if (user) await supabase.from('profiles').update({ mfa_enrolled: true }).eq('id', user.id)
          setStep('already_enrolled')
          setTimeout(() => { router.replace('/dashboard'); router.refresh() }, 1500)
          return
        }
        // Remove any half-finished (unverified) factors before showing the intro.
        for (const f of all) {
          if (f.factor_type === 'totp' && f.status !== 'verified') {
            try { await supabase.auth.mfa.unenroll({ factorId: f.id }) } catch { /* ignore */ }
          }
        }
        setStep('intro')
      } catch {
        setStep('intro')
      }
    })()
  }, [supabase, router])

  // ── Start enrollment ──────────────────────────────────────────────────────
  const handleStart = async () => {
    setLoading(true)
    setError('')
    // Clear any stale unverified factor first so enroll() can't 422 with a
    // "friendly name already exists" conflict (which previously hung this page).
    try {
      const { data: existing } = await supabase.auth.mfa.listFactors()
      for (const f of (existing?.all ?? [])) {
        // Always clear half-finished factors; in reconfigure mode also drop the
        // existing verified factor so a fresh device can take its place.
        if (f.factor_type === 'totp' && (f.status !== 'verified' || reconfigure)) {
          try { await supabase.auth.mfa.unenroll({ factorId: f.id }) } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' })
    setLoading(false)
    if (error) { setError(error.message); return }
    if (!data?.totp) { setError('Failed to initialize 2FA — please try again.'); return }
    setQrCode(data.totp.qr_code)
    setSecret(data.totp.secret)
    setFactorId(data.id)
    setStep('qr')
  }

  // ── Verify code ───────────────────────────────────────────────────────────
  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({ factorId })
    if (challengeErr) { setError(challengeErr.message); setLoading(false); return }
    const { error: verifyErr } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.id,
      code: code.replace(/\s/g, ''),
    })
    if (verifyErr) {
      setError('Invalid code — check your authenticator app and try again.')
      setCode('')
      setLoading(false)
      return
    }
    // Mark enrolled in profiles
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      await supabase.from('profiles').update({ mfa_enrolled: true }).eq('id', user.id)
    }
    setLoading(false)
    setStep('done')
    setTimeout(() => router.replace('/dashboard'), 2000)
  }

  // ── Shared shell ──────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">

        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="bg-sky-600 p-3 rounded-xl mb-3 shadow-lg shadow-sky-500/20">
            <Snowflake className="h-8 w-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">Avantra</h1>
          <p className="text-gray-400 text-sm mt-1">Secure Your Account</p>
        </div>

        {/* Card */}
        <div className="bg-gray-900 rounded-2xl border border-white/10 shadow-2xl overflow-hidden">
          <div className="h-0.5 bg-gradient-to-r from-sky-500 via-sky-400 to-transparent" />

          <div className="p-8">

            {/* Checking */}
            {step === 'checking' && (
              <div className="text-center py-4">
                <Loader2 className="h-8 w-8 animate-spin text-sky-500 mx-auto mb-3" />
                <p className="text-gray-400 text-sm">Checking account status…</p>
              </div>
            )}

            {/* Already enrolled */}
            {step === 'already_enrolled' && (
              <div className="text-center py-4 space-y-3">
                <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-green-500/15 border border-green-500/30 mb-1">
                  <ShieldCheck className="h-7 w-7 text-green-400" />
                </div>
                <p className="text-white font-bold text-lg">2FA Already Active</p>
                <p className="text-gray-400 text-sm">Redirecting you to the dashboard…</p>
              </div>
            )}

            {/* Intro */}
            {step === 'intro' && (
              <div className="space-y-5">
                <div className="text-center">
                  <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-sky-500/15 border border-sky-500/30 mb-4">
                    <ShieldCheck className="h-7 w-7 text-sky-400" />
                  </div>
                  <h2 className="text-xl font-bold text-white mb-2">
                    {reconfigure ? 'Set Up a New Device' : 'Two-Factor Auth Required'}
                  </h2>
                  <p className="text-gray-400 text-sm leading-relaxed">
                    {reconfigure
                      ? 'This replaces your current authenticator. Your old device will stop working once you finish.'
                      : 'Your company requires 2FA on all accounts. It takes less than 2 minutes and protects sensitive load and carrier data.'}
                  </p>
                </div>

                <div className="bg-white/5 rounded-xl p-4 space-y-2.5">
                  {[
                    { n: '1', text: 'Download an authenticator app (Google Authenticator, Authy, or 1Password)' },
                    { n: '2', text: 'Scan the QR code we\'ll show you' },
                    { n: '3', text: 'Enter the 6-digit code to confirm' },
                  ].map(item => (
                    <div key={item.n} className="flex items-start gap-3">
                      <span className="w-5 h-5 rounded-full bg-sky-500 text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">{item.n}</span>
                      <p className="text-sm text-gray-300">{item.text}</p>
                    </div>
                  ))}
                </div>

                <button
                  onClick={handleStart}
                  disabled={loading}
                  className="w-full bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white font-bold py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                  Set Up Two-Factor Auth
                </button>

                {error && (
                  <p className="text-sm text-red-400 bg-red-900/20 border border-red-700/40 p-3 rounded-lg flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 shrink-0" />{error}
                  </p>
                )}
              </div>
            )}

            {/* QR Code */}
            {step === 'qr' && (
              <div className="space-y-5">
                <div>
                  <h2 className="text-lg font-bold text-white mb-1">Scan this QR code</h2>
                  <p className="text-sm text-gray-400">Open your authenticator app and scan:</p>
                </div>

                {qrCode && (
                  <div className="flex justify-center">
                    <div className="p-3 bg-white rounded-xl shadow-lg">
                      <img src={qrCode} alt="2FA QR Code" className="w-48 h-48" />
                    </div>
                  </div>
                )}

                <div>
                  <p className="text-xs text-gray-500 mb-1">Or enter the key manually:</p>
                  <code className="block text-xs font-mono bg-white/5 border border-white/10 px-3 py-2 rounded-lg break-all text-gray-300 select-all">
                    {secret}
                  </code>
                </div>

                <button
                  onClick={() => setStep('verify')}
                  className="w-full bg-sky-600 hover:bg-sky-700 text-white font-bold py-3 rounded-xl transition-colors"
                >
                  I've scanned it →
                </button>
              </div>
            )}

            {/* Verify */}
            {step === 'verify' && (
              <form onSubmit={handleVerify} className="space-y-5">
                <div>
                  <h2 className="text-lg font-bold text-white mb-1">Enter the code</h2>
                  <p className="text-sm text-gray-400">Type the 6-digit code your authenticator app is showing right now:</p>
                </div>

                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9 ]*"
                  maxLength={7}
                  placeholder="000 000"
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/[^0-9 ]/g, ''))}
                  autoFocus
                  required
                  className="w-full text-center text-3xl font-mono font-bold tracking-[0.5em] bg-white/5 border-2 border-white/10 focus:border-sky-500/60 text-white rounded-xl px-4 py-4 outline-none transition-colors placeholder-gray-600"
                />

                {error && (
                  <p className="text-sm text-red-400 bg-red-900/20 border border-red-700/40 p-3 rounded-lg flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 shrink-0" />{error}
                  </p>
                )}

                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => { setStep('qr'); setCode(''); setError('') }}
                    className="px-4 py-3 rounded-xl border border-white/10 text-gray-400 hover:text-white hover:border-white/20 text-sm transition-colors"
                  >
                    ← Back
                  </button>
                  <button
                    type="submit"
                    disabled={loading || code.replace(/\s/g, '').length < 6}
                    className="flex-1 bg-sky-600 hover:bg-sky-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
                  >
                    {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                    Confirm & Activate
                  </button>
                </div>
              </form>
            )}

            {/* Done */}
            {step === 'done' && (
              <div className="text-center py-4 space-y-3">
                <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-green-500/15 border border-green-500/30 mb-1">
                  <ShieldCheck className="h-7 w-7 text-green-400" />
                </div>
                <p className="text-white font-bold text-xl">You're all set!</p>
                <p className="text-gray-400 text-sm">2FA is active on your account.<br />Taking you to the dashboard…</p>
                <Loader2 className="h-5 w-5 animate-spin text-sky-500 mx-auto" />
              </div>
            )}

          </div>
        </div>

        <p className="text-center text-xs text-gray-600 mt-5">
          Need help? Contact your admin.
        </p>
      </div>
    </div>
  )
}
