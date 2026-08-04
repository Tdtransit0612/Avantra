'use client'

import { Snowflake, Clock } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

export default function PendingPage() {
  const router = useRouter()

  const handleSignOut = async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="flex justify-center">
          <div className="relative">
            <Snowflake className="h-16 w-16 text-sky-500" />
            <Clock className="h-6 w-6 text-yellow-400 absolute -bottom-1 -right-1 bg-gray-950 rounded-full" />
          </div>
        </div>

        <div>
          <h1 className="text-2xl font-bold text-white mb-2">Account Pending Approval</h1>
          <p className="text-gray-400 text-sm leading-relaxed">
            Your account has been created but is awaiting admin approval. Contact your administrator to grant you access.
          </p>
        </div>

        <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 text-left space-y-2">
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">What happens next</p>
          <ul className="space-y-1.5 text-sm text-gray-300">
            <li className="flex items-start gap-2">
              <span className="text-sky-500 mt-0.5">1.</span>
              Your admin logs into the TMS and goes to Settings → Users
            </li>
            <li className="flex items-start gap-2">
              <span className="text-sky-500 mt-0.5">2.</span>
              They find your account in the Pending Approval section
            </li>
            <li className="flex items-start gap-2">
              <span className="text-sky-500 mt-0.5">3.</span>
              They assign you a role — then you're in
            </li>
          </ul>
        </div>

        <button
          onClick={handleSignOut}
          className="text-sm text-gray-500 hover:text-gray-300 transition-colors underline underline-offset-4"
        >
          Sign out
        </button>
      </div>
    </div>
  )
}
