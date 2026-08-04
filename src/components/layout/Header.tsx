'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Bell, Search, Settings, LogOut, X, AlertTriangle, CheckCircle, Package, Building2, Truck, FileText, Sun, Moon } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useTheme } from '@/lib/theme-context'

interface SearchResult {
  type: 'load' | 'customer' | 'carrier' | 'invoice'
  id: string
  title: string
  subtitle: string
  href: string
}

interface HeaderProps {
  title: string
  subtitle?: string
}

interface Alert {
  type: 'critical' | 'warning' | 'info'
  message: string
  link?: string
}

export default function Header({ title, subtitle }: HeaderProps) {
  const router = useRouter()
  const { theme, toggle: toggleTheme } = useTheme()
  const [showAlerts, setShowAlerts] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [userEmail, setUserEmail] = useState('')
  const [userInitials, setUserInitials] = useState('CL')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [showSearch, setShowSearch] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const alertRef = useRef<HTMLDivElement>(null)
  const profileRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const supabase = createClient()

    supabase.auth.getUser().then(({ data }) => {
      const email = data.user?.email ?? ''
      setUserEmail(email)
      const parts = email.split('@')[0].split('.')
      setUserInitials(parts.map((p: string) => p[0]?.toUpperCase()).join('').slice(0, 2) || 'CL')
    })

    const soon30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
    const today = new Date().toISOString().slice(0, 10)

    // Queries against not-yet-migrated tables return { data: null } (not a throw),
    // so this degrades to "all clear" until the schema lands.
    Promise.all([
      supabase.from('carriers').select('id, name, insurance_expiry').lte('insurance_expiry', soon30).eq('status', 'active'),
      supabase.from('carriers').select('id, name, authority_status').eq('authority_status', 'not_authorized').eq('status', 'active'),
      supabase.from('invoices').select('id, amount').in('status', ['sent', 'overdue']).lte('due_date', today),
    ]).then(([{ data: ins }, { data: auth }, { data: overdue }]) => {
      const newAlerts: Alert[] = []

      ;(ins ?? []).forEach(c => {
        const days = Math.floor((new Date(c.insurance_expiry).getTime() - Date.now()) / 86400000)
        newAlerts.push({
          type: days <= 7 ? 'critical' : 'warning',
          message: `Carrier COI expiring in ${days}d — ${c.name}`,
          link: `/carriers/${c.id}`,
        })
      })

      ;(auth ?? []).forEach(c => {
        newAlerts.push({
          type: 'critical',
          message: `Carrier authority NOT active — ${c.name}`,
          link: `/carriers/${c.id}`,
        })
      })

      ;(overdue ?? []).forEach(inv => {
        newAlerts.push({
          type: 'critical',
          message: `Overdue invoice — $${Number(inv.amount).toLocaleString()}`,
          link: `/invoicing`,
        })
      })

      setAlerts(newAlerts)
    })
  }, [])

  const runSearch = useCallback(async (q: string) => {
    if (q.length < 2) { setSearchResults([]); return }
    setSearchLoading(true)
    const supabase = createClient()
    const [{ data: loads }, { data: customers }, { data: carriers }, { data: invoices }] = await Promise.all([
      supabase.from('loads').select('id, load_number, pickup_city, pickup_state, delivery_city, delivery_state').is('deleted_at', null).or(`load_number.ilike.%${q}%,pickup_city.ilike.%${q}%,delivery_city.ilike.%${q}%`).limit(4),
      supabase.from('customers').select('id, name, city, state').ilike('name', `%${q}%`).limit(3),
      supabase.from('carriers').select('id, name, mc_number').or(`name.ilike.%${q}%,mc_number.ilike.%${q}%`).limit(4),
      supabase.from('invoices').select('id, invoice_number, amount, status').ilike('invoice_number', `%${q}%`).limit(3),
    ])
    const results: SearchResult[] = [
      ...(loads ?? []).map(l => ({ type: 'load' as const, id: l.id, title: l.load_number, subtitle: `${l.pickup_city ?? '?'}, ${l.pickup_state ?? ''} → ${l.delivery_city ?? '?'}, ${l.delivery_state ?? ''}`, href: `/loads/${l.id}` })),
      ...(customers ?? []).map(c => ({ type: 'customer' as const, id: c.id, title: c.name, subtitle: [c.city, c.state].filter(Boolean).join(', ') || 'Customer', href: `/customers/${c.id}` })),
      ...(carriers ?? []).map(c => ({ type: 'carrier' as const, id: c.id, title: c.name, subtitle: c.mc_number ? `MC# ${c.mc_number}` : 'Carrier', href: `/carriers/${c.id}` })),
      ...(invoices ?? []).map(i => ({ type: 'invoice' as const, id: i.id, title: i.invoice_number, subtitle: `$${Number(i.amount).toLocaleString()} — ${i.status}`, href: `/invoicing` })),
    ]
    setSearchResults(results)
    setSearchLoading(false)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => runSearch(searchQuery), 300)
    return () => clearTimeout(t)
  }, [searchQuery, runSearch])

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (alertRef.current && !alertRef.current.contains(e.target as Node)) setShowAlerts(false)
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) setShowProfile(false)
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setShowSearch(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // ⌘K / Ctrl-K jumps to global search from anywhere; Esc closes the results.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setShowSearch(true)
        document.getElementById('global-search')?.focus()
      } else if (e.key === 'Escape') {
        setShowSearch(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const handleSignOut = async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  const criticalCount = alerts.filter(a => a.type === 'critical').length

  return (
    <header className="flex items-center justify-between px-6 py-4 border-b bg-white dark:bg-gray-900 dark:border-gray-800">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">{title}</h1>
        {subtitle && <p className="text-sm text-gray-500 dark:text-gray-400">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-3">
        <div className="relative hidden md:block" ref={searchRef}>
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 z-10" />
          <Input
            id="global-search"
            placeholder="Search loads, customers, carriers..."
            className="pl-9 pr-12 w-72 h-9"
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); setShowSearch(true) }}
            onFocus={() => setShowSearch(true)}
          />
          <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 hidden lg:flex items-center gap-0.5 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-1.5 py-0.5 text-[10px] font-medium text-gray-400">
            ⌘K
          </kbd>
          {showSearch && (searchResults.length > 0 || searchLoading || searchQuery.length >= 2) && (
            <div className="absolute top-11 left-0 w-96 bg-white dark:bg-gray-800 rounded-xl shadow-lg border dark:border-gray-700 z-50">
              {searchLoading ? (
                <div className="px-4 py-3 text-sm text-gray-400">Searching...</div>
              ) : searchResults.length === 0 ? (
                <div className="px-4 py-3 text-sm text-gray-400">No results for &quot;{searchQuery}&quot;</div>
              ) : (
                <div className="max-h-80 overflow-y-auto py-1">
                  {searchResults.map(r => {
                    const Icon = r.type === 'load' ? Package : r.type === 'customer' ? Building2 : r.type === 'carrier' ? Truck : FileText
                    const color = r.type === 'load' ? 'text-sky-600 bg-sky-50 dark:bg-sky-950' : r.type === 'customer' ? 'text-green-600 bg-green-50 dark:bg-green-950' : r.type === 'carrier' ? 'text-amber-600 bg-amber-50 dark:bg-amber-950' : 'text-purple-600 bg-purple-50 dark:bg-purple-950'
                    return (
                      <Link key={`${r.type}-${r.id}`} href={r.href} onClick={() => { setShowSearch(false); setSearchQuery('') }} className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                        <div className={`p-1.5 rounded-lg ${color}`}><Icon className="h-3.5 w-3.5" /></div>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-gray-900 dark:text-white truncate">{r.title}</div>
                          <div className="text-xs text-gray-400 truncate">{r.subtitle}</div>
                        </div>
                      </Link>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Dark mode toggle */}
        <Button variant="ghost" size="icon" onClick={toggleTheme} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
          {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </Button>

        {/* Notifications */}
        <div className="relative" ref={alertRef}>
          <Button variant="ghost" size="icon" className="relative" onClick={() => { setShowAlerts(v => !v); setShowProfile(false) }}>
            <Bell className="h-5 w-5" />
            {alerts.length > 0 && (
              <span className={`absolute top-1 right-1 h-4 w-4 rounded-full text-white text-[10px] font-bold flex items-center justify-center ${criticalCount > 0 ? 'bg-red-500' : 'bg-sky-500'}`}>
                {alerts.length > 9 ? '9+' : alerts.length}
              </span>
            )}
          </Button>

          {showAlerts && (
            <div className="absolute right-0 top-11 w-80 bg-white dark:bg-gray-800 rounded-xl shadow-lg border dark:border-gray-700 z-50">
              <div className="flex items-center justify-between px-4 py-3 border-b dark:border-gray-700">
                <span className="font-semibold text-sm dark:text-white">Notifications</span>
                <button onClick={() => setShowAlerts(false)}><X className="h-4 w-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200" /></button>
              </div>
              <div className="max-h-[420px] overflow-y-auto">
                {alerts.length === 0 ? (
                  <div className="flex items-center gap-2 p-4 text-sm text-green-700 dark:text-green-400">
                    <CheckCircle className="h-4 w-4 text-green-500" />
                    All clear — no notifications right now
                  </div>
                ) : alerts.map((alert, i) => (
                  <Link
                    key={i}
                    href={alert.link ?? '#'}
                    onClick={() => setShowAlerts(false)}
                    className={`flex items-start gap-3 px-4 py-3 border-b dark:border-gray-700 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors ${alert.type === 'critical' ? 'bg-red-50 dark:bg-red-950 hover:bg-red-100 dark:hover:bg-red-900' : ''}`}
                  >
                    <AlertTriangle className={`h-4 w-4 mt-0.5 flex-shrink-0 ${alert.type === 'critical' ? 'text-red-500' : 'text-yellow-500'}`} />
                    <span className={`text-sm ${alert.type === 'critical' ? 'text-red-800 dark:text-red-300' : 'text-yellow-800 dark:text-yellow-300'}`}>{alert.message}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Profile */}
        <div className="relative" ref={profileRef}>
          <button onClick={() => { setShowProfile(v => !v); setShowAlerts(false) }}>
            <Avatar className="h-8 w-8 cursor-pointer hover:ring-2 hover:ring-sky-400 transition-all">
              <AvatarFallback className="bg-sky-600 text-white text-sm">{userInitials}</AvatarFallback>
            </Avatar>
          </button>

          {showProfile && (
            <div className="absolute right-0 top-11 w-52 bg-white dark:bg-gray-800 rounded-xl shadow-lg border dark:border-gray-700 z-50">
              <div className="px-4 py-3 border-b dark:border-gray-700">
                <p className="text-xs font-medium text-gray-900 dark:text-white">Signed in as</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">{userEmail || 'Avantra'}</p>
              </div>
              <div className="py-1">
                <Link href="/settings" onClick={() => setShowProfile(false)} className="flex items-center gap-2.5 px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
                  <Settings className="h-4 w-4 text-gray-400" />Settings
                </Link>
                <button onClick={handleSignOut} className="flex items-center gap-2.5 w-full px-4 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950">
                  <LogOut className="h-4 w-4" />Sign Out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
