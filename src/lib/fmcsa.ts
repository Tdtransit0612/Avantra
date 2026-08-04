// ─────────────────────────────────────────────────────────────────────────────
// FMCSA carrier-authority lookup (Avantra brokerage).
//
// Thin, server-only wrapper around the FREE FMCSA QCMobile API. We never onboard
// a carrier without confirming they're authorized to operate — this is what the
// carrier-onboarding UI calls to pre-fill authority / insurance / address and to
// flag a carrier whose FMCSA authority is inactive.
//
// The QCMobile API is a plain GET with the caller's key appended as ?webKey=…:
//   • by DOT:    /qc/services/carriers/{dot}
//   • by MC:     /qc/services/carriers/docket-number/{mc}   → { content: [ { carrier }, … ] }
//   • authority: /qc/services/carriers/{dot}/authority       (not needed here —
//                the single-carrier record already carries `allowedToOperate`)
//
// The single-carrier response is { content: { carrier: { legalName, dbaName,
// dotNumber, allowedToOperate:'Y'|'N', safetyRating, bipdInsuranceOnFile,
// cargoInsuranceOnFile, phyStreet, phyCity, phyState, phyZipcode, telephone, … } } }.
//
// Everything here parses DEFENSIVELY: FMCSA freely returns partial records, empty
// `content`, or `content: []` for a docket miss, so every field is optional-chained
// and coerced, and the untouched carrier object is preserved on `.raw` for callers
// that want fields we don't normalize (insurance amounts, OOS dates, etc.).
// ─────────────────────────────────────────────────────────────────────────────

const FMCSA_BASE = 'https://mobile.fmcsa.dot.gov/qc/services'
const REQUEST_TIMEOUT_MS = 10_000

export type AuthorityStatus = 'active' | 'not_authorized' | 'unknown'

/** Normalized, Avantra-shaped carrier record returned by every lookup. */
export interface NormalizedCarrier {
  found: boolean
  legal_name: string | null
  dba_name: string | null
  dot_number: string | null
  mc_number: string | null
  allowed_to_operate: boolean
  authority_status: AuthorityStatus
  safety_rating: string | null
  bipd_on_file: string | null   // BIPD (auto-liability) insurance on file: 'Y'|'N'|null
  cargo_on_file: string | null  // cargo insurance on file: 'Y'|'N'|null
  phone: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  raw: unknown
}

/** Thrown when FMCSA_WEBKEY is unset — the route turns this into { configured:false }. */
export class FmcsaNotConfiguredError extends Error {
  constructor() {
    super('FMCSA_WEBKEY not set')
    this.name = 'FmcsaNotConfiguredError'
  }
}

/** Thrown for a reachable-but-failed lookup (5xx/403/timeout/malformed JSON). */
export class FmcsaLookupError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'FmcsaLookupError'
    this.status = status
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Trim to a non-empty string or null (FMCSA loves empty strings). */
function str(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s.length ? s : null
}

/** An empty "not found" record, echoing back whichever number was searched. */
function notFound(dot: string | null, mc: string | null): NormalizedCarrier {
  return {
    found: false,
    legal_name: null,
    dba_name: null,
    dot_number: dot,
    mc_number: mc,
    allowed_to_operate: false,
    authority_status: 'unknown',
    safety_rating: null,
    bipd_on_file: null,
    cargo_on_file: null,
    phone: null,
    address: null,
    city: null,
    state: null,
    zip: null,
    raw: null,
  }
}

/**
 * Shape a raw FMCSA carrier object into a NormalizedCarrier.
 * @param carrier     the `carrier` sub-object from the FMCSA response
 * @param mcFallback  MC number to record when we looked up by docket (the carrier
 *                    object itself doesn't reliably echo the MC)
 */
function normalize(carrier: any, mcFallback: string | null): NormalizedCarrier {
  const allowedRaw = str(carrier?.allowedToOperate)
  const allowed = allowedRaw ? allowedRaw.toUpperCase() : null
  const authority_status: AuthorityStatus =
    allowed === 'Y' ? 'active' : allowed === 'N' ? 'not_authorized' : 'unknown'

  const dotNumber = carrier?.dotNumber

  return {
    found: true,
    legal_name: str(carrier?.legalName),
    dba_name: str(carrier?.dbaName),
    dot_number: dotNumber != null && String(dotNumber).trim() ? String(dotNumber).trim() : null,
    mc_number: mcFallback,
    allowed_to_operate: allowed === 'Y',
    authority_status,
    safety_rating: str(carrier?.safetyRating),
    bipd_on_file: str(carrier?.bipdInsuranceOnFile),
    cargo_on_file: str(carrier?.cargoInsuranceOnFile),
    // Physical-address phone is `telephone` in QCMobile; tolerate `phone` too.
    phone: str(carrier?.telephone) ?? str(carrier?.phone),
    address: str(carrier?.phyStreet),
    city: str(carrier?.phyCity),
    state: str(carrier?.phyState),
    zip: str(carrier?.phyZipcode),
    raw: carrier ?? null,
  }
}

/**
 * GET a QCMobile endpoint. Returns the parsed JSON (or 404 sentinel). Throws
 * FmcsaNotConfiguredError when the webkey is missing and FmcsaLookupError for any
 * other non-success condition, so callers never crash on a network blip.
 */
async function fmcsaGet(path: string): Promise<{ status: number; json: unknown }> {
  const key = process.env.FMCSA_WEBKEY
  if (!key) throw new FmcsaNotConfiguredError()

  const url = `${FMCSA_BASE}${path}?webKey=${encodeURIComponent(key)}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'AbortError'
    throw new FmcsaLookupError(
      timedOut ? 'FMCSA request timed out' : 'Could not reach FMCSA',
      timedOut ? 504 : 502,
    )
  } finally {
    clearTimeout(timer)
  }

  // 404 = unknown DOT/MC → a normal "not found", not an error.
  if (res.status === 404) return { status: 404, json: null }
  if (!res.ok) throw new FmcsaLookupError(`FMCSA returned HTTP ${res.status}`, res.status)

  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new FmcsaLookupError('FMCSA returned malformed JSON', 502)
  }
  return { status: res.status, json }
}

// ── public API ───────────────────────────────────────────────────────────────

/** Look a carrier up by USDOT number. Digits-only; non-digits are stripped. */
export async function lookupByDot(dotInput: string): Promise<NormalizedCarrier> {
  const dot = String(dotInput ?? '').replace(/\D/g, '')
  if (!dot) return notFound(null, null)

  const { status, json } = await fmcsaGet(`/carriers/${dot}`)
  if (status === 404) return notFound(dot, null)

  const content = (json as any)?.content
  // Single-carrier endpoint nests under content.carrier; guard the empty-array miss.
  const carrier = Array.isArray(content) ? content[0]?.carrier : content?.carrier
  if (!carrier) return notFound(dot, null)

  return normalize(carrier, null)
}

/** Look a carrier up by MC / docket number. Digits-only; non-digits are stripped. */
export async function lookupByMc(mcInput: string): Promise<NormalizedCarrier> {
  const mc = String(mcInput ?? '').replace(/\D/g, '')
  if (!mc) return notFound(null, null)

  const { status, json } = await fmcsaGet(`/carriers/docket-number/${mc}`)
  if (status === 404) return notFound(null, mc)

  // Docket endpoint returns content as an array of { carrier } wrappers.
  const content = (json as any)?.content
  const carrier = Array.isArray(content) ? content[0]?.carrier : content?.carrier
  if (!carrier) return notFound(null, mc)

  return normalize(carrier, mc)
}
