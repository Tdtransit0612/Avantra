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
  /** Non-null when the role could not be resolved — distinguishes "you have no
   *  role yet" from "we could not reach the server to find out". */
  error:               string | null
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
  canModify: false, allowedNav: new Set(), error: null,
  ...EMPTY_ACTIONS,
})

export function RoleProvider({ children }: { children: React.ReactNode }) {
  const [role,          setRole]          = useState<UserRole | null>(null)
  const [isMasterAdmin, setIsMasterAdmin] = useState(false)
  const [loading,       setLoading]       = useState(true)
  const [canModify,     setCanModify]     = useState(false)
  const [allowedNav,    setAllowedNav]    = useState<Set<string>>(new Set())
  const [actions,       setActions]       = useState<RoleActions>(EMPTY_ACTIONS)
  const [error,         setError]         = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const supabase = createClient()

    // Every exit path must settle `loading`. Previously a rejected promise here
    // left it true forever, which the layout renders as an unexplained spinner —
    // no error, no retry, nothing to diagnose from.
    ;(async () => {
      try {
        const { data, error: authErr } = await supabase.auth.getUser()
        if (cancelled) return
        if (authErr) { setError(authErr.message); return }
        if (!data.user) return          // unauthenticated: the auth gate handles it

        const [{ data: profile, error: pErr }, { data: cs }] = await Promise.all([
          supabase.from('profiles').select('role, is_master_admin').eq('id', data.user.id).single(),
          // Not a direct read of company_settings: that row also carries
          // billing_settings with Avantra's ACH routing and account numbers, and
          // RLS is row-level so it cannot hand out one column and withhold the
          // other. Migration 08 closed the table to admin/back_office and exposes
          // just these two fields through a SECURITY DEFINER function.
          supabase.rpc('get_app_config'),
        ])
        if (cancelled) return

        // A signed-in user with no readable profile row is a broken state, not a
        // pending one — say so rather than showing "awaiting approval".
        if (pErr) { setError(`Could not load your profile: ${pErr.message}`); return }

        const userRole = (profile?.role as UserRole) ?? null
        const master   = profile?.is_master_admin === true
        // The config is optional: if it can't be read we fall back to the
        // built-in defaults rather than locking the user out.
        const stored   = ((cs as { role_permissions?: RolePermissions } | null)
                           ?.role_permissions as RolePermissions | null) ?? null

        setRole(userRole)
        setIsMasterAdmin(master)
        // All access is computed by the shared resolver in @/lib/access — the same
        // logic the middleware and layout gate use, so they can never drift. Stored
        // permissions are merged over defaults; unknown/null roles fail closed.
        setCanModify(computeCanModify(userRole, master, stored))
        setAllowedNav(computeAllowedNav(userRole, master, stored))
        setActions(computeActions(userRole, master, stored))
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not reach the server.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [])

  return (
    <RoleContext.Provider value={{
      role,
      loading,
      isAdmin:  role === 'admin',
      isMasterAdmin,
      canModify,
      allowedNav,
      error,
      ...actions,
    }}>
      {children}
    </RoleContext.Provider>
  )
}

export const useRole = () => useContext(RoleContext)
