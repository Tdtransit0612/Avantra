'use client'

import { useEffect, useState } from 'react'
import Header from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useRole } from '@/lib/role-context'
import { logAudit } from '@/lib/audit'
import { Badge } from '@/components/ui/badge'
import {
  ALL_NAV_KEYS, DEFAULT_PERMISSIONS, EMPTY_ACTIONS,
  type RolePermissions, type RoleActions,
} from '@/lib/access'
import { toast } from 'sonner'
import { Loader2, Save, ShieldCheck, ShieldAlert, KeyRound, UserCircle, Mail, AlertTriangle, Zap } from 'lucide-react'

type Json = Record<string, unknown>

const EDITABLE_ROLES = ['dispatcher', 'back_office', 'sales'] as const
const ROLE_LABEL: Record<string, string> = {
  dispatcher: 'Dispatcher', back_office: 'Back Office', sales: 'Sales',
}
const ACTION_KEYS: (keyof RoleActions)[] = [
  'canBookLoad', 'canDispatch', 'canDeleteLoads', 'canOnboardClient', 'canOverrideFee',
  'canInvoiceBroker', 'canRecordPayment', 'canVoidInvoices', 'canIssueStatements',
  'canManageCompliance', 'canViewBankingInfo',
]
const ACTION_LABEL: Record<keyof RoleActions, string> = {
  canBookLoad:         'Book loads for clients',
  canDispatch:         'Dispatch / assign drivers',
  canDeleteLoads:      'Delete loads',
  canOnboardClient:    'Onboard clients',
  canOverrideFee:      'Override dispatch fee',
  canInvoiceBroker:    'Invoice brokers',
  canRecordPayment:    'Record payments',
  canVoidInvoices:     'Void invoices / statements',
  canIssueStatements:  'Issue fee statements',
  canManageCompliance: 'Manage compliance',
  canViewBankingInfo:  'View banking info',
}

function field(obj: Json, key: string): string {
  const v = obj?.[key]
  return v == null ? '' : String(v)
}

