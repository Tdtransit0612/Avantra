// Client helper for writing to RLS-protected tables through a staff-gated,
// service-role endpoint.
//
// Ported from Top Dawg's `updateFleetRow`. The reason the pattern exists: when a
// table is locked by RLS, a rejected browser-client UPDATE affects 0 rows WITHOUT
// throwing — so the write fails silently and the UI "saves" nothing. Route the
// write through the service-role endpoint instead, which does an explicit role +
// column check and surfaces a real error (or a 0-row 404). The return shape
// mirrors a supabase-js result (`{ error }` with `.message`) so call sites can
// keep their existing `if (error) { … }` handling.

export type ProtectedTable = 'carriers' | 'customers' | 'loads' | 'invoices' | 'carrier_settlements'

export type ProtectedWriteError = Error & { code?: string }

export async function updateProtectedRow(
  table: ProtectedTable,
  id: string,
  patch: Record<string, unknown>,
): Promise<{ error: ProtectedWriteError | null }> {
  try {
    const res = await fetch('/api/protected/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table, id, patch }),
    })
    const json = await res.json().catch(() => ({} as { error?: string; ok?: boolean; code?: string }))
    if (!res.ok || !json?.ok) {
      const err: ProtectedWriteError = new Error(json?.error || `Update failed (${res.status})`)
      if (json?.code) err.code = json.code
      return { error: err }
    }
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Network error — please try again.') }
  }
}
