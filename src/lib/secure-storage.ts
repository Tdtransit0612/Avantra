import { createClient } from '@supabase/supabase-js'

// Helpers for the PRIVATE `secure-docs` bucket (signed e-contracts + onboarding
// uploads that contain EIN/SSN/PII). Files live as storage PATHS in the DB; we
// mint short-lived signed URLs on read via the service role. Legacy values that
// are still absolute URLs (files in the old public `documents` bucket, before the
// one-time migration) are passed through unchanged so nothing breaks mid-migration.

export const SECURE_BUCKET = 'secure-docs'

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

const isAbsoluteUrl = (v: string) => /^https?:\/\//i.test(v)

/** A stored value is a secure-docs path when it isn't an absolute URL. */
export function isSecurePath(value: string | null | undefined): value is string {
  return !!value && !isAbsoluteUrl(value)
}

/** Mint a temporary signed URL for a secure-docs path. Absolute URLs pass through. */
export async function signSecureDoc(value: string | null | undefined, ttlSeconds = 7200): Promise<string | null> {
  if (!value) return null
  if (isAbsoluteUrl(value)) return value
  const { data, error } = await admin().storage.from(SECURE_BUCKET).createSignedUrl(value, ttlSeconds)
  if (error) { console.error('[secure-storage] sign failed:', error.message); return null }
  return data?.signedUrl ?? null
}

// Private buckets we'll mint signed URLs against. Legacy company docs were stored as
// PUBLIC `documents` URLs; that bucket was later locked to private, so those public
// URLs now 404 "Bucket not found" — they must be re-signed via the service role.
const SIGNABLE_BUCKETS = new Set([SECURE_BUCKET, 'documents'])

/** Extract { bucket, path } from a Supabase Storage object URL for this project. */
function parseStorageObjectUrl(value: string): { bucket: string; path: string } | null {
  const m = value.match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/?#]+)\/([^?#]+)/)
  if (!m) return null
  let path = m[2]
  try { path = decodeURIComponent(path) } catch { /* leave as-is */ }
  return { bucket: m[1], path }
}

/**
 * Mint a signed URL for ANY stored document value:
 *  - relative path           → signed against the secure-docs bucket
 *  - project storage URL      → signed against that URL's bucket (handles legacy
 *                               `documents`/`secure-docs` files whose public URL
 *                               broke when the bucket went private)
 *  - any other absolute URL   → returned unchanged (truly external link)
 */
export async function signAnyDoc(value: string | null | undefined, ttlSeconds = 7200): Promise<string | null> {
  if (!value) return null
  if (!isAbsoluteUrl(value)) return signSecureDoc(value, ttlSeconds)
  const parsed = parseStorageObjectUrl(value)
  if (!parsed || !SIGNABLE_BUCKETS.has(parsed.bucket)) return value
  const { data, error } = await admin().storage.from(parsed.bucket).createSignedUrl(parsed.path, ttlSeconds)
  if (error) { console.error('[secure-storage] sign (url) failed:', error.message); return null }
  return data?.signedUrl ?? null
}
