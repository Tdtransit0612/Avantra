// Client helper: resolve a short-lived signed URL for an object in the (private)
// shared `documents` bucket via the same-origin /api/doc-url route (cookie auth).
// Accepts a bare storage path OR a stored (possibly legacy-public) URL — the route
// extracts the object path either way. Returns null on failure so callers can
// fall back gracefully (e.g. show an error toast instead of opening a dead link).
export async function getDocUrl(pathOrUrl: string | null | undefined): Promise<string | null> {
  if (!pathOrUrl) return null
  try {
    const res = await fetch('/api/doc-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: pathOrUrl }),
    })
    const json = (await res.json().catch(() => ({}))) as { url?: string }
    if (!res.ok || !json.url) return null
    return json.url
  } catch {
    return null
  }
}

// Convenience: resolve a signed URL and open it in a new tab. No-op on failure.
export async function openDoc(pathOrUrl: string | null | undefined): Promise<void> {
  const url = await getDocUrl(pathOrUrl)
  if (url) window.open(url, '_blank', 'noopener,noreferrer')
}