export default function SettingsPage() {
  const router = useRouter()
  const { role, isAdmin, isMasterAdmin } = useRole()
  const canEdit = isAdmin || isMasterAdmin

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState('account')
  const [identity, setIdentity] = useState<Json>({})
  const [billing, setBilling] = useState<Json>({})
  const [dispatchDefaults, setDispatchDefaults] = useState<Json>({})
  const [perms, setPerms] = useState<RolePermissions>({})

  // ── My Account (self-service — available to every signed-in user) ──
  const [accountEmail, setAccountEmail] = useState('')
  const [mfaOn,    setMfaOn]    = useState<boolean | null>(null)
  const [pw1,      setPw1]      = useState('')
  const [pw2,      setPw2]      = useState('')
  const [pwSaving, setPwSaving] = useState(false)

  // ── Company 2FA policy (admins / master admins only) ──
  const [require2fa,        setRequire2fa]        = useState(true)
  const [reqSettingsId,     setReqSettingsId]     = useState<number | string | null>(null)
  const [reqLoaded,         setReqLoaded]         = useState(false)
  const [reqMissing,        setReqMissing]        = useState(false)
  const [savingReq,         setSavingReq]         = useState(false)
  const [reqError,          setReqError]          = useState('')
  const [showReqOffConfirm, setShowReqOffConfirm] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    supabase.from('company_settings')
      .select('company_identity, billing_settings, dispatch_defaults, role_permissions')
      .eq('id', 1).maybeSingle()
      .then(({ data }) => {
        setIdentity((data?.company_identity as Json) ?? {})
        setBilling((data?.billing_settings as Json) ?? {})
        setDispatchDefaults((data?.dispatch_defaults as Json) ?? {})
        setPerms((data?.role_permissions as RolePermissions) ?? {})
        setLoading(false)
      })
  }, [])

  // Load the signed-in user's own email + current 2FA status for the Account tab.
  useEffect(() => {
    const supabase = createClient()
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      setAccountEmail(user?.email ?? '')
      try {
        const { data } = await supabase.auth.mfa.listFactors()
        setMfaOn((data?.all ?? []).some(f => f.factor_type === 'totp' && f.status === 'verified'))
      } catch { setMfaOn(false) }
    })()
  }, [])

  // Self-service password change (uses the user's own session; no admin rights needed).
  const changePassword = async () => {
    if (pw1.length < 8) { toast.error('Password must be at least 8 characters'); return }
    if (pw1 !== pw2)    { toast.error('Passwords do not match'); return }
    setPwSaving(true)
    const supabase = createClient()
    const { error } = await supabase.auth.updateUser({ password: pw1 })
    setPwSaving(false)
    if (error) { toast.error(error.message); return }
    setPw1(''); setPw2('')
    toast.success('Password updated')
    logAudit('account.password_change')
  }

  // Load the company 2FA policy (admins only). Read in ISOLATION from the main
  // company_settings load so a not-yet-added column can't break the rest of the page.
  useEffect(() => {
    if (!canEdit) { setReqLoaded(true); return }
    const supabase = createClient()
    ;(async () => {
      const { data, error } = await supabase
        .from('company_settings')
        .select('id, require_2fa')
        .limit(1)
        .maybeSingle()
      if (error) {
        // Column not added yet → show the one-time SQL. Any other error → surface it.
        if ((error as { code?: string }).code === '42703' || /require_2fa/i.test(error.message)) setReqMissing(true)
        else setReqError(error.message)
      } else if (data) {
        setReqSettingsId((data as { id: number | string }).id)
        setRequire2fa((data as { require_2fa?: boolean }).require_2fa !== false) // default = required
      }
      setReqLoaded(true)
    })()
  }, [canEdit])

  const applyRequire2fa = async (next: boolean) => {
    setSavingReq(true); setReqError('')
    const supabase = createClient()
    const id = reqSettingsId ?? 1
    const { error } = await supabase.from('company_settings').update({ require_2fa: next }).eq('id', id)
    if (error) { setReqError(error.message); setSavingReq(false); return }
    setRequire2fa(next); setSavingReq(false)
    logAudit('security.require_2fa_changed', {
      table_name: 'company_settings', record_id: String(id), new_value: { require_2fa: next },
    })
  }
  const handleToggleRequire = () => {
    if (require2fa) { setShowReqOffConfirm(true); return } // turning OFF → confirm first
    applyRequire2fa(true)
  }

  // Effective config for a role = defaults merged with stored overrides.
  const navFor = (role: string, key: string): boolean => {
    const stored = perms[role]?.nav?.[key]
    if (stored !== undefined) return stored
    return DEFAULT_PERMISSIONS[role]?.nav?.[key] ?? false
  }
  const canModifyFor = (role: string): boolean =>
    perms[role]?.canModify ?? DEFAULT_PERMISSIONS[role]?.canModify ?? false
  const actionFor = (role: string, key: keyof RoleActions): boolean => {
    const stored = perms[role]?.actions?.[key]
    if (stored !== undefined) return stored
    return DEFAULT_PERMISSIONS[role]?.actions?.[key] ?? false
  }

  const ensureRole = (p: RolePermissions, role: string) => {
    const base = DEFAULT_PERMISSIONS[role]
    if (!p[role]) {
      p[role] = {
        nav: { ...(base?.nav ?? {}) },
        canModify: base?.canModify ?? false,
        actions: { ...(base?.actions ?? EMPTY_ACTIONS) },
      }
    }
    return p[role]
  }
  const setNav = (role: string, key: string, val: boolean) =>
    setPerms(prev => { const p = structuredClone(prev); ensureRole(p, role).nav[key] = val; return p })
  const setCanModify = (role: string, val: boolean) =>
    setPerms(prev => { const p = structuredClone(prev); ensureRole(p, role).canModify = val; return p })
  const setAction = (role: string, key: keyof RoleActions, val: boolean) =>
    setPerms(prev => { const p = structuredClone(prev); ensureRole(p, role).actions[key] = val; return p })

  const save = async () => {
    if (!canEdit) return
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.from('company_settings').update({
      company_identity: identity,
      billing_settings: billing,
      dispatch_defaults: dispatchDefaults,
      role_permissions: perms,
    }).eq('id', 1)
    setSaving(false)
    if (error) { toast.error(error.message); return }
    toast.success('Settings saved')
    logAudit('settings.update', { table_name: 'company_settings', record_id: '1' })
  }

  const Text = (obj: Json, set: (o: Json) => void, key: string, label: string, ph?: string) => (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input value={field(obj, key)} placeholder={ph} disabled={!canEdit}
             onChange={e => set({ ...obj, [key]: e.target.value })} />
    </div>
  )

  if (loading) {
    return (<><Header title="Settings" subtitle="Company &amp; access configuration" /><div className="p-6"><Loader2 className="h-5 w-5 animate-spin text-sky-500" /></div></>)
  }

  return (
    <>
      <Header title="Settings" subtitle="Your account, company &amp; access" />
      <div className="p-6 space-y-6">
        {!canEdit && (
          <Card><CardContent className="py-4 text-sm text-amber-700 dark:text-amber-400">You can view these settings but only an admin can change them.</CardContent></Card>
        )}

        {tab !== 'account' && tab !== 'security' && (
          <div className="flex justify-end">
            <Button onClick={save} disabled={!canEdit || saving} className="bg-sky-600 hover:bg-sky-700">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}<span className="ml-2">Save changes</span>
            </Button>
          </div>
        )}

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="account">My Account</TabsTrigger>
            <TabsTrigger value="company">Company</TabsTrigger>
            <TabsTrigger value="billing">Billing &amp; Remit</TabsTrigger>
            <TabsTrigger value="dispatch">Dispatch Defaults</TabsTrigger>
            <TabsTrigger value="permissions">Permissions</TabsTrigger>
            {canEdit && <TabsTrigger value="security">Security</TabsTrigger>}
          </TabsList>

          <TabsContent value="account">
            <div className="space-y-6">
              {/* Profile */}
              <Card>
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><UserCircle className="h-4 w-4 text-sky-500" />Your account</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-2 text-sm">
                    <Mail className="h-4 w-4 text-gray-400" />
                    <span className="text-gray-600 dark:text-gray-300">{accountEmail || '—'}</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-gray-500">Role</span>
                    <Badge variant="secondary" className="capitalize">{isMasterAdmin ? 'Master admin' : (role ?? '—').replace('_', ' ')}</Badge>
                  </div>
                </CardContent>
              </Card>

              {/* Change password */}
              <Card>
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><KeyRound className="h-4 w-4 text-sky-500" />Change password</CardTitle></CardHeader>
                <CardContent className="space-y-4 max-w-md">
                  <div className="space-y-1">
                    <Label className="text-xs">New password</Label>
                    <Input type="password" value={pw1} autoComplete="new-password"
                           onChange={e => setPw1(e.target.value)} placeholder="At least 8 characters" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Confirm new password</Label>
                    <Input type="password" value={pw2} autoComplete="new-password"
                           onChange={e => setPw2(e.target.value)} placeholder="Re-type new password" />
                  </div>
                  <Button onClick={changePassword}
                          disabled={pwSaving || pw1.length < 8 || pw1 !== pw2}
                          className="bg-sky-600 hover:bg-sky-700">
                    {pwSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}<span className="ml-2">Update password</span>
                  </Button>
                  <p className="text-xs text-gray-500">Use at least 8 characters. You&apos;ll stay signed in on this device.</p>
                </CardContent>
              </Card>

              {/* Two-factor */}
              <Card>
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-sky-500" />Two-factor authentication</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  {mfaOn === null ? (
                    <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" />Checking…</div>
                  ) : mfaOn ? (
                    <>
                      <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400 font-medium">
                        <ShieldCheck className="h-4 w-4" />Active — your account is protected by an authenticator app.
                      </div>
                      <Button variant="outline" onClick={() => router.push('/setup-2fa?reconfigure=1')}>Set up a new device</Button>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400 font-medium">
                        <ShieldAlert className="h-4 w-4" />Not set up — add an authenticator app to secure your account.
                      </div>
                      <Button onClick={() => router.push('/setup-2fa')} className="bg-sky-600 hover:bg-sky-700">
                        <ShieldCheck className="h-4 w-4" /><span className="ml-2">Set up two-factor auth</span>
                      </Button>
                    </>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="company">
            <Card>
              <CardHeader><CardTitle className="text-base">Company identity</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {Text(identity, setIdentity, 'name', 'Legal name', 'Avantra LLC')}
                {Text(identity, setIdentity, 'mc_number', 'Broker MC #')}
                {Text(identity, setIdentity, 'address', 'Address')}
                {Text(identity, setIdentity, 'city', 'City')}
                {Text(identity, setIdentity, 'state', 'State')}
                {Text(identity, setIdentity, 'zip', 'ZIP')}
                {Text(identity, setIdentity, 'phone', 'Phone')}
                {Text(identity, setIdentity, 'email', 'Email')}
                {Text(identity, setIdentity, 'logo_url', 'Logo URL')}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="billing">
            <Card>
              <CardHeader><CardTitle className="text-base">Remit-to (prints on invoices)</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {Text(billing, setBilling, 'remit_name', 'Remit to (name)')}
                {Text(billing, setBilling, 'remit_address', 'Remit address')}
                {Text(billing, setBilling, 'ach_bank', 'Bank name')}
                {Text(billing, setBilling, 'ach_routing', 'ACH routing #')}
                {Text(billing, setBilling, 'ach_account', 'ACH account #')}
                {Text(billing, setBilling, 'payment_terms', 'Default terms', 'Net 30')}
              </CardContent>
            </Card>

            <Card className="mt-4">
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><Zap className="h-4 w-4 text-amber-500" />Carrier Quick Pay policy</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {Text(billing, setBilling, 'quick_pay_rate', 'Quick pay fee (%)', '3')}
                {Text(billing, setBilling, 'quick_pay_min', 'Minimum fee ($)', '25')}
                <p className="sm:col-span-2 text-xs text-gray-500 dark:text-gray-400">
                  Applied to settlements for carriers who opt into Quick Pay (next-business-day payment). Carriers not opted in are Net 30, paid by check or ACH. Defaults: 3% of gross, $25 minimum.
                </p>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="dispatch">
            <Card>
              <CardHeader><CardTitle className="text-base">Default dispatch fee terms</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Prefilled when a new client is added. Each client&apos;s own plan overrides these, and every
                  load snapshots the client&apos;s terms at booking — so changing anything here never rewrites
                  a fee that was already charged.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {Text(dispatchDefaults, setDispatchDefaults, 'fee_percent', 'Default fee %', '10')}
                  {Text(dispatchDefaults, setDispatchDefaults, 'fee_flat', 'Default flat fee ($)', '0')}
                  {Text(dispatchDefaults, setDispatchDefaults, 'fee_basis', 'Fee basis (gross or linehaul)', 'gross')}
                  {Text(dispatchDefaults, setDispatchDefaults, 'fee_minimum', 'Minimum fee per load ($)', '0')}
                  {Text(dispatchDefaults, setDispatchDefaults, 'billing_cycle', 'Billing cycle', 'weekly')}
                  {Text(dispatchDefaults, setDispatchDefaults, 'statement_terms', 'Statement terms', 'Due on receipt')}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="permissions">
            <Card>
              <CardHeader><CardTitle className="text-base">Role permissions</CardTitle></CardHeader>
              <CardContent className="space-y-6">
                <p className="text-xs text-gray-500">Admins and master admins always have full access. Configure the staff roles below — changes merge over the built-in defaults.</p>
                {EDITABLE_ROLES.map(role => (
                  <div key={role} className="border rounded-lg dark:border-gray-700 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-sm">{ROLE_LABEL[role]}</h3>
                      <label className="flex items-center gap-2 text-xs">
                        <input type="checkbox" disabled={!canEdit} checked={canModifyFor(role)} onChange={e => setCanModify(role, e.target.checked)} />
                        Can create / edit / delete
                      </label>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Navigation</p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                        {ALL_NAV_KEYS.map(key => (
                          <label key={key} className="flex items-center gap-2 text-xs capitalize">
                            <input type="checkbox" disabled={!canEdit} checked={navFor(role, key)} onChange={e => setNav(role, key, e.target.checked)} />
                            {key}
                          </label>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Actions</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                        {ACTION_KEYS.map(key => (
                          <label key={key} className="flex items-center gap-2 text-xs">
                            <input type="checkbox" disabled={!canEdit} checked={actionFor(role, key)} onChange={e => setAction(role, key, e.target.checked)} />
                            {ACTION_LABEL[key]}
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </TabsContent>

          {canEdit && (
            <TabsContent value="security">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-sky-500" />Company 2FA Policy
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 max-w-2xl">
                  {!reqLoaded ? (
                    <div className="flex items-center gap-2 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
                  ) : reqMissing ? (
                    <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 rounded-lg text-sm text-amber-800 dark:text-amber-300">
                      <p className="font-medium mb-1">Run this SQL once in Supabase to enable the 2FA policy toggle:</p>
                      <code className="block text-xs mt-1 whitespace-pre-wrap select-all">alter table public.company_settings add column if not exists require_2fa boolean not null default true;</code>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <p className="text-sm font-medium text-gray-800 dark:text-gray-200">Require 2FA for all staff</p>
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                            {require2fa
                              ? 'Every admin, broker, carrier-sales, and accounting user must set up 2FA before using the app.'
                              : '2FA is optional — staff can sign in with just a password unless they enable it themselves in My Account.'}
                          </p>
                        </div>
                        <button
                          role="switch"
                          aria-checked={require2fa}
                          aria-label="Require 2FA for all staff"
                          onClick={handleToggleRequire}
                          disabled={savingReq}
                          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${require2fa ? 'bg-green-600' : 'bg-gray-300 dark:bg-white/20'}`}
                        >
                          <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${require2fa ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
                        </button>
                      </div>
                      {!require2fa && (
                        <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 text-xs text-amber-800 dark:text-amber-300">
                          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                          2FA is currently optional. For security, keep it required for admin accounts at minimum.
                        </div>
                      )}
                      {reqError && <p className="text-xs text-red-600 dark:text-red-400">{reqError}</p>}
                    </>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          )}
        </Tabs>

        {/* Confirm turning the 2FA requirement OFF */}
        <Dialog open={showReqOffConfirm} onOpenChange={setShowReqOffConfirm}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Make 2FA optional for staff?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Staff will be able to sign in with only a password, and anyone who hasn&apos;t enabled 2FA themselves will no longer be prompted to. You can turn this back on anytime.
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="outline" onClick={() => setShowReqOffConfirm(false)}>Cancel</Button>
              <Button className="bg-amber-600 hover:bg-amber-700 text-white" onClick={() => { setShowReqOffConfirm(false); applyRequire2fa(false) }}>
                Make Optional
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </>
  )
}
