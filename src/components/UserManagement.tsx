'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table'
import {
  Loader2, Search, ShieldCheck, UserCheck, UserX, KeyRound, AlertTriangle, Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { logAudit } from '@/lib/audit'
import { longDate } from '@/lib/dispatch'
import type { UserRole, Client } from '@/types'

// Admin console for approving and re-roling users. Every write goes through
// /api/users because the DB pins profiles.role against non-service-role writes —
// that's the anti-self-escalation guard, and this is its sanctioned bypass.

interface ManagedUser {
  id: string
  email: string | null
  full_name: string | null
  phone: string | null
  role: UserRole
  is_master_admin: boolean
  mfa_enrolled: boolean
  client_id: string | null
  created_at: string
}

const ROLE_LABELS: Record<UserRole, string> = {
  admin:       'Admin',
  dispatcher:  'Dispatcher',
  back_office: 'Back Office',
  sales:       'Sales',
  client:      'Client (portal)',
  pending:     'Pending',
  terminated:  'Terminated',
}

const ROLE_COLORS: Record<UserRole, string> = {
  admin:       'bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-900/40 dark:text-indigo-300 dark:border-indigo-800/50',
  dispatcher:  'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-800/50',
  back_office: 'bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-800/50',
  sales:       'bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-900/40 dark:text-teal-300 dark:border-teal-800/50',
  client:      'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800/50',
  pending:     'bg-gray-100 text-gray-700 border-gray-200 dark:bg-white/10 dark:text-gray-300 dark:border-white/10',
  terminated:  'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-800/50',
}

const ASSIGNABLE: UserRole[] = ['admin', 'dispatcher', 'back_office', 'sales', 'client', 'pending', 'terminated']

export function UserManagement({ isMasterAdmin, currentUserId }: {
  isMasterAdmin: boolean
  currentUserId: string | null
}) {
  const [users, setUsers] = useState<ManagedUser[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/users')
      const json = await res.json() as { users?: ManagedUser[]; error?: string }
      if (!res.ok) { setError(json.error ?? 'Could not load users.'); setLoading(false); return }
      setUsers(json.users ?? [])
    } catch {
      setError('Could not reach the server.')
    }
    const supabase = createClient()
    const { data } = await supabase.from('clients').select('*').is('deleted_at', null).order('legal_name')
    setClients((data ?? []) as Client[])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const patch = async (id: string, body: Record<string, unknown>, successMsg: string) => {
    setBusyId(id)
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...body }),
      })
      const json = await res.json() as { ok?: boolean; error?: string }
      if (!res.ok) { toast.error(json.error ?? 'Update failed.'); return }
      // Mirror the server-side audit through the client helper so the high-risk
      // email alert actually fires (the server insert alone doesn't send one).
      void logAudit('user.role_change', {
        table_name: 'profiles', record_id: id, new_value: body,
      })
      toast.success(successMsg)
      load()
    } catch {
      toast.error('Could not reach the server.')
    } finally {
      setBusyId(null)
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return users.filter(u => {
      if (filter === 'pending' && u.role !== 'pending') return false
      if (filter === 'staff' && !['admin', 'dispatcher', 'back_office', 'sales'].includes(u.role)) return false
      if (filter !== 'all' && filter !== 'pending' && filter !== 'staff' && u.role !== filter) return false
      if (!q) return true
      return [u.email, u.full_name, u.phone].filter(Boolean).join(' ').toLowerCase().includes(q)
    })
  }, [users, search, filter])

  const pendingCount = users.filter(u => u.role === 'pending').length

  const clientName = (id: string | null) => {
    if (!id) return null
    const c = clients.find(x => x.id === id)
    return c ? (c.dba_name || c.legal_name) : 'Unknown client'
  }

  return (
    <div className="space-y-4">
      {pendingCount > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-300 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-950/30 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {pendingCount} account{pendingCount === 1 ? '' : 's'} waiting for a role. Until you assign one,
          they can sign in but see nothing.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input placeholder="Search name or email…" className="pl-9 h-9" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <Select value={filter} onValueChange={v => setFilter(v ?? 'all')}>
          <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everyone</SelectItem>
            <SelectItem value="pending">Awaiting approval</SelectItem>
            <SelectItem value="staff">Staff</SelectItem>
            {ASSIGNABLE.map(r => <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 rounded-lg px-4 py-2.5">
          <AlertTriangle className="h-4 w-4 shrink-0" />{error}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-gray-400">
              <Loader2 className="h-6 w-6 animate-spin mr-2" />Loading users…
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <div className="p-3 rounded-full bg-indigo-50 dark:bg-indigo-950 text-indigo-500"><Users className="h-7 w-7" /></div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
                {users.length === 0 ? 'No users yet' : 'Nobody matches that filter'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Joined</TableHead>
                    <TableHead>2FA</TableHead>
                    <TableHead>Current</TableHead>
                    <TableHead className="w-52">Role</TableHead>
                    <TableHead className="w-56">Portal client</TableHead>
                    {isMasterAdmin && <TableHead className="w-32">Master</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map(u => {
                    const isSelf = u.id === currentUserId
                    const busy = busyId === u.id
                    // A plain admin may not re-role a master admin; the server
                    // enforces this too, this just avoids a pointless 403.
                    const locked = isSelf || (u.is_master_admin && !isMasterAdmin)
                    return (
                      <TableRow key={u.id}>
                        <TableCell>
                          <div className="font-medium text-gray-900 dark:text-white">
                            {u.full_name || u.email || 'Unnamed'}
                            {isSelf && <span className="ml-1.5 text-[11px] text-gray-400">(you)</span>}
                          </div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">{u.email}</div>
                        </TableCell>
                        <TableCell className="text-sm text-gray-600 dark:text-gray-300 whitespace-nowrap">
                          {longDate(u.created_at)}
                        </TableCell>
                        <TableCell>
                          {u.mfa_enrolled
                            ? <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                                <KeyRound className="h-3 w-3" />On
                              </span>
                            : <span className="text-xs text-gray-400">Off</span>}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <Badge className={`border ${ROLE_COLORS[u.role]}`}>{ROLE_LABELS[u.role]}</Badge>
                            {u.is_master_admin && (
                              <ShieldCheck className="h-3.5 w-3.5 text-indigo-500" aria-label="Master admin" />
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Select
                            value={u.role}
                            onValueChange={v => {
                              if (!v || v === u.role) return
                              patch(u.id, { role: v }, `${u.email ?? 'User'} → ${ROLE_LABELS[v as UserRole]}`)
                            }}
                          >
                            <SelectTrigger className="h-8 text-xs w-full" disabled={locked || busy}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ASSIGNABLE.map(r => <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          {u.role === 'client' ? (
                            <Select
                              value={u.client_id ?? null}
                              onValueChange={v => {
                                const id = (v && v !== '__none') ? v : null
                                patch(u.id, { client_id: id }, id ? 'Portal access bound' : 'Portal binding cleared')
                              }}
                            >
                              <SelectTrigger className="h-8 text-xs w-full" disabled={busy}>
                                <SelectValue placeholder="Not bound — sees nothing" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__none">Not bound</SelectItem>
                                {clients.map(c => (
                                  <SelectItem key={c.id} value={c.id}>{c.dba_name || c.legal_name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <span className="text-xs text-gray-400">
                              {clientName(u.client_id) ?? '—'}
                            </span>
                          )}
                        </TableCell>
                        {isMasterAdmin && (
                          <TableCell>
                            {u.is_master_admin ? (
                              <Button
                                size="sm" variant="outline" className="h-7 gap-1 text-xs"
                                disabled={isSelf || busy}
                                onClick={() => patch(u.id, { is_master_admin: false }, 'Master admin revoked')}
                              >
                                <UserX className="h-3 w-3" />Revoke
                              </Button>
                            ) : (
                              <Button
                                size="sm" variant="outline" className="h-7 gap-1 text-xs"
                                disabled={busy}
                                onClick={() => {
                                  if (!confirm(`Grant master admin to ${u.email}? They'll be able to change any role, including yours.`)) return
                                  patch(u.id, { is_master_admin: true }, 'Master admin granted')
                                }}
                              >
                                <UserCheck className="h-3 w-3" />Grant
                              </Button>
                            )}
                          </TableCell>
                        )}
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-[11px] text-gray-400">
        New signups land on <strong>Pending</strong> with no access until you assign a role. A
        <strong> Client</strong> user must also be bound to a carrier — that binding is what scopes
        every portal query to their own data.
      </p>
    </div>
  )
}

export default UserManagement
