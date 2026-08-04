'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { useIdleTimeout } from '@/hooks/useIdleTimeout'
import { ShieldCheck, LogOut } from 'lucide-react'

const TIMEOUT_MINS  = 30
const WARNING_MINS  = 2
const TIMEOUT_MS    = TIMEOUT_MINS * 60 * 1000
const WARNING_MS    = WARNING_MINS * 60 * 1000

export default function IdleWarningModal() {
  const router = useRouter()
  const [warning, setWarning]     = useState(false)
  const [countdown, setCountdown] = useState(WARNING_MINS * 60)

  const handleTimeout = async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login?reason=idle')
  }

  const handleStayActive = () => {
    setWarning(false)
    setCountdown(WARNING_MINS * 60)
  }

  useIdleTimeout({
    timeoutMs: TIMEOUT_MS,
    warningMs: WARNING_MS,
    onWarn:    () => { setWarning(true); setCountdown(WARNING_MINS * 60) },
    onTimeout: handleTimeout,
  })

  // Countdown ticker
  useEffect(() => {
    if (!warning) return
    const id = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { clearInterval(id); return 0 }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [warning])

  if (!warning) return null

  const mins = Math.floor(countdown / 60)
  const secs = countdown % 60

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-white/10 p-8 max-w-sm w-full mx-4 text-center">
        {/* Icon */}
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-orange-100 dark:bg-orange-900/30 mb-4">
          <ShieldCheck className="h-7 w-7 text-orange-500" />
        </div>

        <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
          Still there?
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">
          You've been inactive for {TIMEOUT_MINS - WARNING_MINS} minutes.
        </p>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          You'll be automatically signed out in:
        </p>

        {/* Countdown */}
        <div className="text-4xl font-black font-mono text-orange-500 mb-6 tabular-nums">
          {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={handleStayActive}
            className="flex-1 bg-orange-600 hover:bg-orange-700 text-white font-semibold py-2.5 rounded-xl text-sm transition-colors"
          >
            Stay Signed In
          </button>
          <button
            onClick={handleTimeout}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-medium text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors border border-gray-200 dark:border-white/10"
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </button>
        </div>

        <p className="text-xs text-gray-400 dark:text-gray-600 mt-4">
          Move your mouse or press any key to stay logged in.
        </p>
      </div>
    </div>
  )
}
