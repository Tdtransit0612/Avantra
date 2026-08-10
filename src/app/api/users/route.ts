import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { STAFF_ROLES } from '@/lib/access'

// User administration. Role changes CANNOT go through the browser client:
// prevent_profile_privilege_escalation() pins profiles.role and
// profiles.is_master_admin on any write that isn't the service role, precisely
// so a user can't PATCH themselves to admin. So this route is the only path,
// and it re-checks the caller's own role server-side before using that key.
//
// Middleware does not gate /api/*, so this route self-authenticates.

const ASSIGNABLE_ROLES = [...STAFF_ROLES, 'client', 'pending', 'terminated'] as const
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function service() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!serviceKey || !supabaseUrl) return null
  return createServiceClient(supabaseUrl, serviceKey)
}

/** Resolve the caller and confirm they may administer users. */
async function requireAdmin() {
  const admin = service()
  if (!admin) {
    return { error: NextResponse.json({ error: 'Server not configured (missing Supabase service key).' }, { status: 500 }) }
  }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }

  const { data: caller } = await admin
    .from('profiles').select('role, is_master_admin').eq('id', user.id).single()
  const isMaster = caller?.is_master_admin === true
  const isAdmin = isMaster || caller?.role === 'admin'
  if (!isAdmin) return { error: NextResponse.json({ error: 'You don’t have permission to manage users.' }, { status: 403 }) }

  return { admin, user, isMaster }
}

// GET /api/users — list every profile for the admin console.
export async function GET() {
  const ctx = await requireAdmin()
  if ('error' in ctx) return ctx.error
  const { admin } = ctx

  const { data, error } = await admin
    .from('profiles')
    .select('id, email, full_name, phone, role, is_master_admin, mfa_enrolled, client_id, created_at')
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ users: data ?? [] })
}

// POST /api/users — { id, role?, is_master_admin?, client_id? }
export async function POST(req: NextRequest) {
  const ctx = await requireAdmin()
  if ('error' in ctx) return ctx.error
  const { admin, user, isMaster } = ctx

  const body = await req.json().catch(() => null) as {
    id?: string; role?: string; is_master_admin?: boolean; client_id?: string | null
  } | null

  const targetId = String(body?.id ?? '')
  if (!targetId || !UUID_RE.test(targetId)) {
    return NextResponse.json({ error: 'invalid_request: id must be a uuid' }, { status: 400 })
  }

  const { data: target } = await admin
    .from('profiles').select('id, email, role, is_master_admin').eq('id', targetId).single()
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const patch: Record<string, unknown> = {}

  if (body?.role !== undefined) {
    if (!(ASSIGNABLE_ROLES as readonly string[]).includes(body.role)) {
      return NextResponse.json({ error: `Unknown role: ${body.role}` }, { status: 400 })
    }
    // Don't let an admin demote themselves and lock the company out of its own
    // admin console. Someone else with admin has to do it.
    if (targetId === user.id && body.role !== 'admin') {
      return NextResponse.json({ error: 'You can’t change your own role. Ask another admin.' }, { status: 400 })
    }
    // A master admin outranks a plain admin; only another master may re-role one.
    if (target.is_master_admin && !isMaster) {
      return NextResponse.json({ error: 'Only a master admin can change a master admin.' }, { status: 403 })
    }
    patch.role = body.role
    // Leaving the client role behind should drop the portal binding, or the user
    // keeps a stale link to a carrier they no longer represent.
    if (body.role !== 'client') patch.client_id = null
  }

  if (body?.is_master_admin !== undefined) {
    // Master admin is the top of the tree — only an existing master grants it.
    if (!isMaster) {
      return NextResponse.json({ error: 'Only a master admin can grant or revoke master admin.' }, { status: 403 })
    }
    if (targetId === user.id && body.is_master_admin === false) {
      return NextResponse.json({ error: 'You can’t revoke your own master admin.' }, { status: 400 })
    }
    patch.is_master_admin = body.is_master_admin === true
  }

  if (body?.client_id !== undefined) {
    if (body.client_id !== null && !UUID_RE.test(String(body.client_id))) {
      return NextResponse.json({ error: 'invalid_request: client_id must be a uuid or null' }, { status: 400 })
    }
    patch.client_id = body.client_id
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'invalid_request: nothing to update' }, { status: 400 })
  }

  // Revoking the last master admin would leave nobody able to grant it back.
  if (patch.is_master_admin === false) {
    const { count } = await admin
      .from('profiles').select('id', { count: 'exact', head: true }).eq('is_master_admin', true)
    if ((count ?? 0) <= 1) {
      return NextResponse.json({ error: 'That’s the last master admin — promote someone else first.' }, { status: 400 })
    }
  }

  const { error } = await admin.from('profiles').update(patch).eq('id', targetId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Server-side audit — reliable, unlike the browser-side logAudit helper. Note
  // this writes the row directly and so does NOT trigger the high-risk email
  // alert, which is fired from the client helper; the caller does that.
  await admin.from('audit_log').insert({
    user_id: user.id,
    action: 'user.role_change',
    table_name: 'profiles',
    record_id: targetId,
    old_value: { email: target.email, role: target.role, is_master_admin: target.is_master_admin },
    new_value: patch,
  }).then(() => {}, () => {})

  return NextResponse.json({ ok: true })
}
