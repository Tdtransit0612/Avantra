import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

export async function proxy(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  matcher: [
    {
      /*
       * Everything except:
       *  - api            API routes self-authenticate; running the proxy on them
       *                   only adds a Supabase auth round-trip per call.
       *  - _next/static   build output
       *  - _next/image    image optimizer
       *  - favicon.ico    favicon
       *  - track/         the public shipment-tracking page, reachable with no login
       *  - image files    served as-is
       */
      source:
        '/((?!api|_next/static|_next/image|favicon.ico|track/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',

      /*
       * Skip next/link prefetches. This is the matcher shape Next's own CSP guide
       * prescribes, and omitting it is a production-only footgun: every request
       * through this proxy mints a FRESH nonce, so a prefetched RSC payload is
       * stamped with a nonce that no longer matches the CSP on the page the user
       * eventually lands on. The browser then refuses the scripts and client-side
       * navigation breaks — while a hard reload works fine, which is what makes it
       * so confusing. Dev prefetches far less aggressively than production, so this
       * class of bug does not reproduce locally.
       */
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}
