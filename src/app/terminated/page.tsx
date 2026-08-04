'use client'

import { Snowflake, XCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

export default function TerminatedPage() {
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
            <Snowflake className="h-16 w-16 text-gray-600" />
            <XCircle className="h-6 w-6 text-red-500 absolute -bottom-1 -right-1 bg-gray-950 rounded-full" />
          </div>
        </div>

        <div>
          <h1 className="text-2xl font-bold text-white mb-2">Account Terminated</h1>
          <p className="text-gray-400 text-sm leading-relaxed">
            Your access to this system has been revoked. Contact your administrator if you believe this is a mistake.
          </p>
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
