import { NextRequest, NextResponse } from 'next/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

// POST /api/doc-url — mint a short-lived signed URL for an object in the PRIVATE
// `documents` bucket (rate cons, PODs, BOLs, COIs, W-9s, agreements). The bucket
// is never public; always sign on read.
//
// Authorization: staff only (master / admin / dispatcher / back_office / sales).
// Any staff member may sign any path. There is no external portal yet.
//
// ⚠️ When the client portal lands (Phase 3) on this SAME Supabase project, add
// path-scoped access here before the first external login: a `client` user must
// only be able to sign objects belonging to their own carrier. The uploader
// already writes paths as <entity_type>/<entity_id>/…, and documents.client_id +
// app_client_id() give you the scoping key — but this route does not check it
// yet, so shipping the portal without that branch would leak every client's
// paperwork to every other client.
//
// Accepts either a bare storage path or a stored public/sign URL; the object path
// is extracted from it.

const STAFF = ['admin', 'dispatcher', 'back_office', 'sales']

// Turn a stored value (bare path OR a .../documents/<path> URL) into the object key.
function toObjectPath(input: string): string {
  let p = input.trim()
  const marker = '/documents/'
  const i = p.indexOf(marker)
  if (i !== -1) p = p.slice(i + marker.length)
  p = p.split('?')[0] // strip any token query string
  try { p = decodeURIComponent(p) } catch { /* leave as-is */ }
  return p.replace(/^\/+/, '')
}

export async function POST(req: NextRequest) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!serviceKey || !supabaseUrl) {
    return NextResponse.json({ error: 'Server not configured.' }, { status: 500 })
  }

  // Auth: web sends a cookie session; support a Bearer token too (for any future
  // token-based client).
  const admin = createAdmin(supabaseUrl, serviceKey)
  const authHeader = req.headers.get('authorization') ?? ''
  const bearer = /^bearer /i.test(authHeader) ? authHeader.slice(7).trim() : null
  let user
  if (bearer) {
    const { data } = await admin.auth.getUser(bearer)
    user = data.user
  } else {
    const sb = await createClient()
    const { data } = await sb.auth.getUser()
    user = data.user
  }
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { path?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad_request' }, { status: 400 }) }
  const path = toObjectPath(String(body.path ?? ''))
  if (!path || path.includes('..')) return NextResponse.json({ error: 'missing_or_invalid_path' }, { status: 400 })

  const { data: profile } = await admin.from('profiles').select('role, is_master_admin').eq('id', user.id).single()
  const isStaff = profile?.is_master_admin === true || STAFF.includes((profile?.role as string) ?? '')
  if (!isStaff) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { data, error } = await admin.storage.from('documents').createSignedUrl(path, 3600)
  if (error || !data?.signedUrl) return NextResponse.json({ error: error?.message || 'sign_failed' }, { status: 500 })
  return NextResponse.json({ url: data.signedUrl })
}
