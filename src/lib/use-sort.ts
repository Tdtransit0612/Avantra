import { useState, useMemo } from 'react'

/**
 * Lightweight client-side table sorting.
 *
 * Pass the rows plus a STABLE map of column-key → accessor (define it as a module
 * constant or wrap in useMemo so its identity doesn't change every render). Returns
 * the sorted rows, the current sort state, and a toggle() that flips asc/desc on
 * repeat clicks of the same column. Blank/null values always sort last.
 */
export type SortDir = 'asc' | 'desc'
export interface SortState<K extends string> { key: K | null; dir: SortDir }
export type SortAccessors<T, K extends string> = Record<K, (row: T) => string | number | null | undefined>

export function useSort<T, K extends string>(
  rows: T[],
  accessors: SortAccessors<T, K>,
  initial: SortState<K> = { key: null, dir: 'asc' },
) {
  const [sort, setSort] = useState<SortState<K>>(initial)

  const sorted = useMemo(() => {
    if (!sort.key) return rows
    const acc = accessors[sort.key]
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = acc(a), bv = acc(b)
      const an = av == null || av === ''
      const bn = bv == null || bv === ''
      if (an && bn) return 0
      if (an) return 1          // blanks last, regardless of direction
      if (bn) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir
    })
  }, [rows, sort, accessors])

  const toggle = (key: K) =>
    setSort(s => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))

  return { sorted, sort, toggle }
}
