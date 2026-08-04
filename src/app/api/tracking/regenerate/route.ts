import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient as createServerClient } from '@/lib/supabase/server'

// POST /api/tracking/regenerate — mint a FRESH tracking_token for a load (e.g. an
// old link leaked) while keeping tracking_active as-is. Any previously shared link
// stops working; the customer must be re-sent the new link via /api/tracking/share.
//
// Adapted from Top Dawg's /api/tracking/regenerate. Avantra is token-only (no PIN,
// no expiry columns), so this simply rotates the UUID. Middleware does not gate
// /api/*, so this route self-authenticates: staff only.

const STAFF = ['admin', 'dispatcher', 'back_office', 'sales']

export async function POST(req: NextRequest) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!serviceKey || !supabaseUrl) {
    return NextResponse.json({ error: 'Server not configured (missing Supabase service key).' }, { status: 500 })
  }

  // ── Auth: logged-in staff user ─────────────────────────────────────────────
  const authClient = await createServerClient()
  const { data: { user }, error: authErr } = await authClient.auth.getUser()
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createServiceClient(supabaseUrl, serviceKey)
  const { data: profile } = await admin
    .from('profiles').select('role, is_master_admin').eq('id', user.id).single()
  const isStaff = profile?.is_master_admin === true || STAFF.includes((profile?.role as string) ?? '')
  if (!isStaff) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json().catch(() => null)
  const loadId = String(body?.load_id ?? body?.loadId ?? '')
  if (!loadId) return NextResponse.json({ error: 'Missing load_id' }, { status: 400 })

  // Confirm the load exists (and grab its number for the audit trail).
  const { data: existing, error: fetchErr } = await admin
    .from('loads')
    .select('id, load_number, tracking_active')
    .eq('id', loadId)
    .single()
  if (fetchErr || !existing) return NextResponse.json({ error: 'Load not found' }, { status: 404 })

  // Rotate the token; keep tracking_active untouched (this action only invalidates
  // the old link, it doesn't turn tracking on or off).
  const newToken = crypto.randomUUID()
  const { error: updateErr } = await admin
    .from('loads')
    .update({ tracking_token: newToken })
    .eq('id', loadId)
  if (updateErr) {
    console.error('[tracking/regenerate] update failed:', updateErr)
    return NextResponse.json({ error: updateErr.message }, { status: 500 })
  }

  // Server-side audit (service-role; reliable). Best-effort.
  await admin.from('audit_log').insert({
    user_id: user.id,
    action: 'load.tracking_regenerated',
    table_name: 'loads',
    record_id: loadId,
    new_value: { load_number: existing.load_number },
  }).then(() => {}, () => {})

  return NextResponse.json({ ok: true, tracking_token: newToken, tracking_active: existing.tracking_active })
}
