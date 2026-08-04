import type { SupabaseClient } from '@supabase/supabase-js'

// ── Public shipment tracking (Avantra) ─────────────────────────────────────
// The customer-facing track page lives IN THIS app at /track/<token> (see the
// get_load_tracking RPC, which whitelists safe fields and never exposes rate or
// margin). This module is the single source of truth for that URL — do not
// hardcode the path elsewhere.
//
// Unlike Top Dawg, Avantra tracking is TOKEN-ONLY: there is no PIN, no expiry,
// and no view-count columns on `loads`. A load's tracking_token is minted by the
// column default (gen_random_uuid()) at insert; "sharing" simply flips
// tracking_active on. We never rotate the token on activation so any link that
// was already handed to a customer keeps working.
//
// NOTE: this file is intentionally free of Node-only imports (no `crypto`
// module) so it stays safe to import from client components (the loads detail
// page). We use the global `crypto.randomUUID()`, available in both Node 18+ and
// the browser.

// Base for in-app links — relative '/track' by default (resolves against the
// current origin), overridable via env if the page ever moves to its own host.
const TRACK_BASE = (process.env.NEXT_PUBLIC_TRACK_BASE_URL ?? '/track').replace(/\/+$/, '')

/** In-app tracking URL for `token` (relative by default, e.g. "/track/<uuid>"). */
export function trackingUrl(token: string): string {
  return `${TRACK_BASE}/${token}`
}

/**
 * Absolute tracking URL for contexts where a relative path won't resolve
 * (transactional emails, PDFs). Prefers an absolute NEXT_PUBLIC_TRACK_BASE_URL,
 * then NEXT_PUBLIC_APP_URL + '/track', and finally falls back to the (possibly
 * relative) in-app URL when nothing absolute is configured.
 */
export function absoluteTrackingUrl(token: string): string {
  const explicit = process.env.NEXT_PUBLIC_TRACK_BASE_URL
  if (explicit && /^https?:\/\//i.test(explicit)) {
    return `${explicit.replace(/\/+$/, '')}/${token}`
  }
  const app = process.env.NEXT_PUBLIC_APP_URL
  if (app && /^https?:\/\//i.test(app)) {
    return `${app.replace(/\/+$/, '')}/track/${token}`
  }
  return trackingUrl(token)
}

export type TrackingState = {
  token: string
  active: boolean
  /** true when THIS call flipped tracking on (was previously off); false if it was already live. */
  activated: boolean
}

/**
 * Ensure a load has a LIVE public tracking link. Idempotent and NON-rotating: if
 * tracking is already active it returns the existing token unchanged (so repeat
 * calls don't churn the link or re-notify the customer). Otherwise it flips
 * tracking_active on, reusing the existing tracking_token (minted by the column
 * default) so any link already shared keeps working. Pass a SERVICE-ROLE client
 * — RLS would otherwise block the write. Returns null on error.
 */
export async function ensureTrackingActive(
  supabase: SupabaseClient,
  loadId: string,
): Promise<TrackingState | null> {
  const { data: load, error } = await supabase
    .from('loads')
    .select('tracking_token, tracking_active')
    .eq('id', loadId)
    .single()
  if (error || !load) return null

  // Already live — return the existing token untouched (no rotation, no re-email).
  if (load.tracking_active && load.tracking_token) {
    return { token: load.tracking_token as string, active: true, activated: false }
  }

  // Reuse the default-minted token when present; mint one defensively otherwise.
  const token = (load.tracking_token as string) || crypto.randomUUID()

  const { error: upErr } = await supabase
    .from('loads')
    .update({ tracking_token: token, tracking_active: true })
    .eq('id', loadId)
  if (upErr) {
    console.error('[tracking] ensureTrackingActive update failed:', upErr)
    return null
  }
  return { token, active: true, activated: true }
}

/** Minimal HTML escaper for interpolating customer-controlled values into emails. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * A self-contained "Track this shipment" block for transactional emails. Uses an
 * absolute link (email clients can't resolve relative paths) and Avantra's cool
 * ice/sky palette. Inline styles only — email clients ignore <style>. Token-only:
 * no PIN. `token` is a UUID (safe); heading/sub are developer-supplied.
 */
export function trackLinkEmailBlock(
  token: string,
  opts?: { heading?: string; sub?: string },
): string {
  const url = absoluteTrackingUrl(token)
  const heading = opts?.heading ?? 'Track this shipment live'
  const sub = opts?.sub ?? 'Real-time status and ETA — no login required.'
  return `
    <div style="margin-top:20px;padding:18px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;text-align:center">
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#075985">${heading}</p>
      <p style="margin:0 0 14px;font-size:13px;color:#0369a1">${sub}</p>
      <a href="${url}" target="_blank" style="display:inline-block;background:#0284c7;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:11px 24px;border-radius:8px">Track shipment &#8594;</a>
    </div>`
}
