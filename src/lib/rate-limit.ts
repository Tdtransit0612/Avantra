/**
 * In-memory rate limiter for Next.js API routes.
 *
 * Note: in a serverless/edge environment each cold-start gets a fresh Map.
 * This is still effective at blocking bursts within a single instance and
 * provides meaningful protection for low-traffic internal API routes.
 * For a fully distributed solution, replace the Map with Upstash Redis.
 */

interface Entry {
  count:   number
  resetAt: number
}

const store = new Map<string, Entry>()

// Prune expired entries every 5 minutes to avoid memory growth.
// unref() so this timer never keeps a serverless instance alive on its own.
const pruneTimer = setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of store) {
    if (now > entry.resetAt) store.delete(key)
  }
}, 5 * 60 * 1000)
;(pruneTimer as { unref?: () => void }).unref?.()

export interface RateLimitResult {
  ok:        boolean
  remaining: number
  resetAt:   number   // unix ms
}

/**
 * @param key       Unique identifier (e.g. IP + route, or user ID + route)
 * @param limit     Max requests allowed in the window
 * @param windowMs  Rolling window in milliseconds
 */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now   = Date.now()
  const entry = store.get(key)

  if (!entry || now > entry.resetAt) {
    const resetAt = now + windowMs
    store.set(key, { count: 1, resetAt })
    return { ok: true, remaining: limit - 1, resetAt }
  }

  if (entry.count >= limit) {
    return { ok: false, remaining: 0, resetAt: entry.resetAt }
  }

  entry.count++
  return { ok: true, remaining: limit - entry.count, resetAt: entry.resetAt }
}

/** Helper: extract best available IP from request headers */
export function getIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  )
}
