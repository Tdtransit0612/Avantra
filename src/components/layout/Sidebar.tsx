'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard, Columns3, Package, Users, Building2, FileText,
  Receipt, Banknote, ShieldCheck, Wrench, TrendingUp, ClipboardList,
  Settings, LogOut, Compass,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useRole } from '@/lib/role-context'
import type { UserRole } from '@/types'
import { useState } from 'react'

// Visibility is driven entirely by `allowedNav` from the role context (the single
// source of truth in @/lib/access). The page key is the href minus its leading slash.
const allNavItems = [
  { href: '/dashboard',   label: 'Dashboard',      icon: LayoutDashboard },
  { href: '/board',       label: 'Dispatch Board', icon: Columns3 },
  { href: '/loads',       label: 'Loads',          icon: Package },
  { href: '/clients',     label: 'Clients',        icon: Users },
  { href: '/brokers',     label: 'Brokers',        icon: Building2 },
  { href: '/invoicing',   label: 'Invoicing / AR', icon: FileText },
  { href: '/statements',  label: 'Fee Statements', icon: Receipt },
  { href: '/factoring',   label: 'Factoring',      icon: Banknote },
  { href: '/compliance',  label: 'Compliance',     icon: ShieldCheck },
  { href: '/services',    label: 'Services',       icon: Wrench },
  { href: '/reports',     label: 'Reports',        icon: TrendingUp },
  { href: '/audit',       label: 'Audit Log',      icon: ClipboardList },
  { href: '/settings',    label: 'Settings',       icon: Settings },
]

const roleLabels: Record<UserRole, string> = {
  admin:       'Admin',
  dispatcher:  'Dispatcher',
  back_office: 'Back Office',
  sales:       'Sales',
  client:      'Client',
  pending:     'Pending',
  terminated:  'Terminated',
}

const roleDotColors: Record<UserRole, string> = {
  admin:       'bg-indigo-500',
  dispatcher:  'bg-blue-500',
  back_office: 'bg-violet-500',
  sales:       'bg-teal-500',
  client:      'bg-amber-500',
  pending:     'bg-gray-500',
  terminated:  'bg-red-600',
}

export default function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const { role, isMasterAdmin, loading, allowedNav } = useRole()
  const [hovered, setHovered] = useState(false)
  const expanded = hovered

  const navItems = loading || !role
    // Fail closed: while the role is loading or unknown, show ONLY the dashboard —
    // never the full admin nav (which would briefly/persistently leak admin links).
    ? allNavItems.filter(item => item.href === '/dashboard')
    : allNavItems.filter(item => {
        if (role === 'admin' || isMasterAdmin) return true
        if (item.href === '/dashboard') return true
        const pageKey = item.href.replace(/^\//, '')
        return allowedNav.has(pageKey)
      })

  const handleSignOut = async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <aside
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        'flex flex-col min-h-screen bg-slate-900 dark:bg-sidebar text-white shrink-0 transition-all duration-200 ease-in-out',
        expanded ? 'w-64' : 'w-14'
      )}
    >
      {/* Header */}
      <div className="flex items-center h-14 shrink-0 border-b border-slate-700 dark:border-white/10 px-3 gap-3 overflow-hidden">
        <Compass className="h-5 w-5 text-indigo-400 shrink-0" />
        <div className={cn('min-w-0 transition-all duration-200', expanded ? 'opacity-100 w-auto' : 'opacity-0 w-0 overflow-hidden')}>
          <div className="font-bold text-sm leading-tight whitespace-nowrap">Avantra</div>
          <div className="text-xs text-slate-400 leading-tight whitespace-nowrap">Carrier Services</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden py-3 px-2 space-y-0.5">
        {navItems.map((item) => {
          const Icon = item.icon
          const active = pathname === item.href || pathname.startsWith(item.href + '/')
          return (
            <Link
              key={item.href}
              href={item.href}
              title={!expanded ? item.label : undefined}
              className={cn(
                'flex items-center gap-3 px-2 py-2 rounded-md text-sm transition-colors overflow-hidden',
                active
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-300 hover:bg-slate-800 dark:hover:bg-white/10 hover:text-white'
              )}
            >
              <Icon className="h-4 w-4 flex-shrink-0" />
              <span className={cn('whitespace-nowrap transition-all duration-200', expanded ? 'opacity-100' : 'opacity-0 w-0 overflow-hidden')}>{item.label}</span>
            </Link>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-slate-700 dark:border-white/10 py-3 px-2 space-y-1">
        {role && (
          <div className={cn('flex items-center gap-2 px-2 py-1 overflow-hidden', !expanded && 'justify-center')}>
            <span className={`h-2 w-2 rounded-full shrink-0 ${isMasterAdmin ? 'bg-indigo-400' : roleDotColors[role]}`} />
            <span className={cn('text-xs text-slate-400 whitespace-nowrap transition-all duration-200', expanded ? 'opacity-100' : 'opacity-0 w-0 overflow-hidden')}>
              {isMasterAdmin ? 'Master Admin' : roleLabels[role]}
            </span>
          </div>
        )}
        <button
          onClick={handleSignOut}
          title={!expanded ? 'Sign out' : undefined}
          className="flex items-center gap-3 px-2 py-2 rounded-md text-sm text-slate-300 hover:bg-slate-800 dark:hover:bg-white/10 hover:text-white transition-colors w-full overflow-hidden"
        >
          <LogOut className="h-4 w-4 shrink-0" />
          <span className={cn('whitespace-nowrap transition-all duration-200', expanded ? 'opacity-100' : 'opacity-0 w-0 overflow-hidden')}>Sign Out</span>
        </button>
      </div>
    </aside>
  )
}
