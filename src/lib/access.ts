// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for role → page / action access (Avantra).
//
// Used by the client (role-context, the layout AccessGate, the sidebar) AND the
// server (proxy route gating). Keep this free of React / browser APIs so it can
// run in the Edge middleware runtime.
//
// Access is computed from the admin-editable company_settings.role_permissions
// jsonb, falling back to DEFAULT_PERMISSIONS. Stored config is merged OVER the
// defaults (never replaces them) so a page that isn't in the permissions editor
// keeps its default access instead of silently disappearing once an admin saves.
// ─────────────────────────────────────────────────────────────────────────────

export interface RoleActions {
  canDeleteLoads:      boolean
  canBookLoad:         boolean   // commit a load to a client (sourced/offered → booked)
  canDispatch:         boolean   // assign a driver/truck and release the load
  canOnboardClient:    boolean   // move a client through onboarding → active
  canOverrideFee:      boolean   // change the dispatch fee on a load, or waive it
  canInvoiceBroker:    boolean   // create + send invoices in a client's name
  canRecordPayment:    boolean   // mark broker invoices funded/paid
  canVoidInvoices:     boolean
  canIssueStatements:  boolean   // bill our own clients for dispatch fees
  canManageCompliance: boolean
  canViewBankingInfo:  boolean   // client EIN / ACH / factoring detail
}

export interface RoleNavAccess { [pageKey: string]: boolean }

export interface RoleConfig {
  nav:       RoleNavAccess
  canModify: boolean
  actions:   RoleActions
}

export interface RolePermissions { [role: string]: RoleConfig }

// The roles that count as Avantra staff. MUST mirror public.is_staff() in
// supabase/migrations/20260803_01_foundation.sql — server routes gate on this
// list, RLS gates on that function, and a drift between them is a security hole.
export const STAFF_ROLES = ['admin', 'dispatcher', 'back_office', 'sales'] as const

/** Is this role Avantra staff (as opposed to a client-portal or lifecycle role)? */
export function isStaffRole(role: string | null | undefined): boolean {
  return !!role && (STAFF_ROLES as readonly string[]).includes(role)
}

// Every navigable page key. Admin / master-admin always get all of them.
export const ALL_NAV_KEYS = [
  'board', 'loads', 'clients', 'brokers', 'invoicing', 'statements',
  'factoring', 'compliance', 'services', 'reports', 'audit', 'settings',
] as const

// URL segments that don't map 1-to-1 to their nav key (sub-pages of a module).
export const URL_TO_NAV_KEY: Record<string, string> = {
  invoices:   'invoicing',
  tracing:    'invoicing',   // invoice tracing / collections lives under AR
  drivers:    'clients',
  equipment:  'clients',
  onboarding: 'clients',
  dispatch:   'board',
}

// Segments reachable by any authenticated user regardless of role.
const ALWAYS_ALLOWED_SEGMENTS = new Set([
  '', 'dashboard', 'pending', 'terminated', 'setup-2fa', 'login', 'register',
])

export const EMPTY_ACTIONS: RoleActions = {
  canDeleteLoads:      false,
  canBookLoad:         false,
  canDispatch:         false,
  canOnboardClient:    false,
  canOverrideFee:      false,
  canInvoiceBroker:    false,
  canRecordPayment:    false,
  canVoidInvoices:     false,
  canIssueStatements:  false,
  canManageCompliance: false,
  canViewBankingInfo:  false,
}

// Admin always gets every action.
export const ADMIN_ACTIONS: RoleActions = {
  canDeleteLoads:      true,
  canBookLoad:         true,
  canDispatch:         true,
  canOnboardClient:    true,
  canOverrideFee:      true,
  canInvoiceBroker:    true,
  canRecordPayment:    true,
  canVoidInvoices:     true,
  canIssueStatements:  true,
  canManageCompliance: true,
  canViewBankingInfo:  true,
}

