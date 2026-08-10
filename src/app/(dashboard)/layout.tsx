'use client'

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Sidebar from '@/components/layout/Sidebar'
import IdleWarningModal from '@/components/IdleWarningModal'
import { RoleProvider, useRole } from '@/lib/role-context'
import { navKeyForPath } from '@/lib/access'
import { supabaseConfigured } from '@/lib/supabase/config'
import SetupRequired from '@/components/SetupRequired'
import { Compass, Clock } from 'lucide-react'

function AccessGate({ children }: { children: React.ReactNode }) {
  const { role, loading, isMasterAdmin, allowedNav } = useRole()
  const pathname = usePathname()
  const router = useRouter()

  useEffect(() => {
    if (loading || !role) return
    // Admin / master-admin: always allowed
    if (role === 'admin' || isMasterAdmin) return
    // Routes any authenticated user may open (dashboard, pending, terminated, …)
    const navKey = navKeyForPath(pathname)
    if (navKey === null) return
    // Everyone else: must have the page in their allowed nav (external/pending/
    // terminated have an empty set, so any module route bounces to dashboard).
    if (!allowedNav.has(navKey)) router.replace('/dashboard')
  }, [role, loading, isMasterAdmin, allowedNav, pathname, router])

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
      </div>
    )
  }

  if (!role) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          <div className="flex justify-center mb-4">
            <div className="bg-indigo-600 p-4 rounded-2xl">
              <Compass className="h-10 w-10 text-white" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">Avantra Carrier Services</h1>
          <div className="bg-slate-800 rounded-xl p-6 mt-6">
            <div className="flex justify-center mb-3">
              <Clock className="h-8 w-8 text-indigo-400" />
            </div>
            <h2 className="text-lg font-semibold text-white mb-2">Awaiting Approval</h2>
            <p className="text-slate-400 text-sm">Your account has been created but hasn&apos;t been approved yet. An admin will review your request and grant you access shortly.</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen bg-gray-50 dark:bg-gray-950">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        {children}
      </main>
      <IdleWarningModal />
    </div>
  )
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Bail before RoleProvider — it builds a Supabase client on mount, which
  // throws when the project isn't configured.
  if (!supabaseConfigured()) return <SetupRequired />

  return (
    <RoleProvider>
      <AccessGate>{children}</AccessGate>
    </RoleProvider>
  )
}
