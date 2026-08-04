import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Build a displayable driver name from whichever fields are populated.
 *
 * Rule: always prefer first_name + last_name over full_name.
 * `full_name` can be stale, empty, or (in some DB rows) contain the
 * raw UUID — so it is only used as a last resort before "Unknown Driver".
 * Never returns a raw UUID.
 *
 * Use this everywhere a driver name needs to be shown in the UI.
 * DO NOT fall back to `d.id` or `d.full_name` alone when building
 * dropdown labels or display strings — use this helper instead.
 */
export function driverName(
  driver:
    | { first_name?: string | null; last_name?: string | null; full_name?: string | null }
    | null
    | undefined
): string {
  if (!driver) return 'Unknown Driver'
  const fromParts = [driver.first_name, driver.last_name]
    .filter(v => v && v.trim())
    .join(' ')
    .trim()
  if (fromParts) return fromParts
  const fromFull = driver.full_name?.trim()
  // Guard: reject values that look like UUIDs (8-4-4-4-12 hex)
  if (fromFull && !/^[0-9a-f-]{32,}$/i.test(fromFull)) return fromFull
  return 'Unknown Driver'
}