export const DEFAULT_ACTIONS: Record<string, RoleActions> = {
  // Runs freight. Can commit and dispatch loads, but can't rewrite the fee the
  // client was sold, or touch the money side.
  dispatcher: {
    ...EMPTY_ACTIONS, canBookLoad: true, canDispatch: true,
  },
  // Owns the paperwork and the money: AR against brokers, factoring, tracing,
  // and our own fee statements.
  back_office: {
    ...EMPTY_ACTIONS,
    canInvoiceBroker: true, canRecordPayment: true, canVoidInvoices: true,
    canIssueStatements: true, canManageCompliance: true, canViewBankingInfo: true,
  },
  // Signs clients up and negotiates their plan, so it owns the fee terms.
  sales: {
    ...EMPTY_ACTIONS, canOnboardClient: true, canOverrideFee: true,
  },
}

export const DEFAULT_PERMISSIONS: RolePermissions = {
  dispatcher: {
    nav: {
      board: true, loads: true, clients: true, brokers: true, invoicing: false,
      statements: false, factoring: false, compliance: true, services: true,
      reports: false, audit: false, settings: false,
    },
    canModify: true,
    actions: DEFAULT_ACTIONS.dispatcher,
  },
  back_office: {
    nav: {
      board: true, loads: true, clients: true, brokers: true, invoicing: true,
      statements: true, factoring: true, compliance: true, services: true,
      reports: true, audit: true, settings: false,
    },
    canModify: true,
    actions: DEFAULT_ACTIONS.back_office,
  },
  sales: {
    nav: {
      board: false, loads: true, clients: true, brokers: true, invoicing: false,
      statements: false, factoring: false, compliance: true, services: true,
      reports: false, audit: false, settings: false,
    },
    canModify: true,
    actions: DEFAULT_ACTIONS.sales,
  },
}

// The external client portal is a later phase; lifecycle roles never get staff
// nav. Both fail closed here.
const ROLE_HAS_NO_NAV = (role: string) =>
  role === 'client' || role === 'pending' || role === 'terminated'

/** The set of nav page keys a role may access (stored config merged over defaults). */
export function computeAllowedNav(
  role: string | null | undefined,
  isMasterAdmin: boolean,
  stored: RolePermissions | null,
): Set<string> {
  if (!role) return new Set()
  if (role === 'admin' || isMasterAdmin) return new Set(ALL_NAV_KEYS)
  if (ROLE_HAS_NO_NAV(role)) return new Set()
  const def = DEFAULT_PERMISSIONS[role]?.nav ?? {}
  const merged = { ...def, ...(stored?.[role]?.nav ?? {}) }
  return new Set(Object.entries(merged).filter(([, v]) => v).map(([k]) => k))
}

/** Granular action flags for a role (stored config merged over defaults). */
export function computeActions(
  role: string | null | undefined,
  isMasterAdmin: boolean,
  stored: RolePermissions | null,
): RoleActions {
  if (role === 'admin' || isMasterAdmin) return ADMIN_ACTIONS
  if (!role) return EMPTY_ACTIONS
  const def = DEFAULT_ACTIONS[role] ?? EMPTY_ACTIONS
  return { ...def, ...(stored?.[role]?.actions ?? {}) }
}

/** Whether a role may create / edit / delete at all (the global Save switch). */
export function computeCanModify(
  role: string | null | undefined,
  isMasterAdmin: boolean,
  stored: RolePermissions | null,
): boolean {
  if (role === 'admin' || isMasterAdmin) return true
  if (!role) return false
  if (stored?.[role]) return stored[role].canModify ?? false
  return DEFAULT_PERMISSIONS[role]?.canModify ?? false
}

/** Nav key for a pathname, or null for routes any authenticated user may open. */
export function navKeyForPath(pathname: string): string | null {
  const seg = pathname.split('/').filter(Boolean)[0] ?? ''
  if (ALWAYS_ALLOWED_SEGMENTS.has(seg)) return null
  return URL_TO_NAV_KEY[seg] ?? seg
}

/** Server/client route gate: may this role open this path? */
export function isRouteAllowed(
  role: string | null | undefined,
  isMasterAdmin: boolean,
  stored: RolePermissions | null,
  pathname: string,
): boolean {
  if (!role) return true // null role is handled by the auth gate, not here
  if (role === 'admin' || isMasterAdmin) return true
  const key = navKeyForPath(pathname)
  if (key === null) return true
  return computeAllowedNav(role, isMasterAdmin, stored).has(key)
}
