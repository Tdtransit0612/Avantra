'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { UserRole } from '@/types'
import {
  EMPTY_ACTIONS, computeAllowedNav, computeActions, computeCanModify,
  type RolePermissions, type RoleActions,
} from '@/lib/access'

interface RoleContextValue {
  role:                UserRole | null
  loading:             boolean
  isAdmin:             boolean
  isMasterAdmin:       boolean
  canModify:           boolean
  /** Set of nav page keys the current user may access */
  allowedNav:          Set<string>
  // ── Granular action permissions (see RoleActions in @/lib/access) ──
  canDeleteLoads:      boolean
  canBookLoad:         boolean
  canDispatch:         boolean
  canOnboardClient:    boolean
  canOverrideFee:      boolean
  canInvoiceBroker:    boolean
  canRecordPayment:    boolean
  canVoidInvoices:     boolean
  canIssueStatements:  boolean
  canManageCompliance: boolean
  canViewBankingInfo:  boolean
}

const RoleContext = createContext<RoleContextValue>({
  role: null, loading: true, isAdmin: false, isMasterAdmin: false,
  canModify: false, allowedNav: new Set(),
  ...EMPTY_ACTIONS,
})

export function RoleProvider({ children }: { children: React.ReactNode }) {
  const [role,          setRole]          = useState<UserRole | null>(null)
  const [isMasterAdmin, setIsMasterAdmin] = useState(false)
  const [loading,       setLoading]       = useState(true)
  const [canModify,     setCanModify]     = useState(false)
  const [allowedNav,    setAllowedNav]    = useState<Set<string>>(new Set())
  const [actions,       setActions]       = useState<RoleActions>(EMPTY_ACTIONS)

  useEffect(() => {
    const supabase = createClient()

    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) { setLoading(false); return }

      const [{ data: profile }, { data: cs }] = await Promise.all([
        supabase.from('profiles').select('role, is_master_admin').eq('id', data.user.id).single(),
        supabase.from('company_settings').select('role_permissions').limit(1).single(),
      ])

      const userRole = (profile?.role as UserRole) ?? null
      const master   = profile?.is_master_admin === true
      const stored   = (cs?.role_permissions as RolePermissions | null) ?? null

      setRole(userRole)
      setIsMasterAdmin(master)
      // All access is computed by the shared resolver in @/lib/access — the same
      // logic the middleware and layout gate use, so they can never drift. Stored
      // permissions are merged over defaults; unknown/null roles fail closed.
      setCanModify(computeCanModify(userRole, master, stored))
      setAllowedNav(computeAllowedNav(userRole, master, stored))
      setActions(computeActions(userRole, master, stored))
      setLoading(false)
    })
  }, [])

  return (
    <RoleContext.Provider value={{
      role,
      loading,
      isAdmin:  role === 'admin',
      isMasterAdmin,
      canModify,
      allowedNav,
      ...actions,
    }}>
      {children}
    </RoleContext.Provider>
  )
}

export const useRole = () => useContext(RoleContext)
