import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

export async function proxy(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  matcher: [
    // Exempt Next internals, static assets, and /track/ (public shipment tracking
    // page) so it's reachable without a staff login.
    '/((?!_next/static|_next/image|favicon.ico|track/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
