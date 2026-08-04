import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { ensureTrackingActive, trackLinkEmailBlock, escapeHtml } from '@/lib/tracking'

// POST /api/tracking/share — activate a load's public tracking link and (on FIRST
// activation only) email the customer that tracking is live, with the public
// trackingUrl. Called from the load detail page's "Share tracking" action.
//
// Adapted from Top Dawg's /api/tracking/share. Differences: Avantra tracking is
// token-only (no PIN); the notification goes to the CUSTOMER (customers.billing_email
// via loads.customer_id), not a broker. By default it emails ONLY when tracking was
// just activated (so re-sharing an already-live load doesn't re-spam the customer);
// pass { force: true } to re-send on demand.
//
// Middleware does not gate /api/*, so this route self-authenticates: staff only.

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
  const force = body?.force === true
  if (!loadId) return NextResponse.json({ error: 'Missing load_id' }, { status: 400 })

  const { data: load, error: loadErr } = await admin
    .from('loads')
    .select('id, load_number, customer_id, customer_name, pickup_city, pickup_state, pickup_date, delivery_city, delivery_state')
    .eq('id', loadId)
    .single()
  if (loadErr || !load) return NextResponse.json({ error: 'Load not found' }, { status: 404 })

  // ── Flip tracking on (idempotent; reuses the existing token) ────────────────
  const state = await ensureTrackingActive(admin, loadId)
  if (!state) return NextResponse.json({ error: 'Could not activate tracking' }, { status: 500 })

  // Resolve the customer's billing email (notification recipient).
  let customerEmail: string | null = null
  if (load.customer_id) {
    const { data: customer } = await admin
      .from('customers').select('billing_email').eq('id', load.customer_id).single()
    customerEmail = (customer?.billing_email as string | null) ?? null
  }

  // Only email on first activation (avoid re-spamming on status toggles) unless forced.
  const shouldEmail = (state.activated || force) && !!customerEmail && !!process.env.RESEND_API_KEY
  let emailed = false
  const reason = shouldEmail
    ? undefined
    : !customerEmail
      ? 'no_customer_email'
      : !process.env.RESEND_API_KEY
        ? 'email_disabled'
        : 'already_shared'

  if (shouldEmail && customerEmail) {
    const resend = new Resend(process.env.RESEND_API_KEY ?? '')
    const FROM = process.env.RESEND_FROM_EMAIL ?? 'Avantra <onboarding@resend.dev>'

    const laneFrom = load.pickup_city ? `${load.pickup_city}, ${load.pickup_state ?? ''}`.trim() : null
    const laneTo = load.delivery_city ? `${load.delivery_city}, ${load.delivery_state ?? ''}`.trim() : null
    const lane = [laneFrom, laneTo].filter((v): v is string => !!v).map(escapeHtml).join(' &#8594; ') || '—'
    const pickupDate = load.pickup_date
      ? new Date(`${load.pickup_date}T12:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : null
    const loadNumber = escapeHtml(load.load_number ?? '—')
    const customerName = load.customer_name ? escapeHtml(load.customer_name) : null

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto">
        <div style="background:#0c4a6e;padding:22px 24px;border-radius:8px 8px 0 0">
          <h2 style="color:#ffffff;margin:0;font-size:19px">Avantra</h2>
          <p style="color:#bae6fd;margin:4px 0 0;font-size:13px">Shipment booked &middot; tracking is live</p>
        </div>
        <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px;background:#fff">
          <p style="margin:0 0 16px;font-size:14px;color:#374151">${customerName ? `Hi ${customerName} — your` : 'Your'} shipment is booked with Avantra. You can follow it live any time using the secure link below.</p>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;width:120px">Load #</td><td style="padding:6px 0;font-weight:600;font-size:14px">${loadNumber}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280;font-size:13px">Lane</td><td style="padding:6px 0;font-size:14px">${lane}</td></tr>
            ${pickupDate ? `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px">Pickup</td><td style="padding:6px 0;font-size:14px">${escapeHtml(pickupDate)}</td></tr>` : ''}
          </table>
          ${trackLinkEmailBlock(state.token, { heading: 'Track this shipment', sub: 'Real-time status and ETA — no login required.' })}
          <div style="margin-top:20px;padding-top:16px;border-top:1px solid #f3f4f6;color:#9ca3af;font-size:12px">
            Questions? Reply to this email or contact your Avantra representative.
          </div>
        </div>
      </div>`

    try {
      await resend.emails.send({
        from: FROM,
        to: customerEmail,
        subject: `Track your shipment — Load ${load.load_number ?? ''} · Avantra`.trim(),
        html,
      })
      emailed = true
    } catch (e) {
      console.error('[tracking/share] email failed:', e)
      // Tracking is still active — report partial success.
      return NextResponse.json({ ok: true, emailed: false, token: state.token, error: 'email_failed' })
    }
  }

  // Server-side audit (service-role; reliable — logAudit is browser-only). Log
  // identifiers, not rates. Best-effort.
  await admin.from('audit_log').insert({
    user_id: user.id,
    action: 'load.tracking_shared',
    table_name: 'loads',
    record_id: loadId,
    new_value: { load_number: load.load_number, activated: state.activated, emailed, customer_email: emailed ? customerEmail : null },
  }).then(() => {}, () => {})

  return NextResponse.json({ ok: true, emailed, token: state.token, reason })
}
