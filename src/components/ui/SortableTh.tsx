'use client'

import { TableHead } from '@/components/ui/table'
import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react'
import type { SortState } from '@/lib/use-sort'

// Sortable column header shared by every list page, so sorting looks and behaves
// identically across modules. Pair with useSort() from @/lib/use-sort.
export function SortableTh<K extends string>({
  label, k, sort, toggle, align = 'left', className,
}: {
  label: string
  k: K
  sort: SortState<K>
  toggle: (k: K) => void
  align?: 'left' | 'right'
  className?: string
}) {
  const active = sort.key === k
  return (
    <TableHead className={[align === 'right' ? 'text-right' : '', className ?? ''].filter(Boolean).join(' ') || undefined}>
      <button
        type="button"
        onClick={() => toggle(k)}
        className={[
          'inline-flex items-center gap-1 select-none hover:text-indigo-600 dark:hover:text-indigo-400',
          align === 'right' ? 'flex-row-reverse' : '',
          active ? 'text-indigo-600 dark:text-indigo-400 font-semibold' : '',
        ].filter(Boolean).join(' ')}
      >
        {label}
        {active
          ? (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)
          : <ArrowUpDown className="h-3 w-3 text-gray-300 dark:text-gray-600" />}
      </button>
    </TableHead>
  )
}

export default SortableTh
