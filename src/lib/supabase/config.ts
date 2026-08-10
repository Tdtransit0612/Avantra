// Is Supabase wired up at all? Checked before any client is constructed, because
// createServerClient/createBrowserClient throw outright on missing credentials —
// and that throw happens in the proxy, so a fresh clone with no .env.local 500s
// on every route including /login, with nothing on screen explaining why.
//
// Safe on both sides of the wire: only NEXT_PUBLIC_* vars are read, which are
// inlined at build time and are not secrets.

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

export function supabaseConfigured(): boolean {
  return SUPABASE_URL.startsWith('http') && SUPABASE_ANON_KEY.length > 0
}

/** Which of the required vars are missing, for the setup screen. */
export function missingSupabaseVars(): string[] {
  const out: string[] = []
  if (!SUPABASE_URL.startsWith('http')) out.push('NEXT_PUBLIC_SUPABASE_URL')
  if (!SUPABASE_ANON_KEY) out.push('NEXT_PUBLIC_SUPABASE_ANON_KEY')
  return out
}
